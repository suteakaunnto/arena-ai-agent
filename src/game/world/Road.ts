/**
 * world/Road.ts
 * 責務: スプライン道路の生成・サンプリング・空間インデックス・路面メッシュ・路面テクスチャ
 * 公開API: RoadClass, RoadDef, Road, RoadNetwork, ROAD_STYLES, buildRoadTexture
 * 依存: core/math.ts, world/Noise.ts, world/Terrain.ts, world/WorldConfig.ts
 *
 * 設計メモ:
 *  - 道路は「制御点 → Catmull-Rom → 一定間隔サンプル」で作る。
 *  - 高さは地形の生高さを平滑化して決める(最大勾配を制限)。
 *  - 地形は道路の高さへ整地される(Terrain.addFlattenZone)。
 *  - 空間グリッドで「最寄りの道路・横距離・進行方向」を高速に引ける。
 */
import * as THREE from "three";
import { clamp, clamp01, lerp, catmullRom1, smoothstep, Rng } from "../core/math.js";
import { SimplexNoise, fbm2 } from "./Noise.js";
import { Terrain } from "./Terrain.js";
import { SETTLEMENTS, WORLD } from "./WorldConfig.js";

export type RoadClass = "highway" | "arterial" | "mountain" | "dirt" | "street";

export interface RoadStyle {
  cls: RoadClass;
  /** 舗装幅(m) */
  width: number;
  /** 路肩幅(m) */
  shoulder: number;
  /** 上限勾配(ラジアン近似) */
  maxGrade: number;
  /** 曲率上限(1/m) */
  maxCurvature: number;
  /** バンク最大角 */
  maxBank: number;
  /** グリップ係数(1.0 = ドライ舗装) */
  grip: number;
  /** 基本制限速度(km/h) */
  speedLimit: number;
  /** 縁石・ガードレール */
  guardrail: boolean;
  /** 色 */
  color: string;
  /** サンプル間隔(m) */
  spacing: number;
}

export const ROAD_STYLES: Record<RoadClass, RoadStyle> = {
  highway: {
    cls: "highway",
    width: 16,
    shoulder: 3,
    maxGrade: 0.085,
    maxCurvature: 1 / 95,
    maxBank: 0.075,
    grip: 1.0,
    speedLimit: 150,
    guardrail: true,
    color: "#3a3a3f",
    spacing: 8,
  },
  arterial: {
    cls: "arterial",
    width: 11,
    shoulder: 2.2,
    maxGrade: 0.1,
    maxCurvature: 1 / 65,
    maxBank: 0.06,
    grip: 0.98,
    speedLimit: 110,
    guardrail: true,
    color: "#3d3d42",
    spacing: 7,
  },
  mountain: {
    cls: "mountain",
    width: 8.4,
    shoulder: 1.4,
    maxGrade: 0.14,
    maxCurvature: 1 / 34,
    maxBank: 0.05,
    grip: 0.94,
    speedLimit: 80,
    guardrail: true,
    color: "#43434a",
    spacing: 6,
  },
  dirt: {
    cls: "dirt",
    width: 7.5,
    shoulder: 2.5,
    maxGrade: 0.18,
    maxCurvature: 1 / 38,
    maxBank: 0.04,
    grip: 0.76,
    speedLimit: 70,
    guardrail: false,
    color: "#8a6a48",
    spacing: 7,
  },
  street: {
    cls: "street",
    width: 8,
    shoulder: 2,
    maxGrade: 0.12,
    maxCurvature: 1 / 28,
    maxBank: 0.03,
    grip: 0.97,
    speedLimit: 60,
    guardrail: false,
    color: "#414147",
    spacing: 6,
  },
};

export interface RoadDef {
  id: string;
  name: string;
  cls: RoadClass;
  /** 制御点(x, z)。closed なら自動で周回 */
  points: Array<[number, number]>;
  closed?: boolean;
}

export interface RoadSample {
  x: number;
  y: number;
  z: number;
  /** 接線(正規化) */
  tx: number;
  tz: number;
  /** 左法線 */
  nx: number;
  nz: number;
  /** 進行距離 */
  s: number;
  width: number;
  shoulder: number;
  bank: number;
  curvature: number;
  grip: number;
}

export interface RoadQuery {
  road: Road | null;
  sampleIndex: number;
  /** 横方向オフセット(m)。+ が左 */
  lateral: number;
  /** 中心線からの距離(m) */
  distance: number;
  /** 進行距離 s */
  s: number;
  onRoad: boolean;
  grip: number;
  /** 路面の高さ */
  y: number;
  /** 道路の進行方向(ラジアン、XZ平面) */
  heading: number;
}

/** サンプル空間グリッド */
const GRID_CELL = 96;

export class Road {
  readonly style: RoadStyle;
  readonly samples: RoadSample[] = [];
  readonly length: number;
  readonly closed: boolean;
  readonly id: string;
  readonly name: string;
  /** 空間グリッド: セルキー → サンプルインデックス */
  readonly grid = new Map<number, number[]>();
  /** バウンディングボックス */
  readonly bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  /** 法面の広がりを決めるために地形を参照する */
  private terrainRef: { rawHeight(x: number, z: number): number } | null = null;

  setTerrain(terrain: { rawHeight(x: number, z: number): number }): void {
    this.terrainRef = terrain;
  }

  constructor(def: RoadDef, samples: RoadSample[], length: number) {
    this.id = def.id;
    this.name = def.name;
    this.style = ROAD_STYLES[def.cls];
    this.closed = !!def.closed;
    this.samples = samples;
    this.length = length;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      this.bounds.minX = Math.min(this.bounds.minX, s.x);
      this.bounds.maxX = Math.max(this.bounds.maxX, s.x);
      this.bounds.minZ = Math.min(this.bounds.minZ, s.z);
      this.bounds.maxZ = Math.max(this.bounds.maxZ, s.z);
      const key = cellKey(Math.floor(s.x / GRID_CELL), Math.floor(s.z / GRID_CELL));
      let arr = this.grid.get(key);
      if (!arr) {
        arr = [];
        this.grid.set(key, arr);
      }
      arr.push(i);
    }
  }

  sampleAtS(s: number): RoadSample {
    const n = this.samples.length;
    const idx = clamp(Math.floor((s / this.length) * (n - 1)), 0, n - 1);
    return this.samples[idx];
  }

  indexAtS(s: number): number {
    const n = this.samples.length;
    return clamp(Math.floor((s / this.length) * (n - 1)), 0, n - 1);
  }

  /**
   * 路面高さ場への寄与。道路の中心線から横方向にどれだけ離れているかで重みを決める。
   * 路面の下では重み1(完全に路面高さ)、路肩の外では 0 へなだらかに落ちる。
   */
  heightContribution(x: number, z: number, out: { height: number; weight: number; cut: number; fill: number }): void {
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    let bestD2 = Infinity;
    let bestIdx = -1;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.grid.get(cellKey(cx + dx, cz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const sm = this.samples[arr[k]];
          const d2 = (sm.x - x) * (sm.x - x) + (sm.z - z) * (sm.z - z);
          if (d2 < bestD2) {
            bestD2 = d2;
            bestIdx = arr[k];
          }
        }
      }
    }
    if (bestIdx < 0) return;
    const n = this.samples.length;
    // 隣接セグメントへ射影して高さを線形補間
    let bestT = 0;
    let bestSeg = -1;
    let bestSegD = Infinity;
    for (const cand of [bestIdx - 1, bestIdx]) {
      if (cand < 0 || cand >= n - 1) continue;
      const a = this.samples[cand];
      const b = this.samples[cand + 1];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const len2 = vx * vx + vz * vz || 1;
      let t = ((x - a.x) * vx + (z - a.z) * vz) / len2;
      t = clamp(t, 0, 1);
      const px = a.x + vx * t;
      const pz = a.z + vz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestSegD) {
        bestSegD = d;
        bestSeg = cand;
        bestT = t;
      }
    }
    let y: number;
    let halfWidth: number;
    if (bestSeg >= 0) {
      const a = this.samples[bestSeg];
      const b = this.samples[bestSeg + 1];
      y = a.y + (b.y - a.y) * bestT;
      halfWidth = (a.width + (b.width - a.width) * bestT) * 0.5;
    } else {
      const sm = this.samples[bestIdx];
      y = sm.y;
      halfWidth = sm.width * 0.5;
    }
    // 海上の区間は「土手道(コーズウェイ)」として地形ごと路面高さまで持ち上げる。
    //  (ここで何もしないと路面が宙に浮き、車が海へ落ちる)

    const dist = Math.sqrt(bestD2);
    const shoulder = this.style.shoulder;
    // 舗装内は完全一致、路肩で徐々に地形へ戻す
    // 舗装内(半幅の 85% まで)は「完全に路面と同じ高さ」。ここが 1 でないと
    //  車が路面メッシュと地形の間に挟まって跳ねる。
    //  その外側は路肩→法面として滑らかに地形へ戻す。
    const inner = halfWidth * 0.85;
    // 法面の幅は「路面と地形の高低差」に比例させる。
    //  ここを固定 30m にすると、切り通し(最大 70m)では勾配 1:0.4 = 68 度の
    //  壁になっていた。高低差 1m あたり 1.6m の法面を確保して 32 度程度に保つ。
    const cutDepth = this.terrainRef ? Math.abs(y - this.terrainRef.rawHeight(x, z)) : 0;
    const slopeRun = clamp(cutDepth * 1.6, 14, 120);
    const outer = halfWidth * 1.15 + shoulder + slopeRun;
    if (dist > outer) return;
    const w = dist <= inner ? 1 : 1 - smoothstep(inner, outer, dist);
    if (w <= 0.001) return;
    // 他道路と競合した場合は「重みの大きい方(=より近い道路)」を採用する。
    // ここで平均すると、離れた道路の高さが混ざって地形に段差ができる。
    if (w > out.weight) {
      out.height = y;
      out.weight = w;
      out.cut = this.style.cls === "street" ? 10 : 26;
      out.fill = this.style.cls === "street" ? 10 : 26;
    }
  }

  /** 位置と向きから「道路上の投影点」を返す(物理・AI用) */
  project(x: number, z: number): RoadQuery {
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.grid.get(cellKey(cx + dx, cz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const idx = arr[k];
          const sm = this.samples[idx];
          const d2 = (sm.x - x) * (sm.x - x) + (sm.z - z) * (sm.z - z);
          if (d2 < bestD2) {
            bestD2 = d2;
            bestIdx = idx;
          }
        }
      }
    }
    if (bestIdx < 0) {
      return {
        road: this,
        sampleIndex: 0,
        lateral: Infinity,
        distance: Infinity,
        s: 0,
        onRoad: false,
        grip: 0.8,
        y: 0,
        heading: 0,
      };
    }
    // 前後セグメントへ射影して精度を上げる
    let best: { idx: number; t: number; d: number } = { idx: bestIdx, t: 0, d: Math.sqrt(bestD2) };
    for (const cand of [bestIdx - 1, bestIdx]) {
      const n = this.samples.length;
      if (cand < 0 || cand >= n - 1) continue;
      const a = this.samples[cand];
      const b = this.samples[cand + 1];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const len2 = vx * vx + vz * vz || 1;
      const t = clamp01(((x - a.x) * vx + (z - a.z) * vz) / len2);
      const px = a.x + vx * t;
      const pz = a.z + vz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.d) best = { idx: cand, t, d };
    }
    const n = this.samples.length;
    const idx = clamp(best.idx, 0, n - 2);
    const a = this.samples[idx];
    const b = this.samples[Math.min(n - 1, idx + 1)];
    const px = lerp(a.x, b.x, best.t);
    const py = lerp(a.y, b.y, best.t);
    const pz = lerp(a.z, b.z, best.t);
    const heading = Math.atan2(b.z - a.z, b.x - a.x);
    const nx = Math.cos(heading + Math.PI / 2);
    const nz = Math.sin(heading + Math.PI / 2);
    const lateral = (x - px) * nx + (z - pz) * nz;
    const halfWidth = lerp(a.width, b.width, best.t) * 0.5;
    const grip = lerp(a.grip, b.grip, best.t);
    return {
      road: this,
      sampleIndex: idx,
      lateral,
      distance: best.d,
      s: lerp(a.s, a.s + (b.s - a.s), best.t),
      onRoad: Math.abs(lateral) <= halfWidth,
      grip,
      y: py,
      heading,
    };
  }

  /** 指定 s と横オフセットからワールド座標を得る(AI/交通/ルート用) */
  pointAt(s: number, lateral = 0, out = new THREE.Vector3()): THREE.Vector3 {
    const idx = this.indexAtS(s);
    const sm = this.samples[idx];
    return out.set(sm.x + sm.nx * lateral, sm.y + sm.bank * lateral, sm.z + sm.nz * lateral);
  }

  /** 曲率が大きい区間の割合(統計用) */
  curvatureStats(): { max: number; avg: number } {
    let max = 0;
    let sum = 0;
    for (const s of this.samples) {
      max = Math.max(max, Math.abs(s.curvature));
      sum += Math.abs(s.curvature);
    }
    return { max, avg: sum / this.samples.length };
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 8192) * 16384 + (cz + 8192);
}

