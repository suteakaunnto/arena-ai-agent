/**
 * race/Circuit.ts
 * 責務: 既存の道路網から「走れる周回コース」を組み立てる
 * 公開API: Circuit, CircuitDef, CIRCUIT_DEFS, buildCircuit, buildAllCircuits
 * 依存: world/Road.ts, core/math.ts
 *
 * 設計メモ:
 *  - コースは道路そのもの。新しい形状は生成しない(路面・法面・ガードレールを
 *    持つ既存の道路メッシュをそのまま使う)。
 *  - ゲート(チェックポイント)は「道路の s 距離」に置く。判定は
 *    `road.project()` が返す s の前進で行うので、横方向のずれに強い。
 *  - 閉路でない道路はコースにしない。折り返しがあるとラップ判定が壊れるため。
 */
import { clamp } from "../core/math.js";
import type { Road, RoadNetwork } from "../world/Road.js";

export interface CircuitDef {
  id: string;
  name: string;
  /** 説明文(コース選択に出す) */
  description: string;
  /** 使用する道路 id */
  roadId: string;
  /** 難易度の目安(1〜5)。AI の速度係数に使う */
  difficulty: number;
}

export interface Gate {
  /** コース上の進行距離(m) */
  s: number;
  x: number;
  y: number;
  z: number;
  /** ゲートの向き(進行方向, XZ) */
  tx: number;
  tz: number;
  /** 幅(m)。判定に使う */
  width: number;
  /** このゲートを通過したときの区間タイム(スタートで 0) */
  split: number;
}

export class Circuit {
  readonly def: CircuitDef;
  readonly road: Road;
  readonly gates: Gate[] = [];
  /** 1 周の長さ(m) */
  readonly length: number;
  /** 推奨最高速度(km/h)。AI と難易度表示に使う */
  readonly targetSpeed: number;

  constructor(def: CircuitDef, road: Road) {
    this.def = def;
    this.road = road;
    this.length = road.length;
    this.buildGates();
    // 曲率が高いほど推奨速度を落とす。曲率は 1/m なので、旋回半径 R=1/κ で
    //  横 G の上限(約 1.0G)から速度を逆算する: v = sqrt(μ·g·R)
    const stats = road.curvatureStats();
    const kappa = Math.max(0.0006, stats.avg * 1.6);
    const R = 1 / kappa;
    const v = Math.sqrt(1.0 * 9.81 * R) * 3.6;
    this.targetSpeed = clamp(v, 60, 240);
  }

  /**
   * ゲートを等間隔に置く。
   *  12 個前後になるようにし、1 周が短い市街コースでも 8 個は確保する。
   */
  private buildGates(): void {
    const n = clamp(Math.round(this.length / 420), 8, 24);
    const step = this.length / n;
    const used = new Set<number>();
    for (let i = 0; i < n; i++) {
      // スタート/フィニッシュは必ず s=0(スタート地点と一致させる)
      const s = i === 0 ? 0 : step * i;
      const sm = this.road.samples[this.road.indexAtS(s)];
      // 同じサンプルに複数ゲートが乗ると判定が壊れるので避ける
      const key = Math.round(sm.s);
      if (used.has(key)) continue;
      used.add(key);
      this.gates.push({
        s: sm.s,
        x: sm.x,
        y: sm.y,
        z: sm.z,
        tx: sm.tx,
        tz: sm.tz,
        width: sm.width * 1.6,
        split: 0,
      });
    }
  }

  /** スタート地点(グリッド先頭) */
  get start(): Gate {
    return this.gates[0];
  }

  /**
   * 現在位置から「次に通るべきゲート」を返す。
   *  直前のゲート番号を渡し、そこから前方向に探すことで、
   *  ゲートを取りこぼしても 1 つ先まで許容する。
   */
  nextGate(lastIndex: number, x: number, z: number): number {
    const q = this.road.project(x, z);
    const s = q.s;
    const n = this.gates.length;
    // 現在の s より先にあるゲートのうち最も近いもの
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const i = (lastIndex + k) % n;
      const g = this.gates[i];
      let ds = g.s - s;
      if (ds < 0) ds += this.length;
      // 直前のゲートより後ろは無視(周回の巻き戻り防止)
      if (k === 0 && ds > this.length * 0.5) continue;
      if (ds < bestD) {
        bestD = ds;
        best = i;
      }
    }
    return best < 0 ? (lastIndex + 1) % n : best;
  }

  /**
   * ゲート通過判定。
   *  ゲート中心から横方向に width/2 以内、かつ進行方向の前後 ±8m 以内なら通過。
   *  毎フレーム呼ぶので、平方根は使わない。
   */
  isAtGate(index: number, x: number, z: number): boolean {
    const g = this.gates[index];
    if (!g) return false;
    const dx = x - g.x;
    const dz = z - g.z;
    // ゲート面の法線方向(=進行方向)成分
    const along = dx * g.tx + dz * g.tz;
    if (along < -8 || along > 8) return false;
    // 横方向成分(左法線 = (-tz, tx))
    const lateral = dx * -g.tz + dz * g.tx;
    return Math.abs(lateral) <= g.width * 0.5;
  }
}

/* ------------------------------------------------------------------ */
/* コース定義                                                          */
/* ------------------------------------------------------------------ */

/**
 * 使用する道路は閉路のみ。`ring` は 20km と長いので、
 * ショート/ミドルは市街と遺跡の周回路に割り当てる。
 */
export const CIRCUIT_DEFS: CircuitDef[] = [
  {
    id: "city_sprint",
    name: "プエルト・ルンブレ 市街周回",
    description: "街の外周を回る短いコース。路地の立ち上がりとブラインドコーナー。",
    roadId: "city_loop",
    difficulty: 1,
  },
  {
    id: "ruins_ring",
    name: "ルイナス周回路",
    description: "遺跡を囲む未舗装の周回路。路面μが低く、砂埃で視界が悪い。",
    roadId: "ruins_loop",
    difficulty: 3,
  },
  {
    id: "anillo",
    name: "アニージョ・ハイウェイ 1 周",
    description: "島を一周する 20km の本命コース。海岸線・山岳・市街をすべて通る。",
    roadId: "ring",
    difficulty: 5,
  },
];

/** 道路網から 1 コースを構築する。道路が無ければ null。 */
export function buildCircuit(def: CircuitDef, roads: RoadNetwork): Circuit | null {
  const road = roads.roads.find((r) => r.id === def.roadId);
  if (!road || !road.closed) return null;
  if (road.samples.length < 16) return null;
  return new Circuit(def, road);
}

/** 定義されている全コースのうち、実際に構築できたものを返す */
export function buildAllCircuits(roads: RoadNetwork): Circuit[] {
  const out: Circuit[] = [];
  for (const def of CIRCUIT_DEFS) {
    const c = buildCircuit(def, roads);
    if (c) out.push(c);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* タイム計測                                                          */
/* ------------------------------------------------------------------ */

/** mm:ss.mmm */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

/** 差分表示(+1.234 / -0.567) */
export function formatDelta(seconds: number): string {
  if (!isFinite(seconds)) return "";
  const sign = seconds < 0 ? "-" : "+";
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}
