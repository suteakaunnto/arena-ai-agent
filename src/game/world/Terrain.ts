/**
 * world/Terrain.ts
 * 責務: 12km四方のハイトフィールド地形(解析的・決定論的)と、3段LODのチャンクメッシュ生成
 * 公開API: Terrain (heightAt / normalAt / slopeAt / biomeAt / surfaceHeight / isWater),
 *           buildChunkGeometry(), TerrainStreamer
 * 依存: core/math.ts, world/Noise.ts, world/WorldConfig.ts
 *
 * 設計メモ:
 *  - 高さは「解析関数」で求める。物理の接地判定も同じ関数を使うので、
 *    メッシュLODによる段差がゲームプレイに影響しない。
 *  - チャンクは 256m 角。LOD0=32分割(8m) / LOD1=16分割(16m) / LOD2=8分割(32m)。
 *  - 継ぎ目はスカート(外周を下へ伸ばした帯)で隠す。
 */
import * as THREE from "three";
import { clamp, clamp01, lerp, smoothstep, Rng } from "../core/math.js";
import { SimplexNoise, fbm2, ridged2, warp2, voronoi2, valueNoise2 } from "./Noise.js";
import { BIOMES, BiomeId, LANDMARKS, SETTLEMENTS, WORLD } from "./WorldConfig.js";

const HALF = WORLD.size / 2;
/** heightAt の連続呼び出しで確保を避けるための作業領域 */
const roadSample = { height: 0, weight: 0, cut: 0, fill: 0 };

/** 道路の整地情報(道路側から書き込まれる) */
export interface FlattenZone {
  /** ワールド座標 */
  x: number;
  z: number;
  radius: number;
  /** 目標高さ */
  height: number;
  /** 場外のぼかし幅 */
  blend: number;
}

/**
 * 道路が作る高さ場。道路網を生成したあとに Terrain へ渡すと、
 * 路面の直下と路肩が滑らかにつながる(切り通し/盛り土)。
 */
/**
 * 道路網が焼き込んだ高さラスタ。
 * クエリごとに道路グリッドを引くとセル境界で参照が途切れて段差になるため、
 * 起動時に一度だけ 2D 画像として焼き、heightAt では双一次補間で参照する。
 * これにより「どこでも連続」が構造的に保証される。
 */
export interface RoadRaster {
  /** セルサイズ(m) */
  cell: number;
  /** 原点(ワールド座標の最小値) */
  minX: number;
  minZ: number;
  /** セル数 */
  nx: number;
  nz: number;
  /** 路面高さ(未舗装地点は 0) */
  height: Float32Array;
  /** 重み(0=地形そのまま, 1=路面高さ) */
  weight: Float32Array;
  /** 地形から削れる最大量(m) */
  cut: Float32Array;
  /** 地形へ盛れる最大量(m) */
  fill: Float32Array;
}

export interface TerrainSample {
  height: number;
  normal: THREE.Vector3;
  slope: number;
  biome: BiomeId;
}

export class Terrain {
  readonly noiseA: SimplexNoise;
  readonly noiseB: SimplexNoise;
  readonly noiseC: SimplexNoise;
  readonly noiseD: SimplexNoise;

  /** 道路などによる整地(空間ハッシュで参照) */
  private flattenGrid = new Map<number, FlattenZone[]>();
  private flattenCell = 512;
  /** 道路網の高さラスタ(あれば路面へブレンドする) */
  private roadRaster: RoadRaster | null = null;

  constructor(seed = WORLD.seed) {
    this.noiseA = new SimplexNoise(seed);
    this.noiseB = new SimplexNoise(seed + 1024);
    this.noiseC = new SimplexNoise(seed + 4096);
    this.noiseD = new SimplexNoise(seed + 8192);
  }

  /* ---------------------------------------------------------------- */
  /* 整地ゾーン                                                       */
  /* ---------------------------------------------------------------- */

