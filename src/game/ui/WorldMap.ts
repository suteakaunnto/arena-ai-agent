/**
 * ui/WorldMap.ts
 * 責務: 12km 全域マップ(ズーム/パン/イベント地点/ファストトラベル/目的地表示)
 * 公開API: WorldMap
 * 依存: world/Road.ts, world/Terrain.ts, world/WorldConfig.ts
 *
 * 設計メモ:
 *  - マップ画像は初回オープン時に一度だけ Canvas に描く(地形の縮小図 + 道路 + 地名)。
 *  - ズーム/パンは Canvas の transform で行う。
 *  - 地点をクリックでファストトラベル(位置を返すだけ。実際の移動は Game が行う)。
 */
import * as THREE from "three";
import { RoadNetwork } from "../world/Road.js";
import { Terrain } from "../world/Terrain.js";
import { LANDMARKS, SETTLEMENTS, WORLD } from "../world/WorldConfig.js";
import { clamp, TAU } from "../core/math.js";

export interface MapPoint {
  id: string;
  name: string;
  x: number;
  z: number;
  kind: "settlement" | "landmark";
  description: string;
}

export class WorldMap {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private player = new THREE.Vector2();
  private points: MapPoint[] = [];
  private open_ = false;
  private raf: number | null = null;
  private infoEl: HTMLDivElement;
  private onTeleport: ((x: number, z: number, name: string) => void) | null = null;

