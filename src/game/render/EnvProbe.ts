/**
 * render/EnvProbe.ts
 * 責務: 車の映り込み用の環境マップ生成(スタジオ/空/夕暮れ/夜)と、走行中の随時更新
 * 公開API: EnvProbe
 * 依存: three, core/math.ts
 *
 * 設計メモ:
 *  - ショールーム用は手続き生成のスタジオHDRI(ソフトボックス3灯 + 帯状のリフレクタ)を Canvas で作る。
 *  - PMREM でぼかして使い回すので、重いキューブレンダリングは不要。
 *  - 走行中は空の色から簡易環境マップを作り直す(数秒間隔)。
 */
import * as THREE from "three";
import { clamp01, lerp } from "../core/math.js";

export type StudioPreset = "showroom" | "day" | "sunset" | "night" | "garage";

export class EnvProbe {
  private renderer: THREE.WebGLRenderer;
  private pmrem: THREE.PMREMGenerator;
  private current: THREE.Texture | null = null;
  private currentKey = "";
  private dirty = true;
  private timer = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
  }

  /** スタジオ環境を生成(ショールーム) */
  private buildStudioCanvas(preset: StudioPreset, tint: { top: string; bottom: string; key: string }): HTMLCanvasElement {
    const W = 512;
    const H = 256;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;

    // 上下グラデーション(天井/床)
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, tint.top);
    g.addColorStop(0.48, tint.top);
    g.addColorStop(0.52, tint.bottom);
    g.addColorStop(1, "#141416");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // ソフトボックス(横長の白い帯)
    const boxes: Array<[number, number, number, number, number]> = [
      [0.18, 0.05, 0.22, 0.28, 1.0],
      [0.55, 0.02, 0.28, 0.2, 0.85],
      [0.05, 0.35, 0.14, 0.18, 0.55],
      [0.78, 0.3, 0.16, 0.22, 0.6],
    ];
    for (const [x, y, w, h, a] of boxes) {
      const grd = ctx.createRadialGradient(
        (x + w / 2) * W,
        (y + h / 2) * H,
        1,
        (x + w / 2) * W,
        (y + h / 2) * H,
        (w * W) / 1.4
      );
      grd.addColorStop(0, `rgba(255,255,255,${a})`);
      grd.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grd;
      ctx.fillRect(x * W, y * H, w * W, h * H);
    }

    // 帯状のリフレクタ(車のボディに映る白いライン)
    ctx.save();
    ctx.globalAlpha = 0.9;
    for (const y of [0.44, 0.47]) {
      const grd = ctx.createLinearGradient(0, y * H - 3, 0, y * H + 3);
      grd.addColorStop(0, "rgba(255,255,255,0)");
      grd.addColorStop(0.5, `rgba(255,255,255,${y === 0.44 ? 0.8 : 0.55})`);
      grd.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grd;
      ctx.fillRect(0, y * H - 3, W, 6);
    }
    ctx.restore();

    // キーライトの色味
    const keyGrd = ctx.createRadialGradient(W * 0.62, H * 0.18, 2, W * 0.62, H * 0.18, W * 0.32);
    keyGrd.addColorStop(0, tint.key);
    keyGrd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = keyGrd;
    ctx.fillRect(0, 0, W, H);

    if (preset === "night") {
      // 点光源の玉
      for (let i = 0; i < 14; i++) {
        const x = Math.random() * W;
        const y = Math.random() * H * 0.5;
        const r = 3 + Math.random() * 8;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, "rgba(255,230,180,0.9)");
        grd.addColorStop(1, "rgba(255,230,180,0)");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return c;
  }

  /** 空の色から環境マップを作る(走行中) */
  private buildSkyCanvas(zenith: THREE.Color, horizon: THREE.Color, sun: THREE.Color, sunDir: THREE.Vector3): HTMLCanvasElement {
    const W = 512;
    const H = 256;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `#${zenith.getHexString()}`);
    g.addColorStop(0.45, `#${zenith.clone().lerp(horizon, 0.6).getHexString()}`);
    g.addColorStop(0.5, `#${horizon.getHexString()}`);
    g.addColorStop(0.62, `#${horizon.clone().multiplyScalar(0.6).getHexString()}`);
    g.addColorStop(1, "#2b2822");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 太陽
    const u = (Math.atan2(sunDir.z, sunDir.x) / (Math.PI * 2) + 0.5) * W;
    const v = (0.5 - Math.asin(clamp01(sunDir.y)) / Math.PI) * H;
    const sunGrd = ctx.createRadialGradient(u, v, 1, u, v, 46);
    sunGrd.addColorStop(0, `#${sun.getHexString()}`);
    sunGrd.addColorStop(0.15, `rgba(255,240,210,0.9)`);
    sunGrd.addColorStop(1, "rgba(255,220,180,0)");
    ctx.fillStyle = sunGrd;
    ctx.beginPath();
    ctx.arc(u, v, 46, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }

  /** 環境マップを取得(必要なら再生成) */
  get(
    preset: StudioPreset,
    sky?: { zenith: THREE.Color; horizon: THREE.Color; sun: THREE.Color; sunDir: THREE.Vector3; exposure: number },
    force = false
  ): THREE.Texture {
    const key = sky ? `${preset}_${sky.zenith.getHexString()}_${sky.horizon.getHexString()}` : preset;
    if (!force && !this.dirty && this.current && key === this.currentKey) return this.current;

    let canvas: HTMLCanvasElement;
    if (preset === "showroom") {
      canvas = this.buildStudioCanvas("showroom", { top: "#eef2f6", bottom: "#6f7378", key: "rgba(255,250,240,0.55)" });
    } else if (preset === "garage") {
      canvas = this.buildStudioCanvas("garage", { top: "#1a1d22", bottom: "#2a2f36", key: "rgba(255,210,150,0.35)" });
    } else if (sky) {
      canvas = this.buildSkyCanvas(sky.zenith, sky.horizon, sky.sun, sky.sunDir);
    } else {
      canvas = this.buildStudioCanvas(preset === "night" ? "night" : "day", {
        top: preset === "night" ? "#0a1020" : "#dfeaf5",
        bottom: preset === "night" ? "#101822" : "#8d9299",
        key: preset === "night" ? "rgba(140,170,255,0.25)" : "rgba(255,245,225,0.4)",
      });
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const rt = this.pmrem.fromEquirectangular(tex);
    tex.dispose();
    if (this.current) this.current.dispose();
    this.current = rt.texture;
    this.currentKey = key;
    this.dirty = false;
    return this.current;
  }

  /** 走行中に数秒ごとに更新 */
  update(dt: number, interval = 4.5): boolean {
    this.timer += dt;
    if (this.timer > interval) {
      this.timer = 0;
      this.dirty = true;
      return true;
    }
    return false;
  }

  dispose(): void {
    this.current?.dispose();
    this.pmrem.dispose();
  }
}

export { lerp };