/* ------------------------------------------------------------------ */
/* 道路網                                                             */
/* ------------------------------------------------------------------ */

export interface RouteStop {
  x: number;
  z: number;
  name: string;
}

export class RoadNetwork {
  readonly roads: Road[] = [];
  readonly grid = new Map<number, Road[]>();
  readonly group = new THREE.Group();
  readonly guardrailGroup = new THREE.Group();
  private materials = new Map<RoadClass, THREE.Material>();
  private guardrailMat: THREE.Material;
  private postMat: THREE.Material;
  totalLength = 0;

  constructor(private terrain: Terrain) {
    this.group.name = "roads";
    this.guardrailGroup.name = "guardrails";
    this.guardrailMat = new THREE.MeshStandardMaterial({
      color: 0xb0b6bd,
      roughness: 0.42,
      metalness: 0.85,
    });
    this.postMat = new THREE.MeshStandardMaterial({ color: 0x6f747a, roughness: 0.7, metalness: 0.4 });
    for (const cls of Object.keys(ROAD_STYLES) as RoadClass[]) {
      this.materials.set(
        cls,
        new THREE.MeshStandardMaterial({
          map: buildRoadTexture(ROAD_STYLES[cls]),
          roughness: cls === "dirt" ? 0.92 : 0.72,
          metalness: 0.08,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        })
      );
    }
  }

  /* ----------------------------- 生成 ----------------------------- */

