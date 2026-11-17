/**
 * game/Game.ts
 * 責務: ゲーム全体の初期化とメインループ。World/Vehicle/CarView/Input/Render/UI を配線する。
 * 公開API: Game
 * 依存: すべて
 *
 * 設計メモ:
 *  - 固定 120Hz の物理ステップをアキュムレータで回す(描画 FPS と分離)。
 *  - 1 フレームの処理順: 入力 → 物理(固定) → ビジュアル同期 → ワールドストリーム → 描画 → ポスト → UI
 *  - 画面遷移は GameStateMachine に集約。
 */
import * as THREE from "three";
import { RenderPipeline, QUALITY_PRESETS } from "./render/Pipeline.js";
import { PostFX } from "./render/PostFX.js";
import { QualityScaler } from "./render/QualityScaler.js";
import { EnvProbe } from "./render/EnvProbe.js";
import { ParticleSystem } from "./render/Particles.js";
import { buildAllCircuits, type Circuit } from "./race/Circuit.js";
import { RaceSession } from "./race/RaceSession.js";
import { RaceMarkerSet } from "./race/RaceMarkers.js";
import { World } from "./world/World.js";
import { Vehicle, PHYSICS_DT } from "./physics/Vehicle.js";
import { CarView, makeBlobShadowTexture } from "./car/CarView.js";
import { CARS, getCar, CarSpec } from "./car/spec/CarSpec.js";
import { materialLibrary } from "./car/materials/CarMaterials.js";
import { InputManager } from "./input/InputManager.js";
import { CameraRig, CameraMode } from "./systems/Camera.js";
import { Hud } from "./ui/Hud.js";
import { MenuSystem } from "./ui/Menus.js";
import { Garage } from "./ui/Garage.js";
import { GameStateMachine } from "./core/state.js";
import { DebugHud, createLoader, debugLog } from "./core/debug.js";
import { SaveSystem } from "./systems/Save.js";
import { clamp, clamp01, damp, lerp, smoothstep, DEG2RAD } from "./core/math.js";
import { DAY_HOURS } from "./world/WorldConfig.js";
import { AmbientAudio } from "./audio/Ambient.js";
import { EngineSynth } from "./audio/EngineSynth.js";
import { WorldMap } from "./ui/WorldMap.js";

export interface GameOptions {
  container: HTMLElement;
}

export class Game {
  readonly pipeline: RenderPipeline;
  readonly post: PostFX;
  readonly scaler: QualityScaler;
  readonly env: EnvProbe;
  readonly particles: ParticleSystem;
  readonly world: World;
  readonly input: InputManager;
  readonly camera: CameraRig;
  readonly hud: Hud;
  readonly menus: MenuSystem;
  readonly garage: Garage;
  readonly stateMachine = new GameStateMachine();
  readonly debug: DebugHud;
  readonly save: SaveSystem;
  readonly worldMap: WorldMap;
  readonly engineAudio: EngineSynth;
  readonly ambient: AmbientAudio;

  private vehicle: Vehicle;
  private carView: CarView;
  private container: HTMLElement;
  private clock = new THREE.Clock();
  private accumulator = 0;
  private running = false;
  private frameHandle: number | null = null;
  private qualityIndex = 2;
  private elapsed = 0;
  private lightsOn = false;
  private lastSpeed = 0;
  private shakeSeed = 0;
  private blobShadow: THREE.Mesh;
  private blobTexture: THREE.Texture;
  private shadowY = 0;
  private lastTimeHour = 16.5;
  private weather: "clear" | "cloudy" | "rain" | "storm" = "clear";
  private wetness = 0;
  private dust = 0;
  private photoMode = false;
  private currentCar: CarSpec;
  private isDragging = false;
  private lastPointer = { x: 0, y: 0 };
  private autopilot = false;
  private raceClock = 0;
  /** 走行可能なコース一覧(起動時に道路網から構築) */
  readonly circuits: Circuit[] = [];
  /** 進行中のセッション。null ならフリードライブ */
  private race: RaceSession | null = null;
  private raceMarkers = new RaceMarkerSet();


