/**
 * ui/Garage.ts
 * 責務: 車の選択・塗装/ホイール変更・スペック表示のショールーム UI
 * 公開API: Garage
 * 依存: car/spec/CarSpec.ts, car/materials/CarMaterials.ts, core/math.ts
 *
 * 設計メモ:
 *  - 3D のプレビューは別 Canvas(専用の小さいレンダラー)で行い、ゲーム本体の描画に干渉しない。
 *  - 車の一覧はカード形式。選択でプレビューが即座に切り替わる。
 *  - 塗装色・仕上げ・ホイールの変更は、その場でマテリアルへ反映する。
 */
import * as THREE from "three";
import { CARS, CarSpec, PAINT_FINISHES, TIER_COLORS, STYLE_LABELS, carStats, PaintFinish } from "../car/spec/CarSpec.js";
import { CarMaterialLibrary, FINISH_PRESETS } from "../car/materials/CarMaterials.js";
import { buildBody } from "../car/geometry/BodyBuilder.js";
import { buildGlass, buildLights } from "../car/geometry/GlassAndLamps.js";
import { buildWheel } from "../car/geometry/Wheels.js";
import { clamp01, lerp } from "../core/math.js";

const GARAGE_STYLE = `
.garage-overlay{position:absolute;inset:0;z-index:45;background:linear-gradient(160deg,#0b1015,#070a0e);display:flex;flex-direction:column;font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif;color:#e8eef4}
.garage-head{display:flex;align-items:center;justify-content:space-between;padding:14px clamp(14px,2.4vw,28px);border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0}
.garage-body{flex:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);min-height:0}
@media (max-width:860px){.garage-body{grid-template-columns:1fr;grid-template-rows:1fr auto}}
.garage-cars{overflow-y:auto;padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px;align-content:start}
.car-card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);border-radius:9px;padding:10px 11px;cursor:pointer;transition:all .14s;text-align:left;font-family:inherit;color:inherit;position:relative;overflow:hidden}
.car-card:hover{background:rgba(255,138,61,0.1);border-color:rgba(255,138,61,0.4)}
.car-card.sel{background:rgba(255,138,61,0.16);border-color:#ff8a3d;box-shadow:0 0 0 1px rgba(255,138,61,0.4)}
.car-card .n{font-weight:700;font-size:13px;margin-bottom:2px}
.car-card .m{font-size:10px;color:#8fa3b2;letter-spacing:0.08em}
.car-card .s{font-size:10px;color:#6f7f8c;margin-top:6px;display:flex;justify-content:space-between}
.car-tier{position:absolute;top:0;right:0;font-size:9px;font-weight:800;padding:3px 8px;border-bottom-left-radius:6px;color:#0a0e13}
.garage-side{overflow-y:auto;padding:16px;border-left:1px solid rgba(255,255,255,0.08);background:rgba(0,0,0,0.25)}
@media (max-width:860px){.garage-side{border-left:0;border-top:1px solid rgba(255,255,255,0.08);max-height:44vh}}
`;

export class Garage {
  readonly root: HTMLDivElement;
  private preview: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private carGroup: THREE.Group | null = null;
  private current: CarSpec;
  private selected: CarSpec;
  private previewAngle = 0.6;
  private dragging = false;
  private lastX = 0;
  private rafHandle: number | null = null;
  private mats: CarMaterialLibrary;
  private styleEl: HTMLStyleElement;
  private color: number;
  private finish: PaintFinish;
  private open_ = false;

