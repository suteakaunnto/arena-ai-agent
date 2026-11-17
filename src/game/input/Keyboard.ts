/**
 * input/Keyboard.ts
 * 責務: KeyboardEvent.code ベースの入力収集、複数キー割当、デジタル→アナログ変換の前段
 * 公開API: KeyboardManager
 * 依存: input/Bindings.ts
 *
 * 設計メモ:
 *  - 押下状態は Set で管理し、キーリピートは無視。
 *  - Space / 矢印キーのスクロールを抑止。
 *  - ブラウザのショートカット(Ctrl+W 等)は尊重し、修飾キー併用時は無視する。
 */

export class KeyboardManager {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();
  private enabled = true;
  /** 最後に押されたキーの時刻 */
  lastActivity = 1e9;
  /** テキスト入力中は無効化 */
  private typing = false;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  setTyping(v: boolean): void {
    this.typing = v;
    if (v) this.down.clear();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.typing) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

    if (!this.down.has(e.code)) {
      this.pressedThisFrame.add(e.code);
    }
    this.down.add(e.code);
    this.lastActivity = 0;

    // スクロール/既定動作の抑止
    if (
      e.code === "Space" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowDown" ||
      e.code === "ArrowLeft" ||
      e.code === "ArrowRight" ||
      e.code === "Backspace" ||
      e.code === "Tab"
    ) {
      if (e.code !== "Tab" || this.enabled) e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    this.releasedThisFrame.add(e.code);
    this.lastActivity = 0;
  };

  private onBlur = (): void => {
    for (const code of this.down) this.releasedThisFrame.add(code);
    this.down.clear();
  };

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  anyDown(codes: string[]): boolean {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  anyPressed(codes: string[]): boolean {
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  /** フレーム末に呼ぶ */
  endFrame(dt: number): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.lastActivity += dt;
  }

  get isActive(): boolean {
    return this.lastActivity < 0.4;
  }

  /** 押されているキー数(テレメトリ用) */
  get activeCount(): number {
    return this.down.size;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.down.clear();
  }
}
