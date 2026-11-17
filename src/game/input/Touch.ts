/**
 * input/Touch.ts
 * 責務: スマホ向けタッチ操作。画面ホイール/左右ボタン/傾きステア、ペダル、2本指同時操作、触覚、配置エディタ
 * 公開API: TouchManager, TouchLayout
 * 依存: input/Bindings.ts, core/math.ts
 *
 * 設計メモ:
 *  - Pointer Events でマルチタッチを扱う。ボタンは pointerId で個別に追跡。
 *  - ステア方式は 3 種類: wheel(円形の縁をドラッグ) / buttons(左右) / tilt(傾き)。
 *  - ボタンの位置・サイズ・透明度は localStorage に保存し、エディタで編集できる。
 *  - タッチが無い PC では DOM を生成しない(負荷ゼロ)。
 */
import { ActionId } from "./Bindings.js";
import { clamp, clamp01, damp } from "../core/math.js";

export type SteerMode = "wheel" | "buttons" | "tilt";

export interface TouchButtonLayout {
  id: string;
  action: ActionId;
  /** 画面に対する相対位置(0..1) */
  x: number;
  y: number;
  /** サイズ(px, 基準解像度に対する比率) */
  size: number;
  label: string;
  /** 透明度 */
  opacity: number;
}

export interface TouchLayout {
  steerMode: SteerMode;
  buttons: TouchButtonLayout[];
  wheel: { x: number; y: number; radius: number; opacity: number };
  pedalLeft: { x: number; y: number; w: number; h: number; opacity: number };
  pedalRight: { x: number; y: number; w: number; h: number; opacity: number };
  scale: number;
}

const STORAGE_KEY = "costa_sol_touch_layout_v1";

export function defaultLayout(): TouchLayout {
  return {
    steerMode: "wheel",
    scale: 1,
    wheel: { x: 0.15, y: 0.72, radius: 0.115, opacity: 0.34 },
    pedalLeft: { x: 0.79, y: 0.63, w: 0.09, h: 0.2, opacity: 0.42 },
    pedalRight: { x: 0.9, y: 0.63, w: 0.09, h: 0.2, opacity: 0.42 },
    buttons: [
      { id: "hb", action: "handbrake", x: 0.73, y: 0.42, size: 46, label: "HB", opacity: 0.5 },
      { id: "cam", action: "camera", x: 0.63, y: 0.3, size: 42, label: "CAM", opacity: 0.45 },
      { id: "up", action: "shiftUp", x: 0.93, y: 0.4, size: 38, label: "▲", opacity: 0.45 },
      { id: "down", action: "shiftDown", x: 0.93, y: 0.53, size: 38, label: "▼", opacity: 0.45 },
      { id: "map", action: "map", x: 0.88, y: 0.16, size: 36, label: "MAP", opacity: 0.45 },
      { id: "pause", action: "pause", x: 0.95, y: 0.16, size: 36, label: "Ⅱ", opacity: 0.45 },
      { id: "back", action: "lookBack", x: 0.63, y: 0.42, size: 40, label: "REAR", opacity: 0.42 },
    ],
  };
}

export class TouchManager {
  readonly root: HTMLDivElement;
  private layout: TouchLayout;
  private pressedIds = new Map<number, TouchButtonLayout>();
  private framePressed = new Set<ActionId>();
  private frameHeld = new Set<ActionId>();
  private steerPointerId: number | null = null;
  private pedalIds = new Map<number, "left" | "right">();
  throttle = 0;
  brake = 0;
  steerValue = 0;
  steerAnalog = false;
  steerActive = false;
  enabled = false;
  lastActivity = 1e9;
  private tiltHandler: ((e: DeviceOrientationEvent) => void) | null = null;
  private tiltEnabled = false;
  private tiltZero: number | null = null;
  private wheelAngle = 0;
  private wheelDragStart = 0;
  private editing = false;
  private dragTarget: { type: "button" | "wheel"; id: string } | null = null;

  constructor(private container: HTMLElement) {
    this.layout = this.loadLayout();
    this.root = document.createElement("div");
    this.root.className = "touch-layer";
    this.root.style.cssText =
      "position:absolute;inset:0;pointer-events:none;touch-action:none;z-index:20;display:none;user-select:none;";
    container.appendChild(this.root);
    this.detect();
  }

  get currentLayout(): TouchLayout {
    return this.layout;
  }

