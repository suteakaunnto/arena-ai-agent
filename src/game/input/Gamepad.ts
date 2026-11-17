/**
 * input/Gamepad.ts
 * 責務: Gamepad API のポーリング、Xbox / Switch Pro / 汎用パッドのプロファイル判定、
 *       デッドゾーン・トリガー・擬似アナログ・振動
 * 公開API: GamepadManager, PadProfile
 * 依存: input/Bindings.ts, core/math.ts
 *
 * 設計メモ:
 *  - 標準マッピングを最優先。非標準(Switch Pro の一部環境)ではベンダーIDで判定して変換表を使う。
 *  - ZL/ZR がデジタルの環境向けに「押下時間で 0→1 に立ち上げる」擬似アナログを実装。
 *  - スティックは放射状デッドゾーン + 感度カーブ。ドリフト対策で大きめの初期値を設定。
 */
import { clamp, clamp01, signPow, lerp, Ema } from "../core/math.js";
import { GamepadButtonName } from "./Bindings.js";

export type PadProfileId = "xbox" | "switchpro" | "playstation" | "generic";

export interface PadProfile {
  id: PadProfileId;
  name: string;
  /** ボタン表示の配色 */
  colors: { a: string; b: string; x: string; y: string };
  /** ボタンのラベル(A/B/X/Y の並び) */
  labels: { south: string; east: string; west: string; north: string };
  /** 標準マッピングか */
  standard: boolean;
}

export const PAD_PROFILES: Record<PadProfileId, PadProfile> = {
  xbox: {
    id: "xbox",
    name: "Xbox コントローラー",
    colors: { a: "#4caf50", b: "#e53935", x: "#2196f3", y: "#fdd835" },
    labels: { south: "A", east: "B", west: "X", north: "Y" },
    standard: true,
  },
  switchpro: {
    id: "switchpro",
    name: "Nintendo Switch Pro",
    colors: { a: "#e53935", b: "#e53935", x: "#e53935", y: "#e53935" },
    labels: { south: "B", east: "A", west: "Y", north: "X" },
    standard: true,
  },
  playstation: {
    id: "playstation",
    name: "PlayStation コントローラー",
    colors: { a: "#5c9bd6", b: "#d65c5c", x: "#d68ec8", y: "#5cc9a9" },
    labels: { south: "×", east: "○", west: "□", north: "△" },
    standard: true,
  },
  generic: {
    id: "generic",
    name: "汎用コントローラー",
    colors: { a: "#8fa3b8", b: "#8fa3b8", x: "#8fa3b8", y: "#8fa3b8" },
    labels: { south: "1", east: "2", west: "3", north: "4" },
    standard: true,
  },
};

/** 標準マッピングのボタンインデックス */
const STD_BUTTONS: Record<GamepadButtonName, number> = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Back: 8,
  Start: 9,
  LS: 10,
  RS: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
};

/** 非標準マッピング用のフォールバック表(Switch Pro の一部環境) */
const FALLBACK_BUTTONS: Record<GamepadButtonName, number> = {
  B: 0,
  A: 1,
  Y: 2,
  X: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Back: 8,
  Start: 9,
  LS: 10,
  RS: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
};

export interface PadState {
  connected: boolean;
  profile: PadProfile;
  id: string;
  /** 各ボタンの押下量(0..1, 擬似アナログ適用後) */
  buttons: Record<GamepadButtonName, number>;
  /** 生の押下状態 */
  rawButtons: Record<GamepadButtonName, boolean>;
  axes: { lx: number; ly: number; rx: number; ry: number };
  /** 振動に対応しているか */
  rumble: boolean;
  /** 最終入力からの経過(自動切替用) */
  lastActive: number;
}

function emptyButtons(): Record<GamepadButtonName, number> {
  const o = {} as Record<GamepadButtonName, number>;
  for (const k of Object.keys(STD_BUTTONS) as GamepadButtonName[]) o[k] = 0;
  return o;
}

function emptyRaw(): Record<GamepadButtonName, boolean> {
  const o = {} as Record<GamepadButtonName, boolean>;
  for (const k of Object.keys(STD_BUTTONS) as GamepadButtonName[]) o[k] = false;
  return o;
}