  private cellKey(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  addFlattenZone(z: FlattenZone): void {
    const minX = Math.floor((z.x - z.radius - z.blend) / this.flattenCell);
    const maxX = Math.floor((z.x + z.radius + z.blend) / this.flattenCell);
    const minZ = Math.floor((z.z - z.radius - z.blend) / this.flattenCell);
    const maxZ = Math.floor((z.z + z.radius + z.blend) / this.flattenCell);
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const k = this.cellKey(cx, cz);
        let arr = this.flattenGrid.get(k);
        if (!arr) {
          arr = [];
          this.flattenGrid.set(k, arr);
        }
        arr.push(z);
      }
    }
  }

  clearFlattenZones(): void {
    this.flattenGrid.clear();
  }

  /** 道路網の高さラスタを設定する(道路生成後に一度だけ呼ぶ) */
  setRoadRaster(raster: RoadRaster | null): void {
    this.roadRaster = raster;
  }

  get hasRoadRaster(): boolean {
    return this.roadRaster !== null;
  }

  /**
   * 道路ラスタの双一次補間サンプル。
   * 重みも高さも連続なので、隣接する heightAt の差は必ず滑らかになる。
   */
  private sampleRoadRaster(x: number, z: number, out: { height: number; weight: number; cut: number; fill: number }): boolean {
    const R = this.roadRaster;
    if (!R) return false;
    const fx = (x - R.minX) / R.cell;
    const fz = (z - R.minZ) / R.cell;
    if (fx < 0 || fz < 0 || fx >= R.nx - 1 || fz >= R.nz - 1) return false;
    const ix = fx | 0;
    const iz = fz | 0;
    const tx = fx - ix;
    const tz = fz - iz;
    const i0 = iz * R.nx + ix;
    const i1 = i0 + 1;
    const i2 = i0 + R.nx;
    const i3 = i2 + 1;
    const w00 = (1 - tx) * (1 - tz);
    const w10 = tx * (1 - tz);
    const w01 = (1 - tx) * tz;
    const w11 = tx * tz;
    // 高さも重みも双一次補間。ただし「重み0のセル(高さ未設定=0)」が混ざって
    // 高さが引きずられないよう、重みで重み付けした平均を取る。
    const wsum = R.weight[i0] * w00 + R.weight[i1] * w10 + R.weight[i2] * w01 + R.weight[i3] * w11;
    if (wsum <= 1e-4) return false;
    const hsum =
      R.height[i0] * R.weight[i0] * w00 +
      R.height[i1] * R.weight[i1] * w10 +
      R.height[i2] * R.weight[i2] * w01 +
      R.height[i3] * R.weight[i3] * w11;
    out.weight = clamp01(wsum);
    out.height = hsum / wsum;
    out.cut = (R.cut[i0] * w00 + R.cut[i1] * w10 + R.cut[i2] * w01 + R.cut[i3] * w11);
    out.fill = (R.fill[i0] * w00 + R.fill[i1] * w10 + R.fill[i2] * w01 + R.fill[i3] * w11);
    return true;
  }

  private applyFlatten(x: number, z: number, h: number): number {
    if (this.flattenGrid.size === 0) return h;
    const cx = Math.floor(x / this.flattenCell);
    const cz = Math.floor(z / this.flattenCell);
    const arr = this.flattenGrid.get(this.cellKey(cx, cz));
    if (!arr) return h;
    let out = h;
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      const dx = x - f.x;
      const dz = z - f.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > f.radius + f.blend) continue;
      const w = 1 - smoothstep(f.radius, f.radius + f.blend, d);
      out = lerp(out, f.height, w);
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* 高さ関数                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * 生の地形高さ(整地前)。海面は 0m。
   */
  rawHeight(x: number, z: number): number {
    const nx = x / HALF;
    const nz = z / HALF;

    // 大きなうねり
    const [wx, wz] = warp2(this.noiseA, x * 0.00035, z * 0.00035, 1.9, 1.0);
    const swell = fbm2(this.noiseA, wx * 0.9, wz * 0.9, { octaves: 4, gain: 0.52 });

    // 海岸線: 西と南西が海。ノイズでギザギザにする
    const shoreNoise = fbm2(this.noiseB, x * 0.0006, z * 0.0006, { octaves: 3 }) * 0.09;
    const coast = -nx * 0.72 + nz * 0.26 + shoreNoise;

    // 東の山脈(火山へ向かって立ち上がる)。
    //  ラクナリティ/ゲインを少し下げると、尾根の最高高度はほぼ保ったまま
    //  8m 格子での最大傾斜が 50m → 38m 程度に緩む(垂直の崖が消える)。
    const ridge = ridged2(this.noiseB, x * 0.0003, z * 0.0003, 4, 1.8, 0.42);
    const mountainMask = smoothstep(0.05, 0.85, nx + swell * 0.25);
    let h = 12 + swell * 34;
    // 振幅: 尾根の局所傾斜が 8m 格子で 40m 未満に収まる値。
    //  (470 だと尾根の肩が 76° になり、LOD0 メッシュでも壁に見える)
    h += Math.max(0, ridge) * 412 * mountainMask;

    // 火山(コーン+カルデラ)
    const volc = LANDMARKS.find((l) => l.kind === "volcano")!;
    const vdx = x - volc.x;
    const vdz = z - volc.z;
    const vdist = Math.sqrt(vdx * vdx + vdz * vdz);
    // 火山(コーン+カルデラ)。
    //  ここは「地形との max」なので、項が外側で 0 に戻らないと切れ目が崖になる。
    //  コーン(coneR)も麓の底上げ(base)も半径の外で完全に 0 へ落とし、
    //  さらに max を滑らかな max(softmax)にして折れ目も消す。
    const coneR = 1250;
    {
      const t = clamp01(1 - vdist / coneR);
      // 指数 2.1: 山麓がなだらかになり、道路が登れる勾配に収まる
      const cone = Math.pow(t, 2.1) * 780;
      const crater = smoothstep(0.93, 1.0, t) * 80;
      // 麓の底上げ(火口から 1750m で 0)
      const base = 50 * smoothstep(coneR * 1.4, coneR * 0.5, vdist);
      const volcanoH = cone - crater + base;
      const d = h - volcanoH;
      // 平滑 max: d>>0 なら h、d<<0 なら volcanoH。境界で微分可能。
      h = volcanoH + 0.5 * (d + Math.sqrt(d * d + 64));
    }

    // 湖とダム(湿地)
    const lakeX = -1100;
    const lakeZ = -3050;
    const ldx = x - lakeX;
    const ldz = z - lakeZ;
    const ldist = Math.sqrt(ldx * ldx + ldz * ldz);
    const lakeMask = 1 - smoothstep(1150, 1900, ldist);
    if (lakeMask > 0) {
      const basin = -38 * lakeMask * (1 - smoothstep(0, 900, ldist));
      h = lerp(h, Math.min(h, 6), lakeMask * 0.55) + basin;
    }

    // 海岸の落ち込み(海へ向かうほど沈む)
    const seaMask = smoothstep(-0.06, 0.5, coast);
    h = lerp(h, -95, seaMask);
    h += Math.max(0, -coast - 0.12) * 40;

    // 砂漠の平坦化(北東)
    const desertMask = smoothstep(0.2, 0.75, nz * 0.8 + nx * 0.55 + swell * 0.3);
    h = lerp(h, h * 0.55 + 8, desertMask * 0.5);

    // 細かい起伏(スケールを落として、車で走れる程度のうねりに抑える)
    h += fbm2(this.noiseC, x * 0.0035, z * 0.0035, { octaves: 4, gain: 0.45 }) * 9.0;
    h += fbm2(this.noiseD, x * 0.012, z * 0.012, { octaves: 3, gain: 0.4 }) * 2.6;

    // 山岳部の侵食っぽいギザギザ(低周波に限定)
    const rough = Math.abs(ridged2(this.noiseC, x * 0.0016, z * 0.0016, 3)) * 26;
    h += rough * mountainMask * 0.6;

    return h;
  }

  /** 整地と道路を適用した最終的な高さ(m) */
  heightAt(x: number, z: number): number {
    let h = this.rawHeight(x, z);
    if (this.flattenGrid.size > 0) h = this.applyFlatten(x, z, h);
    if (this.roadRaster) {
      const r = roadSample;
      if (this.sampleRoadRaster(x, z, r) && r.weight > 0.001) {
        // 路面高さへ線形ブレンドする。路面高さは地形から ±26m 以内に収めて
        // あるので、weight の連続性がそのまま地形の連続性になる。
        h += (r.height - h) * r.weight;
      }
    }
    return h;
  }

  /**
   * 道路網の高さ情報を 2D ラスタへ焼き込む。
   * ラスタは全体で 1 枚(12km を 3m 刻み = 4096²)なので 4 枚で約 268MB になる。
   * メモリ予算 1GB に対して重いので、2 枚(高さ・重み)だけを保持し、
   * 削掘/盛土の上限は重みから復元する。
   */
  bakeRoadRaster(field: { sample(x: number, z: number): { height: number; weight: number; cut: number; fill: number } }, cell = 4): void {
    const nx = Math.ceil(WORLD.size / cell) + 1;
    const nz = nx;
    const height = new Float32Array(nx * nz);
    const weight = new Float32Array(nx * nz);
    const cut = new Float32Array(nx * nz);
    const fill = new Float32Array(nx * nz);
    const minX = -HALF;
    const minZ = -HALF;
    for (let iz = 0; iz < nz; iz++) {
      const z = minZ + iz * cell;
      for (let ix = 0; ix < nx; ix++) {
        const x = minX + ix * cell;
        const s = field.sample(x, z);
        const k = iz * nx + ix;
        height[k] = s.height;
        weight[k] = s.weight;
        cut[k] = s.cut;
        fill[k] = s.fill;
      }
    }
    this.roadRaster = { cell, minX, minZ, nx, nz, height, weight, cut, fill };
  }

  /**
   * 実際の路面サンプル位置の高さでラスタを上書きする。
   * bakeRoadRaster は格子点で高さ場を評価するため、サンプル位置(数mずれる)では
   * 補間誤差が出る。舗装の直下を厳密に一致させるためにここで補正する。
   */
  stampRoadSamples(roads: Array<{ samples: Array<{ x: number; z: number; y: number; width: number }> }>): void {
    const R = this.roadRaster;
    if (!R) return;
    const stamp = (x: number, z: number, y: number, weight: number): void => {
      const fx = (x - R.minX) / R.cell;
      const fz = (z - R.minZ) / R.cell;
      const ix = Math.round(fx);
      const iz = Math.round(fz);
      if (ix < 0 || iz < 0 || ix >= R.nx || iz >= R.nz) return;
      const k = iz * R.nx + ix;
      R.height[k] = y;
      R.weight[k] = weight;
    };
    for (const road of roads) {
      for (const s of road.samples) {
        stamp(s.x, s.z, s.y, 1);
        // 舗装の縁(横方向)も同じ高さで塗ることで、補間が路面高さを保つ
        for (let o = 1; o <= 2; o++) {
          const off = (s.width * 0.5) * (o / 2);
          stamp(s.x + off, s.z + off * 0.0001, s.y, 1);
          stamp(s.x - off, s.z - off * 0.0001, s.y, 1);
        }
      }
    }
  }

  /** 焼き込み済みラスタのメモリ使用量(概算, MB) */
  get roadRasterMemoryMB(): number {
    const R = this.roadRaster;
    if (!R) return 0;
    return (R.height.byteLength + R.weight.byteLength + R.cut.byteLength + R.fill.byteLength) / (1024 * 1024);
  }

  /** 地表法線(中心差分) */
  normalAt(x: number, z: number, out = new THREE.Vector3(), eps = 2.5): THREE.Vector3 {
    const hL = this.heightAt(x - eps, z);
    const hR = this.heightAt(x + eps, z);
    const hD = this.heightAt(x, z - eps);
    const hU = this.heightAt(x, z + eps);
    out.set(hL - hR, 2 * eps, hD - hU).normalize();
    return out;
  }

  /** 傾斜(0=平坦, 1=垂直) */
  slopeAt(x: number, z: number): number {
    const n = this.normalAt(x, z, scratchNormal, 3);
    return clamp01(1 - n.y);
  }

  /** 路面の傾斜角(ラジアン) */
  slopeAngleAt(x: number, z: number): number {
    return Math.acos(clamp(this.normalAt(x, z, scratchNormal, 3).y, -1, 1));
  }

  isWater(x: number, z: number): boolean {
    return this.heightAt(x, z) < WORLD.seaLevel + 0.2;
  }

  /** 水面の高さ(地形が海面より低い場合) */
  waterHeightAt(x: number, z: number): number | null {
    const h = this.heightAt(x, z);
    return h < WORLD.seaLevel ? WORLD.seaLevel : null;
  }

  /** バイオーム判定(標高・湿度・傾斜) */
  biomeAt(x: number, z: number, height?: number): BiomeId {
    const h = height ?? this.heightAt(x, z);
    if (h < 1.5) return "ocean";

    const nx = x / HALF;
    const nz = z / HALF;
    const moisture = fbm2(this.noiseB, x * 0.0005 + 11, z * 0.0005 - 7, { octaves: 3 });
    const slope = this.slopeAt(x, z);

    // 原点からの相対位置で大まかな気候を作る
    const westCoast = -nx; // 西ほど海側
    const northHeat = nz; // 北ほど乾燥
    const eastAlti = nx; // 東ほど高地

    if (h > 520 || eastAlti > 0.42) {
      if (h > 760) return "volcano";
      if (slope > 0.34) return "volcano";
      return eastAlti > 0.55 ? "volcano" : "jungle";
    }
    if (westCoast > 0.5 && h < 90) return "coast";
    if (northHeat > 0.3 && moisture < 0.1) return "desert";
    if (moisture > 0.22 && h < 120) return "wetland";
    if (northHeat > 0.05 && moisture < -0.05) return "desert";
    if (moisture > 0.05 || westCoast > 0.18) return "jungle";
    if (h > 240) return "volcano";
    return "farmland";
  }

  /** 複合サンプル */
  sample(x: number, z: number): TerrainSample {
    const height = this.heightAt(x, z);
    const normal = this.normalAt(x, z, new THREE.Vector3());
    return {
      height,
      normal,
      slope: clamp01(1 - normal.y),
      biome: this.biomeAt(x, z, height),
    };
  }

  /** 地表の色(バイオーム + 傾斜 + ノイズで変化) */
  surfaceColor(x: number, z: number, h: number, slope: number, biome: BiomeId, out: THREE.Color): THREE.Color {
    const def = BIOMES[biome];
    const n = valueNoise2(x * 0.02, z * 0.02, 17);
    const n2 = fbm2(this.noiseD, x * 0.004, z * 0.004, { octaves: 3 });
    const t = clamp01(0.5 + n * 0.3 + n2 * 0.35);
    const g = def.ground;
    const g2 = def.ground2;
    let r = lerp(g[0], g2[0], t);
    let gg = lerp(g[1], g2[1], t);
    let b = lerp(g[2], g2[2], t);

    // 傾斜が強いところは岩
    const rockMix = smoothstep(0.22, 0.55, slope);
    r = lerp(r, def.rock[0], rockMix);
    gg = lerp(gg, def.rock[1], rockMix);
    b = lerp(b, def.rock[2], rockMix);

    // 海岸の砂
    if (biome === "coast") {
      const sand = smoothstep(0.4, 0.05, slope);
      r = lerp(r, 0.88, sand * 0.35);
      gg = lerp(gg, 0.82, sand * 0.3);
      b = lerp(b, 0.66, sand * 0.25);
    }

    // 植生の色味(湿度ノイズ)
    if (def.vegetation > 0.2 && slope < 0.3) {
      const veg = clamp01(def.vegetation * (0.55 + 0.45 * (0.5 + valueNoise2(x * 0.05, z * 0.05, 91))));
      r = lerp(r, def.grass[0], veg * 0.5);
      gg = lerp(gg, def.grass[1], veg * 0.5);
      b = lerp(b, def.grass[2], veg * 0.5);
    }

    // 雪(高山)
    if (h > 850) {
      const snow = smoothstep(850, 1080, h) * (1 - smoothstep(0.35, 0.62, slope));
      r = lerp(r, 0.93, snow);
      gg = lerp(gg, 0.95, snow);
      b = lerp(b, 0.98, snow);
    }
    // 水面下
    if (h < 0) {
      const deep = clamp01(-h / 25);
      r = lerp(r, 0.12, deep);
      gg = lerp(gg, 0.18, deep);
      b = lerp(b, 0.2, deep);
    }

    out.setRGB(r, gg, b, THREE.SRGBColorSpace);
    return out;
  }

  /** 集落の中心(近傍の集落を返す) */
  nearestSettlement(x: number, z: number): { s: (typeof SETTLEMENTS)[number]; dist: number } {
    let best = SETTLEMENTS[0];
    let bd = Infinity;
    for (const s of SETTLEMENTS) {
      const d = Math.hypot(x - s.x, z - s.z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return { s: best, dist: bd };
  }

  /** 集落による建物用の平坦化(起動時に一度だけ) */
  flattenSettlements(): void {
    const heights = new Map<string, number>();
    for (const s of SETTLEMENTS) {
      const h = this.rawHeight(s.x, s.z);
      heights.set(s.id, Math.max(h, 3));
    }
    // 建物ごとに細かく平らにするのではなく、集落中心の高さへゆるく寄せる
    for (const s of SETTLEMENTS) {
      const h = heights.get(s.id)!;
      const r = s.radius * 0.55;
      this.addFlattenZone({ x: s.x, z: s.z, radius: r, height: h, blend: s.radius * 0.55 });
    }
  }
}

const scratchNormal = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* チャンクメッシュ生成                                               */
/* ------------------------------------------------------------------ */

export interface ChunkGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  minHeight: number;
  maxHeight: number;
}

