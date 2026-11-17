/**
 * ui/Hud.ts
 * 責務: 走行中の HUD(スピード/タコメーター/ギア/ミニマップ/順位/ラップ/サーフェス/アシスト表示)
 * 公開API: Hud
 * 依存: physics/Vehicle.ts, world/Road.ts, world/Terrain.ts, input/InputManager.ts
 *
 * 設計メモ:
 *  - DOM + Canvas 2D で描画(Three.js の負荷を増やさない)。
 *  - タコメーターは Canvas に毎フレーム描画。スピードは数字のみ(読みやすさ優先)。
 *  - ミニマップは道路網を事前に Canvas へ描き、自車位置だけ描き直す。
 *  - デバイスに応じてボタン表示を切り替える。
 */
import { formatTime } from "../race/Circuit.js";
import { Vehicle } from "../physics/Vehicle.js";
import { RoadNetwork } from "../world/Road.js";
import { Terrain } from "../world/Terrain.js";
import { WORLD, SETTLEMENTS, LANDMARKS } from "../world/WorldConfig.js";
import { clamp, clamp01, lerp, TAU } from "../core/math.js";
import { InputManager } from "../input/InputManager.js";

export interface HudOptions {
  showMinimap?: boolean;
  showTach?: boolean;
}

export class Hud {
  readonly root: HTMLDivElement;
  private speedEl: HTMLDivElement;
  private gearEl: HTMLDivElement;
  private surfaceEl: HTMLDivElement;
  private tachCanvas: HTMLCanvasElement;
  private tachCtx: CanvasRenderingContext2D;
  private mapCanvas: HTMLCanvasElement;
  private mapCtx: CanvasRenderingContext2D;
  private mapBase: HTMLCanvasElement | null = null;
  private timeEl: HTMLDivElement;
  private posEl: HTMLDivElement;
  // --- レース計測パネル ---
  private raceEl: HTMLDivElement;
  private raceLapEl: HTMLDivElement;
  private raceTimeEl: HTMLDivElement;
  private raceBestEl: HTMLDivElement;
  private raceDeltaEl: HTMLDivElement;
  private raceCountEl: HTMLDivElement;
  private driftEl: HTMLDivElement;
  private assistEl: HTMLDivElement;
  private batteryEl: HTMLDivElement;
  private promptEl: HTMLDivElement;
  private roads: RoadNetwork | null = null;
  private terrain: Terrain | null = null;
  private timeAcc = 0;
  private tachVisible = true;
  private minimapVisible = true;
  private mapZoom = 1;
  private lastPrompt = "";
  private promptTimer = 0;
  private driftScore = 0;
  private driftTimer = 0;
  private driftBest = 0;

