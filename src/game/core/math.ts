/**
 * core/math.ts
 * 責務: 依存のない数学ユーティリティ(スカラー/補間/乱数/スプライン/幾何ヘルパ)
 * 公開API: clamp, lerp, smoothstep, damp, moveTowards, wrapAngle, angleDelta,
 *           Rng, hash2, hash3, CatmullRom, hermite, approxEq, remap, signPow
 * 依存: なし(Three.js には依存しない。純粋な数値関数のみ)
 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, a0: number, a1: number, b0: number, b1: number): number {
  return lerp(b0, b1, clamp01(invLerp(a0, a1, v)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** フレームレート非依存の指数減衰補間 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

/** 符号を保ったまま絶対値の累乗(ステア応答カーブなどに使用) */
export function signPow(v: number, p: number): number {
  const s = v < 0 ? -1 : 1;
  return s * Math.pow(Math.abs(v), p);
}

export function approxEq(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

export function saturateSigned(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** 2の累乗へ切り上げ */
export function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

/* ------------------------------------------------------------------ */
/* 乱数: シード固定で再現可能な xorshift128 系                        */
/* ------------------------------------------------------------------ */

export class Rng {
  private s0 = 1;
  private s1 = 2;
  private s2 = 3;
  private s3 = 4;

  constructor(seed = 0x9e3779b9) {
    this.seed(seed);
  }

  seed(seed: number): this {
    let s = seed | 0 || 1;
    const split = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return s >>> 0;
    };
    this.s0 = split();
    this.s1 = split();
    this.s2 = split();
    this.s3 = split();
    // 0 埋まりの回避
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    for (let i = 0; i < 12; i++) this.next();
    return this;
  }

  /** [0,1) */
  next(): number {
    const t = this.s0 ^ (this.s0 << 11);
    this.s0 = this.s1;
    this.s1 = this.s2;
    this.s2 = this.s3;
    this.s3 = this.s3 ^ (this.s3 >>> 19) ^ t ^ (t >>> 8);
    return (this.s3 >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }

  /** 中央寄せ(-1..1) */
  signed(): number {
    return this.next() * 2 - 1;
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  /** 正規分布(Box-Muller) */
  gauss(mean = 0, sd = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** 整数座標からの決定論的ハッシュ(0..1) */
export function hash2(x: number, y: number, seed = 0): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = x * 374761393 + y * 668265263 + z * 1442695041 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ */
/* スプライン                                                          */
/* ------------------------------------------------------------------ */

/** 1次元 Catmull-Rom(テンション付き) */
export function catmullRom1(p0: number, p1: number, p2: number, p3: number, t: number, tension = 0.5): number {
  const m1 = (p2 - p0) * tension;
  const m2 = (p3 - p1) * tension;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p1 +
    (t3 - 2 * t2 + t) * m1 +
    (-2 * t3 + 3 * t2) * p2 +
    (t3 - t2) * m2
  );
}

/** Hermite 補間(位置と接線を直接与える) */
export function hermite(p0: number, p1: number, m0: number, m1: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p0 +
    (t3 - 2 * t2 + t) * m0 +
    (-2 * t3 + 3 * t2) * p1 +
    (t3 - t2) * m1
  );
}

/** 単調増加を守る3次補間(車体シルエットの制御点などに使用) */
export function monotoneCubic(ys: number[], t: number): number {
  const n = ys.length;
  if (n === 0) return 0;
  if (n === 1) return ys[0];
  const x = clamp01(t) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const f = x - i;
  const d0 = i > 0 ? (ys[i + 1] - ys[i - 1]) * 0.5 : ys[1] - ys[0];
  const d1 = i < n - 2 ? (ys[i + 2] - ys[i]) * 0.5 : ys[n - 1] - ys[n - 2];
  return hermite(ys[i], ys[i + 1], d0, d1, f);
}

/**
 * 3次ベジェ曲線(2次元)。パラメータ t は 0..1 で、弧長近似も可能。
 */
export function bezier2(
  p0: [number, number],
  c0: [number, number],
  c1: [number, number],
  p1: [number, number],
  t: number
): [number, number] {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0],
    a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1],
  ];
}

/* ------------------------------------------------------------------ */
/* 角度・単位変換                                                     */
/* ------------------------------------------------------------------ */

export const kmhToMs = (kmh: number) => kmh / 3.6;
export const msToKmh = (ms: number) => ms * 3.6;
export const msToMph = (ms: number) => ms * 2.2369362920544;
export const hpToWatt = (hp: number) => hp * 745.6998715822702;
export const wattToHp = (w: number) => w / 745.6998715822702;
export const lbFtToNm = (lbft: number) => lbft * 1.3558179483314;
export const nmToLbFt = (nm: number) => nm / 1.3558179483314;

/* ------------------------------------------------------------------ */
/* 平滑化ユーティリティ                                               */
/* ------------------------------------------------------------------ */

/** 指数移動平均 */
export class Ema {
  value = 0;
  private init = false;
  constructor(private alpha = 0.15) {}
  push(v: number): number {
    if (!this.init) {
      this.value = v;
      this.init = true;
    } else {
      this.value += (v - this.value) * this.alpha;
    }
    return this.value;
  }
  reset(v = 0): void {
    this.value = v;
    this.init = false;
  }
}

/** 単純なリングバッファ統計 */
export class Ring {
  private buf: Float32Array;
  private i = 0;
  private filled = 0;
  constructor(size: number) {
    this.buf = new Float32Array(size);
  }
  push(v: number): void {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
  }
  get count(): number {
    return this.filled;
  }
  avg(): number {
    if (!this.filled) return 0;
    let s = 0;
    for (let i = 0; i < this.filled; i++) s += this.buf[i];
    return s / this.filled;
  }
  max(): number {
    let m = -Infinity;
    for (let i = 0; i < this.filled; i++) m = Math.max(m, this.buf[i]);
    return this.filled ? m : 0;
  }
  /** 下位95%平均(スパイクを除いた平均フレーム時間) */
  trimmedAvg(ratio = 0.95): number {
    if (!this.filled) return 0;
    const arr = Array.from(this.buf.subarray(0, this.filled)).sort((a, b) => a - b);
    const n = Math.max(1, Math.floor(arr.length * ratio));
    let s = 0;
    for (let i = 0; i < n; i++) s += arr[i];
    return s / n;
  }
}

/** 簡易ヒステリシス付き比較 */
export class Hysteresis {
  private on = false;
  constructor(private low: number, private high: number) {}
  test(v: number): boolean {
    if (this.on) {
      if (v < this.low) this.on = false;
    } else if (v > this.high) {
      this.on = true;
    }
    return this.on;
  }
  get value(): boolean {
    return this.on;
  }
}

/** タイマー(クールダウン管理) */
export class Cooldown {
  private t = 0;
  constructor(private duration: number) {}
  update(dt: number): void {
    if (this.t > 0) this.t = Math.max(0, this.t - dt);
  }
  trigger(): void {
    this.t = this.duration;
  }
  get ready(): boolean {
    return this.t <= 0;
  }
  get progress(): number {
    return 1 - this.t / this.duration;
  }
}
