/**
 * input/SteeringFilter.ts
 * 責務: ステア入力の応答カーブ、速度依存舵角、キー入力の立ち上がり/戻り、トリガー擬似アナログ
 * 公開API: SteeringFilter, ThrottleFilter
 * 依存: core/math.ts
 *
 * 設計メモ:
 *  - キーボードは 0/1 しか出せないので、ここで「人間の手」に近い時定数を作る。
 *  - 速度が上がるほど舵角を制限(高速で全切りすると滑るため)。
 *  - カウンターステアの戻りは速く、切り増しはゆっくり(ドライバーの癖に近づける)。
 */
import { clamp, clamp01, lerp, moveTowards, signPow, smoothstep, damp } from "../core/math.js";

export interface SteeringConfig {
  /** 立ち上がり速度(1秒あたりの舵角変化) */
  riseRate: number;
  /** 戻り速度 */
  returnRate: number;
  /** 応答カーブ(1=リニア, 1.6=最初は穏やか) */
  curve: number;
  /** 高速での舵角制限(0..1) */
  highSpeedLimit: number;
  /** 平滑化の強さ */
  smoothing: number;
  /** 速度依存舵角の有効化 */
  speedSensitive: boolean;
}

export const DEFAULT_STEERING: SteeringConfig = {
  riseRate: 3.6,
  returnRate: 7.2,
  curve: 1.45,
  highSpeedLimit: 0.42,
  smoothing: 14,
  speedSensitive: true,
};

export class SteeringFilter {
  /** -1(左) .. 1(右) */
  value = 0;
  private target = 0;
  private velocity = 0;
  private config: SteeringConfig;
  /** 車速(km/h) */
  speed = 0;
  /** 現在の舵角制限(テレメトリ用) */
  limit = 1;

  constructor(config: Partial<SteeringConfig> = {}) {
    this.config = { ...DEFAULT_STEERING, ...config };
  }

  setConfig(c: Partial<SteeringConfig>): void {
    this.config = { ...this.config, ...c };
  }

  get configRef(): SteeringConfig {
    return this.config;
  }

  /** 生の入力(-1..1)。デジタル入力の場合は -1/0/1 */
  setInput(raw: number, isDigital: boolean, dt: number, speedKmh: number): void {
    this.speed = speedKmh;
    const c = this.config;

    // 速度依存の舵角制限
    if (c.speedSensitive) {
      const t = smoothstep(40, 230, speedKmh);
      this.limit = lerp(1, c.highSpeedLimit, t);
    } else {
      this.limit = 1;
    }

    let input = clamp(raw, -1, 1);

    if (isDigital) {
      // デジタル入力: 目標へ向かって一定速度で動かす
      const rate = Math.sign(input) === Math.sign(this.target) && Math.abs(input) > Math.abs(this.target)
        ? c.riseRate
        : c.returnRate;
      if (input === 0) {
        this.target = moveTowards(this.target, 0, c.returnRate * dt);
      } else {
        // 切り増しはゆっくり、戻しは速く
        const towardZero = Math.sign(input) !== Math.sign(this.target) && this.target !== 0;
        const r = towardZero ? c.returnRate : c.riseRate;
        this.target = moveTowards(this.target, input, r * dt);
        void rate;
      }
      input = this.target;
    }

    // 応答カーブ(中心付近をマイルドに)
    const shaped = signPow(clamp(input, -1, 1), c.curve) * this.limit;

    // 平滑化
    this.value = damp(this.value, shaped, c.smoothing, dt);
    this.value = clamp(this.value, -1, 1);
    this.velocity = (this.value - (this.velocity || this.value));
  }

  /** 外部から直接値をセット(AI用) */
  setDirect(v: number): void {
    this.value = clamp(v, -1, 1);
    this.target = this.value;
  }

  reset(): void {
    this.value = 0;
    this.target = 0;
  }
}

/** スロットル/ブレーキの応答(アクセルは速く、ブレーキはやや緩やか) */
export class ThrottleFilter {
  throttle = 0;
  brake = 0;

  update(rawThrottle: number, rawBrake: number, dt: number, digital: boolean): void {
    const tRate = digital ? 4.2 : 12;
    const bRate = digital ? 5.5 : 14;
    const tTarget = clamp01(rawThrottle);
    const bTarget = clamp01(rawBrake);
    if (digital) {
      this.throttle = moveTowards(this.throttle, tTarget, tRate * dt);
      this.brake = moveTowards(this.brake, bTarget, bRate * dt);
    } else {
      this.throttle = lerp(this.throttle, tTarget, clamp01(dt * tRate));
      this.brake = lerp(this.brake, bTarget, clamp01(dt * bRate));
    }
  }

  reset(): void {
    this.throttle = 0;
    this.brake = 0;
  }
}

/** デジタルボタンからアナログへの変換(汎用) */
export function digitalToAnalog(current: number, pressed: boolean, dt: number, rise = 5, fall = 9): number {
  return moveTowards(current, pressed ? 1 : 0, (pressed ? rise : fall) * dt);
}