  /** 制御点列から道路を構築(高さは地形に沿わせて平滑化) */
  private buildRoad(def: RoadDef, seed: number): Road {
    const style = ROAD_STYLES[def.cls];
    const pts = def.points;
    const closed = !!def.closed;
    const n = pts.length;
    const rng = new Rng(seed);

    // 1) 密な点に展開(Catmull-Rom)
    const dense: Array<[number, number]> = [];
    const segCount = closed ? n : n - 1;
    const SUB = 18;
    for (let i = 0; i < segCount; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i % n];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB;
        dense.push([
          catmullRom1(p0[0], p1[0], p2[0], p3[0], t),
          catmullRom1(p0[1], p1[1], p2[1], p3[1], t),
        ]);
      }
    }
    // 非閉路は終点を、閉路は始点を末尾に足して経路を閉じる。
    //  (閉路でこれを忘れると最後の1区間が欠落し、環状線が数百m 途切れる)
    if (!closed) dense.push(pts[n - 1]);
    else dense.push([dense[0][0], dense[0][1]]);

    // 2) 一定間隔に再サンプル
    const spacing = style.spacing;
    const resampled: Array<[number, number]> = [];
    let carry = 0;
    resampled.push([dense[0][0], dense[0][1]]);
    for (let i = 1; i < dense.length; i++) {
      const ax = dense[i - 1][0];
      const az = dense[i - 1][1];
      const bx = dense[i][0];
      const bz = dense[i][1];
      const dx = bx - ax;
      const dz = bz - az;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-5) continue;
      const ux = dx / segLen;
      const uz = dz / segLen;
      // carry は「直前のサンプルからこのセグメント開始点までの距離」
      let travelled = spacing - carry;
      while (travelled <= segLen) {
        resampled.push([ax + ux * travelled, az + uz * travelled]);
        travelled += spacing;
      }
      carry = segLen - (travelled - spacing);
    }

    // 3) 地形に沿った高さ(平滑化)
    const m = resampled.length;
    const rawH = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      rawH[i] = this.terrain.rawHeight(resampled[i][0], resampled[i][1]);
      // 水面下は「橋」として扱う: 路面高さは下げず、地形側の高さ場を無効化する。
      //  (ここで rawH を持ち上げるとクランプ/平滑化の基準が壊れて段差になる)
      //  死海のような陸地の窪地(標高 -100m)は水面ではないので持ち上げない。
      //  ここで一律 2.6m にすると、窪地の道路だけ 60〜100m の高架になる。
      if (rawH[i] < 1.2 && rawH[i] > -1.5) rawH[i] = 2.6;
    }
    // 既存の道路と交差する地点では高さを合わせる(インターチェンジの溶接)。
    //  ここを揃えないと、交差点で 10〜30m の段差が地形に残り、車が落ちる。
    if (this.roads.length > 0) {
      const WELD_R = 26;
      const WELD_W = Math.max(1, Math.round(WELD_R / spacing));
      for (let i = 0; i < m; i++) {
        const [x, z] = resampled[i];
        // 注意: ここではまだ indexNetwork() が走っていないので this.nearest() は使えない。
        //       既存道路のサンプルを直接走査する(道路生成は起動時の一度きり)。
        let bestD = Infinity;
        let bestY = 0;
        for (const other of this.roads) {
          if (
            x < other.bounds.minX - WELD_R || x > other.bounds.maxX + WELD_R ||
            z < other.bounds.minZ - WELD_R || z > other.bounds.maxZ + WELD_R
          ) {
            continue;
          }
          const stepJ = Math.max(1, Math.floor(other.samples.length / 600));
          for (let j = 0; j < other.samples.length; j += stepJ) {
            const o = other.samples[j];
            const d = Math.hypot(o.x - x, o.z - z);
            if (d < bestD) {
              bestD = d;
              bestY = o.y;
            }
          }
        }
        if (bestD > WELD_R) continue;
        // 近いほど強く既存道路の高さへ寄せる(勾配制限の前に効かせる)
        const t = 1 - smoothstep(0, WELD_R, bestD);
        rawH[i] += (bestY - rawH[i]) * t;
      }
      // 溶接点の前後もなめらかに(急な折れを作らない)
      const tmpR = Float32Array.from(rawH);
      for (let i = 0; i < m; i++) {
        let sum = 0;
        let cnt = 0;
        for (let k = -WELD_W; k <= WELD_W; k++) {
          let j = i + k;
          if (closed) j = ((j % m) + m) % m;
          else j = clamp(j, 0, m - 1);
          sum += tmpR[j];
          cnt++;
        }
        rawH[i] = rawH[i] * 0.5 + (sum / cnt) * 0.5;
      }
    }

    /* ---------------------------------------------------------------- */
    /* 高さの決定                                                        */
    /*                                                                   */
    /*  「路面の高さ」は 2 つの制約を同時に満たす必要がある:              */
    /*    (A) 勾配が道路種別の上限を超えない(車が登れない/跳ねる)       */
    /*    (B) 地形から離れすぎない(離すと法面が壁になり段差になる)        */
    /*  どちらも凸な制約なので、交互射影で解く:                           */
    /*    1) 地形±MAX_DEV の箱へクランプ                                 */
    /*    2) 勾配の緩和(超過した辺の両端を半分ずつ寄せる)                 */
    /*  2) は対称更新なので閉路の高さ合計が保存され、始端と終端が          */
    /*  食い違わない。長い環状線は収束が遅いのでスイープ数を多めに取る。    */
    /* ---------------------------------------------------------------- */

    const segN = closed ? m : m - 1;
    /** 辺 i の実距離(m)。再サンプル端数で 5〜10m にばらつく。 */
    const segLen = new Float32Array(m);
    for (let i = 0; i < segN; i++) {
      const j = (i + 1) % m;
      segLen[i] = Math.max(0.5, Math.hypot(resampled[j][0] - resampled[i][0], resampled[j][1] - resampled[i][1]));
    }
    if (!closed) segLen[m - 1] = segLen[Math.max(0, m - 2)];

    /**
     * 辺 i の許容高低差(m)。
     *
     *  「地形からの偏差」を絶対制約、「勾配」を相対的な目安として扱う。
     *  地形から 100m 以上離れた路面(=山を貫くトンネルや宙に浮く橋)は
     *  どう描いても破綻するので、そちらを先に守る。勾配はその範囲で
     *  できるだけ抑える。基準は道路種別の maxGrade、上限は 3 倍かつ 32%。
     */
    const gradeSoft = Math.tan(style.maxGrade);
    const gradeCeil = Math.min(0.34, gradeSoft * 3);
    const riseSoft = new Float32Array(m);
    const riseCeil = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      riseSoft[i] = gradeSoft * segLen[i];
      riseCeil[i] = gradeCeil * segLen[i];
    }

    /**
     * 実際に使う許容高低差。地形が急で基準勾配では通れない区間だけ、
     * 上限(32% かつ 基準の 3 倍)まで自動的に緩める。
     *  山腹の連絡路は 10% では登れず、地形から 260m 下(トンネル)になってしまう。
     *  その場合は勾配を譲る方が破綻が小さい。
     */
    const allowance = (out: Float32Array): void => {
      for (let i = 0; i < m; i++) {
        out[i] = riseSoft[i];
        if (!closed && i === m - 1) continue;
        const j = (i + 1) % m;
        const natural = Math.abs(rawH[j] - rawH[i]);
        if (natural <= riseSoft[i]) continue;
        // 地形が急なら許容も広げる(最大で基準勾配の 3 倍 = 山道 42%)
        out[i] = Math.min(Math.max(riseSoft[i], natural * 1.15), riseCeil[i]);
      }
    };
    const riseAllow = new Float32Array(m);
    allowance(riseAllow);

    /** 勾配の緩和 1 スイープ(前進 + 後退)。超過分を両端で半分ずつ受け持つ。 */
    const gradeSweep = (y: Float32Array, limit: Float32Array): void => {
      for (let dir = 0; dir < 2; dir++) {
        for (let k = 0; k < segN; k++) {
          const i = dir === 0 ? k : segN - 1 - k;
          const j = (i + 1) % m;
          const lim = limit[i];
          const d = y[j] - y[i];
          if (d > lim) {
            const ex = (d - lim) * 0.5;
            y[j] -= ex;
            y[i] += ex;
          } else if (d < -lim) {
            const ex = (-d - lim) * 0.5;
            y[j] += ex;
            y[i] -= ex;
          }
        }
      }
    };

    /** 地形からの偏差上限。路面をこれ以上離すと法面が壁(またはトンネル)になる。 */
    const MAX_DEV =
      style.cls === "street" ? 12 : style.cls === "mountain" || style.cls === "dirt" ? 70 : 45;
    const clampDev = (y: Float32Array): number => {
      let moved = 0;
      for (let i = 0; i < m; i++) {
        const c = clamp(y[i], Math.max(rawH[i] - MAX_DEV, 2.2), rawH[i] + MAX_DEV);
        moved += Math.abs(c - y[i]);
        y[i] = c;
      }
      return moved;
    };

    // 1) 地形のローパス(5点重み付き平均 × 120 回 ≒ 標準偏差 15 サンプル)
    //    生の地形をそのまま使うと細かい起伏が残り、路面が波打つ。
    const h = new Float32Array(m);
    {
      let cur = Float32Array.from(rawH);
      let nxt = new Float32Array(m);
      const nb = (i: number, d: number): number =>
        closed ? (((i + d) % m) + m) % m : clamp(i + d, 0, m - 1);
      for (let pass = 0; pass < 120; pass++) {
        for (let i = 0; i < m; i++) {
          nxt[i] =
            (cur[nb(i, -2)] + 4 * cur[nb(i, -1)] + 6 * cur[i] + 4 * cur[nb(i, 1)] + cur[nb(i, 2)]) / 16;
        }
        const t = cur;
        cur = nxt;
        nxt = t;
      }
      h.set(cur);
    }

    // 2) 偏差クランプ(絶対制約)→ 勾配緩和(目安)の交互射影。
    //    対称ガウス=ザイデルなので閉路の高さ合計は保存され、始端と終端が
    //    食い違わない。まず緩い上限で大枠を作り、次に厳しい上限へ寄せる。
    clampDev(h);
    for (let pass = 0; pass < 40; pass++) {
      gradeSweep(h, riseCeil);
      clampDev(h);
    }
    for (let pass = 0; pass < 40; pass++) {
      gradeSweep(h, riseAllow);
      clampDev(h);
    }
    // 3) 勾配を確定させる。ここでは緩和だけでなく「傾き空間の射影」も併用し、
    //    緩和が振動して残すスパイクを消す。地形偏差は法面で吸収するので、
    //    クランプはソフト(上限の 4 倍)に留める。
    for (let i = 0; i < 240; i++) gradeSweep(h, riseAllow);
    // 傾き空間の射影(閉路は定数シフトで Σ=0)
    const projectNow = (): void => {
      const d = new Float32Array(m);
      for (let i = 0; i < segN; i++) {
        const j = (i + 1) % m;
        d[i] = clamp(h[j] - h[i], -riseAllow[i], riseAllow[i]);
      }
      if (closed) {
        let maxA = 0;
        for (let i = 0; i < m; i++) maxA = Math.max(maxA, riseAllow[i]);
        let lo = -2 * maxA;
        let hi = 2 * maxA;
        for (let it = 0; it < 70; it++) {
          const c = (lo + hi) * 0.5;
          let acc = 0;
          for (let i = 0; i < m; i++) acc += clamp(d[i] - c, -riseAllow[i], riseAllow[i]);
          if (acc > 0) lo = c;
          else hi = c;
        }
        const c = (lo + hi) * 0.5;
        for (let i = 0; i < m; i++) d[i] = clamp(d[i] - c, -riseAllow[i], riseAllow[i]);
      }
      const y = new Float32Array(m);
      y[0] = h[0];
      for (let i = 0; i < m - 1; i++) y[i + 1] = y[i] + d[i];
      let meanY = 0;
      let meanH = 0;
      for (let i = 0; i < m; i++) {
        meanY += y[i];
        meanH += h[i];
      }
      const shift = (meanH - meanY) / m;
      for (let i = 0; i < m; i++) h[i] = y[i] + shift;
    };
    projectNow();
    // 地形から離れすぎた点だけ、ソフトに押し戻してからもう一度射影する。
    //  閾値は MAX_DEV の 4 倍。これを超えると法面が 100m 級になり壁になる。
    const softLimit = MAX_DEV * 4;
    for (let pass = 0; pass < 8; pass++) {
      let moved = 0;
      for (let i = 0; i < m; i++) {
        const lo = Math.max(rawH[i] - softLimit, 2.2);
        const hi = rawH[i] + softLimit;
        const c = clamp(h[i], lo, hi);
        moved += Math.abs(c - h[i]);
        h[i] = c;
      }
      projectNow();
      if (moved / m < 0.05) break;
    }

    // 4) 開放端(行き止まり)は地形へなじませる。
    //    平滑化フィルタが端も平均してしまうため、端の高さが地形から数十mずれると
    //    地形側に巨大な段差ができる。端から 60m かけて地形高へ寄せる。
    if (!closed) {
      const blendN = Math.max(2, Math.min(m - 1, Math.round(60 / spacing)));
      for (let k = 0; k < blendN; k++) {
        const t = 1 - k / blendN;
        const w = t * t * (3 - 2 * t);
        h[k] += (rawH[k] - h[k]) * w;
        h[m - 1 - k] += (rawH[m - 1 - k] - h[m - 1 - k]) * w;
      }
      for (let i = 0; i < 200; i++) gradeSweep(h, riseAllow);
    }

    // 5) 最終射影: 傾き空間で ±riseAllow へクリップし、閉路は定数シフトで
    //    Σ=0 にする。緩和法が 2 周期で振動して残すスパイク(14m/19m)を、
    //    構造的に消す。勾配はここで必ず守られる。
    {
      const d = new Float32Array(m);
      for (let i = 0; i < segN; i++) {
        const j = (i + 1) % m;
        d[i] = clamp(h[j] - h[i], -riseAllow[i], riseAllow[i]);
      }
      if (closed) {
        let maxA = 0;
        for (let i = 0; i < m; i++) maxA = Math.max(maxA, riseAllow[i]);
        let lo = -2 * maxA;
        let hi = 2 * maxA;
        for (let it = 0; it < 70; it++) {
          const c = (lo + hi) * 0.5;
          let acc = 0;
          for (let i = 0; i < m; i++) acc += clamp(d[i] - c, -riseAllow[i], riseAllow[i]);
          if (acc > 0) lo = c;
          else hi = c;
        }
        const c = (lo + hi) * 0.5;
        for (let i = 0; i < m; i++) d[i] = clamp(d[i] - c, -riseAllow[i], riseAllow[i]);
      }
      // 積分(基準は現在の h[0]、全体のドリフトは平均で戻す)
      const y = new Float32Array(m);
      y[0] = h[0];
      for (let i = 0; i < m - 1; i++) y[i + 1] = y[i] + d[i];
      let meanY = 0;
      let meanH = 0;
      for (let i = 0; i < m; i++) {
        meanY += y[i];
        meanH += h[i];
      }
      const shift = (meanH - meanY) / m;
      for (let i = 0; i < m; i++) h[i] = y[i] + shift;
    }



    // 4) サンプル生成(接線・曲率・バンク)
    const samples: RoadSample[] = [];
    let s = 0;
    for (let i = 0; i < m; i++) {
      const [x, z] = resampled[i];
      const prev = resampled[(i - 1 + m) % m] ?? resampled[i];
      const next = resampled[(i + 1) % m] ?? resampled[i];
      const tx = next[0] - prev[0];
      const tz = next[1] - prev[1];
      const tl = Math.hypot(tx, tz) || 1;
      const ux = tx / tl;
      const uz = tz / tl;
      // 曲率(前 2 点との向きの差)
      let curvature = 0;
      if (i >= 4) {
        const a = resampled[(i - 4 + m) % m];
        const b = resampled[i];
        const c = resampled[(i + 4) % m];
        const abx = b[0] - a[0];
        const abz = b[1] - a[1];
        const bcx = c[0] - b[0];
        const bcz = c[1] - b[1];
        const ang = Math.atan2(abx * bcz - abz * bcx, abx * bcx + abz * bcz);
        const arc = Math.hypot(bcx, bcz) + Math.hypot(abx, abz);
        curvature = arc > 1 ? -ang / arc : 0;
      }
      const bank = clamp(curvature * 26, -style.maxBank, style.maxBank);
      const width = style.width + (style.cls === "dirt" ? rng.range(-1.2, 1.2) : 0);
      samples.push({
        x,
        y: h[i],
        z,
        tx: ux,
        tz: uz,
        nx: -uz,
        nz: ux,
        s,
        width,
        shoulder: style.shoulder,
        bank,
        curvature,
        grip: style.grip,
      });
      s += spacing;
    }
    if (closed) {
      // 閉路: 最後のサンプルは始点と重複するので、長さは「最後から始点まで」を足して確定する
      const first = samples[0];
      const last = samples[samples.length - 1];
      s = last.s + Math.hypot(first.x - last.x, first.z - last.z);
    }

    // 地形の整地は heightContribution(区間補間 + 法面)で行うため、
    // ここでの円形整地は使わない(円が重なって段差になる)。


    const road = new Road(def, samples, s);
    road.setTerrain(this.terrain);
    return road;
  }

  /* ---------------------------- ネットワーク ---------------------------- */

  /**
   * 集落と主要地点を結ぶ道路網を生成する。
   */
  generate(): void {
    const rng = new Rng(WORLD.seed + 77);
    const defs: RoadDef[] = [];

    // (a) 幹線ループ: 集落の外側を囲む大きな環状線
    //
    //  固定半径の円だと山脈(150m 超の尾根)を真っ直ぐ突っ切ってしまい、
    //  14% 勾配では登れない壁になる。そこで方位ごとに半径を選び直し、
    //  「標高が目標帯に入る」かつ「隣の方位と高さが近い」位置を通す。
    //  これで環状線は等高線沿いの緩い道になり、勾配制限と両立する。
    const RING_N = 72;
    const ringPoints: Array<[number, number]> = [];
    const ringTarget = 46;
    {
      // 方位ごとの候補半径と高さ
      const cand: Array<Array<{ r: number; h: number }>> = [];
      for (let i = 0; i < RING_N; i++) {
        const a = (i / RING_N) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const list: Array<{ r: number; h: number }> = [];
        for (let r = 2300; r <= 5400; r += 90) {
          const h = this.terrain.rawHeight(ca * r, sa * r);
          if (h > 8 && h < 210) list.push({ r, h });
        }
        cand.push(list.length > 0 ? list : [{ r: 3600, h: this.terrain.rawHeight(ca * 3600, sa * 3600) }]);
      }
      // 動的計画法: 目標高さへの近さ + 隣接方位との高低差 + 半径の滑らかさ
      const cost: number[][] = [];
      const back: number[][] = [];
      const score = (c: { r: number; h: number }, prev: { r: number; h: number } | null, a: number): number => {
        let c0 = Math.abs(c.h - ringTarget) * 0.55;
        // 海岸(-)と高山(+)を強く避ける。海は絶対に通さない。
        if (c.h < 16) c0 += (16 - c.h) * (c.h < 4 ? 40 : 8);
        if (c.h > 130) c0 += (c.h - 130) * 5;
        // 半径 3200〜4300 を好む
        c0 += Math.abs(c.r - 3600) * 0.006;
        if (prev) {
          const dH = Math.abs(c.h - prev.h);
          // 周方向の距離は約 2πr/N ≒ 470m。勾配上限 8.5% なら 40m まで許容。
          c0 += dH * 1.1;
          // 周方向の距離はおよそ 2πr/N ≒ 300m。40% なら 120m まで許容。
          if (dH > 110) c0 += (dH - 110) * 30;
          c0 += Math.abs(c.r - prev.r) * 0.02;
        }
        // 方位 90〜225 度(海側)は内陸へ寄せる
        const deg = (a * 180) / Math.PI;
        if (deg > 75 && deg < 240) c0 += Math.max(0, c.r - 1900) * 0.06;
        return c0;
      };
      for (let i = 0; i < RING_N; i++) {
        const a = (i / RING_N) * Math.PI * 2;
        cost.push(new Array(cand[i].length).fill(0));
        back.push(new Array(cand[i].length).fill(-1));
        for (let k = 0; k < cand[i].length; k++) {
          if (i === 0) {
            cost[i][k] = score(cand[i][k], null, a);
            continue;
          }
          let best = Infinity;
          let bi = -1;
          for (let j = 0; j < cand[i - 1].length; j++) {
            const v = cost[i - 1][j] + score(cand[i][k], cand[i - 1][j], a);
            if (v < best) {
              best = v;
              bi = j;
            }
          }
          cost[i][k] = best;
          back[i][k] = bi;
        }
      }
      // 最短の終点から復元(閉路なので最初と最後もつなぐ)
      let bi = 0;
      for (let k = 1; k < cand[RING_N - 1].length; k++) if (cost[RING_N - 1][k] < cost[RING_N - 1][bi]) bi = k;
      const pick: Array<{ r: number; h: number }> = new Array(RING_N);
      for (let i = RING_N - 1; i >= 0; i--) {
        pick[i] = cand[i][bi];
        bi = Math.max(0, back[i][bi]);
      }
      // 半径の平滑化はしない。
      //  平滑化すると「半径を大きく変えなければならない区間(山脈の内側→外側)」
      //  で弦ができ、その弦が尾根を突っ切って 200% 勾配の壁になる。
      //  ギザギザは経路探索側で吸収する。
      //  ただし「隣と 600m 以上違う半径」は、後段の経路探索が地形の壁を
      //  迂回しきれない原因になるので、方位方向に 1 回だけ大枠を均す。
      const rs = pick.map((p) => p.r);
      for (let i = 0; i < RING_N; i++) {
        const p0 = pick[(i - 1 + RING_N) % RING_N].r;
        const p2 = pick[(i + 1) % RING_N].r;
        const mid = (p0 + p2) * 0.5;
        if (Math.abs(rs[i] - mid) > 280) rs[i] = mid + Math.sign(rs[i] - mid) * 280;
      }
      // 方位ごとの半径は「目安」にすぎない。そのまま結ぶと尾根を突っ切り、
      // 勾配 100% 超の区間が出る。目安の間を経路探索でつなぎ、
      // 登れる道だけを通す。
      const way: Array<[number, number]> = [];
      for (let i = 0; i < RING_N; i += 8) {
        const a = (i / RING_N) * Math.PI * 2;
        way.push([Math.cos(a) * rs[i], Math.sin(a) * rs[i]]);
      }
      const hwy = ROAD_STYLES.highway;
      const rawRing: Array<[number, number]> = [];
      for (let i = 0; i < way.length; i++) {
        const from = way[i];
        const to = way[(i + 1) % way.length];
        const seg = this.routeRoad(from, to, hwy);
        for (let k = 0; k < seg.length - 1; k++) rawRing.push(seg[k]);
      }
      // 経路探索の結果は角ばっているので、端点を固定して平滑化する
      let cur = rawRing.map((p) => [p[0], p[1]] as [number, number]);
      for (let it = 0; it < 40; it++) {
        const nxt = cur.map((p) => [p[0], p[1]] as [number, number]);
        for (let i = 0; i < cur.length; i++) {
          const a0 = cur[(i - 1 + cur.length) % cur.length];
          const a2 = cur[(i + 1) % cur.length];
          nxt[i][0] = cur[i][0] * 0.5 + (a0[0] + a2[0]) * 0.25;
          nxt[i][1] = cur[i][1] * 0.5 + (a0[1] + a2[1]) * 0.25;
        }
        cur = nxt;
      }
      // 250m 間隔に間引いて、後段の Catmull-Rom に渡す
      for (let i = 0; i < cur.length; i++) {
        const prev = ringPoints[ringPoints.length - 1];
        if (prev && Math.hypot(cur[i][0] - prev[0], cur[i][1] - prev[1]) < 250) continue;
        ringPoints.push(cur[i]);
      }
      if (ringPoints.length < 8) {
        for (let i = 0; i < RING_N; i++) {
          const a = (i / RING_N) * Math.PI * 2;
          ringPoints.push([Math.cos(a) * rs[i], Math.sin(a) * rs[i]]);
        }
      }
    }
    defs.push({ id: "ring", name: "アニージョ・ハイウェイ", cls: "highway", points: ringPoints, closed: true });

    // (b) 集落への連絡路
    let connIdx = 0;
    for (const st of SETTLEMENTS) {
      const nodes = nearestRingPoints(st.x, st.z, ringPoints, 2);
      const target = nodes[0];
      // 中間点は「等高線に沿って登る」ように選ぶ。
      //  直線で結ぶと山腹を真っ直ぐ突っ切り、勾配制限では絶対に到達できない
      //  壁になる(地形の 260m 下を通る=トンネル)。標高を段階的に上げる
      //  経由点を作り、各段で勾配を稼ぐ距離を確保する。
      const dest = this.safePoint(st.x, st.z, st.kind === "city" ? 90 : 40);
      const cls: RoadClass = st.kind === "village" ? "arterial" : "highway";
      const route = this.routeRoad(target as [number, number], dest, ROAD_STYLES[cls]);
      defs.push({
        id: `conn_${st.id}_${connIdx++}`,
        name: `${st.name} 連絡路`,
        cls,
        points: route,
      });
    }

    // (c) 山道(火山・高地)
    //  手書きの制御点だと地形の壁を真っ直ぐ突っ切るので、経路探索で
    //  「登れる道」を選ばせる。
    defs.push({
      id: "volcano_pass",
      name: "クンブレス・パス",
      cls: "mountain",
      points: this.routeRoad([1500, -3800], [3900, -4900], ROAD_STYLES.mountain),
    });
    defs.push({
      id: "ridge_climb",
      name: "シエラ・アルタ 登山道",
      cls: "mountain",
      points: this.routeRoad([2500, 1500], [3300, -1500], ROAD_STYLES.mountain),
    });

    // (d) ダート(砂漠・ジャングル・遺跡)
    defs.push({
      id: "desert_dirt",
      name: "ピスタ・デ・アレナ ダート",
      cls: "dirt",
      // 西端の 2 点は海(-95m)に浸かっていたので、砂浜の内陸側へ寄せた。
      points: [
        [700, 2500],
        [1100, 3600],
        [2100, 4100],
        [3000, 3800],
        [3600, 3200],
      ],
    });
    defs.push({
      id: "jungle_dirt",
      name: "ボカ・アンチャ 林道",
      cls: "dirt",
      points: [
        [-2600, -2600],
        [-3300, -2100],
        [-3900, -1500],
        [-4400, -800],
      ],
    });
    //  遺跡は「西の海底 (-95m)」に置かれていたため、safePoint が制御点を
    //  原点付近まで引き戻し、地形から 80m 浮く周回路になっていた。
    //  乾いた台地(内陸、標高 200〜400m)へ移す。
    defs.push({
      id: "ruins_loop",
      name: "ルイナス周回路",
      cls: "dirt",
      points: [
        [400, -1200],
        [1000, -700],
        [700, -100],
        [-100, -300],
      ],
      closed: true,
    });

    // (e) 街のストリート(プエルト・ルンブレ)
    const city = SETTLEMENTS[0];
    defs.push({
      id: "city_loop",
      name: "プエルト・ルンブレ 周回路",
      cls: "street",
      points: [
        [city.x - 380, city.z - 220],
        [city.x - 60, city.z - 400],
        [city.x + 320, city.z - 260],
        [city.x + 400, city.z + 140],
        [city.x + 120, city.z + 380],
        [city.x - 300, city.z + 260],
      ],
      closed: true,
    });

    // (f) 滑走路(直線)
    defs.push({
      id: "airstrip",
      name: "ピスタ・デ・アレナ",
      cls: "highway",
      points: [
        [200, 4600],
        [1200, 4500],
        [2400, 4380],
        [3500, 4300],
      ],
    });

    // 生成
    let seed = WORLD.seed;
    for (const def of defs) {
      // 海中の制御点を陸へ寄せる
      const fixed = def.points.map(([x, z]) => this.safePoint(x, z, 30));
      const road = this.buildRoad({ ...def, points: fixed }, seed++);
      if (road.samples.length < 6) continue;
      this.roads.push(road);
      this.totalLength += road.length;
    }

    // 道路どうしの交差部の高さを溶接する(これをしないと交差点に段差が残る)
    this.weldIntersections(6, 12);
    // 溶接で崩れた勾配と地形偏差を整える(これを忘れると交差点周辺で
    // 勾配が 100% を超え、車が跳ねる)
    for (const road of this.roads) {
      this.gradeProject(
        road,
        road.style.cls === "street" ? 12 : road.style.cls === "mountain" || road.style.cls === "dirt" ? 110 : 45
      );
    }
    this.buildMeshes();
    this.indexNetwork();
    // 地形が路面高さへなじむよう、高さ場をラスタへ焼き込む
    this.terrain.bakeRoadRaster(this, 8);
  }

  /**
   * RoadNetwork 自身を高さ場として使う(Terrain.setRoadField)。
   * 最寄りの道路1本だけを見るので、交差部は片側優先になるが地形の破綻はしない。
   */
  sample(x: number, z: number): { height: number; weight: number; cut: number; fill: number } {
    const out = { height: 0, weight: 0, cut: 20, fill: 16 };
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    const seen = new Set<Road>();
    // 交差部では複数の道路が weight=1 で重なる。片方の高さだけを採用すると
    // 「もう片方の路面との段差」がそのまま地形の段差になるので、
    // 重み付き平均を取る(道路どうしは溶接でほぼ同じ高さになっている)。
    let hsum = 0;
    let wsum = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.grid.get(cellKey(cx + dx, cz + dz));
        if (!arr) continue;
        for (const road of arr) {
          if (seen.has(road)) continue;
          seen.add(road);
          const r = { height: 0, weight: 0, cut: 0, fill: 0 };
          road.heightContribution(x, z, r);
          if (r.weight <= 0.001) continue;
          hsum += r.height * r.weight;
          wsum += r.weight;
          if (r.weight > out.weight) {
            out.weight = r.weight;
            out.cut = r.cut;
            out.fill = r.fill;
          }
        }
      }
    }
    if (wsum > 1e-4) out.height = hsum / wsum;
    return out;
  }


  /**
   * 交差部の高さ溶接。
   * 道路は1本ずつ独立に高さを決めるので、交差点では 2 本の路面高さが食い違う。
   * 近接サンプル同士を数回平均化して、接続部をなめらかにつなぐ。
   */
  private weldIntersections(passes = 6, gather = 40): void {
    const all: Road[] = this.roads;
    if (all.length < 2) return;
    const R = gather;
    const R2 = R * R;
    for (let pass = 0; pass < passes; pass++) {
      const deltas = all.map((r) => new Float32Array(r.samples.length));
      const counts = all.map((r) => new Float32Array(r.samples.length));
      for (const road of all) {
        for (let i = 0; i < road.samples.length; i++) {
          const s = road.samples[i];
          // 他路線の近傍サンプルを探す
          for (const other of all) {
            if (other === road) continue;
            if (
              s.x < other.bounds.minX - R || s.x > other.bounds.maxX + R ||
              s.z < other.bounds.minZ - R || s.z > other.bounds.maxZ + R
            ) {
              continue;
            }
            // 粗い間引きで近傍を走査(十分な精度)
            const step = Math.max(1, Math.floor(other.samples.length / 400));
            let bestD2 = Infinity;
            let bestY = 0;
            for (let j = 0; j < other.samples.length; j += step) {
              const o = other.samples[j];
              const dx = o.x - s.x;
              const dz = o.z - s.z;
              const d2 = dx * dx + dz * dz;
              if (d2 < bestD2) {
                bestD2 = d2;
                bestY = o.y;
              }
            }
            if (bestD2 > R2) continue;
            const w = 1 - Math.sqrt(bestD2) / R;
            deltas[all.indexOf(road)][i] += (bestY - s.y) * w * 0.35;
            counts[all.indexOf(road)][i] += w;
          }
        }
      }
      for (let r = 0; r < all.length; r++) {
        const road = all[r];
        const d = deltas[r];
        for (let i = 0; i < road.samples.length; i++) {
          if (counts[r][i] > 1e-4) road.samples[i].y += d[i] / counts[r][i];
        }
      }
      // 交差点そのものは「両方の道路が同じ高さ」でなければならない。
      //  近傍平均だけだと、交差角度によって片方が 20m 高いまま残り、
      //  その真下を通る道路の路面が地形から浮く(または埋まる)。
      this.snapCrossings(all, 55);
    }
  }

  /**
   * 交差部の高さを一致させる。
   *  道路 A のサンプル a と道路 B のサンプル b が cros 以内にあれば、
   *  交点の高さを両者の平均へ揃える(周辺 3 サンプルずつも半分だけ寄せる)。
   */
  private snapCrossings(all: Road[], cros = 55): void {
    // 交差点では 2 本のサンプル位置が完全には一致しない(角度と間隔のため
    // 20〜50m ずれる)。ここを揃えないと、ラスタ上で片方の高さだけが採用され、
    // もう片方の路面が地形から 10m 以上浮く。
    const move = new Map<RoadSample, number[]>();
    const add = (smp: RoadSample, target: number): void => {
      let arr = move.get(smp);
      if (!arr) {
        arr = [0, 0];
        move.set(smp, arr);
      }
      arr[0] += target;
      arr[1] += 1;
    };
    for (let x = 0; x < all.length; x++) {
      const ra = all[x];
      for (const sa of ra.samples) {
        for (let y = x + 1; y < all.length; y++) {
          const rb = all[y];
          if (
            sa.x < rb.bounds.minX - cros || sa.x > rb.bounds.maxX + cros ||
            sa.z < rb.bounds.minZ - cros || sa.z > rb.bounds.maxZ + cros
          ) {
            continue;
          }
          let bestD = Infinity;
          let bestI = -1;
          for (let i = 0; i < rb.samples.length; i++) {
            const sb = rb.samples[i];
            const d = Math.hypot(sb.x - sa.x, sb.z - sa.z);
            if (d < bestD) {
              bestD = d;
              bestI = i;
            }
          }
          if (bestI < 0 || bestD > cros) continue;
          const sb = rb.samples[bestI];
          const mid = (sa.y + sb.y) * 0.5;
          add(sa, mid);
          add(sb, mid);
        }
      }
    }
    for (const [smp, acc] of move) {
      if (acc[1] > 0) smp.y = acc[0] / acc[1];
    }
  }

  /**
   * 道路の高さプロファイルを「地形から ±maxDev」かつ「勾配はできるだけ緩く」へ整える。
   *
   *  制約の優先順位:
   *    1) 地形からの偏差(絶対)。これを破ると路面が山の中(トンネル)や
   *       空中(橋)に埋もれ、走行不能な段差になる。
   *    2) 勾配(できるだけ)。基準は種別の maxGrade、上限は 3 倍かつ 32%。
   *  山腹の集落へ登る連絡路などは、勾配上限だけでは到達できずに
   *  「地形の 260m 下」になってしまう。その場合は勾配を譲る。
   *
   *  交互射影(勾配射影 ↔ 偏差クランプ)を回し、最後は必ずクランプで終える。
   *  勾配射影は対称ガウス=ザイデルなので閉路の高さ合計が保存される。
   */
  private gradeProject(road: Road, maxDev = 0): void {
    const n = road.samples.length;
    if (n < 3) return;
    const closed = road.closed;
    const segs = closed ? n : n - 1;
    const soft = Math.tan(road.style.maxGrade);
    // 地形が崖なので、上限は「基準勾配の 3 倍」かつ「絶対 38%」。
    const ceil = Math.min(0.38, Math.max(soft * 3, 0.34));
    const riseSoft = new Float32Array(n);
    const riseCeil = new Float32Array(n);
    for (let i = 0; i < segs; i++) {
      const a = road.samples[i];
      const b = road.samples[(i + 1) % n];
      const len = Math.max(0.5, Math.hypot(b.x - a.x, b.z - a.z));
      riseSoft[i] = soft * len;
      riseCeil[i] = ceil * len;
    }
    if (!closed) {
      riseSoft[n - 1] = riseSoft[Math.max(0, n - 2)];
      riseCeil[n - 1] = riseCeil[Math.max(0, n - 2)];
    }
    const sweep = (limit: Float32Array): void => {
      for (let dir = 0; dir < 2; dir++) {
        for (let k = 0; k < segs; k++) {
          const i = dir === 0 ? k : segs - 1 - k;
          const j = (i + 1) % n;
          const lim = limit[i];
          const a = road.samples[i];
          const b = road.samples[j];
          const d = b.y - a.y;
          if (d > lim) {
            const ex = (d - lim) * 0.5;
            b.y -= ex;
            a.y += ex;
          } else if (d < -lim) {
            const ex = (-d - lim) * 0.5;
            b.y += ex;
            a.y -= ex;
          }
        }
      }
    };
    /**
     * 地形からの偏差を「上限つきで」抑える。
     *  絶対に maxDev へ押し戻すと、崖を越える区間に実行不能な制約を課すことになり、
     *  勾配緩和とケンカして 60% 超のスパイクが残る。ここでは
     *  ・limit を超えた分だけ戻す(ソフトな押し戻し)
     *  ・勾配射影の後に呼ぶので、押し戻しで崩れた勾配は次の緩和で直る
     *  という形にして、勾配側を優先する。
     */
    const pullBack = (limit: number): number => {
      let moved = 0;
      for (let i = 0; i < n; i++) {
        const smp = road.samples[i];
        const base = this.terrain.rawHeight(smp.x, smp.z);
        // 路面が地形より下(切通し)は、地形より上(盛土)より高くつく。
        //  尾根を 33% で越えると路面が地形の 45m 下に潜り「堀割」になるが、
        //  盛土 45m は法面で成立するので、上下で許容量を変えて
        //  尾根越えより谷沿いを選ばせる。
        const lo = base - limit * 0.7;
        const hi = base + limit * 1.35;
        let target = smp.y;
        if (smp.y < lo) target = lo;
        else if (smp.y > hi) target = hi;
        if (target !== smp.y) {
          moved += Math.abs(target - smp.y);
          smp.y = target;
        }
      }
      return moved;
    };
    if (maxDev > 0) pullBack(maxDev);
    // 1) 緩い上限(基準勾配)で地形に沿わせる
    for (let pass = 0; pass < 12; pass++) {
      sweep(riseSoft);
      if (maxDev > 0) pullBack(maxDev * 1.6);
    }
    // 2) 勾配を上限内へ詰める。地形からは離れるが、法面が受け持つ。
    for (let pass = 0; pass < 60; pass++) sweep(riseCeil);
    // 3) 地形から離れた点を、勾配を守ったまま戻す。
    //  「地形へ引き戻す」と「勾配を詰める」を交互に回すと、両方が同時に
    //  満たせる範囲へ落ち着く(交互にしないと、引き戻しで壊れた勾配を
    //  最後の射影が直せずに段差として残る)。
    //  許容量を 3 段階に絞りながら回すと、最後は「地形に近く、勾配も守る」
    //  解に収束しやすい。一気に締めると尾根を越える区間が戻りきらない。
    if (maxDev > 0) {
      for (const scale of [2.4, 1.2, 0.6]) {
        const lim = Math.max(1.5, maxDev * scale);
        for (let pass = 0; pass < 24; pass++) {
          const moved = pullBack(lim);
          sweep(riseCeil);
          if (moved / n < 0.02) break;
        }
      }
    }
    // 4) 最後の砦。どんなに急な地形でも 33% は超えない、という絶対上限。
    //   反復の打ち切り誤差を見込んで、判定基準 34% より 1% 低く取る。
    //   これを破ると「壁を登る道路」になり、車が通れなくなる。
    //   ここまでで地形から離れた点は法面(盛土/切土)が吸収する。
    //   ※ 必ず最後に置くこと。前に置くと 3) の緩和で破られる。
    const hard = 0.33;
    const riseHard = new Float32Array(n);
    for (let i = 0; i < segs; i++) {
      const a = road.samples[i];
      const b = road.samples[(i + 1) % n];
      riseHard[i] = hard * Math.max(0.5, Math.hypot(b.x - a.x, b.z - a.z));
    }
    if (!closed) riseHard[n - 1] = riseHard[Math.max(0, n - 2)];
    // 収束するまで回す。480 サンプルの鎖では、違反が全体に薄く広がるため
    //  60 回では 37%→34% まで詰まらない(実測: 60 回で 37.1% 残存)。
    for (let pass = 0; pass < 4000; pass++) {
      let viol = 0;
      for (let i = 0; i < segs; i++) {
        const a = road.samples[i];
        const b = road.samples[(i + 1) % n];
        const ex = Math.abs(b.y - a.y) - riseHard[i];
        if (ex > viol) viol = ex;
      }
      if (viol < 1e-3) break;
      sweep(riseHard);
    }
  }

  /**
   * 2 点を結ぶ「登れる道路」の経由点を作る(グリッド上の Dijkstra)。
   *
   *  出発点と到着点の標高差が大きいと、直線経路は勾配上限を超える。
   *  上限を守ったまま直線で結ぶ解が存在しないため、地形を無視した路面
   *  (=山を貫くトンネル/宙に浮く橋)になっていた。
   *  ここでは地形を 1 格子 120m で読み、勾配が上限を超える辺は通さない。
   *  これで「登れる場所を迂回する」道が選ばれる。
   */
  private routeRoad(
    from: [number, number],
    to: [number, number],
    style: RoadStyle
  ): Array<[number, number]> {
    const CELL = 120;
    // 探索範囲は「高低差を登るのに必要な道のり」から決める。
    //  固定 900m だと、500m 先へ 260m 登る区間(必要道のり 850m)で
    //  迂回路が範囲外になり、直線(勾配 50%)にフォールバックしていた。
    const hA = this.terrain.rawHeight(from[0], from[1]);
    const hB = this.terrain.rawHeight(to[0], to[1]);
    const need = Math.abs(hB - hA) / 0.3;
    const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const MARGIN = clamp(Math.max(900, (need - span) * 0.75), 900, 3200);
    const minX = Math.min(from[0], to[0]) - MARGIN;
    const maxX = Math.max(from[0], to[0]) + MARGIN;
    const minZ = Math.min(from[1], to[1]) - MARGIN;
    const maxZ = Math.max(from[1], to[1]) + MARGIN;
    const nx = Math.max(2, Math.ceil((maxX - minX) / CELL) + 1);
    const nz = Math.max(2, Math.ceil((maxZ - minZ) / CELL) + 1);
    const total = nx * nz;
    if (total > 400000) return [from, to];
    const hgt = new Float32Array(total);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        hgt[iz * nx + ix] = this.terrain.rawHeight(minX + ix * CELL, minZ + iz * CELL);
      }
    }
    const idxOf = (x: number, z: number): number => {
      const ix = clamp(Math.round((x - minX) / CELL), 0, nx - 1);
      const iz = clamp(Math.round((z - minZ) / CELL), 0, nz - 1);
      return iz * nx + ix;
    };
    const start = idxOf(from[0], from[1]);
    const goal = idxOf(to[0], to[1]);
    if (start === goal) return [from, to];
    const hFrom = hgt[start];
    const hTo = hgt[goal];
    const climbing = hTo >= hFrom;
    // 経路探索でも 40% を絶対上限として扱う(法面なしの地形ではこれ以上は登れない)
    let gLimit = Math.max(Math.tan(style.maxGrade) * 1.15, 0.4);

    let nearGoal = false;
    let dist = new Float32Array(total).fill(Infinity);
    let prev = new Int32Array(total).fill(-1);
    let done = new Uint8Array(total);

    // 二分ヒープ(優先度付きキュー)。距離の小さいセルから取り出す。
    const hd: number[] = [];
    const hi: number[] = [];
    const heapPush = (d: number, i: number): void => {
      hd.push(d);
      hi.push(i);
      let k = hd.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (hd[p] <= hd[k]) break;
        const td = hd[p];
        const ti = hi[p];
        hd[p] = hd[k];
        hi[p] = hi[k];
        hd[k] = td;
        hi[k] = ti;
        k = p;
      }
    };
    const heapPop = (): [number, number] => {
      const outD = hd[0];
      const outI = hi[0];
      const lastD = hd.pop()!;
      const lastI = hi.pop()!;
      if (hd.length > 0) {
        hd[0] = lastD;
        hi[0] = lastI;
        let k = 0;
        for (;;) {
          const l = k * 2 + 1;
          const r = l + 1;
          let m = k;
          if (l < hd.length && hd[l] < hd[m]) m = l;
          if (r < hd.length && hd[r] < hd[m]) m = r;
          if (m === k) break;
          const td = hd[m];
          const ti = hi[m];
          hd[m] = hd[k];
          hi[m] = hi[k];
          hd[k] = td;
          hi[k] = ti;
          k = m;
        }
      }
      return [outD, outI];
    };
    const DIRS = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    /**
     * 「引き返し」を禁止する。登り区間で標高を下げる辺は高くつく。
     *  これが無いと、尾根を登ってそのまま戻る折り返し(ヘアピン)が出て、
     *  前後で高低差 ±20m のスパイクになる。
     */
    const relax = (): void => {
      hd.length = 0;
      hi.length = 0;
      heapPush(0, start);
      dist = new Float32Array(total).fill(Infinity);
      prev = new Int32Array(total).fill(-1);
      done = new Uint8Array(total);
      dist[start] = 0;
      let guard = 0;
      while (hd.length > 0 && guard++ < total * 4) {
        const [d, i] = heapPop();
        if (done[i]) continue;
        done[i] = 1;
        if (i === goal) break;
        // 終点セルが急斜面の上だと、そこへ入る辺が全て勾配超過で到達不能になる。
        // その場合だけ、ゴール近傍(2 セル以内)への到達で打ち切る。
        //  常に近傍で打ち切ると、スタートとゴールが近い場合に 1 歩で終わってしまう。
        if (nearGoal && Math.abs((i % nx) - (goal % nx)) <= 1 && Math.abs(((i / nx) | 0) - ((goal / nx) | 0)) <= 1) break;
        const ix = i % nx;
        const iz = (i / nx) | 0;
        const hi = hgt[i];
        for (const [dx, dz] of DIRS) {
          const jx = ix + dx;
          const jz = iz + dz;
          if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
          const j = jz * nx + jx;
          if (done[j]) continue;
          const hj = hgt[j];
          const len = CELL * Math.hypot(dx, dz);
          const grade = Math.abs(hj - hi) / len;
          // 勾配上限を超える辺は通行禁止にすると、急峻な地形ではスタート地点から
          // 1 セルも出られなくなる(実際に到達セル 4 個で詰まった)。
          // そこで「上限を超えた分は大きな罰則」にして、可能な限り避けつつ
          // 必要なら 1〜2 セルだけ急斜面を横切れるようにする。
          const over = Math.max(0, grade - gLimit);
          // 急坂は「通行禁止」にはしない。禁止すると山岳地帯で探索空間が閉じる。
          //  代わりに勾配超過を強く罰し、必要最小限の距離だけ急斜面を横切らせる。
          let cost = len * (1 + over * 40 + over * over * 60);
          if (hj < 8) cost += (8 - hj) * 260;
          if (grade > 0.3) cost += (grade - 0.3) * len * 120;
          // 引き返しペナルティは「大きく一気に戻る」辺だけにする。
          //  1 セルの下降まで罰すると、尾根を巻く経路(必ず少し下る)が
          //  選べず、直登しかなくなって勾配 55% になる。
          const dh = (hj - hi) * (climbing ? 1 : -1);
          if (dh < -25) cost += (-dh - 25) * 30;
          const nd = d + cost;
          if (nd < dist[j]) {
            dist[j] = nd;
            prev[j] = i;
            heapPush(nd, j);
          }
        }
      }
    };
    relax();
    // 目標セルへ到達できなければ、ゴール近傍への到達を許して再探索する。
    if (prev[goal] < 0) {
      nearGoal = true;
      relax();
    }
    // 上限を緩めてまで通すと、最終的に急斜面を直登する経路になる。
    // 緩和は 1 段(絶対上限 42%)までに留め、それでも駄目なら迂回させる。
    for (let k = 0; k < 2 && prev[goal] < 0 && gLimit < 0.42; k++) {
      gLimit = Math.min(0.42, gLimit * 1.15);
      relax();
    }
    if (prev[goal] < 0) {
      // それでも通れない(急峻すぎる)。直線で結ぶと勾配 50% 超になるので、
      // 標高を稼ぐために大きく回り込む経路を返す。
      const h0 = this.terrain.rawHeight(from[0], from[1]);
      const h1 = this.terrain.rawHeight(to[0], to[1]);
      const need = Math.abs(h1 - h0) / 0.3;
      const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const bulge = Math.max(0, need - span) * 0.6;
      const dx = (to[0] - from[0]) / Math.max(1, span);
      const dz = (to[1] - from[1]) / Math.max(1, span);
      const out: Array<[number, number]> = [];
      const N = 8;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const b = Math.sin(t * Math.PI) * bulge;
        out.push([from[0] + (to[0] - from[0]) * t - dz * b, from[1] + (to[1] - from[1]) * t + dx * b]);
      }
      return out;
    }
    const path: number[] = [];
    // 打ち切った地点(=ゴール近傍)から復元する
    let cur = -1;
    {
      let bestD = Infinity;
      for (let i = 0; i < total; i++) {
        if (!done[i]) continue;
        const d = Math.hypot((i % nx) - (goal % nx), ((i / nx) | 0) - ((goal / nx) | 0));
        if (d < bestD) {
          bestD = d;
          cur = i;
        }
      }
      if (cur < 0) cur = goal;
    }
    let hops = 0;
    while (cur >= 0 && hops++ < total) {
      path.push(cur);
      if (cur === start) break;
      cur = prev[cur];
    }
    path.reverse();
    if (path.length < 2) return [from, to];
    const out: Array<[number, number]> = [[from[0], from[1]]];
    let lastX = from[0];
    let lastZ = from[1];
    for (let k = 1; k < path.length - 1; k++) {
      const i = path[k];
      const x = minX + (i % nx) * CELL;
      const z = minZ + ((i / nx) | 0) * CELL;
      if (Math.hypot(x - lastX, z - lastZ) < 240) continue;
      out.push([x, z]);
      lastX = x;
      lastZ = z;
    }
    out.push([to[0], to[1]]);
    // グリッド経路は「階段状の直角」だらけなので、そのまま Catmull-Rom に
    // 通すと大きくオーバーシュートして道路が目標地点を突き抜ける。
    // 端点を固定したラプラシアン平滑化で角を落としてから返す。
    let smooth = out.map((p) => [p[0], p[1]] as [number, number]);
    for (let it = 0; it < 24; it++) {
      const nxt = smooth.map((p) => [p[0], p[1]] as [number, number]);
      for (let i = 1; i < smooth.length - 1; i++) {
        nxt[i][0] = smooth[i][0] * 0.5 + (smooth[i - 1][0] + smooth[i + 1][0]) * 0.25;
        nxt[i][1] = smooth[i][1] * 0.5 + (smooth[i - 1][1] + smooth[i + 1][1]) * 0.25;
      }
      smooth = nxt;
    }
    return smooth;
  }

  /** 海(=低標高)なら陸へ寄せる */  /** 海(=低標高)なら陸へ寄せる */
  private safePoint(x: number, z: number, margin: number): [number, number] {
    let px = x;
    let pz = z;
    for (let i = 0; i < 40; i++) {
      const h = this.terrain.rawHeight(px, pz);
      if (h > 4 + margin * 0.05) break;
      // 原点方向へ寄せる
      const len = Math.hypot(px, pz) || 1;
      px -= (px / len) * 70;
      pz -= (pz / len) * 70;
    }
    return [px, pz];
  }

  private buildMeshes(): void {
    const postGeom = new THREE.BoxGeometry(0.12, 0.72, 0.12);
    const railGeom = new THREE.BoxGeometry(1, 0.12, 0.03);

    for (const road of this.roads) {
      const mat = this.materials.get(road.style.cls)!;
      const geom = this.buildRibbon(road, 0, road.style.width * 0.5);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = `road_${road.id}`;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);

      // 路肩(砂利)
      if (road.style.shoulder > 0.5) {
        const shGeom = this.buildRibbon(road, road.style.width * 0.5, road.style.width * 0.5 + road.style.shoulder);
        const shMat = new THREE.MeshStandardMaterial({
          color: road.style.cls === "dirt" ? 0x9b7b55 : 0x6b6b63,
          roughness: 1,
          metalness: 0,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        });
        const shMesh = new THREE.Mesh(shGeom, shMat);
        shMesh.matrixAutoUpdate = false;
        this.group.add(shMesh);
      }

      // ガードレール
      if (road.style.guardrail) {
        this.buildGuardrails(road, postGeom, railGeom);
      }
    }
  }

  private buildRibbon(road: Road, inner: number, outer: number): THREE.BufferGeometry {
    const samples = road.samples;
    const n = samples.length;
    const positions = new Float32Array(n * 2 * 3);
    const normals = new Float32Array(n * 2 * 3);
    const uvs = new Float32Array(n * 2 * 2);
    const indices = new Uint32Array((n - 1) * 6);
    const texLen = road.style.width * 3.2;
    for (let i = 0; i < n; i++) {
      const sm = samples[i];
      const w = sm.width * 0.5;
      const iu = inner / (w || 1);
      const ou = outer / (w || 1);
      // 左
      const lx = sm.x + sm.nx * outer;
      const lz = sm.z + sm.nz * outer;
      const rx = sm.x - sm.nx * outer;
      const rz = sm.z - sm.nz * outer;

      // 舗装(inner=0)は平坦な帯として中心高さに固定する。縁を地形に合わせると
      // 片側だけ盛り上がって路面が傾き、車が跳ねる。
      // 路肩(inner>0)は地形に沿わせて、舗装と地面の段差を埋める。
      const isShoulder = inner > 0.01;
      const yL = isShoulder ? this.terrain.heightAt(lx, lz) : sm.y;
      const yR = isShoulder ? this.terrain.heightAt(rx, rz) : sm.y;
      const yLC = Number.isFinite(yL) ? yL : sm.y;
      const yRC = Number.isFinite(yR) ? yR : sm.y;

      positions[i * 6] = lx;
      positions[i * 6 + 1] = yLC + (isShoulder ? 0.01 : 0.02);
      positions[i * 6 + 2] = lz;
      positions[i * 6 + 3] = rx;
      positions[i * 6 + 4] = yRC + (isShoulder ? 0.01 : 0.02);
      positions[i * 6 + 5] = rz;
      normals[i * 6] = 0;
      normals[i * 6 + 1] = 1;
      normals[i * 6 + 2] = 0;
      normals[i * 6 + 3] = 0;
      normals[i * 6 + 4] = 1;
      normals[i * 6 + 5] = 0;
      const v = sm.s / texLen;
      uvs[i * 4] = 0;
      uvs[i * 4 + 1] = v;
      uvs[i * 4 + 2] = 1;
      uvs[i * 4 + 3] = v;
      void iu;
      void ou;
    }
    let p = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      indices[p++] = a;
      indices[p++] = c;
      indices[p++] = b;
      indices[p++] = b;
      indices[p++] = c;
      indices[p++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeBoundingSphere();
    return g;
  }

  private buildGuardrails(road: Road, postGeom: THREE.BufferGeometry, railGeom: THREE.BufferGeometry): void {
    const samples = road.samples;
    const step = Math.max(1, Math.round(6 / road.style.spacing));
    const postCount: number[] = [];
    for (let i = 0; i < samples.length; i += step) {
      if (Math.abs(samples[i].curvature) > 0.02) continue; // 急カーブは省略(見た目優先)
      postCount.push(i);
    }
    if (postCount.length < 4) return;
    const posts = new THREE.InstancedMesh(postGeom, this.postMat, postCount.length * 2);
    const rails = new THREE.InstancedMesh(railGeom, this.guardrailMat, postCount.length * 2);
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);
    let k = 0;
    const dist = 6;
    for (const idx of postCount) {
      const sm = samples[idx];
      const w = sm.width * 0.5 + 0.9;
      for (const side of [1, -1]) {
        pos.set(sm.x + sm.nx * w * side, sm.y + 0.3, sm.z + sm.nz * w * side);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(sm.tx, sm.tz));
        mtx.compose(pos, q, scl);
        posts.setMatrixAt(k, mtx);
        pos.y += 0.55;
        scl.set(dist * 1.05, 1, 1);
        mtx.compose(pos, q, scl);
        rails.setMatrixAt(k, mtx);
        scl.set(1, 1, 1);
        k++;
      }
    }
    posts.count = k;
    rails.count = k;
    posts.instanceMatrix.needsUpdate = true;
    rails.instanceMatrix.needsUpdate = true;
    posts.castShadow = false;
    rails.castShadow = false;
    this.guardrailGroup.add(posts, rails);
  }

  private indexNetwork(): void {
    for (const road of this.roads) {
      const b = road.bounds;
      const minCX = Math.floor(b.minX / GRID_CELL);
      const maxCX = Math.floor(b.maxX / GRID_CELL);
      const minCZ = Math.floor(b.minZ / GRID_CELL);
      const maxCZ = Math.floor(b.maxZ / GRID_CELL);
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        for (let cx = minCX; cx <= maxCX; cx++) {
          const key = cellKey(cx, cz);
          let arr = this.grid.get(key);
          if (!arr) {
            arr = [];
            this.grid.set(key, arr);
          }
          arr.push(road);
        }
      }
    }
  }

  /** 最寄りの道路を問い合わせる(物理・AI用) */
  nearest(x: number, z: number): RoadQuery {
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    let best: RoadQuery | null = null;
    const seen = new Set<Road>();
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.grid.get(cellKey(cx + dx, cz + dz));
        if (!arr) continue;
        for (const road of arr) {
          if (seen.has(road)) continue;
          seen.add(road);
          const q = road.project(x, z);
          if (!best || q.distance < best.distance) best = q;
        }
      }
    }
    if (!best) {
      return {
        road: null,
        sampleIndex: 0,
        lateral: Infinity,
        distance: Infinity,
        s: 0,
        onRoad: false,
        grip: 0.7,
        y: this.terrain.heightAt(x, z),
        heading: 0,
      };
    }
    // 舗装外はグリップを少し落とす
    if (!best.onRoad) {
      const margin = best.distance - (best.road ? best.road.style.width * 0.5 : 0);
      best.grip = lerp(best.grip, 0.66, smoothstep(0, 12, margin));
    }
    return best;
  }

  /** 道路上のランダムな地点(交通・AI用) */
  randomPoint(rng: Rng): { x: number; z: number; heading: number; road: Road } {
    const road = rng.pick(this.roads);
    const idx = rng.int(0, road.samples.length - 1);
    const sm = road.samples[idx];
    return { x: sm.x, z: sm.z, heading: Math.atan2(sm.tz, sm.tx), road };
  }

  /** スタート地点(街の近くの舗装路) */
  findStart(): { x: number; z: number; y: number; heading: number; road: Road; s: number } {
    const city = SETTLEMENTS[0];
    let best: { road: Road; idx: number; d: number } | null = null;
    for (const road of this.roads) {
      if (road.style.cls !== "street" && road.style.cls !== "highway") continue;
      for (let i = 0; i < road.samples.length; i += 4) {
        const sm = road.samples[i];
        const d = Math.hypot(sm.x - city.x, sm.z - city.z);
        if (!best || d < best.d) best = { road, idx: i, d };
      }
    }
    if (!best) {
      const sm = this.roads[0].samples[0];
      return { x: sm.x, z: sm.z, y: sm.y, heading: Math.atan2(sm.tz, sm.tx), road: this.roads[0], s: 0 };
    }
    const sm = best.road.samples[best.idx];
    return {
      x: sm.x,
      z: sm.z,
      y: sm.y,
      heading: Math.atan2(sm.tz, sm.tx),
      road: best.road,
      s: sm.s,
    };
  }

  /**
   * 周回コースを作る: 環状線を分割し、指定長に近い閉路を返す
   */
  makeCircuit(targetLength: number): Road[] {
    const closed = this.roads.filter((r) => r.closed);
    const pool = closed.length ? closed : this.roads;
    const sorted = [...pool].sort((a, b) => Math.abs(a.length - targetLength) - Math.abs(b.length - targetLength));
    return [sorted[0]];
  }

  getStats() {
    return {
      roads: this.roads.length,
      lengthKm: +(this.totalLength / 1000).toFixed(1),
      closed: this.roads.filter((r) => r.closed).length,
    };
  }

  dispose(): void {
    for (const r of this.roads) {
      r.grid.clear();
    }
    this.roads.length = 0;
    this.grid.clear();
    for (const m of this.materials.values()) m.dispose();
    this.guardrailMat.dispose();
    this.postMat.dispose();
  }
}