/** LODごとの分割数 */
export const LOD_SEGMENTS = [32, 16, 8] as const;

/**
 * チャンクのジオメトリを生成する。スカート付き。
 */
export function buildChunkGeometry(
  terrain: Terrain,
  chunkX: number,
  chunkZ: number,
  lod: number,
  skirtDepth = 12
): ChunkGeometryData {
  const seg = LOD_SEGMENTS[clamp(lod, 0, LOD_SEGMENTS.length - 1)];
  const size = WORLD.chunk;
  const x0 = chunkX * size;
  const z0 = chunkZ * size;
  const step = size / seg;
  const n = seg + 1;

  // 頂点: 本体 (n*n) + スカート (4n)
  const bodyCount = n * n;
  const skirtCount = 4 * n;
  const total = bodyCount + skirtCount;

  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);

  const heights = new Float32Array(n * n);
  let minHeight = Infinity;
  let maxHeight = -Infinity;

  const col = new THREE.Color();
  const nrm = new THREE.Vector3();

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const wx = x0 + i * step;
      const wz = z0 + j * step;
      const h = terrain.heightAt(wx, wz);
      const idx = j * n + i;
      heights[idx] = h;
      positions[idx * 3] = wx;
      positions[idx * 3 + 1] = h;
      positions[idx * 3 + 2] = wz;

      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;

      // 法線は隣接頂点から(解析法線より高速で継ぎ目が出ない)
      const iL = Math.max(0, i - 1);
      const iR = Math.min(seg, i + 1);
      const jD = Math.max(0, j - 1);
      const jU = Math.min(seg, j + 1);
      const hl = heights[j * n + iL];
      const hr = heights[j * n + iR];
      const hd = heights[jD * n + i];
      const hu = heights[jU * n + i];
      const dx = (iR - iL) * step || step;
      const dz = (jU - jD) * step || step;
      nrm.set(hl - hr, 2 * step, hd - hu).normalize();
      normals[idx * 3] = nrm.x;
      normals[idx * 3 + 1] = nrm.y;
      normals[idx * 3 + 2] = nrm.z;

      const slope = 1 - nrm.y;
      const biome = terrain.biomeAt(wx, wz, h);
      terrain.surfaceColor(wx, wz, h, slope, biome, col);
      colors[idx * 3] = col.r;
      colors[idx * 3 + 1] = col.g;
      colors[idx * 3 + 2] = col.b;

      uvs[idx * 2] = i / seg;
      uvs[idx * 2 + 1] = j / seg;
    }
  }

  // インデックス(本体)
  const quadCount = seg * seg;
  const bodyIndexCount = quadCount * 6;
  const skirtIndexCount = 4 * seg * 6;
  const indices = new Uint32Array(bodyIndexCount + skirtIndexCount);
  let p = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * n + i;
      const b = j * n + i + 1;
      const c = (j + 1) * n + i;
      const d = (j + 1) * n + i + 1;
      indices[p++] = a;
      indices[p++] = c;
      indices[p++] = b;
      indices[p++] = b;
      indices[p++] = c;
      indices[p++] = d;
    }
  }

  // スカート(外周を下に伸ばし、隣チャンクとの高低差を隠す)
  let v = bodyCount;
  const skirtStart = v;
  const edges: number[][] = [[], [], [], []];
  for (let i = 0; i < n; i++) edges[0].push(i); // z=0
  for (let i = 0; i < n; i++) edges[1].push(seg * n + i); // z=seg
  for (let j = 0; j < n; j++) edges[2].push(j * n); // x=0
  for (let j = 0; j < n; j++) edges[3].push(j * n + seg); // x=seg
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < n; k++) {
      const src = edges[e][k];
      positions[v * 3] = positions[src * 3];
      positions[v * 3 + 1] = positions[src * 3 + 1] - skirtDepth;
      positions[v * 3 + 2] = positions[src * 3 + 2];
      normals[v * 3] = normals[src * 3];
      normals[v * 3 + 1] = normals[src * 3 + 1];
      normals[v * 3 + 2] = normals[src * 3 + 2];
      colors[v * 3] = colors[src * 3] * 0.6;
      colors[v * 3 + 1] = colors[src * 3 + 1] * 0.6;
      colors[v * 3 + 2] = colors[src * 3 + 2] * 0.6;
      uvs[v * 2] = uvs[src * 2];
      uvs[v * 2 + 1] = uvs[src * 2 + 1];
      v++;
    }
  }
  let q = p;
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < seg; k++) {
      const t0 = edges[e][k];
      const t1 = edges[e][k + 1];
      const s0 = skirtStart + e * n + k;
      const s1 = skirtStart + e * n + k + 1;
      // 巻き順は表裏両方が見えるよう両面描画前提で構わない
      indices[q++] = t0;
      indices[q++] = s0;
      indices[q++] = t1;
      indices[q++] = t1;
      indices[q++] = s0;
      indices[q++] = s1;
    }
  }

  return { positions, normals, colors, uvs, indices, minHeight, maxHeight };
}

