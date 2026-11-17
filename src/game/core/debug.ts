/**
 * core/debug.ts
 * 責務: FPS/三角形数/ドローコールの表示、デバッグパネル、簡易ロガー
 * 公開API: DebugHud, debugLog
 * 依存: render/Pipeline.ts, render/QualityScaler.ts
 */

import { RenderStats } from "../render/Pipeline.js";
import { clamp, Ring } from "./math.js";

export interface DebugLine {
  label: string;
  value: string;
  color?: string;
}

export class DebugHud {
  private el: HTMLDivElement;
  private visible = false;
  private statsRing = new Ring(60);
  private lastUpdate = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "debug-hud";
    this.el.style.cssText =
      "position:absolute;left:8px;top:8px;z-index:60;font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;color:#9fe8c8;background:rgba(6,10,14,0.72);padding:8px 10px;border-radius:6px;border:1px solid rgba(120,220,180,0.22);pointer-events:none;display:none;white-space:pre;text-shadow:0 1px 2px #000;";
    parent.appendChild(this.el);
  }

  toggle(force?: boolean): boolean {
    this.visible = force ?? !this.visible;
    this.el.style.display = this.visible ? "block" : "none";
    return this.visible;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(stats: RenderStats, extra: DebugLine[] = []): void {
    if (!this.visible) return;
    const now = performance.now();
    if (now - this.lastUpdate < 120) return;
    this.lastUpdate = now;
    this.statsRing.push(stats.frameMs);
    const avg = this.statsRing.avg();
    const max = this.statsRing.max();

    const lines: DebugLine[] = [
      { label: "FPS", value: `${stats.fps}  (${avg.toFixed(1)}ms / max ${max.toFixed(1)}ms)` },
      { label: "Triangles", value: stats.triangles.toLocaleString("en-US") },
      { label: "DrawCalls", value: String(stats.drawCalls) },
      { label: "Geometries", value: String(stats.geometries) },
      { label: "Textures", value: String(stats.textures) },
      { label: "Resolution", value: `${stats.resolution.w}×${stats.resolution.h} (${Math.round(stats.resolution.scale * 100)}%)` },
      ...extra,
    ];
    this.el.innerHTML = lines
      .map(
        (l) =>
          `<span style="color:#5f7a70">${l.label.padEnd(12, " ")}</span><span style="color:${l.color ?? "#d8f5e8"}">${l.value}</span>`
      )
      .join("\n");
  }

  dispose(): void {
    this.el.remove();
  }
}

let logEl: HTMLDivElement | null = null;
let logLines: string[] = [];

export function debugLog(msg: string): void {
  logLines.push(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
  if (logLines.length > 200) logLines.shift();
  console.log(msg);
}

export function showDebugLog(parent: HTMLElement): HTMLDivElement {
  if (logEl) return logEl;
  logEl = document.createElement("div");
  logEl.style.cssText =
    "position:absolute;left:8px;bottom:8px;z-index:60;font-family:ui-monospace,monospace;font-size:10px;color:#8ab;background:rgba(6,10,14,0.7);padding:6px 8px;border-radius:4px;max-width:46ch;max-height:28vh;overflow:auto;white-space:pre-wrap;display:none;";
  parent.appendChild(logEl);
  logEl.textContent = logLines.join("\n");
  return logEl;
}

/** 円形プログレス(ローディング用) */
export function createLoader(parent: HTMLElement): { set: (progress: number, label: string) => void; hide: () => void } {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:absolute;inset:0;z-index:90;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 45%,#141b24,#080b10 70%);color:#e8eef4;font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif;transition:opacity .6s;";
  wrap.innerHTML = `
    <div style="font-size:11px;letter-spacing:.36em;color:#ff8a3d;margin-bottom:14px;font-weight:700">COSTA SOL</div>
    <div style="width:min(420px,72vw);height:3px;background:rgba(255,255,255,.1);border-radius:2px;overflow:hidden">
      <div id="ldbar" style="height:100%;width:0%;background:linear-gradient(90deg,#ff6a1a,#ffc06a);transition:width .35s ease"></div>
    </div>
    <div id="ldlabel" style="margin-top:12px;font-size:12px;color:#9aa7b4;letter-spacing:.06em">起動中…</div>
  `;
  parent.appendChild(wrap);
  const bar = wrap.querySelector("#ldbar") as HTMLDivElement;
  const label = wrap.querySelector("#ldlabel") as HTMLDivElement;
  return {
    set(progress: number, text: string) {
      bar.style.width = `${clamp(progress * 100, 0, 100)}%`;
      label.textContent = text;
    },
    hide() {
      wrap.style.opacity = "0";
      setTimeout(() => wrap.remove(), 700);
    },
  };
}
