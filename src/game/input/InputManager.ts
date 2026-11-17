/**
 * input/InputManager.ts
 * 責務: デバイス抽象化。キーボード/ゲームパッド/タッチを「アクション」へ集約し、
 *       ホットスワップ(最後に使った入力でUI表示を切替)を行う
 * 公開API: InputManager, InputSnapshot, DeviceKind
 * 依存: input/Keyboard.ts, input/Gamepad.ts, input/Touch.ts, input/Bindings.ts, input/SteeringFilter.ts
 *
 * 設計メモ:
 *  - ゲーム側が読むのは InputSnapshot のみ。デバイスを切り替えても同じ車が同じように動く。
 *  - アナログ入力があるデバイスが最後に操作されたら、その値を優先する。
 *  - 毎フレーム1回 poll() し、物理ステップへは最新値を渡す(入力遅延を最小化)。
 */
import { KeyboardManager } from "./Keyboard.js";
import { GamepadManager, PadProfile } from "./Gamepad.js";
import { TouchManager } from "./Touch.js";
import { ActionId, BindingStore, ACTIONS, keyLabel } from "./Bindings.js";
import { SteeringFilter, ThrottleFilter, DEFAULT_STEERING, SteeringConfig } from "./SteeringFilter.js";
import { clamp, clamp01 } from "../core/math.js";

export type DeviceKind = "keyboard" | "touch" | "gamepad";

export interface InputSnapshot {
  /** -1(左) .. 1(右) */
  steer: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** 0..1 */
  handbrake: number;
  /** 1回だけ立つボタン */
  pressed: Set<ActionId>;
  /** 押されているアクション */
  held: Set<ActionId>;
  /** 使用中のデバイス */
  device: DeviceKind;
  /** パッドのプロファイル(接続時) */
  padProfile: PadProfile | null;
  /** リマップ画面用: 今押された生キー */
  lastRawKey: string | null;
  /** メニュー操作用のフォーカス移動(-1/0/1) */
  uiNav: { x: number; y: number };
  uiAccept: boolean;
  uiBack: boolean;
  /** タッチのアナログ位置など(デバッグ用) */
  debug: { steerRaw: number; throttleRaw: number; brakeRaw: number };
}

export class InputManager {
  readonly keyboard: KeyboardManager;
  readonly gamepad: GamepadManager;
  readonly touch: TouchManager;
  readonly bindings: BindingStore;
  readonly steering: SteeringFilter;
  readonly throttleFilter: ThrottleFilter;

  private device: DeviceKind = "keyboard";
  private prevHeld = new Set<ActionId>();
  private held = new Set<ActionId>();
  private pressed = new Set<ActionId>();
  private snapshot: InputSnapshot;
  private uiNavPrev = { x: 0, y: 0 };
  private enabled = true;
  private steerRaw = 0;
  private throttleRaw = 0;
  private brakeRaw = 0;
  private handbrakeRaw = 0;
  private lastSteerDevice: DeviceKind = "keyboard";
  private padSteerDeadband = 0.02;