  constructor(parent: HTMLElement, options: HudOptions = {}) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:15;font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.7);";
    this.root.innerHTML = `
      <div class="hud-speed" style="position:absolute;right:4.5%;bottom:5%;display:flex;align-items:flex-end;gap:10px;">
        <div id="hud-gear" style="font-size:clamp(20px,3vw,34px);font-weight:800;color:#ffb066;min-width:1.6em;text-align:center;letter-spacing:-0.02em;padding-bottom:6px">1</div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;line-height:0.92">
          <div id="hud-speed" style="font-size:clamp(42px,7.5vw,86px);font-weight:800;letter-spacing:-0.04em;font-variant-numeric:tabular-nums">0</div>
          <div style="font-size:clamp(9px,1.2vw,12px);letter-spacing:0.28em;color:#9fb0be;font-weight:700">KM/H</div>
        </div>
      </div>
      <canvas id="hud-tach" width="360" height="360" style="position:absolute;right:2.2%;bottom:2%;width:clamp(120px,17vw,186px);height:clamp(120px,17vw,186px);opacity:0.96"></canvas>
      <div style="position:absolute;left:3%;top:3.5%;display:flex;flex-direction:column;gap:6px;font-size:clamp(10px,1.15vw,13px)">
        <div id="hud-surface" style="font-weight:700;letter-spacing:0.12em;color:#cfe0ea">舗装路</div>
        <div id="hud-time" style="color:#8fa3b2;font-variant-numeric:tabular-nums">16:30</div>
      </div>
      <div id="hud-prompt" style="position:absolute;left:50%;top:62%;transform:translateX(-50%);font-size:clamp(12px,1.5vw,16px);background:rgba(8,12,16,0.72);padding:8px 16px;border-radius:6px;opacity:0;transition:opacity .28s;border:1px solid rgba(255,160,80,0.35);white-space:nowrap"></div>
      <div id="hud-drift" style="position:absolute;left:50%;top:16%;transform:translateX(-50%);text-align:center;opacity:0;transition:opacity .2s">
        <div style="font-size:clamp(11px,1.3vw,13px);letter-spacing:0.3em;color:#ffb066;font-weight:800">DRIFT</div>
        <div id="hud-drift-score" style="font-size:clamp(22px,3.6vw,40px);font-weight:800;font-variant-numeric:tabular-nums">0</div>
      </div>
      <canvas id="hud-map" width="360" height="360" style="position:absolute;left:2.4%;bottom:3.2%;width:clamp(110px,14vw,158px);height:clamp(110px,14vw,158px);border-radius:50%;opacity:0.9"></canvas>
      <div id="hud-assist" style="position:absolute;left:50%;bottom:3%;transform:translateX(-50%);display:flex;gap:6px;font-size:10px;letter-spacing:0.1em;opacity:0.75"></div>
      <div id="hud-pos" style="position:absolute;right:3%;top:3.5%;font-size:clamp(10px,1.1vw,12px);color:#9fb0be;text-align:right;line-height:1.5"></div>
      <div id="hud-race" style="position:absolute;left:50%;top:2.6%;transform:translateX(-50%);display:none;flex-direction:column;align-items:center;gap:2px;background:linear-gradient(180deg,rgba(8,12,16,0.78),rgba(8,12,16,0.28));padding:8px 22px 10px;border-radius:10px;border:1px solid rgba(255,160,80,0.28)">
        <div id="hud-race-lap" style="font-size:clamp(9px,1.05vw,11px);letter-spacing:0.28em;color:#9fb0be;font-weight:800">LAP 1/2</div>
        <div id="hud-race-time" style="font-size:clamp(20px,3vw,32px);font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;line-height:1.05">00:00.000</div>
        <div style="display:flex;gap:14px;font-size:clamp(9px,1.05vw,11px);font-variant-numeric:tabular-nums;align-items:baseline">
          <span style="color:#8fa3b2">BEST <b id="hud-race-best" style="color:#ffb066;font-weight:800">--:--.---</b></span>
          <span id="hud-race-delta" style="font-weight:800;color:#7ad8ff"></span>
        </div>
        <div id="hud-race-count" style="position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:10px;font-size:clamp(38px,7vw,76px);font-weight:900;color:#ff8a3d;text-shadow:0 2px 18px rgba(0,0,0,0.6);display:none;font-variant-numeric:tabular-nums"></div>
      </div>
    `;
    parent.appendChild(this.root);

    this.speedEl = this.root.querySelector("#hud-speed")!;
    this.gearEl = this.root.querySelector("#hud-gear")!;
    this.surfaceEl = this.root.querySelector("#hud-surface")!;
    this.timeEl = this.root.querySelector("#hud-time")!;
    this.promptEl = this.root.querySelector("#hud-prompt")!;
    this.driftEl = this.root.querySelector("#hud-drift")!;
    this.posEl = this.root.querySelector("#hud-pos")!;
    this.raceEl = this.root.querySelector("#hud-race")!;
    this.raceLapEl = this.root.querySelector("#hud-race-lap")!;
    this.raceTimeEl = this.root.querySelector("#hud-race-time")!;
    this.raceBestEl = this.root.querySelector("#hud-race-best")!;
    this.raceDeltaEl = this.root.querySelector("#hud-race-delta")!;
    this.raceCountEl = this.root.querySelector("#hud-race-count")!;
    this.assistEl = this.root.querySelector("#hud-assist")!;
    this.batteryEl = this.root.querySelector("#hud-drift-score")!;
    this.tachCanvas = this.root.querySelector("#hud-tach")!;
    this.tachCtx = this.tachCanvas.getContext("2d")!;
    this.mapCanvas = this.root.querySelector("#hud-map")!;
    this.mapCtx = this.mapCanvas.getContext("2d")!;
    this.tachVisible = options.showTach ?? true;
    this.minimapVisible = options.showMinimap ?? true;
    this.tachCanvas.style.display = this.tachVisible ? "block" : "none";
    this.mapCanvas.style.display = this.minimapVisible ? "block" : "none";
  }

  setWorld(roads: RoadNetwork, terrain: Terrain): void {
    this.roads = roads;
    this.terrain = terrain;
    this.buildMinimapBase();
  }

  /** ミニマップのベース(道路網)を一度だけ描く */
  private buildMinimapBase(): void {
    if (!this.roads) return;
    const size = 512;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(10,16,20,0.72)";
    ctx.fillRect(0, 0, size, size);

    // 海(低地)をざっくり塗る
    if (this.terrain) {
      const step = 16;
      for (let y = 0; y < size; y += step) {
        for (let x = 0; x < size; x += step) {
          const wx = (x / size) * WORLD.size - WORLD.half;
          const wz = (y / size) * WORLD.size - WORLD.half;
          const h = this.terrain.rawHeight(wx, wz);
          if (h < 1) {
            ctx.fillStyle = "rgba(30,58,78,0.85)";
            ctx.fillRect(x, y, step, step);
          } else if (h > 600) {
            ctx.fillStyle = "rgba(64,60,58,0.6)";
            ctx.fillRect(x, y, step, step);
          }
        }
      }
    }

    // 道路
    for (const road of this.roads.roads) {
      ctx.beginPath();
      road.samples.forEach((s, i) => {
        const x = ((s.x + WORLD.half) / WORLD.size) * size;
        const y = ((s.z + WORLD.half) / WORLD.size) * size;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      const cls = road.style.cls;
      ctx.strokeStyle =
        cls === "highway" ? "rgba(255,190,110,0.95)" : cls === "arterial" ? "rgba(230,225,200,0.8)" : cls === "dirt" ? "rgba(190,150,100,0.8)" : "rgba(210,210,210,0.75)";
      ctx.lineWidth = cls === "highway" ? 3 : cls === "arterial" ? 2 : 1.4;
      ctx.stroke();
    }

    // 集落
    for (const s of SETTLEMENTS) {
      const x = ((s.x + WORLD.half) / WORLD.size) * size;
      const y = ((s.z + WORLD.half) / WORLD.size) * size;
      ctx.beginPath();
      ctx.arc(x, y, s.kind === "city" ? 7 : s.kind === "town" ? 5 : 3.4, 0, TAU);
      ctx.fillStyle = s.kind === "city" ? "#ffb066" : "#ffe6c0";
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const lm of LANDMARKS) {
      const x = ((lm.x + WORLD.half) / WORLD.size) * size;
      const y = ((lm.z + WORLD.half) / WORLD.size) * size;
      ctx.beginPath();
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x + 4.5, y + 4);
      ctx.lineTo(x - 4.5, y + 4);
      ctx.closePath();
      ctx.fillStyle = "#7ad8ff";
      ctx.fill();
    }
    this.mapBase = c;
  }

  /** プロンプト表示(数秒で消える) */
  /**
   * レース計測パネルを更新する。null で非表示(フリードライブ)。
   *  @param info lap 表示 / time ラップタイム / best ベストラップ
   *              / delta 区間差分テキスト / countdown カウントダウン表示
   */
  setRace(
    info: {
      lap: number;
      totalLaps: number;
      time: number;
      best: number;
      delta: string;
      countdown: string | null;
      state: "countdown" | "running" | "finished";
    } | null
  ): void {
    if (!info) {
      this.raceEl.style.display = "none";
      return;
    }
    if (this.raceEl.style.display !== "flex") this.raceEl.style.display = "flex";
    this.raceLapEl.textContent = `LAP ${Math.min(info.lap, info.totalLaps)}/${info.totalLaps}`;
    this.raceTimeEl.textContent = formatTime(info.time);
    this.raceBestEl.textContent = isFinite(info.best) ? formatTime(info.best) : "--:--.---";
    this.raceDeltaEl.textContent = info.delta;
    this.raceDeltaEl.style.color = info.delta.startsWith("-") ? "#7ce8a0" : "#ff8a6a";
    if (info.countdown) {
      this.raceCountEl.style.display = "block";
      this.raceCountEl.textContent = info.countdown;
      const n = Number(info.countdown);
      this.raceCountEl.style.color = n > 0 ? "#ff8a3d" : "#7ce8a0";
      this.raceCountEl.style.fontSize = n > 0 ? "clamp(38px,7vw,76px)" : "clamp(30px,5.6vw,62px)";
    } else {
      this.raceCountEl.style.display = "none";
    }
  }

  prompt(text: string, duration = 3): void {
    if (this.lastPrompt === text && this.promptTimer > 0) {
      this.promptTimer = Math.max(this.promptTimer, duration);
      return;
    }
    this.lastPrompt = text;
    this.promptTimer = duration;
    this.promptEl.textContent = text;
    this.promptEl.style.opacity = "1";
  }

  setDeviceHints(input: InputManager): void {
    const device = input.currentDevice;
    const hints =
      device === "gamepad"
        ? ["RT アクセル", "LT ブレーキ", "Lスティック ステア", "Start ポーズ"]
        : device === "touch"
          ? ["右ペダル", "左ペダル", "ホイール", "右上 ポーズ"]
          : ["W アクセル", "S ブレーキ", "A/D ステア", "Esc ポーズ"];
    this.assistEl.innerHTML = hints
      .map((h) => `<span style="background:rgba(8,12,16,0.6);padding:3px 7px;border-radius:4px;border:1px solid rgba(255,255,255,0.12)">${h}</span>`)
      .join("");
  }

  setAssistText(text: string): void {
    this.assistEl.innerHTML = `<span style="background:rgba(8,12,16,0.6);padding:3px 7px;border-radius:4px;border:1px solid rgba(255,255,255,0.12)">${text}</span>`;
  }

  /** 毎フレーム更新 */
  update(vehicle: Vehicle, dt: number, timeHour: number, extra: { driftEnabled?: boolean; mapZoom?: number } = {}): void {
    // プロンプトのフェード
    if (this.promptTimer > 0) {
      this.promptTimer -= dt;
      if (this.promptTimer <= 0) this.promptEl.style.opacity = "0";
    }

    // 速度(数字は間引いて更新: ちらつき防止)
    this.timeAcc += dt;
    const speed = Math.round(vehicle.displaySpeed);
    this.speedEl.textContent = String(speed);
    const gear = vehicle.state.gear;
    this.gearEl.textContent = gear === 0 ? "N" : gear < 0 ? "R" : String(gear);
    this.gearEl.style.color = vehicle.state.rpm > vehicle.spec.engine.redline * 0.92 ? "#ff5a4a" : "#ffb066";

    if (this.timeAcc > 0.08) {
      this.timeAcc = 0;
      this.surfaceEl.textContent = vehicle.state.surfaceLabel;
      const h = Math.floor(timeHour);
      const m = Math.floor((timeHour - h) * 60);
      this.timeEl.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      // 位置の説明
      const pos = this.describeLocation(vehicle);
      this.posEl.textContent = pos;
    }

    // ドリフトスコア
    if (vehicle.isDrifting) {
      this.driftTimer += dt;
      this.driftScore += Math.abs(vehicle.driftAngleRad) * vehicle.speedKmh * dt * 0.55;
      this.driftEl.style.opacity = "1";
      this.batteryEl.textContent = String(Math.round(this.driftScore));
    } else if (this.driftTimer > 0) {
      if (this.driftTimer > 0.6) {
        this.driftBest = Math.max(this.driftBest, this.driftScore);
        this.driftScore = 0;
        this.driftTimer = 0;
        this.driftEl.style.opacity = "0";
      }
    }

    if (this.tachVisible) this.drawTach(vehicle);
    if (this.minimapVisible) this.drawMinimap(vehicle, extra.mapZoom ?? 1);
  }

  private describeLocation(vehicle: Vehicle): string {
    if (!this.roads) return "";
    const s = vehicle.state.position;
    const q = this.roads.nearest(s.x, s.z);
    let nearest = "";
    let nd = Infinity;
    for (const st of SETTLEMENTS) {
      const d = Math.hypot(st.x - s.x, st.z - s.z);
      if (d < nd) {
        nd = d;
        nearest = st.name;
      }
    }
    const roadName = q.road && q.distance < 60 ? q.road.name : "";
    const line1 = roadName ? roadName : nearest;
    const dist = nd > 1000 ? `${(nd / 1000).toFixed(1)} km` : `${Math.round(nd)} m`;
    return `${line1}\n${nearest} まで ${dist}\n${(s.y).toFixed(0)} m`;
  }

  /** タコメーター */
  private drawTach(vehicle: Vehicle): void {
    const ctx = this.tachCtx;
    const W = this.tachCanvas.width;
    const H = this.tachCanvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = W * 0.42;
    ctx.clearRect(0, 0, W, H);

    const e = vehicle.spec.engine;
    const rpm = vehicle.state.rpm;
    const maxRpm = e.redline * 1.06;
    const startAngle = Math.PI * 0.75;
    const endAngle = Math.PI * 2.25;

    // 背景
    ctx.beginPath();
    ctx.arc(cx, cy, R + 8, 0, TAU);
    ctx.fillStyle = "rgba(8,12,16,0.42)";
    ctx.fill();

    // レッドゾーン
    const redStart = startAngle + ((e.redline * 0.94) / maxRpm) * (endAngle - startAngle);
    ctx.beginPath();
    ctx.arc(cx, cy, R, redStart, endAngle);
    ctx.strokeStyle = "rgba(255,60,40,0.55)";
    ctx.lineWidth = 12;
    ctx.stroke();

    // 目盛り
    const ticks = 8;
    for (let i = 0; i <= ticks; i++) {
      const a = startAngle + (i / ticks) * (endAngle - startAngle);
      const inner = R - 16;
      const outer = R - 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      ctx.stroke();
      // 数字
      const label = String(Math.round(((i / ticks) * maxRpm) / 1000));
      ctx.fillStyle = "rgba(210,225,235,0.55)";
      ctx.font = `600 ${Math.round(W * 0.052)}px ui-monospace,monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx + Math.cos(a) * (R - 34), cy + Math.sin(a) * (R - 34));
    }

    // 回転数のアーク
    const ang = startAngle + clamp01(rpm / maxRpm) * (endAngle - startAngle);
    ctx.beginPath();
    ctx.arc(cx, cy, R, startAngle, ang);
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#59d0ff");
    grad.addColorStop(0.55, "#ffd166");
    grad.addColorStop(1, "#ff4b3a");
    ctx.strokeStyle = rpm > e.redline * 0.9 ? "#ff4b3a" : grad;
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.stroke();

    // 針
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(-R * 0.1, 0);
    ctx.lineTo(R * 0.78, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // 中央の数字
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${Math.round(W * 0.1)}px ui-monospace,monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(Math.round(rpm)), cx, cy + R * 0.24);
    ctx.font = `600 ${Math.round(W * 0.042)}px ui-monospace,monospace`;
    ctx.fillStyle = "rgba(180,200,215,0.7)";
    ctx.fillText("RPM", cx, cy + R * 0.42);
  }

  /** ミニマップ(自車中心の回転マップ) */
  private drawMinimap(vehicle: Vehicle, zoom: number): void {
    if (!this.mapBase) return;
    const ctx = this.mapCtx;
    const W = this.mapCanvas.width;
    const H = this.mapCanvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const scale = 5.4 * zoom; // 1m = scale px
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 2, 0, TAU);
    ctx.clip();
    ctx.fillStyle = "rgba(8,14,18,0.62)";
    ctx.fillRect(0, 0, W, H);

    const s = vehicle.state.position;
    const heading = vehicle.state.heading;

    // 回転して自車が上を向くように
    ctx.translate(cx, cy);
    ctx.rotate(heading);
    const mapSize = this.mapBase.width;
    const px = ((s.x + WORLD.half) / WORLD.size) * mapSize;
    const py = ((s.z + WORLD.half) / WORLD.size) * mapSize;
    // マップ画像の縮尺を合わせる
    const mapScale = (WORLD.size / mapSize) * scale;
    ctx.scale(1, 1);
    ctx.globalAlpha = 0.95;
    ctx.drawImage(this.mapBase, -px * mapScale, -py * mapScale, mapSize * mapScale, mapSize * mapScale);
    ctx.restore();

    // 自車マーカー
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 4);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fillStyle = "#ff8a3d";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    // 外周のリング
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 2, 0, TAU);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }

  /** 表示/非表示 */
  setVisible(v: boolean): void {
    this.root.style.display = v ? "block" : "none";
  }

  toggleTach(): void {
    this.tachVisible = !this.tachVisible;
    this.tachCanvas.style.display = this.tachVisible ? "block" : "none";
  }

  toggleMinimap(): void {
    this.minimapVisible = !this.minimapVisible;
    this.mapCanvas.style.display = this.minimapVisible ? "block" : "none";
  }

  setMapZoom(z: number): void {
    this.mapZoom = clamp(z, 0.5, 3);
  }

  get currentDriftScore(): number {
    return Math.round(this.driftScore);
  }

  dispose(): void {
    this.root.remove();
  }
}
