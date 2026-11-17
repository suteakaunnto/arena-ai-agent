/**
 * input/Bindings.ts
 * 責務: ゲーム内アクションの定義と、デバイス別の既定割当・保存/復元・重複検出
 * 公開API: ActionId, ACTIONS, DEFAULT_BINDINGS, BindingStore
 * 依存: なし(純データ + localStorage)
 *
 * 設計メモ:
 *  - ゲーム側は「アクション」だけを見る。デバイスの違いはここで吸収する。
 *  - ボタンは「位置」基準(下ボタン = Xbox A / Switch Pro B)。
 *  - KeyboardEvent.code 基準なので AZERTY 等でも物理位置が同じなら同じ動作になる。
 */

export type ActionId =
  | "accelerate"
  | "brake"
  | "steerLeft"
  | "steerRight"
  | "handbrake"
  | "shiftUp"
  | "shiftDown"
  | "camera"
  | "lookBack"
  | "rewind"
  | "lights"
  | "horn"
  | "map"
  | "pause"
  | "photo"
  | "reset"
  | "autopilot";

export interface ActionDef {
  id: ActionId;
  name: string;
  /** アナログ値を持つか(ステア/アクセルなど) */
  analog: boolean;
  /** メニューでも使うか */
  ui: boolean;
  group: "drive" | "camera" | "system";
}

export const ACTIONS: ActionDef[] = [
  { id: "accelerate", name: "アクセル", analog: true, ui: false, group: "drive" },
  { id: "brake", name: "ブレーキ / 後退", analog: true, ui: false, group: "drive" },
  { id: "steerLeft", name: "ステア左", analog: true, ui: true, group: "drive" },
  { id: "steerRight", name: "ステア右", analog: true, ui: true, group: "drive" },
  { id: "handbrake", name: "ハンドブレーキ", analog: true, ui: false, group: "drive" },
  { id: "shiftUp", name: "ギアアップ", analog: false, ui: true, group: "drive" },
  { id: "shiftDown", name: "ギアダウン", analog: false, ui: true, group: "drive" },
  { id: "camera", name: "視点切替", analog: false, ui: false, group: "camera" },
  { id: "lookBack", name: "後方確認", analog: false, ui: false, group: "camera" },
  { id: "rewind", name: "リワインド", analog: false, ui: false, group: "system" },
  { id: "lights", name: "ライト", analog: false, ui: false, group: "system" },
  { id: "horn", name: "ホーン", analog: false, ui: false, group: "system" },
  { id: "map", name: "マップ", analog: false, ui: true, group: "system" },
  { id: "pause", name: "ポーズ", analog: false, ui: true, group: "system" },
  { id: "photo", name: "フォトモード", analog: false, ui: false, group: "system" },
  { id: "reset", name: "リセット(コースへ戻す)", analog: false, ui: false, group: "system" },
  { id: "autopilot", name: "自動走行", analog: false, ui: false, group: "system" },
];

export interface KeyboardBinding {
  /** KeyboardEvent.code の配列(1アクションに複数) */
  codes: string[];
}

export type GamepadButtonName =
  | "A" | "B" | "X" | "Y"
  | "LB" | "RB" | "LT" | "RT"
  | "Back" | "Start" | "LS" | "RS"
  | "Up" | "Down" | "Left" | "Right";

export interface PadBinding {
  buttons: GamepadButtonName[];
  /** 軸を使うか(ステア) */
  axis?: "lx" | "ly" | "rx" | "ry";
}

export interface Bindings {
  keyboard: Record<ActionId, KeyboardBinding>;
  gamepad: Record<ActionId, PadBinding>;
}

const kb = (...codes: string[]): KeyboardBinding => ({ codes });
const pad = (buttons: GamepadButtonName[], axis?: PadBinding["axis"]): PadBinding => ({ buttons, axis });