  constructor(private parent: HTMLElement, initial: CarSpec, private onConfirm: (spec: CarSpec) => void) {
    this.current = initial;
    this.selected = initial;
    this.color = initial.colors[0];
    this.finish = initial.finish;
    this.mats = new CarMaterialLibrary();

    this.styleEl = document.createElement("style");
    this.styleEl.textContent = GARAGE_STYLE;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement("div");
    this.root.className = "garage-overlay";
    this.root.style.display = "none";
    this.root.innerHTML = `
      <div class="garage-head">
        <div>
          <div style="font-size:10px;letter-spacing:0.32em;color:#ff8a3d;font-weight:800">GARAGE</div>
          <div style="font-size:clamp(16px,2vw,22px);font-weight:800">車を選ぶ</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="menu-btn" data-g="close" style="width:auto;margin:0;padding:9px 16px">戻る</button>
          <button class="menu-btn" data-g="drive" style="width:auto;margin:0;padding:9px 18px;background:#ff8a3d;color:#140b04;border-color:#ff8a3d;font-weight:800">この車でドライブ</button>
        </div>
      </div>
      <div class="garage-body">
        <div class="garage-cars" id="garage-cars"></div>
        <div class="garage-side" id="garage-side"></div>
      </div>
    `;
    // プレビューは game の DOM に置くと overlay の下になるので、garage 内に配置
    this.preview = document.createElement("canvas");
    this.preview.style.cssText = "width:100%;height:100%;display:block;touch-action:none;cursor:grab;";
    const previewWrap = document.createElement("div");
    previewWrap.style.cssText =
      "position:absolute;inset:0;z-index:-1;background:radial-gradient(circle at 50% 62%,#20262e,#080b0f 72%);";
    previewWrap.appendChild(this.preview);
    this.root.appendChild(previewWrap);

    parent.appendChild(this.root);
    this.root.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-g]") as HTMLElement | null;
      if (!el) return;
      const act = el.dataset.g;
      if (act === "close") this.close();
      if (act === "drive") {
        this.onConfirm(this.selected);
      }
      if (act === "color") {
        this.color = parseInt(el.dataset.color!, 16);
        this.rebuildPreview();
        this.renderSide();
      }
      if (act === "finish") {
        this.finish = el.dataset.finish as PaintFinish;
        this.rebuildPreview();
        this.renderSide();
      }
      if (act === "car") {
        const id = el.dataset.id!;
        this.selected = CARS.find((c) => c.id === id)!;
        this.color = this.selected.colors[0];
        this.finish = this.selected.finish;
        this.rebuildPreview();
        this.renderList();
        this.renderSide();
      }
    });

    this.preview.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.preview.setPointerCapture?.(e.pointerId);
    });
    this.preview.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.previewAngle += (e.clientX - this.lastX) * 0.009;
      this.lastX = e.clientX;
    });
    this.preview.addEventListener("pointerup", () => {
      this.dragging = false;
    });

    this.renderList();
    this.renderSide();
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    this.open_ = true;
    this.root.style.display = "flex";
    this.initPreview();
    this.rebuildPreview();
    this.renderSide();
    this.loopPreview();
  }

  close(): void {
    this.open_ = false;
    this.root.style.display = "none";
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  private initPreview(): void {
    if (this.renderer) return;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.preview.clientWidth || 800, this.preview.clientHeight || 600, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.preview.appendChild?.(this.renderer.domElement);
    // canvas 自体を renderer のものに差し替える
    this.renderer.domElement.style.cssText = "width:100%;height:100%;display:block;";
    this.preview.replaceWith(this.renderer.domElement);
    const newCanvas = this.renderer.domElement;
    newCanvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      newCanvas.setPointerCapture?.(e.pointerId);
    });
    newCanvas.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.previewAngle += (e.clientX - this.lastX) * 0.009;
      this.lastX = e.clientX;
    });
    newCanvas.addEventListener("pointerup", () => {
      this.dragging = false;
    });
    this.preview = newCanvas as unknown as HTMLCanvasElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camera.position.set(4.2, 1.9, 5.6);
    this.camera.lookAt(0, 0.72, 0);

    // スタジオライティング
    const key = new THREE.DirectionalLight(0xfff4e8, 3.4);
    key.position.set(4, 7, 5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xa8c8f0, 1.3);
    fill.position.set(-5, 3, -4);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffd8b0, 2.2);
    rim.position.set(-2, 4, -7);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x2a2620, 0.9));

    // 環境マップ(スタジオ)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#e8eef4");
    g.addColorStop(0.45, "#dfe6ec");
    g.addColorStop(0.5, "#8a9098");
    g.addColorStop(1, "#22262a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 256);
    for (const [x, y, w, h, a] of [
      [90, 10, 130, 60, 0.95],
      [300, 4, 150, 42, 0.8],
      [20, 90, 70, 40, 0.5],
      [420, 80, 80, 50, 0.55],
    ] as Array<[number, number, number, number, number]>) {
      const rg = ctx.createRadialGradient(x + w / 2, y + h / 2, 2, x + w / 2, y + h / 2, w * 0.7);
      rg.addColorStop(0, `rgba(255,255,255,${a})`);
      rg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(x, y, w, h);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const env = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    this.scene.environment = env;
    pmrem.dispose();

    // 床(反射風)
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({ color: 0x1c2128, roughness: 0.28, metalness: 0.7 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    this.scene.add(floor);
  }

  private rebuildPreview(): void {
    if (!this.scene || !this.renderer) return;
    if (this.carGroup) {
      this.scene.remove(this.carGroup);
      this.carGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    }
    const spec = { ...this.selected, colors: [this.color, ...this.selected.colors.slice(1)], finish: this.finish };
    const group = new THREE.Group();
    const body = buildBody(spec, this.mats, 2);
    group.add(body.group);
    const glass = buildGlass(spec, body.sections, this.mats);
    group.add(glass.all);
    const lights = buildLights(spec, body.sections, this.mats);
    group.add(lights.group);
    const halfTrackF = spec.chassis.trackFront * 0.5;
    const halfTrackR = spec.chassis.trackRear * 0.5;
    const wheels: Array<[number, number, boolean, boolean]> = [
      [halfTrackF, body.axles.frontZ, true, false],
      [-halfTrackF, body.axles.frontZ, true, true],
      [halfTrackR, body.axles.rearZ, false, false],
      [-halfTrackR, body.axles.rearZ, false, true],
    ];
    for (const [x, z, isFront, mirror] of wheels) {
      const w = buildWheel(spec, this.mats, isFront, mirror, 2);
      w.group.position.set(x, spec.dims.wheelRadiusFront, z);
      group.add(w.group);
    }
    group.position.y = 0;
    this.scene.add(group);
    this.carGroup = group;
    this.mats.applyEnvMap(this.scene.environment as THREE.Texture);
    body.paint.envMap = this.scene.environment as THREE.Texture;
    body.paint.needsUpdate = true;
  }

  private loopPreview(): void {
    const tick = () => {
      if (!this.open_ || !this.renderer || !this.scene || !this.camera) return;
      this.rafHandle = requestAnimationFrame(tick);
      const w = this.preview.clientWidth || 1;
      const h = this.preview.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      // ゆっくり回転
      if (!this.dragging) this.previewAngle += 0.0032;
      const r = 6.4;
      this.camera.position.set(Math.sin(this.previewAngle) * r, 2.1 + Math.sin(this.previewAngle * 0.6) * 0.35, Math.cos(this.previewAngle) * r);
      this.camera.lookAt(0, 0.66, 0);
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  private renderList(): void {
    const el = this.root.querySelector("#garage-cars");
    if (!el) return;
    el.innerHTML = CARS.map((c) => {
      const sel = c.id === this.selected.id ? " sel" : "";
      return `
        <button class="car-card${sel}" data-g="car" data-id="${c.id}">
          <span class="car-tier" style="background:${TIER_COLORS[c.tier]}">${c.tier}</span>
          <div class="n">${c.name}</div>
          <div class="m">${c.maker} · ${c.year}</div>
          <div class="s"><span>${STYLE_LABELS[c.style]}</span><span>${c.drive}</span></div>
          <div class="s"><span>${c.engine.powerHp} hp</span><span>${c.chassis.mass} kg</span></div>
        </button>`;
    }).join("");
    // プレビュー領域を避けるため、一覧の高さを調整
    (el as HTMLElement).style.paddingTop = "0";
  }

  private renderSide(): void {
    const el = this.root.querySelector("#garage-side");
    if (!el) return;
    const c = this.selected;
    const stats = carStats(c);
    const colorButtons = c.colors
      .map(
        (col) =>
          `<button data-g="color" data-color="${col.toString(16).padStart(6, "0")}" style="width:26px;height:26px;border-radius:50%;border:2px solid ${
            col === this.color ? "#ff8a3d" : "rgba(255,255,255,0.18)"
          };background:#${col.toString(16).padStart(6, "0")};cursor:pointer"></button>`
      )
      .join("");
    const finishes = PAINT_FINISHES.map(
      (f) =>
        `<button data-g="finish" data-finish="${f.id}" style="padding:5px 9px;border-radius:6px;border:1px solid ${
          f.id === this.finish ? "#ff8a3d" : "rgba(255,255,255,0.14)"
        };background:${f.id === this.finish ? "rgba(255,138,61,0.18)" : "rgba(255,255,255,0.04)"};color:#dbe6ef;font-size:11px;cursor:pointer;font-family:inherit">${f.name}</button>`
    ).join("");

    el.innerHTML = `
      <div style="font-size:10px;letter-spacing:0.26em;color:#ff8a3d;font-weight:800">${c.maker.toUpperCase()}</div>
      <h3 style="margin:4px 0 2px;font-size:clamp(17px,2.1vw,22px);font-weight:800">${c.name}</h3>
      <div style="font-size:11px;color:#8fa3b2;margin-bottom:12px">${c.description}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px 12px;font-size:11px;margin-bottom:14px">
        ${stats
          .slice(0, 8)
          .map(
            (s) =>
              `<div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.05);padding:3px 0"><span style="color:#8fa3b2">${s.label}</span><span style="font-family:ui-monospace,monospace;color:#e8eef4">${s.value}</span></div>`
          )
          .join("")}
      </div>
      <div style="font-size:10px;letter-spacing:0.2em;color:#8fa3b2;margin-bottom:6px">BODY COLOR</div>
      <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">${colorButtons}</div>
      <div style="font-size:10px;letter-spacing:0.2em;color:#8fa3b2;margin-bottom:6px">FINISH</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">${finishes}</div>
      <p style="font-size:10px;color:#6f7f8c;line-height:1.6;margin-top:14px">ドラッグで回転。塗装はそのままゲーム内の車に反映されます。すべての車はオリジナルデザインです。</p>
    `;
    void lerp;
    void FINISH_PRESETS;
    void clamp01;
  }

  dispose(): void {
    this.close();
    this.styleEl.remove();
    this.root.remove();
    this.mats.dispose();
    this.renderer?.dispose();
  }
}