/** ベンダーIDからプロファイルを推定 */
export function detectProfile(gp: Gamepad): PadProfileId {
  const id = gp.id.toLowerCase();
  if (id.includes("xbox") || id.includes("xinput") || id.includes("045e")) return "xbox";
  if (id.includes("nintendo") || id.includes("switch") || id.includes("057e") || id.includes("pro controller")) return "switchpro";
  if (id.includes("playstation") || id.includes("dualshock") || id.includes("dualsense") || id.includes("054c") || id.includes("sony")) return "playstation";
  return "generic";
}

export class GamepadManager {
  private profileId: PadProfileId = "generic";
  private index = -1;
  private state: PadState;
  /** デジタルトリガーの擬似アナログ用 */
  private pseudoTrigger: Record<string, number> = { LT: 0, RT: 0 };
  private rumbleSupported = false;
  private deadZone = 0.14;
  private triggerDeadZone = 0.06;
  private sensitivity = 1;
  private curve = 1.35;
  private invertY = false;

  constructor() {
    this.state = {
      connected: false,
      profile: PAD_PROFILES.generic,
      id: "",
      buttons: emptyButtons(),
      rawButtons: emptyRaw(),
      axes: { lx: 0, ly: 0, rx: 0, ry: 0 },
      rumble: false,
      lastActive: 1e9,
    };
    window.addEventListener("gamepadconnected", (e) => this.onConnect(e as GamepadEvent));
    window.addEventListener("gamepaddisconnected", (e) => this.onDisconnect(e as GamepadEvent));
  }

  private onConnect(e: GamepadEvent): void {
    this.index = e.gamepad.index;
    this.profileId = detectProfile(e.gamepad);
    this.state.connected = true;
    this.state.profile = PAD_PROFILES[this.profileId];
    this.state.id = e.gamepad.id;
    const gp = e.gamepad as Gamepad & { vibrationActuator?: unknown };
    this.rumbleSupported = !!(gp.vibrationActuator || (gp as unknown as { hapticActuators?: unknown[] }).hapticActuators);
    this.state.rumble = this.rumbleSupported;
    document.dispatchEvent(new CustomEvent("pad-connected", { detail: { name: this.state.profile.name } }));
  }

  private onDisconnect(e: GamepadEvent): void {
    if (e.gamepad.index !== this.index) return;
    this.state.connected = false;
    this.index = -1;
    document.dispatchEvent(new CustomEvent("pad-disconnected"));
  }

  get profile(): PadProfile {
    return PAD_PROFILES[this.profileId];
  }

  get current(): PadState {
    return this.state;
  }

  setDeadZone(v: number): void {
    this.deadZone = clamp(v, 0, 0.5);
  }

  setSensitivity(v: number): void {
    this.sensitivity = clamp(v, 0.3, 2);
  }

  setCurve(v: number): void {
    this.curve = clamp(v, 0.5, 3);
  }

