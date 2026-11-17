/**
 * core/state.ts
 * 責務: ゲーム全体の状態機械(タイトル / ガレージ / 走行 / ポーズ / マップ / リザルト)と簡易イベントバス
 * 公開API: GameState, GameStateMachine, EventBus
 * 依存: なし
 */

export type GameScreen = "loading" | "title" | "garage" | "driving" | "paused" | "map" | "photo" | "results" | "settings";

export interface ScreenTransition {
  from: GameScreen;
  to: GameScreen;
  at: number;
}

export type Listener = (payload?: unknown) => void;

export class EventBus {
  private map = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(event: string, payload?: unknown): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[event:${event}]`, e);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export class GameStateMachine {
  private screen: GameScreen = "loading";
  private history: ScreenTransition[] = [];
  readonly bus = new EventBus();

  get current(): GameScreen {
    return this.screen;
  }

  is(...screens: GameScreen[]): boolean {
    return screens.includes(this.screen);
  }

  transition(to: GameScreen): boolean {
    if (to === this.screen) return false;
    // 不正な遷移を防止
    const from = this.screen;
    const valid: Record<GameScreen, GameScreen[]> = {
      loading: ["title"],
      title: ["garage", "driving", "settings"],
      garage: ["title", "driving", "settings"],
      driving: ["paused", "map", "photo", "results", "garage", "title"],
      paused: ["driving", "settings", "garage", "title"],
      map: ["driving"],
      photo: ["driving"],
      results: ["garage", "driving", "title"],
      settings: ["title", "garage", "paused"],
    };
    if (!valid[from].includes(to)) {
      // 強制遷移は許可するがログを残す
      console.warn(`[state] unusual transition ${from} -> ${to}`);
    }
    this.history.push({ from, to, at: performance.now() });
    if (this.history.length > 40) this.history.shift();
    this.screen = to;
    this.bus.emit("screen", { from, to });
    return true;
  }

  /** ポーズ中か(時間を止めるべきか) */
  get isSimulationPaused(): boolean {
    return this.screen === "paused" || this.screen === "map" || this.screen === "settings" || this.screen === "title" || this.screen === "garage";
  }

  get isDriving(): boolean {
    return this.screen === "driving";
  }
}