/* ------------------------------------------------------------------ */
/* ストリーミング                                                     */
/* ------------------------------------------------------------------ */

export interface ChunkEntry {
  key: string;
  cx: number;
  cz: number;
  lod: number;
  mesh: THREE.Mesh;
  lastUsed: number;
}

/**
 * チャンクの生成と破棄を管理する。1フレームの生成予算を超えないようキュー制御。
 */
export class TerrainStreamer {
  readonly group = new THREE.Group();
  private chunks = new Map<string, ChunkEntry>();
  private material: THREE.MeshLambertMaterial;
  private queue: Array<{ cx: number; cz: number; lod: number }> = [];
  private frame = 0;
  private centerX = 0;
  private centerZ = 0;
  private stats = { chunks: 0, triangles: 0, built: 0, disposed: 0 };

  constructor(private terrain: Terrain, private maxChunks = 420) {
    this.group.name = "terrain";
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      // 遠景はフォグで溶かす
      fog: true,
    });
  }

  get materialRef(): THREE.Material {
    return this.material;
  }

  private keyOf(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  /** カメラ位置に応じてチャンクを要求 */
  update(centerX: number, centerZ: number, budgetMs = WORLD.frameBudgetMs): void {
    this.centerX = centerX;
    this.centerZ = centerZ;
    this.frame++;

    const radiusChunks = Math.ceil(WORLD.farDistance / WORLD.chunk);
    const ccx = Math.floor(centerX / WORLD.chunk);
    const ccz = Math.floor(centerZ / WORLD.chunk);

    // 既存チャンクのLOD更新と破棄判定
    for (const entry of this.chunks.values()) {
      const dx = (entry.cx + 0.5) * WORLD.chunk - centerX;
      const dz = (entry.cz + 0.5) * WORLD.chunk - centerZ;
      const dist = Math.hypot(dx, dz);
      if (dist > WORLD.farDistance + WORLD.chunk * 2) {
        this.group.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        this.chunks.delete(entry.key);
        this.stats.disposed++;
        continue;
      }
      entry.lastUsed = this.frame;
      const wantLod = this.lodForDistance(dist);
      if (wantLod !== entry.lod) {
        this.queue.push({ cx: entry.cx, cz: entry.cz, lod: wantLod });
        entry.lod = -1; // 再生成待ち
      }
    }

    // 近い順にキューへ追加
    const pending: Array<{ cx: number; cz: number; lod: number; d: number }> = [];
    for (let dz = -radiusChunks; dz <= radiusChunks; dz++) {
      for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        if (cx < 0 || cz < 0 || cx >= WORLD.chunksPerSide || cz >= WORLD.chunksPerSide) continue;
        const key = this.keyOf(cx, cz);
        const existing = this.chunks.get(key);
        if (existing && existing.lod >= 0) continue;
        const wx = (cx + 0.5) * WORLD.chunk;
        const wz = (cz + 0.5) * WORLD.chunk;
        const d = Math.hypot(wx - centerX, wz - centerZ);
        if (d > WORLD.farDistance) continue;
        pending.push({ cx, cz, lod: this.lodForDistance(d), d });
      }
    }
    pending.sort((a, b) => a.d - b.d);
    for (const p of pending.slice(0, 64)) {
      if (this.queue.length > 160) break;
      if (!this.queue.some((q) => q.cx === p.cx && q.cz === p.cz)) {
        this.queue.push({ cx: p.cx, cz: p.cz, lod: p.lod });
      }
    }

    // 予算内で生成
    const start = performance.now();
    let builtThisFrame = 0;
    while (this.queue.length > 0) {
      if (performance.now() - start > budgetMs && builtThisFrame > 0) break;
      const job = this.queue.shift()!;
      if (job.cx < 0 || job.cz < 0 || job.cx >= WORLD.chunksPerSide || job.cz >= WORLD.chunksPerSide) continue;
      const key = this.keyOf(job.cx, job.cz);
      const existing = this.chunks.get(key);
      if (existing && existing.lod === job.lod) continue;
      if (existing) {
        this.group.remove(existing.mesh);
        existing.mesh.geometry.dispose();
        this.chunks.delete(key);
      }
      if (this.chunks.size >= this.maxChunks) {
        // LRUで1つ捨てる
        let oldest: ChunkEntry | null = null;
        for (const e of this.chunks.values()) {
          if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e;
        }
        if (oldest) {
          this.group.remove(oldest.mesh);
          oldest.mesh.geometry.dispose();
          this.chunks.delete(oldest.key);
          this.stats.disposed++;
        }
      }
      const data = buildChunkGeometry(this.terrain, job.cx, job.cz, job.lod);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
      geom.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
      geom.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
      geom.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
      geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geom.computeBoundingSphere();
      const mesh = new THREE.Mesh(geom, this.material);
      mesh.name = `chunk_${job.cx}_${job.cz}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.chunks.set(key, { key, cx: job.cx, cz: job.cz, lod: job.lod, mesh, lastUsed: this.frame });
      builtThisFrame++;
      this.stats.built++;
    }
  }

  lodForDistance(d: number): number {
    if (d < 900) return 0;
    if (d < 2600) return 1;
    return 2;
  }

  /** 初期ロード: 指定地点周辺を同期的に生成 */
  prime(x: number, z: number, radius = 700): void {
    const ccx = Math.floor(x / WORLD.chunk);
    const ccz = Math.floor(z / WORLD.chunk);
    const r = Math.ceil(radius / WORLD.chunk);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        if (cx < 0 || cz < 0 || cx >= WORLD.chunksPerSide || cz >= WORLD.chunksPerSide) continue;
        const key = this.keyOf(cx, cz);
        if (this.chunks.has(key)) continue;
        const wx = (cx + 0.5) * WORLD.chunk;
        const wz = (cz + 0.5) * WORLD.chunk;
        const d = Math.hypot(wx - x, wz - z);
        const lod = this.lodForDistance(d);
        const data = buildChunkGeometry(this.terrain, cx, cz, lod);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
        geom.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
        geom.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
        geom.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
        geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
        geom.computeBoundingSphere();
        const mesh = new THREE.Mesh(geom, this.material);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.group.add(mesh);
        this.chunks.set(key, { key, cx, cz, lod, mesh, lastUsed: this.frame });
      }
    }
    this.stats.chunks = this.chunks.size;
  }

  getStats() {
    let tris = 0;
    for (const c of this.chunks.values()) {
      const g = c.mesh.geometry as THREE.BufferGeometry;
      const idx = g.getIndex();
      if (idx) tris += idx.count / 3;
    }
    this.stats.chunks = this.chunks.size;
    this.stats.triangles = Math.round(tris);
    return { ...this.stats, queued: this.queue.length };
  }

  dispose(): void {
    for (const c of this.chunks.values()) c.mesh.geometry.dispose();
    this.chunks.clear();
    this.material.dispose();
  }
}