  constructor(
    private parent: HTMLElement,
    private roads: RoadNetwork,
    private terrain: Terrain,
    onTeleport?: (x: number, z: number, name: string) => void
  ) {
    this.onTeleport = onTeleport ?? null;
    this.root = document.createElement("div");
    this.root.style.cssText =
      "position:absolute;inset:0;z-index:44;display:none;background:rgba(5,8,11,0.94);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif;color:#e8eef4;";
    this.root.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid rgba(255,255,255,0.08)">
        <div>
          <div style="font-size:10px;letter-spacing:0.32em;color:#7ad8ff;font-weight:800">COSTA SOL · MAP</div>
          <div style="font-size:clamp(15px,1.9vw,20px);font-weight:800">全域マップ <span style="font-size:11px;color:#8fa3b2;font-weight:400">12km × 12km</span></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span style="font-size:11px;color:#8fa3b2">ドラッグで移動 / ホイールで拡大</span>
          <button data-m="close" class="menu-btn" style="width:auto;margin:0;padding:8px 16px">閉じる (M)</button>
        </div>
      </div>
      <div style="position:absolute;inset:62px 0 0 0;display:flex">
        <div style="flex:1;position:relative;overflow:hidden">
          <canvas id="wm-canvas" style="width:100%;height:100%;display:block;cursor:grab;touch-action:none"></canvas>
        </div>
        <div id="wm-info" style="width:min(300px,32vw);border-left:1px solid rgba(255,255,255,0.08);padding:16px;overflow-y:auto;font-size:12px"></div>
      </div>
    `;
    parent.appendChild(this.root);
    this.canvas = this.root.querySelector("#wm-canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.infoEl = this.root.querySelector("#wm-info")!;

    this.points = [
      ...SETTLEMENTS.map<MapPoint>((s) => ({
        id: s.id,
        name: s.name,
        x: s.x,
        z: s.z,
        kind: "settlement",
        description: s.description,
      })),
      ...LANDMARKS.map<MapPoint>((l) => ({
        id: l.id,
        name: l.name,
        x: l.x,
        z: l.z,
        kind: "landmark",
        description: l.description,
      })),
    ];

    this.root.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-m]") as HTMLElement | null;
      if (el?.dataset.m === "close") this.close();
      const p = (e.target as HTMLElement).closest("[data-pt]") as HTMLElement | null;
      if (p) {
        const pt = this.points.find((x) => x.id === p.dataset.pt);
        if (pt) this.focusPoint(pt);
      }
      const t = (e.target as HTMLElement).closest("[data-tp]") as HTMLElement | null;
      if (t) {
        const pt = this.points.find((x) => x.id === t.dataset.tp);
        if (pt && this.onTeleport) {
          this.onTeleport(pt.x, pt.z, pt.name);
          this.close();
        }
      }
    });

    this.canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture?.(e.pointerId);
      this.canvas.style.cursor = "grabbing";
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.panX += e.clientX - this.lastPointer.x;
      this.panY += e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.clampPan();
      this.draw();
    });
    const stop = () => {
      this.dragging = false;
      this.canvas.style.cursor = "grab";
    };
    this.canvas.addEventListener("pointerup", stop);
    this.canvas.addEventListener("pointercancel", stop);
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.88 : 1.14;
        this.zoom = clamp(this.zoom * factor, 1, 8);
        this.clampPan();
        this.draw();
      },
      { passive: false }
    );
    this.renderInfo(null);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(playerPos: THREE.Vector3): void {
    this.open_ = true;
    this.root.style.display = "block";
    this.player.set(playerPos.x, playerPos.z);
    if (!this.base) this.buildBase();
    this.resize();
    this.draw();
    this.renderInfo(null);
    this.loop();
  }

  close(): void {
    this.open_ = false;
    this.root.style.display = "none";
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private loop(): void {
    const tick = () => {
      if (!this.open_) return;
      this.raf = requestAnimationFrame(tick);
      this.draw();
    };
    tick();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.max(2, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(2, Math.round(rect.height * dpr));
  }

  private buildBase(): void {
    const S = 1024;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const ctx = c.getContext("2d")!;
    // 地形の簡易カラー
    const step = 8;
    for (let y = 0; y < S; y += step) {
      for (let x = 0; x < S; x += step) {
        const wx = (x / S) * WORLD.size - WORLD.half;
        const wz = (y / S) * WORLD.size - WORLD.half;
        const h = this.terrain.rawHeight(wx, wz);
        let col: string;
        if (h < 0) col = `rgb(${18},${34 + h * 0.1},${46})`;
        else if (h < 6) col = "rgb(150,140,110)";
        else if (h < 120) col = "rgb(96,112,66)";
        else if (h < 320) col = "rgb(110,104,58)";
        else if (h < 620) col = "rgb(92,84,70)";
        else col = "rgb(150,148,146)";
        ctx.fillStyle = col;
        ctx.fillRect(x, y, step, step);
      }
    }
    // 海
    ctx.globalAlpha = 0.35;
    for (let y = 0; y < S; y += step) {
      for (let x = 0; x < S; x += step) {
        const wx = (x / S) * WORLD.size - WORLD.half;
        const wz = (y / S) * WORLD.size - WORLD.half;
        if (this.terrain.rawHeight(wx, wz) < 0) {
          ctx.fillStyle = "rgba(20,60,90,0.8)";
          ctx.fillRect(x, y, step, step);
        }
      }
    }
    ctx.globalAlpha = 1;

    // 道路
    for (const road of this.roads.roads) {
      ctx.beginPath();
      road.samples.forEach((s, i) => {
        const x = ((s.x + WORLD.half) / WORLD.size) * S;
        const y = ((s.z + WORLD.half) / WORLD.size) * S;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      const cls = road.style.cls;
      ctx.strokeStyle =
        cls === "highway" ? "rgba(255,186,110,0.95)" : cls === "arterial" ? "rgba(235,230,205,0.85)" : cls === "dirt" ? "rgba(190,150,100,0.85)" : "rgba(215,215,215,0.8)";
      ctx.lineWidth = cls === "highway" ? 4.5 : cls === "arterial" ? 3 : 2;
      ctx.stroke();
    }

    // 集落
    for (const s of SETTLEMENTS) {
      const x = ((s.x + WORLD.half) / WORLD.size) * S;
      const y = ((s.z + WORLD.half) / WORLD.size) * S;
      ctx.beginPath();
      ctx.arc(x, y, s.kind === "city" ? 16 : s.kind === "town" ? 10 : 7, 0, TAU);
      ctx.fillStyle = s.kind === "city" ? "#ffb066" : "#ffe6c0";
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    for (const l of LANDMARKS) {
      const x = ((l.x + WORLD.half) / WORLD.size) * S;
      const y = ((l.z + WORLD.half) / WORLD.size) * S;
      ctx.beginPath();
      ctx.moveTo(x, y - 10);
      ctx.lineTo(x + 9, y + 8);
      ctx.lineTo(x - 9, y + 8);
      ctx.closePath();
      ctx.fillStyle = "#7ad8ff";
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    this.base = c;
  }

  private clampPan(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const maxX = Math.max(0, (w * this.zoom - w) / 2);
    const maxY = Math.max(0, (h * this.zoom - h) / 2);
    this.panX = clamp(this.panX, -maxX, maxX);
    this.panY = clamp(this.panY, -maxY, maxY);
  }

  private draw(): void {
    if (!this.base) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + this.panX, h / 2 + this.panY);
    ctx.scale(this.zoom, this.zoom);
    const size = Math.min(w, h) * 0.98;
    ctx.drawImage(this.base, -size / 2, -size / 2, size, size);

    // 地点ラベル
    ctx.scale(1 / this.zoom, 1 / this.zoom);
    const fontSize = Math.max(11, Math.min(w, h) * 0.014);
    ctx.font = `600 ${fontSize}px 'Hiragino Sans','Noto Sans JP',sans-serif`;
    ctx.textAlign = "center";
    for (const p of this.points) {
      const px = ((p.x + WORLD.half) / WORLD.size - 0.5) * size;
      const py = ((p.z + WORLD.half) / WORLD.size - 0.5) * size;
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      const label = p.name;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(px - tw / 2 - 4, py - fontSize * 2.1, tw + 8, fontSize * 1.4);
      ctx.fillStyle = p.kind === "settlement" ? "#ffe6c0" : "#9fe8ff";
      ctx.fillText(label, px, py - fontSize * 1.05);
    }
    // プレイヤー
    const px = ((this.player.x + WORLD.half) / WORLD.size - 0.5) * size;
    const py = ((this.player.y + WORLD.half) / WORLD.size - 0.5) * size;
    ctx.beginPath();
    ctx.arc(px, py, fontSize * 0.7, 0, TAU);
    ctx.fillStyle = "#ff8a3d";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  private focusPoint(p: MapPoint): void {
    this.renderInfo(p);
  }

  private renderInfo(p: MapPoint | null): void {
    if (!p) {
      this.infoEl.innerHTML = `
        <div style="font-size:10px;letter-spacing:0.24em;color:#7ad8ff;font-weight:800;margin-bottom:10px">DESTINATION</div>
        ${this.points
          .map(
            (pt) => `
          <button data-pt="${pt.id}" style="display:block;width:100%;text-align:left;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 10px;margin-bottom:6px;color:#dbe6ef;font-family:inherit;font-size:12px;cursor:pointer">
            <b style="color:${pt.kind === "settlement" ? "#ffe6c0" : "#9fe8ff"}">${pt.name}</b>
          </button>`
          )
          .join("")}
        <p style="font-size:10px;color:#6f7f8c;line-height:1.6;margin-top:12px">地点を選ぶとファストトラベルできます。走行中は M キーで開閉。</p>
      `;
      return;
    }
    this.infoEl.innerHTML = `
      <div style="font-size:10px;letter-spacing:0.24em;color:#7ad8ff;font-weight:800;margin-bottom:6px">${p.kind === "settlement" ? "SETTLEMENT" : "LANDMARK"}</div>
      <h3 style="margin:0 0 8px;font-size:17px;font-weight:800">${p.name}</h3>
      <p style="font-size:12px;color:#9fb0be;line-height:1.7;margin-bottom:16px">${p.description}</p>
      <button data-tp="${p.id}" style="width:100%;padding:10px;border-radius:7px;border:1px solid #ff8a3d;background:rgba(255,138,61,0.18);color:#ffb066;font-weight:800;font-family:inherit;font-size:13px;cursor:pointer">ここへ移動</button>
      <button data-m="close" style="width:100%;margin-top:8px;padding:9px;border-radius:7px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.04);color:#cbd5e1;font-family:inherit;font-size:12px;cursor:pointer">閉じる</button>
    `;
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }
}
