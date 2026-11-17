/**
 * systems/Save.ts
 * 責務: localStorage への進行・設定・発見済みエリアの保存
 * 公開API: SaveSystem
 * 依存: なし
 */
export interface SaveData {
  carId: string;
  quality: number;
  hour: number;
  weather: string;
  discovered: string[];
  bestDrift: number;
  totalDistanceKm: number;
  money: number;
  paintColor?: number;
}

const KEY = "costa_sol_save_v1";

const DEFAULTS: SaveData = {
  carId: "vela_gt",
  quality: 2,
  hour: 16.5,
  weather: "clear",
  discovered: [],
  bestDrift: 0,
  totalDistanceKm: 0,
  money: 0,
};

export class SaveSystem {
  private data: SaveData;
  private timer: number | null = null;

  constructor() {
    this.data = this.load();
  }

  private load(): SaveData {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
    }
  }

  get<K extends keyof SaveData>(key: K, fallback: SaveData[K]): SaveData[K] {
    const v = this.data[key];
    return (v === undefined || v === null ? fallback : v) as SaveData[K];
  }

  set<K extends keyof SaveData>(key: K, value: SaveData[K]): void {
    this.data[key] = value;
    this.scheduleSave();
  }

  discover(id: string): boolean {
    if (this.data.discovered.includes(id)) return false;
    this.data.discovered.push(id);
    this.scheduleSave();
    return true;
  }

  private scheduleSave(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      try {
        localStorage.setItem(KEY, JSON.stringify(this.data));
      } catch {
        /* 容量不足などは無視 */
      }
    }, 400);
  }

  get all(): SaveData {
    return this.data;
  }

  reset(): void {
    this.data = { ...DEFAULTS };
    this.scheduleSave();
  }
}