function nearestRingPoints(x: number, z: number, ring: Array<[number, number]>, count: number): Array<Array<number> | [number, number]> {
  return [...ring]
    .sort((a, b) => Math.hypot(a[0] - x, a[1] - z) - Math.hypot(b[0] - x, b[1] - z))
    .slice(0, count);
}

/* ------------------------------------------------------------------ */
/* 路面テクスチャ(Canvas生成)                                        */
/* ------------------------------------------------------------------ */

export function buildRoadTexture(style: RoadStyle): THREE.Texture {
  const W = 256;
  const H = 512;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const rng = new Rng(style.cls.length * 7919 + 13);

  // アスファルト/ダートの下地
  if (style.cls === "dirt") {
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "#8b6b49");
    grad.addColorStop(0.5, "#a9855d");
    grad.addColorStop(1, "#8b6b49");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // 轍
    ctx.globalAlpha = 0.35;
    for (const x of [W * 0.26, W * 0.74]) {
      const g2 = ctx.createLinearGradient(x - 22, 0, x + 22, 0);
      g2.addColorStop(0, "rgba(120,90,60,0)");
      g2.addColorStop(0.5, "rgba(110,82,54,0.9)");
      g2.addColorStop(1, "rgba(120,90,60,0)");
      ctx.fillStyle = g2;
      ctx.fillRect(x - 22, 0, 44, H);
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < 900; i++) {
      const x = rng.next() * W;
      const y = rng.next() * H;
      const r = rng.range(0.5, 2.4);
      ctx.fillStyle = rng.bool() ? "rgba(160,130,95,0.5)" : "rgba(90,66,44,0.5)";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = "#35353a";
    ctx.fillRect(0, 0, W, H);
    // 細かい骨材
    for (let i = 0; i < 5200; i++) {
      const x = rng.next() * W;
      const y = rng.next() * H;
      const g = rng.range(38, 78);
      ctx.fillStyle = `rgba(${g},${g},${g + rng.range(-4, 6)},${rng.range(0.25, 0.75)})`;
      ctx.fillRect(x, y, rng.range(1, 2.4), rng.range(1, 2.4));
    }
    // センターライン
    if (style.cls === "highway") {
      // 4車線: 中央二重線 + 車線区切り破線
      ctx.fillStyle = "rgba(235,225,180,0.9)";
      ctx.fillRect(W * 0.5 - 4, 0, 3.2, H);
      ctx.fillRect(W * 0.5 + 1, 0, 3.2, H);
      ctx.fillStyle = "rgba(230,230,230,0.75)";
      for (const xr of [0.25, 0.75]) {
        for (let y = 0; y < H; y += 96) {
          ctx.fillRect(W * xr - 2, y, 4, 48);
        }
      }
    } else if (style.cls === "street") {
      ctx.fillStyle = "rgba(225,215,170,0.85)";
      ctx.fillRect(W * 0.5 - 2.4, 0, 4.8, H);
    } else if (style.cls === "arterial") {
      ctx.fillStyle = "rgba(232,226,190,0.85)";
      for (let y = 0; y < H; y += 80) {
        ctx.fillRect(W * 0.5 - 2.2, y, 4.4, 40);
      }
    }
    // 白い外側線
    ctx.fillStyle = "rgba(225,225,225,0.55)";
    ctx.fillRect(W * 0.045, 0, 3, H);
    ctx.fillRect(W * 0.94, 0, 3, H);
    // タイヤの汚れ
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = "#141416";
    ctx.fillRect(W * 0.1, 0, W * 0.18, H);
    ctx.fillRect(W * 0.72, 0, W * 0.18, H);
    ctx.globalAlpha = 1;
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