  constructor(container: HTMLElement) {
    this.keyboard = new KeyboardManager();
    this.gamepad = new GamepadManager();
    this.touch = new TouchManager(container);
    this.bindings = new BindingStore();
    this.steering = new SteeringFilter();
    this.throttleFilter = new ThrottleFilter();

    this.snapshot = {
      steer: 0,
      throttle: 0,
      brake: 0,
      handbrake: 0,
      pressed: new Set(),
      held: new Set(),
      device: "keyboard",
      padProfile: null,
      lastRawKey: null,
      uiNav: { x: 0, y: 0 },
      uiAccept: false,
      uiBack: false,
      debug: { steerRaw: 0, throttleRaw: 0, brakeRaw: 0 },
    };

    window.addEventListener("keydown", (e) => {
      this.snapshot.lastRawKey = e.code;
    });
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) {
      this.held.clear();
      this.steering.reset();
      this.throttleFilter.reset();
    }
  }

  setSteeringConfig(c: Partial<SteeringConfig>): void {
    this.steering.setConfig(c);
  }

  get currentDevice(): DeviceKind {
    return this.device;
  }

  /** 毎フレーム1回呼ぶ */
  poll(dt: number, speedKmh = 0): InputSnapshot {
    const pads = this.gamepad.poll(dt);
    this.touch.update(dt);

    const held = new Set<ActionId>();
    const pressed = new Set<ActionId>();
    const b = this.bindings.current;

    // --- キーボード ---
    let kbActive = false;
    for (const action of ACTIONS) {
      const codes = b.keyboard[action.id].codes;
      if (codes.length === 0) continue;
      if (this.keyboard.anyDown(codes)) {
        held.add(action.id);
        kbActive = true;
      }
      if (this.keyboard.anyPressed(codes)) pressed.add(action.id);
    }

    // --- ゲームパッド ---
    let padActive = false;
    if (pads.connected) {
      for (const action of ACTIONS) {
        const binding = b.gamepad[action.id];
        if (!binding) continue;
        let active = false;
        for (const btn of binding.buttons) {
          if (pads.buttons[btn] > 0.35) active = true;
        }
        if (active) {
          held.add(action.id);
          padActive = true;
        }
        if (active && !this.prevHeld.has(action.id)) pressed.add(action.id);
      }
      if (pads.lastActive < 0.25) padActive = true;
    }

    // --- タッチ ---
    const touchActive = this.touch.isActive;
    if (this.touch.enabled) {
      for (const action of this.touch.heldActions()) held.add(action);
      for (const action of this.touch.pressedActions()) pressed.add(action);
      // タッチのアナログ
      if (this.touch.steerActive) held.add(this.touch.steerValue > 0 ? "steerRight" : "steerLeft");
    }

    if (!this.enabled) {
      held.clear();
      pressed.clear();
    }

    this.pressed = pressed;
    this.held = held;

    // --- デバイス判定(最後に使った入力) ---
    if (padActive && pads.lastActive < 0.2) this.device = "gamepad";
    else if (kbActive) this.device = "keyboard";
    else if (touchActive) this.device = "touch";
    if (this.gamepad.current.connected && this.device === "gamepad") {
      this.snapshot.padProfile = this.gamepad.profile;
    } else if (this.device === "gamepad") {
      this.snapshot.padProfile = this.gamepad.profile;
    } else {
      this.snapshot.padProfile = pads.connected ? this.gamepad.profile : null;
    }

    // --- アナログ値の解決 ---
    // ステア: パッド > タッチ > キーボード
    const padSteer = Math.abs(pads.axes.lx) > this.padSteerDeadband ? clamp(pads.axes.lx, -1, 1) : 0;
    const kbLeft = held.has("steerLeft");
    const kbRight = held.has("steerRight");
    let steerInput = 0;
    let steerDigital = true;

    if (this.device === "gamepad" && padSteer !== 0) {
      steerInput = padSteer;
      steerDigital = false;
      this.lastSteerDevice = "gamepad";
    } else if (this.device === "touch" && this.touch.steerActive) {
      steerInput = clamp(this.touch.steerValue, -1, 1);
      steerDigital = !this.touch.steerAnalog;
      this.lastSteerDevice = "touch";
    } else if (kbLeft || kbRight) {
      steerInput = (kbRight ? 1 : 0) - (kbLeft ? 1 : 0);
      steerDigital = true;
      this.lastSteerDevice = "keyboard";
    } else if (this.lastSteerDevice === "gamepad" && padSteer !== 0) {
      steerInput = padSteer;
      steerDigital = false;
    } else if (this.touch.enabled && this.touch.steerActive) {
      steerInput = clamp(this.touch.steerValue, -1, 1);
      steerDigital = !this.touch.steerAnalog;
    }

    // タッチのステアが「ボタン式」の場合はデジタル扱い
    this.steerRaw = steerInput;
    this.steering.setInput(steerInput, steerDigital, dt, speedKmh);

    // スロットル/ブレーキ
    let throttle = held.has("accelerate") ? 1 : 0;
    let brake = held.has("brake") ? 1 : 0;
    let digitalThrottle = true;

    if (pads.connected) {
      const rt = pads.buttons.RT;
      const lt = pads.buttons.LT;
      if (rt > 0.02) {
        throttle = Math.max(throttle, rt);
        digitalThrottle = false;
      }
      if (lt > 0.02) {
        brake = Math.max(brake, lt);
        digitalThrottle = false;
      }
    }
    if (this.touch.enabled) {
      if (this.touch.throttle > 0.01) {
        throttle = Math.max(throttle, this.touch.throttle);
        digitalThrottle = false;
      }
      if (this.touch.brake > 0.01) {
        brake = Math.max(brake, this.touch.brake);
        digitalThrottle = false;
      }
    }
    this.throttleRaw = throttle;
    this.brakeRaw = brake;
    this.handbrakeRaw = held.has("handbrake") ? 1 : 0;

    this.throttleFilter.update(throttle, brake, dt, digitalThrottle);

    // UI ナビゲーション
    const navX =
      (held.has("steerRight") ? 1 : 0) - (held.has("steerLeft") ? 1 : 0) ||
      (Math.abs(pads.axes.lx) > 0.55 ? Math.sign(pads.axes.lx) : 0);
    const navY =
      (this.keyboard.anyDown(["ArrowDown"]) ? 1 : 0) - (this.keyboard.anyDown(["ArrowUp"]) ? 1 : 0);
    const uiNav = { x: navX, y: navY };
    // エッジ検出
    const navEdge = {
      x: this.uiNavPrev.x === 0 ? navX : 0,
      y: this.uiNavPrev.y === 0 ? navY : 0,
    };
    this.uiNavPrev = uiNav;

    const uiAccept =
      pressed.has("handbrake") ||
      this.keyboard.anyPressed(["Enter", "NumpadEnter"]) ||
      (pads.connected && this.edgePadButton(pads.buttons.A)) ||
      this.touch.pressedActions().size > 0;
    const uiBack = pressed.has("pause") || this.keyboard.anyPressed(["Escape"]) || pressed.has("rewind");

    this.snapshot = {
      steer: this.steering.value,
      throttle: this.throttleFilter.throttle,
      brake: this.throttleFilter.brake,
      handbrake: this.handbrakeRaw,
      pressed,
      held,
      device: this.device,
      padProfile: this.snapshot.padProfile,
      lastRawKey: this.snapshot.lastRawKey,
      uiNav: navEdge,
      uiAccept,
      uiBack,
      debug: { steerRaw: this.steerRaw, throttleRaw: this.throttleRaw, brakeRaw: this.brakeRaw },
    };

    this.prevHeld = new Set(held);
    this.keyboard.endFrame(dt);
    this.touch.endFrame();
    return this.snapshot;
  }

  private prevPadA = 0;
  private edgePadButton(v: number): boolean {
    const now = v > 0.5 ? 1 : 0;
    const edge = now === 1 && this.prevPadA === 0;
    this.prevPadA = now;
    return edge;
  }

  get state(): InputSnapshot {
    return this.snapshot;
  }

  /** アクションが押された瞬間か */
  wasPressed(action: ActionId): boolean {
    return this.pressed.has(action);
  }

  isHeld(action: ActionId): boolean {
    return this.held.has(action);
  }

  /** デバイスに応じたアクションの表示ラベル */
  actionLabel(action: ActionId): string {
    if (this.device === "touch") {
      const map: Record<ActionId, string> = {
        accelerate: "右ペダル",
        brake: "左ペダル",
        steerLeft: "ステア",
        steerRight: "ステア",
        handbrake: "HB",
        shiftUp: "▲",
        shiftDown: "▼",
        camera: "カメラ",
        lookBack: "長押し",
        rewind: "巻戻",
        lights: "ライト",
        horn: "ホーン",
        map: "マップ",
        pause: "ポーズ",
        photo: "フォト",
        reset: "リセット",
        autopilot: "自動",
      };
      return map[action] ?? action;
    }
    if (this.device === "gamepad") {
      const profile = this.gamepad.profile;
      const padLabels: Partial<Record<ActionId, string>> = {
        handbrake: profile.labels.south,
        camera: profile.labels.north,
        lookBack: "RS",
        rewind: profile.labels.west,
        lights: "十字↑",
        horn: "LS",
        map: "Back",
        pause: "Start",
        photo: "十字↓",
        reset: "LB+RB",
        autopilot: "↓+Start",
        shiftUp: "RB",
        shiftDown: "LB",
        accelerate: "RT",
        brake: "LT",
        steerLeft: "Lスティック",
        steerRight: "Lスティック",
      };
      return padLabels[action] ?? action;
    }
    const codes = this.bindings.current.keyboard[action].codes;
    return codes.map(keyLabel).join(" / ") || "—";
  }

  /** 設定保存 */
  saveBindings(): void {
    this.bindings.save();
  }

  dispose(): void {
    this.keyboard.dispose();
    this.touch.dispose();
  }
}

export { clamp01, DEFAULT_STEERING };
