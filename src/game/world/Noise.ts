/**
 * world/Noise.ts
 * 責務: シード付きノイズ生成(Simplex 2D/3D, Perlin, FBM, Ridged, Domain Warp, Voronoi)
 *       Worker 内でもそのまま動く純関数のみ(外部状態なし)
 * 公開API: SimplexNoise, fbm2, ridged2, warp2, voronoi2, valueNoise2, Worley
 * 依存: core/math.ts のみ
 */
import { Rng, lerp, clamp01, smoothstep } from "../core/math.js";

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

/** 2D/3D Simplex ノイズ。出力は概ね -1..1 */
export class SimplexNoise {
  private perm = new Uint8Array(512);
  private permMod12 = new Uint8Array(512);

  constructor(seed = 1337) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = new Rng(seed | 0);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise2(xin: number, yin: number): number {
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = xin - X0;
    const y0 = yin - Y0;
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi = this.permMod12[ii + this.perm[jj]];
      const g = GRAD3[gi];
      t0 *= t0;
      n0 = t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi = this.permMod12[ii + i1 + this.perm[jj + j1]];
      const g = GRAD3[gi];
      t1 *= t1;
      n1 = t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi = this.permMod12[ii + 1 + this.perm[jj + 1]];
      const g = GRAD3[gi];
      t2 *= t2;
      n2 = t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  noise3(xin: number, yin: number, zin: number): number {
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

    const ii = i & 255, jj = j & 255, kk = k & 255;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = GRAD3[this.permMod12[ii + this.perm[jj + this.perm[kk]]]];
      t0 *= t0;
      n0 = t0 * t0 * (g[0] * x0 + g[1] * y0 + g[2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = GRAD3[this.permMod12[ii + i1 + this.perm[jj + j1 + this.perm[kk + k1]]]];
      t1 *= t1;
      n1 = t1 * t1 * (g[0] * x1 + g[1] * y1 + g[2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = GRAD3[this.permMod12[ii + i2 + this.perm[jj + j2 + this.perm[kk + k2]]]];
      t2 *= t2;
      n2 = t2 * t2 * (g[0] * x2 + g[1] * y2 + g[2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = GRAD3[this.permMod12[ii + 1 + this.perm[jj + 1 + this.perm[kk + 1]]]];
      t3 *= t3;
      n3 = t3 * t3 * (g[0] * x3 + g[1] * y3 + g[2] * z3);
    }
    return 32 * (n0 + n1 + n2 + n3);
  }
}

/** バリューノイズ(安価。植生配置などに使用) */
export function valueNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (a: number, b: number) => {
    let n = a * 374761393 + b * 668265263 + seed * 1442695041;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}

export interface FbmOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  /** オクターブごとの回転角(グリッド臭さを消す) */
  rotate?: number;
}

/** フラクタルブラウンノイズ */
export function fbm2(
  noise: SimplexNoise,
  x: number,
  y: number,
  opts: FbmOptions = {}
): number {
  const octaves = opts.octaves ?? 5;
  const lacunarity = opts.lacunarity ?? 2.03;
  const gain = opts.gain ?? 0.5;
  const rot = opts.rotate ?? 0.37;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  let px = x;
  let py = y;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  for (let i = 0; i < octaves; i++) {
    sum += noise.noise2(px * freq, py * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
    const nx = px * cs - py * sn;
    const ny = px * sn + py * cs;
    px = nx;
    py = ny;
  }
  return sum / (norm || 1);
}

/** 稜線ノイズ(山岳の尾根) */
export function ridged2(
  noise: SimplexNoise,
  x: number,
  y: number,
  octaves = 5,
  lacunarity = 2.07,
  gain = 0.5
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise.noise2(x * freq, y * freq));
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return (sum / (norm || 1)) * 2 - 1;
}

/** ドメインワープ(地形に有機的な歪みを与える) */
export function warp2(
  noise: SimplexNoise,
  x: number,
  y: number,
  strength = 1.2,
  freq = 0.7
): [number, number] {
  const wx = noise.noise2(x * freq + 5.2, y * freq + 1.3);
  const wy = noise.noise2(x * freq - 3.7, y * freq + 9.1);
  return [x + wx * strength, y + wy * strength];
}

export interface VoronoiResult {
  /** 最近点までの距離(0..1 程度) */
  d1: number;
  /** 2番目に近い点までの距離 */
  d2: number;
  /** セルID(ハッシュ値) 0..1 */
  id: number;
  /** セル中心のオフセット座標(ドット柄の生成などに使う) */
  cx: number;
  cy: number;
}

/** 2Dボロノイ(セル状の植生分布・岩肌に使用) */
export function voronoi2(x: number, y: number, seed = 0): VoronoiResult {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = Infinity;
  let second = Infinity;
  let bid = 0;
  let bcx = 0;
  let bcy = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const h1 = hashCell(cx, cy, seed);
      const h2 = hashCell(cx, cy, seed + 977);
      const px = cx + h1;
      const py = cy + h2;
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) {
        second = best;
        best = d;
        bid = h1;
        bcx = px - xi;
        bcy = py - yi;
      } else if (d < second) {
        second = d;
      }
    }
  }
  return { d1: Math.sqrt(best), d2: Math.sqrt(second), id: bid, cx: bcx, cy: bcy };
}

function hashCell(x: number, y: number, seed: number): number {
  let n = x * 1597334677 + y * 3812015801 + seed * 2654435761;
  n = (n ^ (n >>> 15)) * 2246822519;
  n = (n ^ (n >>> 13)) * 3266489917;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * Worley(細胞)ノイズの F1/F2 を返す。voronoi2 の軽量版。
 */
export function worley2(x: number, y: number, seed = 0): [number, number] {
  const v = voronoi2(x, y, seed);
  return [v.d1, v.d2];
}

/** 曲線用のノイズ(1D) */
export function noise1(noise: SimplexNoise, x: number): number {
  return noise.noise2(x, 0.137);
}

/** ノイズから 0..1 の滑らかな値を得るヘルパ */
export function n01(noise: SimplexNoise, x: number, y: number): number {
  return clamp01(noise.noise2(x, y) * 0.5 + 0.5);
}

/** 地形の侵食風の柔らかい凹み(シンプルな近似) */
export function erode(n: number, slope: number, strength = 1): number {
  const s = smoothstep(0.15, 0.85, slope) * strength;
  return n - Math.abs(n) * s * 0.35;
}

export { SmoothstepLookup };

/** 高頻度で呼ばれる smoothstep をテーブル化したもの */
// eslint-disable-next-line no-var
var SmoothstepLookup = (() => {
  const N = 256;
  const table = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    table[i] = t * t * (3 - 2 * t);
  }
  return {
    get(t: number): number {
      const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
      const f = c * N;
      const i = f | 0;
      const frac = f - i;
      return table[i] + (table[Math.min(N, i + 1)] - table[i]) * frac;
    },
    table,
  };
})();