  /** 毎フレーム呼ぶ。dt は秒。 */
  poll(dt: number): PadState {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        gp = p;
        break;
      }
    }
    if (!gp) {
      if (this.state.connected) {
        this.state.connected = false;
        for (const k of Object.keys(this.state.buttons) as GamepadButtonName[]) {
          this.state.buttons[k] = 0;
          this.state.rawButtons[k] = false;
        }
      }
      this.state.lastActive += dt;
      return this.state;
    }
    if (!this.state.connected) {
      this.onConnect({ gamepad: gp } as GamepadEvent);
    }

    const std = gp.mapping === "standard";
    const table = std ? STD_BUTTONS : this.profileId === "switchpro" ? FALLBACK_BUTTONS : STD_BUTTONS;

    let anyActivity = false;
    for (const name of Object.keys(table) as GamepadButtonName[]) {
      const idx = table[name];
      const btn = gp.buttons[idx];
      const value = btn ? (typeof btn === "object" ? btn.value : btn) : 0;
      const pressed = btn ? (typeof btn === "object" ? btn.pressed || value > 0.1 : value > 0.5) : false;
      const prevRaw = this.state.rawButtons[name];
      const prevVal = this.state.buttons[name];
      if (pressed !== prevRaw) anyActivity = true;

      if (name === "LT" || name === "RT") {
        // デジタルなら擬似アナログ
        const isDigital = value === 0 || value === 1;
        if (isDigital) {
          const target = pressed ? 1 : 0;
          const rate = target > this.pseudoTrigger[name] ? 4.5 : 8.0;
          this.pseudoTrigger[name] = moveTowards(this.pseudoTrigger[name], target, rate * dt);
          this.state.buttons[name] = this.pseudoTrigger[name];
        } else {
          this.state.buttons[name] = value < this.triggerDeadZone ? 0 : (value - this.triggerDeadZone) / (1 - this.triggerDeadZone);
          this.pseudoTrigger[name] = this.state.buttons[name];
        }
      } else {
        this.state.buttons[name] = pressed ? (value > 0.1 ? value : 1) : 0;
      }
      this.state.rawButtons[name] = pressed;
      if (Math.abs(prevVal - this.state.buttons[name]) > 0.05) anyActivity = true;
    }

    // スティック(放射状デッドゾーン)
    const lxRaw = gp.axes[0] ?? 0;
    const lyRaw = gp.axes[1] ?? 0;
    const rxRaw = gp.axes[2] ?? 0;
    const ryRaw = gp.axes[3] ?? 0;
    const applyRadial = (x: number, y: number): [number, number] => {
      const mag = Math.hypot(x, y);
      if (mag < this.deadZone) return [0, 0];
      const norm = clamp01((mag - this.deadZone) / (1 - this.deadZone));
      const scaled = signPow(norm * this.sensitivity, this.curve);
      const nx = x / mag;
      const ny = y / mag;
      return [nx * scaled, ny * scaled];
    };
    const [lx, ly] = applyRadial(lxRaw, lyRaw);
    const [rx, ry] = applyRadial(rxRaw, ryRaw);
    const prevLx = this.state.axes.lx;
    const prevLy = this.state.axes.ly;
    this.state.axes.lx = lx;
    this.state.axes.ly = this.invertY ? -ly : ly;
    this.state.axes.rx = rx;
    this.state.axes.ry = ry;
    if (Math.abs(prevLx - lx) > 0.06 || Math.abs(prevLy - ly) > 0.06) anyActivity = true;

    if (anyActivity) {
      this.state.lastActive = 0;
      this.state.connected = true;
      this.state.profile = PAD_PROFILES[this.profileId];
    } else {
      this.state.lastActive += dt;
    }
    return this.state;
  }

  /** 振動(強さ 0..1) */
  rumble(strong: number, weak = strong, durationMs = 120): void {
    if (!this.state.connected) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[this.index] as (Gamepad & {
      vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> };
    }) | null;
    if (!gp) return;
    const s = clamp01(strong);
    const w = clamp01(weak);
    if (gp.vibrationActuator?.playEffect) {
      void gp.vibrationActuator
        .playEffect("dual-rumble", {
          startDelay: 0,
          duration: durationMs,
          weakMagnitude: w,
          strongMagnitude: s,
        })
        .catch(() => undefined);
    } else {
      const haptic = (gp as unknown as { hapticActuators?: Array<{ pulse?: (v: number, ms: number) => void }> })
        .hapticActuators;
      haptic?.[0]?.pulse?.(s, durationMs);
    }
  }

  /** 路面・エンジンに応じた連続振動 */
  roadFeel(intensity: number, dt: number): void {
    this.rumbleTimer = (this.rumbleTimer ?? 0) + dt;
    if (this.rumbleTimer < 0.05) return;
    this.rumbleTimer = 0;
    if (intensity > 0.02) this.rumble(clamp01(intensity * 0.7), clamp01(intensity), 60);
  }

  private rumbleTimer = 0;
}

function moveTowards(a: number, b: number, d: number): number {
  if (Math.abs(b - a) <= d) return b;
  return a + Math.sign(b - a) * d;
}

export { lerp, Ema };