/** 既定の割当(設計書の割当表に準拠) */
export function defaultBindings(): Bindings {
  const keyboard: Record<ActionId, KeyboardBinding> = {
    accelerate: kb("KeyW", "ArrowUp"),
    brake: kb("KeyS", "ArrowDown"),
    steerLeft: kb("KeyA", "ArrowLeft"),
    steerRight: kb("KeyD", "ArrowRight"),
    handbrake: kb("Space"),
    shiftUp: kb("KeyE"),
    shiftDown: kb("KeyQ"),
    camera: kb("KeyC"),
    lookBack: kb("KeyZ"),
    rewind: kb("Backspace"),
    lights: kb("KeyL"),
    horn: kb("KeyH"),
    map: kb("KeyM"),
    pause: kb("Escape", "KeyP"),
    photo: kb("KeyF"),
    reset: kb("KeyR"),
    autopilot: kb("KeyT"),
  };
  const gamepad: Record<ActionId, PadBinding> = {
    accelerate: pad(["RT"]),
    brake: pad(["LT"]),
    steerLeft: pad([], "lx"),
    steerRight: pad([], "lx"),
    handbrake: pad(["A"]),
    shiftUp: pad(["RB"]),
    shiftDown: pad(["LB"]),
    camera: pad(["Y"]),
    lookBack: pad(["RS"]),
    rewind: pad(["X"]),
    lights: pad(["Up"]),
    horn: pad(["LS"]),
    map: pad(["Back"]),
    pause: pad(["Start"]),
    photo: pad(["Down"]),
    reset: pad(["LB", "RB"]),
    autopilot: pad(["Down", "Start"]),
  };
  return { keyboard, gamepad };
}

/* ------------------------------------------------------------------ */
/* 保存                                                               */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "costa_sol_bindings_v1";

export class BindingStore {
  private bindings: Bindings;

  constructor() {
    this.bindings = defaultBindings();
    this.load();
  }

  get current(): Bindings {
    return this.bindings;
  }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Bindings>;
      if (parsed.keyboard) {
        for (const k of Object.keys(this.bindings.keyboard) as ActionId[]) {
          const v = parsed.keyboard[k];
          if (v && Array.isArray(v.codes)) this.bindings.keyboard[k] = { codes: v.codes };
        }
      }
      if (parsed.gamepad) {
        for (const k of Object.keys(this.bindings.gamepad) as ActionId[]) {
          const v = parsed.gamepad[k];
          if (v && Array.isArray(v.buttons)) {
            this.bindings.gamepad[k] = { buttons: v.buttons, axis: v.axis };
          }
        }
      }
    } catch {
      /* 破損データは無視 */
    }
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    } catch {
      /* 容量不足などは無視 */
    }
  }

  reset(): void {
    this.bindings = defaultBindings();
    this.save();
  }

  /** キーを 1 つ割り当てる(既存の重複は外す) */
  assignKey(action: ActionId, code: string): void {
    const b = this.bindings.keyboard[action];
    if (!b.codes.includes(code)) b.codes.push(code);
    this.save();
  }

  clearKey(action: ActionId, code: string): void {
    const b = this.bindings.keyboard[action];
    b.codes = b.codes.filter((c) => c !== code);
    this.save();
  }

  /** 重複しているアクションを検出 */
  findConflicts(): Array<{ code: string; actions: ActionId[] }> {
    const map = new Map<string, ActionId[]>();
    for (const [action, b] of Object.entries(this.bindings.keyboard) as Array<[ActionId, KeyboardBinding]>) {
      for (const code of b.codes) {
        const arr = map.get(code) ?? [];
        arr.push(action);
        map.set(code, arr);
      }
    }
    return [...map.entries()]
      .filter(([, actions]) => actions.length > 1)
      .map(([code, actions]) => ({ code, actions }));
  }

  /** アクションに対応するキー表示文字列 */
  label(action: ActionId): string {
    return this.bindings.keyboard[action].codes.map(keyLabel).join(" / ") || "未割当";
  }
}

/** KeyboardEvent.code → 表示用ラベル */
export function keyLabel(code: string): string {
  const map: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Space: "Space",
    Escape: "Esc",
    Backspace: "Backspace",
    Enter: "Enter",
    ShiftLeft: "LShift",
    ShiftRight: "RShift",
    ControlLeft: "LCtrl",
    ControlRight: "RCtrl",
    AltLeft: "LAlt",
    AltRight: "RAlt",
    Tab: "Tab",
    KeyW: "W",
    KeyA: "A",
    KeyS: "S",
    KeyD: "D",
    KeyQ: "Q",
    KeyE: "E",
    KeyR: "R",
    KeyT: "T",
    KeyF: "F",
    KeyG: "G",
    KeyH: "H",
    KeyJ: "J",
    KeyK: "K",
    KeyL: "L",
    KeyZ: "Z",
    KeyX: "X",
    KeyC: "C",
    KeyV: "V",
    KeyB: "B",
    KeyN: "N",
    KeyM: "M",
    Digit1: "1",
    Digit2: "2",
    Digit3: "3",
    Digit4: "4",
    Digit5: "5",
    Digit6: "6",
  };
  return map[code] ?? code.replace("Key", "").replace("Digit", "");
}