  constructor(options: GameOptions) {
    this.container = options.container;
    this.container.style.cssText =
      "position:relative;width:100%;height:100%;overflow:hidden;background:#0a0e13;touch-action:none;";

    this.save = new SaveSystem();
    this.qualityIndex = this.save.get("quality", 2);
    this.currentCar = getCar(this.save.get("carId", CARS[0].id)) ?? CARS[0];

    const loader = createLoader(this.container);
    loader.set(0.05, "レンダラーを初期化しています…");

    this.pipeline = new RenderPipeline(this.container, this.qualityIndex);
    this.post = new PostFX(this.pipeline.renderer, this.pipeline.renderer.domElement.width, this.pipeline.renderer.domElement.height);
    this.scaler = new QualityScaler(this.pipeline, this.qualityIndex);
    this.env = new EnvProbe(this.pipeline.renderer);
    this.particles = new ParticleSystem(this.pipeline.renderer.getPixelRatio());
    this.pipeline.scene.add(this.particles.group);
    this.debug = new DebugHud(this.container);

    loader.set(0.18, "12km 四方の地形を生成しています…");
    this.world = new World(this.qualityIndex);
    this.pipeline.scene.add(this.world.group);
    this.pipeline.scene.fog = this.world.sky.fog;

    loader.set(0.62, "道路と集落を配置しています…");
    this.world.props.primeAll();

    loader.set(0.76, "車を組み立てています…");
    this.vehicle = new Vehicle(this.currentCar, this.world.terrain, this.world.roads);
    this.carView = new CarView(this.currentCar, materialLibrary, { quality: 2 });
    this.pipeline.scene.add(this.carView.root);

    const spawn = this.world.spawnPoint();
    this.vehicle.teleport(spawn.x, spawn.z, spawn.heading);
    this.pipeline.scene.add(this.world.sky.sunLight);

    // 接地影
    this.blobTexture = makeBlobShadowTexture(128);
    const blobGeom = new THREE.PlaneGeometry(1, 1);
    blobGeom.rotateX(-Math.PI / 2);
    this.blobShadow = new THREE.Mesh(
      blobGeom,
      new THREE.MeshBasicMaterial({ map: this.blobTexture, transparent: true, opacity: 0.5, depthWrite: false })
    );
    this.blobShadow.scale.set(this.currentCar.dims.width * 1.5, 1, this.currentCar.dims.length * 1.15);
    this.pipeline.scene.add(this.blobShadow);

    loader.set(0.86, "入力デバイスを検出しています…");
    this.input = new InputManager(this.container);
    this.camera = new CameraRig(this.pipeline.camera, this.world.terrain);
    this.camera.snap(this.vehicle);

    this.hud = new Hud(this.container);
    this.hud.setWorld(this.world.roads, this.world.terrain);
    this.hud.setDeviceHints(this.input);

    // 走行可能なコースを道路網から構築(閉路のみ)
    this.circuits.push(...buildAllCircuits(this.world.roads));
    this.raceMarkers = new RaceMarkerSet();
    this.pipeline.scene.add(this.raceMarkers.group);

    this.engineAudio = new EngineSynth();
    this.ambient = new AmbientAudio();

    this.garage = new Garage(this.container, this.currentCar, (spec) => this.selectCar(spec));
    this.worldMap = new WorldMap(this.container, this.world.roads, this.world.terrain);

    this.menus = new MenuSystem(this.container, {
      onStart: () => this.startDriving(),
      onGarage: () => this.openGarage(),
      onResume: () => this.resume(),
      onSettings: () => this.openSettings(),
      onQuit: () => this.toTitle(),
      onQualityChange: (i) => this.setQuality(i),
      onTimeChange: (h) => this.setTime(h),
      onWeatherChange: (w) => this.setWeather(w),
      onCameraChange: (m) => this.setCamera(m),
      onToggleDebug: () => this.debug.toggle(),
      onPhotoMode: () => this.togglePhotoMode(),
      onFullscreen: () => this.input.touch.requestFullscreenLandscape(),
      onReset: () => this.rescueVehicle(),
      onCircuits: () => this.openCircuits(),
      onRaceStart: (id) => this.startRace(id),
    });

    // 昼夜・天候の初期化
    this.setTime(this.save.get("hour", 16.5));
    this.setWeather(this.save.get("weather", "clear") as typeof this.weather, true);

    // 環境マップ
    this.updateEnvMap(true);
    materialLibrary.applyEnvMap(this.env.get("showroom"));
    this.carView.body.paint.envMap = this.env.get("showroom");
    this.carView.body.paint.needsUpdate = true;

    this.setupPointer();
    this.setupKeyboardShortcuts();

    loader.set(1, "準備完了");
    setTimeout(() => {
      loader.hide();
      this.toTitle();
      this.start();
    }, 320);

    window.addEventListener("resize", () => this.onResize());
  }