  private detect(): void {
    const isTouch =
      "ontouchstart" in window ||
      (navigator.maxTouchPoints ?? 0) > 1 ||
      window.matchMedia("(pointer: coarse)").matches;
    if (!isTouch) return;
    this.enabled = true;
    this.root.style.display = "block";
    this.build();
    // 拡大・長押しメニューの抑止
    document.addEventListener("gesturestart", (e) => e.preventDefault());
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("orientationchange", () => this.refresh());
    window.addEventListener("resize", () => this.refresh());
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.root.style.display = v ? "block" : "none";
    if (v && this.root.childElementCount === 0) this.build();
  }

  /** レイアウトを保存して再構築 */
  setLayout(l: TouchLayout): void {
    this.layout = l;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(l));
    } catch {
      /* noop */
    }
    this.build();
  }

  private loadLayout(): TouchLayout {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultLayout();
      const parsed = JSON.parse(raw) as TouchLayout;
      const def = defaultLayout();
      return { ...def, ...parsed, buttons: parsed.buttons?.length ? parsed.buttons : def.buttons };
    } catch {
      return defaultLayout();
    }
  }

  private W(): number {
    return this.root.clientWidth || window.innerWidth;
  }

  private H(): number {
    return this.root.clientHeight || window.innerHeight;
  }

  private build(): void {
    this.root.innerHTML = "";
    if (!this.enabled) return;
    const W = this.W();
    const H = this.H();
    const s = this.layout.scale;

    // ステアホイール
    const wheelSize = Math.min(W, H) * this.layout.wheel.radius * 2 * s;
    const wheel = document.createElement("div");
    wheel.className = "touch-wheel";
    wheel.style.cssText = `position:absolute;left:${this.layout.wheel.x * W - wheelSize / 2}px;top:${
      this.layout.wheel.y * H - wheelSize / 2
    }px;width:${wheelSize}px;height:${wheelSize}px;border-radius:50%;border:${
      2 + wheelSize * 0.02
    }px solid rgba(255,255,255,${this.layout.wheel.opacity});background:radial-gradient(circle,rgba(255,255,255,0.04),rgba(255,255,255,${
      this.layout.wheel.opacity * 0.35
    }));pointer-events:auto;`;
    wheel.innerHTML = `<div class="touch-wheel-mark" style="position:absolute;left:50%;top:6%;width:2px;height:22%;background:rgba(255,255,255,0.7);transform-origin:50% 200%;"></div>`;
    this.root.appendChild(wheel);
    wheel.addEventListener("pointerdown", (e) => {
      if (this.layout.steerMode === "buttons") return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      this.steerPointerId = e.pointerId;
      this.lastActivity = 0;
      const rect = wheel.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const angle = Math.atan2(e.clientY - cy, e.clientX - cx);
      this.wheelDragStart = angle - this.wheelAngle;
    });
    wheel.addEventListener("pointermove", (e) => {
      if (this.steerPointerId !== e.pointerId) return;
      e.preventDefault();
      const rect = wheel.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const angle = Math.atan2(e.clientY - cy, e.clientX - cx);
      let delta = angle - this.wheelDragStart;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      // 最大 1.6rad(約90度)でフルロック
      const v = clamp(delta / 1.5, -1, 1);
      this.wheelAngle = angle - this.wheelDragStart;
      this.steerValue = v;
      this.steerAnalog = true;
      this.steerActive = true;
      const mark = wheel.querySelector(".touch-wheel-mark") as HTMLElement | null;
      if (mark) mark.style.transform = `rotate(${this.wheelAngle}rad)`;
      this.lastActivity = 0;
    });
    const releaseWheel = (e: PointerEvent) => {
      if (this.steerPointerId !== e.pointerId) return;
      this.steerPointerId = null;
      this.wheelAngle = 0;
      this.steerActive = false;
      const mark = wheel.querySelector(".touch-wheel-mark") as HTMLElement | null;
      if (mark) mark.style.transform = "rotate(0rad)";
    };
    wheel.addEventListener("pointerup", releaseWheel);
    wheel.addEventListener("pointercancel", releaseWheel);

    // 左右ボタン(ステアモードが buttons のときだけ表示)
    if (this.layout.steerMode === "buttons") {
      for (const [i, label] of [
        [0, "◀"],
        [1, "▶"],
      ] as Array<[number, string]>) {
        const b = document.createElement("div");
        const size = Math.min(W, H) * 0.18;
        b.style.cssText = `position:absolute;left:${(0.06 + i * 0.2) * W}px;top:${0.66 * H}px;width:${size}px;height:${size}px;border-radius:18%;border:2px solid rgba(255,255,255,0.4);background:rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:center;font-size:${size * 0.4}px;color:rgba(255,255,255,0.85);pointer-events:auto;`;
        b.textContent = label;
        this.root.appendChild(b);
        const action: ActionId = i === 0 ? "steerLeft" : "steerRight";
        b.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          this.frameHeld.add(action);
          this.steerValue = action === "steerLeft" ? -1 : 1;
          this.steerAnalog = false;
          this.steerActive = true;
          this.brake = this.brake;
          b.setPointerCapture?.(e.pointerId);
          this.lastActivity = 0;
        });
        const rel = () => {
          this.steerActive = false;
          this.steerValue = 0;
        };
        b.addEventListener("pointerup", rel);
        b.addEventListener("pointercancel", rel);
      }
    }

    // ペダル
    const mkPedal = (
      cfg: { x: number; y: number; w: number; h: number; opacity: number },
      label: string,
      kind: "left" | "right"
    ) => {
      const pw = cfg.w * W * s;
      const ph = cfg.h * H * s;
      const el = document.createElement("div");
      el.style.cssText = `position:absolute;left:${cfg.x * W - pw / 2}px;top:${
        cfg.y * H - ph / 2
      }px;width:${pw}px;height:${ph}px;border-radius:${pw * 0.22}px;border:2px solid rgba(255,255,255,${
        cfg.opacity + 0.35
      });background:rgba(255,255,255,${cfg.opacity * 0.55});display:flex;align-items:flex-end;justify-content:center;padding-bottom:8px;font-size:${
        pw * 0.3
      }px;color:rgba(255,255,255,0.9);pointer-events:auto;font-weight:700;letter-spacing:0.05em;`;
      el.textContent = label;
      this.root.appendChild(el);
      const set = (v: boolean) => {
        if (kind === "right") this.throttle = v ? 1 : 0;
        else this.brake = v ? 1 : 0;
        if (v) {
          this.frameHeld.add(kind === "right" ? "accelerate" : "brake");
          this.framePressedThisFrame.add(kind === "right" ? "accelerate" : "brake");
        }
        this.lastActivity = 0;
      };
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        this.pedalIds.set(e.pointerId, kind);
        el.style.background = `rgba(255,255,255,${Math.min(0.9, cfg.opacity + 0.4)})`;
        set(true);
      });
      const off = (e: PointerEvent) => {
        this.pedalIds.delete(e.pointerId);
        el.style.background = `rgba(255,255,255,${cfg.opacity * 0.55})`;
        set(false);
      };
      el.addEventListener("pointerup", off);
      el.addEventListener("pointercancel", off);
      el.addEventListener("pointerleave", (e) => {
        if (this.pedalIds.has((e as PointerEvent).pointerId)) off(e as PointerEvent);
      });
    };
    mkPedal(this.layout.pedalLeft, "BRAKE", "left");
    mkPedal(this.layout.pedalRight, "GAS", "right");

    // 小ボタン群
    for (const btn of this.layout.buttons) {
      const size = btn.size * s;
      const el = document.createElement("div");
      el.style.cssText = `position:absolute;left:${btn.x * W - size / 2}px;top:${
        btn.y * H - size / 2
      }px;width:${size}px;height:${size}px;border-radius:50%;border:2px solid rgba(255,255,255,${
        btn.opacity + 0.3
      });background:rgba(255,255,255,${btn.opacity * 0.5});display:flex;align-items:center;justify-content:center;font-size:${
        size * 0.3
      }px;color:rgba(255,255,255,0.92);pointer-events:auto;font-weight:600;`;
      el.textContent = btn.label;
      this.root.appendChild(el);
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        this.pressedIds.set(e.pointerId, btn);
        this.frameHeld.add(btn.action);
        this.framePressedThisFrame.add(btn.action);
        el.style.background = `rgba(255,255,255,${Math.min(0.9, btn.opacity + 0.4)})`;
        this.lastActivity = 0;
        this.vibrate(12);
      });
      const off = () => {
        for (const [pid, b] of this.pressedIds) {
          if (b.id === btn.id) this.pressedIds.delete(pid);
        }
        el.style.background = `rgba(255,255,255,${btn.opacity * 0.5})`;
      };
      el.addEventListener("pointerup", off);
      el.addEventListener("pointercancel", off);
      el.addEventListener("pointerleave", off);
    }
  }

  private framePressedThisFrame = new Set<ActionId>();

  private refresh(): void {
    if (!this.enabled) return;
    this.build();
  }

  /** 傾きステアを有効化(iOS は権限要求が必要) */
  async enableTilt(): Promise<boolean> {
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } })
      .DeviceOrientationEvent;
    if (!DOE) return false;
    if (DOE.requestPermission) {
      try {
        const res = await DOE.requestPermission();
        if (res !== "granted") return false;
      } catch {
        return false;
      }
    }
    if (this.tiltHandler) window.removeEventListener("deviceorientation", this.tiltHandler);
    this.tiltHandler = (e: DeviceOrientationEvent) => {
      if (!this.tiltEnabled) return;
      // 端末を横向きに持ったときの gamma をステアに使う
      const raw = e.gamma ?? 0;
      if (this.tiltZero === null) this.tiltZero = raw;
      const delta = raw - this.tiltZero;
      this.steerValue = clamp(delta / 26, -1, 1);
      this.steerAnalog = true;
      if (Math.abs(this.steerValue) > 0.04) {
        this.steerActive = true;
        this.lastActivity = 0;
      } else {
        this.steerActive = false;
      }
    };
    window.addEventListener("deviceorientation", this.tiltHandler);
    this.tiltEnabled = true;
    this.layout.steerMode = "tilt";
    this.refresh();
    return true;
  }

  calibrateTilt(): void {
    this.tiltZero = null;
  }

  disableTilt(): void {
    this.tiltEnabled = false;
    this.steerActive = false;
    this.steerValue = 0;
  }

  vibrate(ms: number): void {
    if (navigator.vibrate) {
      try {
        navigator.vibrate(ms);
      } catch {
        /* noop */
      }
    }
  }

  update(dt: number): void {
    if (!this.enabled) {
      this.throttle = damp(this.throttle, 0, 14, dt);
      this.brake = damp(this.brake, 0, 14, dt);
      return;
    }
    this.lastActivity += dt;
    // ペダルが押されていない場合は減衰
    let leftHeld = false;
    let rightHeld = false;
    for (const kind of this.pedalIds.values()) {
      if (kind === "left") leftHeld = true;
      if (kind === "right") rightHeld = true;
    }
    if (!rightHeld && !this.frameHeld.has("accelerate")) this.throttle = damp(this.throttle, 0, 18, dt);
    if (!leftHeld && !this.frameHeld.has("brake")) this.brake = damp(this.brake, 0, 18, dt);
    if (this.layout.steerMode === "tilt" && !this.tiltEnabled) this.enableTilt().catch(() => undefined);
  }

  heldActions(): Set<ActionId> {
    return this.frameHeld;
  }

  pressedActions(): Set<ActionId> {
    return this.framePressedThisFrame;
  }

  endFrame(): void {
    this.framePressedThisFrame.clear();
    // ペダルは押し続けを維持
    const keep = new Set<ActionId>();
    for (const b of this.pressedIds.values()) keep.add(b.action);
    for (const kind of this.pedalIds.values()) keep.add(kind === "left" ? "brake" : "accelerate");
    if (this.steerActive && this.layout.steerMode === "buttons") {
      keep.add(this.steerValue > 0 ? "steerRight" : "steerLeft");
    }
    this.frameHeld = keep;
    // タッチでのステア: ホイールはアナログなので held に含めない
  }

  get isActive(): boolean {
    return this.enabled && this.lastActivity < 0.6;
  }

  /* ------------------------- レイアウトエディタ ------------------------- */

  setEditing(v: boolean): void {
    this.editing = v;
    this.root.style.outline = v ? "2px dashed rgba(255,255,255,0.25)" : "none";
  }

  get isEditing(): boolean {
    return this.editing;
  }

  /** 全画面 + 横向き固定を要求 */
  async requestFullscreenLandscape(): Promise<void> {
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      const orientation = screen.orientation as unknown as { lock?: (o: string) => Promise<void> };
      if (orientation?.lock) await orientation.lock("landscape");
    } catch {
      /* 非対応環境では無視 */
    }
  }

  dispose(): void {
    if (this.tiltHandler) window.removeEventListener("deviceorientation", this.tiltHandler);
    this.root.remove();
  }
}

export { clamp01, clamp };