  /* ---------------------------------------------------------------- */
  /* セットアップ                                                     */
  /* ---------------------------------------------------------------- */

  private setupPointer(): void {
    const el = this.pipeline.renderer.domElement;
    el.addEventListener("pointerdown", (e) => {
      this.isDragging = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("pointerup", () => {
      this.isDragging = false;
    });
    window.addEventListener("pointermove", (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      if (this.photoMode) this.camera.photoOrbit(dx, dy, 0);
    });
    el.addEventListener(
      "wheel",
      (e) => {
        if (this.photoMode) {
          e.preventDefault();
          this.camera.photoOrbit(0, 0, e.deltaY);
        }
      },
      { passive: false }
    );
  }

  private setupKeyboardShortcuts(): void {
    window.addEventListener("keydown", (e) => {
      if (e.code === "F3") {
        e.preventDefault();
        this.debug.toggle();
      }
      if (e.code === "KeyG" && this.stateMachine.is("title")) {
        this.openGarage();
      }
      if (e.code === "KeyH" && this.stateMachine.is("title")) {
        this.menus.showHelp();
      }
      // T: タイムトライアル(タイトル / ポーズ中から)
      if (e.code === "KeyT" && this.stateMachine.is("title", "paused")) {
        this.openCircuits();
      }
      if (e.code === "KeyF" && this.stateMachine.is("driving")) {
        this.togglePhotoMode();
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* 画面遷移                                                         */
  /* ---------------------------------------------------------------- */

  toTitle(): void {
    this.endRace(false);
    this.stateMachine.transition("title");
    this.hud.setVisible(false);
    this.garage.close();
    this.worldMap.close();
    this.engineAudio.setActive(false);
    this.menus.showTitle({
      cars: CARS.length,
      roads: this.world.roads.getStats().roads,
      world: `${this.world.getStats().roadKm} km の道路網`,
    });
  }

  openGarage(): void {
    this.stateMachine.transition("garage");
    this.hud.setVisible(false);
    this.menus.close();
    this.garage.open();
  }

  openSettings(): void {
    this.menus.showSettings({
      quality: this.qualityIndex,
      time: this.lastTimeHour,
      weather: this.weather,
      camera: this.camera.mode,
      debug: this.debug.isVisible,
    });
  }

  /** コース選択画面を開く */
  openCircuits(): void {
    if (this.circuits.length === 0) {
      this.hud.prompt("走行可能な周回路が見つかりません", 2.5);
      return;
    }
    this.hud.setVisible(false);
    this.menus.showCircuits(
      this.circuits.map((c) => ({
        id: c.def.id,
        name: c.def.name,
        description: c.def.description,
        lengthKm: c.length / 1000,
        difficulty: c.def.difficulty,
        best: this.save.bestLap(c.def.id),
      }))
    );
  }

  /**
   * タイムトライアルを開始する。circuitId が null ならフリードライブ。
   *  車をスタートゲートへ置き、3 秒のカウントダウンから計測を始める。
   */
  startRace(circuitId: string | null): void {
    const circuit = circuitId ? this.circuits.find((c) => c.def.id === circuitId) ?? null : null;
    if (!circuit) {
      // フリードライブ: セッションを捨てて通常走行へ
      this.endRace(false);
      this.startDriving();
      return;
    }
    this.race = new RaceSession(circuit, 2, this.save.bestLap(circuit.def.id));
    this.raceMarkers.setCircuit(circuit);
    this.raceMarkers.setVisible(true);

    // 車をスタート位置へ
    const p = this.race.startPose;
    this.vehicle.teleport(p.x, p.z, p.heading);
    this.camera.snap(this.vehicle);

    this.menus.close();
    this.garage.close();
    this.stateMachine.transition("driving");
    this.hud.setVisible(true);
    this.hud.setDeviceHints(this.input);
    this.engineAudio.setActive(true);
    this.raceClock = 0;
    this.autopilot = false;
    this.hud.prompt(`${circuit.def.name} — 3 秒後にスタート`, 3);
  }

  /** セッションを破棄する。showResults はフィニッシュ時のみ */
  private endRace(showResults: boolean): void {
    const race = this.race;
    this.race = null;
    this.raceMarkers.setCircuit(null);
    this.raceMarkers.setVisible(false);
    this.hud.setRace(null);
    if (!race) return;
    if (showResults) this.showRaceResults(race);
  }

  /** フィニッシュ時のリザルト表示 */
  private showRaceResults(race: RaceSession): void {
    const res = race.result(this.save.bestLap(race.circuit.def.id));
    const prevBest = this.save.bestLap(race.circuit.def.id);
    const isRecord = isFinite(res.bestLap) && res.bestLap < prevBest;
    if (isRecord) this.save.submitLap(race.circuit.def.id, res.bestLap);
    this.save.recordFinish(race.circuit.def.id);
    this.stateMachine.transition("results");
    this.hud.setVisible(false);
    this.engineAudio.setActive(false);

    const lines: Array<[string, string]> = [
      ["周回", `${res.laps} / ${race.totalLaps}`],
      ["トータル", fmtLap(res.total)],
      ["ベストラップ", fmtLap(res.bestLap)],
    ];
    // ラップごとの記録(最大 6 周まで)
    for (const r of res.records.slice(0, 6)) {
      lines.push([`  LAP ${r.lap}`, fmtLap(r.time)]);
    }
    if (isFinite(res.bestDelta)) {
      lines.push(["前回ベストとの差", (res.bestDelta >= 0 ? "+" : "") + res.bestDelta.toFixed(3)]);
    }
    if (isRecord) lines.push(["", "★ NEW RECORD"]);
    lines.push(["走行距離", `${(res.distance / 1000).toFixed(2)} km`]);
    lines.push(["コースアウト", `${res.offRoadTime.toFixed(1)} 秒`]);

    this.menus.showResults({
      title: race.circuit.def.name,
      lines,
      onRestart: () => this.startRace(race.circuit.def.id),
    });
  }

  startDriving(): void {
    // ここへ来るのはフリードライブ。進行中のセッションは破棄する。
    this.endRace(false);
    this.menus.close();
    this.garage.close();
    this.stateMachine.transition("driving");
    this.hud.setVisible(true);
    this.hud.setDeviceHints(this.input);
    this.engineAudio.setActive(true);
    this.raceClock = 0;
    this.hud.prompt(`${this.currentCar.name} — ドライブ開始`, 3.2);
  }

  resume(): void {
    if (this.stateMachine.is("paused", "settings")) {
      this.stateMachine.transition("driving");
      this.menus.close();
      this.hud.setVisible(true);
    }
  }

  pause(): void {
    if (!this.stateMachine.is("driving")) return;
    this.stateMachine.transition("paused");
    this.hud.setVisible(false);
    this.menus.showPause({
      speed: Math.abs(this.vehicle.state.forwardSpeed) * 3.6,
      distance: this.vehicle.state.odometer / 1000,
      time: this.hudTimeString(),
      car: `${this.currentCar.maker} ${this.currentCar.name}`,
    });
  }

  private hudTimeString(): string {
    const h = Math.floor(this.lastTimeHour);
    const m = Math.floor((this.lastTimeHour - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  private selectCar(spec: CarSpec): void {
    if (spec.id === this.currentCar.id) {
      this.startDriving();
      return;
    }
    this.currentCar = spec;
    this.save.set("carId", spec.id);
    this.changeCar(spec);
    this.garage.close();
    this.startDriving();
  }

  private changeCar(spec: CarSpec): void {
    // 既存の車を破棄
    this.pipeline.scene.remove(this.carView.root);
    this.carView.dispose();
    this.carView = new CarView(spec, materialLibrary, { quality: 2 });
    this.pipeline.scene.add(this.carView.root);
    const prevHeading = this.vehicle.state.heading;
    const pos = this.vehicle.state.position.clone();
    this.vehicle = new Vehicle(spec, this.world.terrain, this.world.roads);
    this.vehicle.teleport(pos.x, pos.z, prevHeading);
    this.carView.root.position.copy(this.vehicle.state.position);
    this.blobShadow.scale.set(spec.dims.width * 1.5, 1, spec.dims.length * 1.15);
    this.camera.snap(this.vehicle);
    this.engineAudio.setSpec(spec);
  }

  private rescueVehicle(): void {
    this.vehicle.rescue();
    this.camera.snap(this.vehicle);
    this.hud.prompt("コースへ戻しました", 2);
    this.resume();
  }

  togglePhotoMode(): void {
    if (!this.stateMachine.is("driving", "photo")) return;
    this.photoMode = !this.photoMode;
    if (this.photoMode) {
      this.stateMachine.transition("photo");
      this.hud.prompt("フォトモード: ドラッグで回転 / ホイールでズーム / F で戻る", 4);
      this.camera.setMode("photo");
    } else {
      this.stateMachine.transition("driving");
      this.camera.setMode("chase");
    }
  }

  private setCamera(mode: string): void {
    if (mode === "__cycle__") {
      const m = this.camera.cycle();
      this.hud.prompt(`カメラ: ${m}`, 1.6);
      return;
    }
    this.camera.setMode(mode as CameraMode);
  }

  private setQuality(i: number): void {
    this.qualityIndex = clamp(i, 0, 3);
    this.save.set("quality", this.qualityIndex);
    this.scaler.setTier(this.qualityIndex);
    this.world.setQuality(this.qualityIndex);
    this.particles.setDensity(QUALITY_PRESETS[this.qualityIndex].particles);
    const preset = QUALITY_PRESETS[this.qualityIndex];
    this.post.applyPreset(preset);
    this.pipeline.renderer.shadowMap.enabled = true;
    this.world.sky.sunLight.castShadow = preset.shadowMapSize > 0;
    this.openSettings();
  }

  private setTime(hour: number): void {
    this.lastTimeHour = hour;
    this.world.sky.setHour(hour);
    this.save.set("hour", hour);
    this.updateEnvMap(true);
  }

  private setWeather(w: typeof this.weather, instant = false): void {
    this.weather = w;
    this.world.sky.setWeather(w, instant);
    this.save.set("weather", w);
    if (!instant) this.hud.prompt(`天候: ${w === "clear" ? "晴れ" : w === "cloudy" ? "曇り" : w === "rain" ? "雨" : "嵐"}`, 2);
    this.particles.updateRain(0, this.vehicle.state.position, 0, new THREE.Vector3());
  }

  private updateEnvMap(force = false): void {
    const sky = this.world.sky;
    const zenith = (sky as unknown as { material: THREE.ShaderMaterial }).material.uniforms.uZenith.value as THREE.Color;
    const horizon = (sky as unknown as { material: THREE.ShaderMaterial }).material.uniforms.uHorizon.value as THREE.Color;
    const sun = sky.sunLight.color;
    const dir = sky.sunDirection();
    const tex = this.env.get("day", { zenith, horizon, sun, sunDir: dir, exposure: 1 }, force);
    this.pipeline.scene.environment = tex;
    materialLibrary.applyEnvMap(tex);
    this.carView.body.paint.envMap = tex;
    this.carView.body.paint.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- */
  /* メインループ                                                     */
  /* ---------------------------------------------------------------- */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(loop);
      this.frame();
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
  }

  private frame(): void {
    const rawDt = this.clock.getDelta();
    const dt = clamp(rawDt, 0.0005, 0.05);
    this.elapsed += dt;

    // --- 入力 ---
    const snap = this.input.poll(dt, this.vehicle.speedKmh);
    this.handleGlobalInput(snap);

    const simulating = this.stateMachine.is("driving", "photo");
    const paused = !simulating;

    // --- 物理(固定ステップ) ---
    if (!paused && !this.photoMode) {
      this.accumulator += dt;
      let steps = 0;
      const maxSteps = 8;
      // カウントダウン中は入力を殺す(フライング防止)
      const locked = this.race?.state === "countdown";
      const input = {
        steer: locked ? 0 : snap.steer,
        throttle: locked ? 0 : snap.throttle,
        brake: locked ? 1 : snap.brake,
        handbrake: locked ? 1 : snap.handbrake,
        shiftUp: locked ? false : snap.pressed.has("shiftUp"),
        shiftDown: locked ? false : snap.pressed.has("shiftDown"),
        autoGear: true,
      };
      while (this.accumulator >= PHYSICS_DT && steps < maxSteps) {
        if (this.autopilot) {
          const ap = this.computeAutopilot();
          input.steer = ap.steer;
          input.throttle = ap.throttle;
          input.brake = ap.brake;
        }
        this.vehicle.step(input, PHYSICS_DT);
        this.accumulator -= PHYSICS_DT;
        steps++;
      }
      if (steps === maxSteps) this.accumulator = 0;
      this.raceClock += dt;
    }

    // --- 車体のビジュアル同期 ---
    const night = this.world.sky.isNight;
    this.carView.sync(this.vehicle, dt, {
      night,
      lightsOn: this.lightsOn,
      wetness: this.wetness,
      dust: this.dust,
    });
    this.carView.updateBrakeLights(snap.brake);

    // 接地影
    const groundY = this.world.terrain.heightAt(this.vehicle.state.position.x, this.vehicle.state.position.z);
    this.shadowY = damp(this.shadowY, groundY + 0.06, 14, dt);
    this.blobShadow.position.set(this.vehicle.state.position.x, this.shadowY, this.vehicle.state.position.z);
    this.blobShadow.rotation.y = this.vehicle.state.heading;
    const airH = clamp01((this.vehicle.state.position.y - groundY) / 6);
    (this.blobShadow.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - airH * 0.75);

    // --- カメラ ---
    this.camera.updateLookBack(snap.held.has("lookBack"), dt);
    if (!this.photoMode) {
      this.camera.update(this.vehicle, dt, snap.held.has("lookBack"));
    } else {
      this.camera.update(this.vehicle, dt, false);
    }
    if (this.vehicle.impactStrength > 1.5) {
      this.camera.addShake(clamp01(this.vehicle.impactStrength * 0.05));
      this.vehicle.clearImpact();
    }

    // --- パーティクル ---
    this.emitTireParticles(dt);
    this.particles.setPixelRatio(this.pipeline.renderer.getPixelRatio());
    const rainIntensity = this.weather === "rain" ? 0.55 : this.weather === "storm" ? 1.0 : 0;
    const fwd = this.vehicle.forward();
    this.particles.updateRain(dt, this.vehicle.state.position, rainIntensity, fwd);
    this.particles.update(dt, this.pipeline.camera.position);

    // --- タイムトライアル ---
    this.updateRace(dt, paused || this.photoMode);

    // --- ワールド ---
    this.world.update(dt, this.pipeline.camera, this.vehicle.state.position, this.qualityIndex, this.elapsed);

    // 天候の遷移(濡れ・汚れ)
    const targetWet = this.weather === "rain" ? 0.85 : this.weather === "storm" ? 1 : 0;
    this.wetness = damp(this.wetness, targetWet, 0.22, dt);
    const onDirt = this.vehicle.state.surfaceLabel === "砂" || this.vehicle.state.surfaceLabel === "ダート" ? 1 : 0;
    this.dust = damp(this.dust, onDirt * 0.7, 0.12, dt);

    // --- 描画 ---
    const stats2 = this.scaler.update(dt);
    this.updatePostSettings(stats2);
    this.post.setSize(this.pipeline.renderer.domElement.width, this.pipeline.renderer.domElement.height, 1);
    this.post.renderScene(this.pipeline.scene, this.pipeline.camera);
    const speedNorm = clamp01(Math.abs(this.vehicle.state.forwardSpeed) / 70);
    this.post.present(dt, speedNorm * (this.vehicle.isDrifting ? 220 : 90));

    this.pipeline.renderer.info.reset();
    const stats = this.pipeline.tick();

    // --- UI ---
    if (this.stateMachine.is("driving", "photo")) {
      this.hud.setVisible(!this.photoMode);
      this.hud.setDeviceHints(this.input);
      this.hud.update(this.vehicle, dt, this.lastTimeHour, {});
    }
    this.debug.update(stats, [
      { label: "Quality", value: `${this.scaler.label} / ${this.scaler.autoLabel}` },
      { label: "Speed", value: `${this.vehicle.speedKmh.toFixed(0)} km/h` },
      { label: "Surface", value: `${this.vehicle.state.surfaceLabel} μ${this.vehicle.state.surfaceMu.toFixed(2)}` },
      { label: "Pos", value: `${this.vehicle.state.position.x.toFixed(0)}, ${this.vehicle.state.position.z.toFixed(0)}` },
      { label: "Chunks", value: String(this.world.getStats().chunks) },
      { label: "Device", value: this.input.currentDevice },
    ]);

    // --- オーディオ ---
    this.engineAudio.update(this.vehicle, dt);
    this.ambient.update(dt, this.vehicle);
  }

  private handleGlobalInput(snap: ReturnType<InputManager["poll"]>): void {
    // ポーズ
    if (snap.pressed.has("pause")) {
      if (this.stateMachine.is("driving", "photo")) this.pause();
      else if (this.stateMachine.is("paused")) this.resume();
      else if (this.menus.isOpen) this.menus.close();
    }
    // カメラ切替
    if (snap.pressed.has("camera") && this.stateMachine.is("driving")) {
      const m = this.camera.cycle();
      this.hud.prompt(`カメラ: ${m}`, 1.5);
    }
    // ライト
    if (snap.pressed.has("lights") && this.stateMachine.is("driving")) {
      this.lightsOn = !this.lightsOn;
      this.hud.prompt(this.lightsOn ? "ライト ON" : "ライト OFF", 1.5);
    }
    // リセット
    if (snap.pressed.has("reset") && this.stateMachine.is("driving")) {
      this.rescueVehicle();
    }
    // マップ
    if (snap.pressed.has("map") && this.stateMachine.is("driving")) {
      this.stateMachine.transition("map");
      this.worldMap.open(this.vehicle.state.position);
      this.hud.setVisible(false);
    } else if (snap.pressed.has("map") && this.stateMachine.is("map")) {
      this.worldMap.close();
      this.stateMachine.transition("driving");
    }
    // フォト
    if (snap.pressed.has("photo") && this.stateMachine.is("driving")) {
      this.togglePhotoMode();
    }
    // オートパイロット
    if (snap.pressed.has("autopilot") && this.stateMachine.is("driving")) {
      this.autopilot = !this.autopilot;
      this.hud.prompt(this.autopilot ? "自動走行 ON" : "自動走行 OFF", 1.8);
    }
  }

  private emitTireParticles(dt: number): void {
    const v = this.vehicle;
    if (!v.state.grounded) return;
    const surface = v.state.surfaceLabel;
    const kind =
      surface === "砂" ? "sand" : surface === "ダート" ? "dirt" : surface === "草地" ? "grass" : surface === "水" ? "water" : "paved";
    const fwd = v.forward();
    const speed = Math.abs(v.state.forwardSpeed);
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      if (!w.grounded) continue;
      const smoke = w.smoke;
      if (smoke > 0.1) {
        this.particles.emitTireSmoke(
          w.world.x,
          w.world.y,
          w.world.z,
          smoke * (0.6 + clamp01(speed / 40)),
          kind as "paved" | "dirt" | "sand" | "grass" | "water",
          fwd,
          speed
        );
      }
    }
    if (this.vehicle.impactStrength > 2) {
      this.particles.emitSparks(
        this.vehicle.state.position.x,
        this.vehicle.state.position.y + 0.5,
        this.vehicle.state.position.z,
        8,
        clamp01(this.vehicle.impactStrength / 12)
      );
      this.vehicle.clearImpact();
    }
    void dt;
  }

  private computeAutopilot(): { steer: number; throttle: number; brake: number } {
    const v = this.vehicle;
    const q = this.world.roads.nearest(v.state.position.x, v.state.position.z);
    if (!q.road) return { steer: 0, throttle: 0.35, brake: 0 };
    const lookAhead = 12 + Math.abs(v.state.forwardSpeed) * 0.7;
    const target = q.road.pointAt(q.s + lookAhead, 0);
    const dx = target.x - v.state.position.x;
    const dz = target.z - v.state.position.z;
    const targetHeading = Math.atan2(dx, dz);
    let diff = targetHeading - v.state.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const steer = clamp(diff * 1.8, -1, 1);
    // カーブの曲率から目標速度
    const sm = q.road.sampleAtS(q.s + lookAhead);
    const curv = Math.abs(sm.curvature);
    const targetSpeed = clamp(Math.sqrt(1.4 / Math.max(0.0004, curv)), 14, 82);
    const curSpeed = Math.abs(v.state.forwardSpeed);
    const throttle = curSpeed < targetSpeed - 2 ? 0.85 : 0.12;
    const brake = curSpeed > targetSpeed + 3 ? 0.55 : 0;
    return { steer, throttle, brake };
  }

  /**
   * タイムトライアルの進行。
   *  ポーズ/フォトモード中はラップタイマーを止めるので、
   *  セッションへ渡す lapTime は自前で積む。
   */
  private updateRace(dt: number, frozen: boolean): void {
    const race = this.race;
    if (!race) return;
    const pos = this.vehicle.state.position;
    const onRoad = this.world.roads.nearest(pos.x, pos.z).onRoad;

    if (race.isActive) {
      // ポーズ中は dt=0 を渡してタイマーを止める
      race.update(pos.x, pos.z, onRoad, frozen ? 0 : dt);
      // カウントダウン中は車を止める(アクセルを踏ませない)
      if (race.state === "countdown") {
        this.vehicle.state.velocity.set(0, 0, 0);
        this.vehicle.state.forwardSpeed = 0;
        this.vehicle.state.lateralSpeed = 0;
      }
    } else if (race.isFinished) {
      this.endRace(true);
      return;
    }

    // マーカーと HUD
    this.raceMarkers.update(dt, race.nextGate);
    const countdownText =
      race.state === "countdown" ? (race.countdown > 0 ? String(Math.ceil(race.countdown)) : "GO") : null;
    const best = isFinite(race.bestLap) && race.records.length > 0 ? race.bestLap : this.save.bestLap(race.circuit.def.id);
    this.hud.setRace({
      lap: race.lap,
      totalLaps: race.totalLaps,
      time: race.lapTime,
      best,
      delta: race.lastSplitDelta !== 0 ? (race.lastSplitDelta >= 0 ? "+" : "") + race.lastSplitDelta.toFixed(3) : "",
      countdown: countdownText,
      state: race.state === "finished" ? "finished" : race.state === "running" ? "running" : "countdown",
    });
  }

  private updatePostSettings(scaler: ReturnType<QualityScaler["update"]>): void {
    const preset = QUALITY_PRESETS[this.qualityIndex];
    const night = this.world.sky.isNight;
    const nightFactor = night ? 1 : clamp01(1 - this.world.sky.sunElevation * 3);
    this.post.setSettings({
      exposure: this.world.sky.exposure * (this.photoMode ? 1.15 : 1),
      bloom: preset.bloom,
      bloomStrength: night ? 1.05 : 0.68,
      bloomThreshold: night ? 0.62 : 0.88,
      motionBlur: preset.motionBlur && !this.photoMode,
      motionBlurAmount: clamp01(Math.abs(this.vehicle.state.forwardSpeed) / 55) * 0.55,
      dof: preset.dof || this.photoMode,
      dofFocus: 14,
      dofAperture: this.photoMode ? 1.6 : 0.7,
      vignette: 0.36,
      saturation: night ? 0.92 : 1.08,
      contrast: 1.05,
      colorTemp: night ? -0.35 : this.world.sky.sunElevation < 0.25 ? 0.28 : 0.05,
      chromatic: 0.2,
      grain: 0.03,
      damageFlash: 0,
      nightTint: night ? 0.55 : nightFactor * 0.2,
    });
    void scaler;
  }

  private onResize(): void {
    this.post.setSize(this.pipeline.renderer.domElement.width, this.pipeline.renderer.domElement.height, 1);
  }

  dispose(): void {
    this.stop();
    this.input.dispose();
    this.hud.dispose();
    this.menus.dispose();
    this.garage.dispose();
    this.worldMap.dispose();
    this.debug.dispose();
    this.particles.dispose();
    this.env.dispose();
    this.post.dispose();
    this.carView.dispose();
    this.world.dispose();
    this.pipeline.dispose();
  }

  get vehicleRef(): Vehicle {
    return this.vehicle;
  }

  get carSpec(): CarSpec {
    return this.currentCar;
  }
}

/** mm:ss.mmm 形式。Result 画面用。 */
function fmtLap(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const sec = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
}
