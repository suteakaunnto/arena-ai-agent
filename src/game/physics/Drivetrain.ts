/**
 * physics/Drivetrain.ts
 * 責務: エンジンのトルクカーブ、ギアボックス、クラッチ、LSD、AWD配分、ターボラグ
 * 公開API: Drivetrain, TorqueCurve
 * 依存: core/math.ts, car/spec/CarSpec.ts
 *
 * 設計メモ:
 *  - エンジントルクは「正規化トルクカーブ」を 3 次式で近似(peakiness で尖らせる)。
 *  - アイドルからレッドラインまで回転数を積分し、クラッチで駆動輪へ伝える。
 *  - オートマは「アップシフト/ダウンシフトのしきい値」を持ち、変速中はトルクを切る。
 *  - タイヤの空転時はエンジン回転が吹け上がる(スリップクラッチモデル)。
 */
import { CarSpec, EngineSpec, GearboxSpec } from "../car/spec/CarSpec.js";
import { clamp, clamp01, lerp, smoothstep } from "../core/math.js";

/** 正規化トルクカーブ(0..1 の回転数 → トルク比) */
export class TorqueCurve {
  constructor(private engine: EngineSpec) {}

  /** 回転数(rpm)に対するトルク(Nm) */
  torqueAt(rpm: number): number {
    const e = this.engine;
    const idle = e.idle;
    const red = e.redline;
    if (rpm < idle) return e.torqueNm * 0.55;
    if (rpm > red) {
      // レブリミット以降は急落
      const over = (rpm - red) / (red * 0.08);
      return Math.max(0, e.torqueNm * (1 - over)) * 0.2;
    }
    const x = (rpm - idle) / (red - idle);
    // ピーク位置
    const peakX = clamp01((e.torqueRpm - idle) / (red - idle));
    const p = e.peakiness;
    // ピーク前は立ち上がり、ピーク後は緩やかに落ちる
    let shape: number;
    if (x < peakX) {
      const t = x / peakX;
      shape = 0.62 + 0.38 * Math.pow(smoothstep(0, 1, t), lerp(2.4, 1.2, p));
    } else {
      const t = (x - peakX) / (1 - peakX);
      // 高回転でもパワーが出るタイプ(p が小さい)は落ちにくい
      shape = 1 - Math.pow(t, lerp(1.6, 2.6, p)) * lerp(0.28, 0.42, p);
    }
    // NA はトルクピーク=パワーピーク近辺で伸びる、ターボは中回転で盛り上がる
    const forced = e.aspiration !== "na";
    if (forced) {
      // ターボラグ的な「中回転の谷」を浅く
      shape *= 1 - Math.exp(-Math.pow(x / 0.34, 2)) * 0.18;
    }
    return e.torqueNm * shape;
  }

  /** その回転数での出力(hp) */
  powerAt(rpm: number): number {
    const t = this.torqueAt(rpm);
    return (t * rpm * 2 * Math.PI) / 60 / 745.7;
  }

  /** 最高出力回転数付近を探す(表示用) */
  findPowerPeak(): { rpm: number; hp: number } {
    let best = { rpm: this.engine.idle, hp: 0 };
    for (let rpm = this.engine.idle; rpm <= this.engine.redline; rpm += 50) {
      const hp = this.powerAt(rpm);
      if (hp > best.hp) best = { rpm, hp };
    }
    return best;
  }

  /** トルクカーブのサンプル(UIグラフ用) */
  samples(n = 32): Array<{ rpm: number; torque: number; power: number }> {
    const out: Array<{ rpm: number; torque: number; power: number }> = [];
    for (let i = 0; i < n; i++) {
      const rpm = lerp(this.engine.idle, this.engine.redline, i / (n - 1));
      out.push({ rpm, torque: this.torqueAt(rpm), power: this.powerAt(rpm) });
    }
    return out;
  }
}

export interface DrivetrainInput {
  throttle: number;
  /** 手動変速のリクエスト */
  shiftUp: boolean;
  shiftDown: boolean;
  /** クラッチ(0=接続, 1=切断) */
  clutch?: number;
  /** 車速(m/s) */
  speed: number;
  /** 駆動輪の平均角速度(rad/s) */
  wheelOmega: number;
  /** ホイール半径(m) */
  wheelRadius: number;
  /** 変速モード: true = オートマ */
  auto: boolean;
  dt: number;
  /** 坂道の影響(重力成分) */
  gradeResistance: number;
}

export interface DrivetrainOutput {
  /** 駆動輪に与えるトルク(Nm, 合計。AWD は前後に分割済み) */
  driveTorque: number;
  /** エンジン回転数 */
  rpm: number;
  /** 現在のギア(-1 = 後退, 0 = ニュートラル, 1..) */
  gear: number;
  /** 変速中か */
  shifting: boolean;
  /** クラッチの滑り */
  clutchSlip: number;
  /** ターボのブースト(0..1) */
  boost: number;
  /** ギア比 */
  ratio: number;
  /** エンジン負荷(音用 0..1) */
  load: number;
  /** レブリミッターに当たっているか */
  limiter: boolean;
}

export class Drivetrain {
  readonly curve: TorqueCurve;
  rpm = 900;
  gear = 1;
  private shiftTimer = 0;
  private boost = 0;
  private clutchSlip = 0;
  private lastShiftTime = 0;
  private limiter = false;
  private spec: CarSpec;
  private gearbox: GearboxSpec;
  /** エンジンの慣性(kg·m²) */
  private engineInertia = 0.22;

  constructor(spec: CarSpec) {
    this.spec = spec;
    this.gearbox = spec.gearbox;
    this.curve = new TorqueCurve(spec.engine);
    this.rpm = spec.engine.idle;
  }

  get gearCount(): number {
    return this.gearbox.ratios.length;
  }

  get currentRatio(): number {
    if (this.gear === 0) return 0;
    if (this.gear < 0) return -3.2;
    return this.gearbox.ratios[Math.min(this.gearbox.ratios.length - 1, this.gear - 1)] * this.gearbox.finalDrive;
  }

  get isShifting(): boolean {
    return this.shiftTimer > 0;
  }

  reset(): void {
    this.rpm = this.spec.engine.idle;
    this.gear = 1;
    this.shiftTimer = 0;
    this.boost = 0;
  }

  update(input: DrivetrainInput): DrivetrainOutput {
    const e = this.spec.engine;
    const g = this.gearbox;
    const dt = input.dt;

    // 変速タイマー
    if (this.shiftTimer > 0) {
      this.shiftTimer = Math.max(0, this.shiftTimer - dt);
      if (this.shiftTimer === 0) this.lastShiftTime = 0;
    }

    // 手動変速
    if (input.shiftUp && this.gear < this.gearCount && this.shiftTimer <= 0) {
      this.gear++;
      this.shiftTimer = g.shiftTime;
    }
    if (input.shiftDown && this.gear > 1 && this.shiftTimer <= 0) {
      this.gear--;
      this.shiftTimer = g.shiftTime;
    }

    // 回転数: 車輪速度から計算(クラッチ接続時)
    const wheelRpm = (input.wheelOmega * 60) / (2 * Math.PI);
    const ratio = this.currentRatio;
    let targetRpm = Math.abs(wheelRpm * ratio);
    if (this.gear === 0 || this.gear < 0) targetRpm = e.idle;

    // オートマチック変速
    if (input.auto && this.shiftTimer <= 0 && this.gear >= 1) {
      const upThreshold = lerp(e.redline * 0.74, e.redline * 0.94, clamp01(input.throttle));
      const downThreshold = lerp(e.redline * 0.62, e.redline * 0.3, clamp01(input.throttle));
      if (targetRpm > upThreshold && this.gear < this.gearCount) {
        this.gear++;
        this.shiftTimer = g.shiftTime;
      } else if (targetRpm < downThreshold && this.gear > 1) {
        this.gear--;
        this.shiftTimer = g.shiftTime * 0.6;
      }
    }

    // 回転数は「車輪の角速度」ではなく「実車速」から求める。
    //  (空転している駆動輪の角速度を使うと、スピンした瞬間に回転数が急上昇して暴走する)
    const newRatio = this.currentRatio;
    const speedWheelRpm = (Math.abs(input.speed) / Math.max(0.05, input.wheelRadius)) * (60 / (2 * Math.PI));
    targetRpm = speedWheelRpm * Math.abs(newRatio);
    // 発進時(クラッチスリップ)はアイドル付近から吹け上がる
    const launchRpm = e.idle + input.throttle * e.redline * 0.32;
    const launchBlend = clamp01(1 - Math.abs(input.speed) / 9);
    targetRpm = lerp(targetRpm, Math.max(targetRpm, launchRpm), launchBlend * clamp01(input.throttle + 0.25));
    // 低回転でスロットルを踏んだ時のトルクコンバータ的な滑り
    if (input.throttle > 0.35 && targetRpm < e.idle + 500) {
      targetRpm = Math.max(targetRpm, e.idle + 500 + input.throttle * 700);
    }
    // オートマのダウンシフトは「回転数が低すぎる」時に起きるので、判定はクラッチ後に行う

    // 回転数の追従(慣性)
    const rpmResponse = lerp(9, 4, clamp01(Math.abs(input.speed) / 40));
    const rpmPrev = this.rpm;
    this.rpm = lerp(this.rpm, clamp(targetRpm, e.idle, e.redline * 1.02), clamp01(rpmResponse * dt));

    // レブリミッター
    this.limiter = this.rpm >= e.redline * 0.995;
    if (this.limiter) this.rpm = e.redline * 0.995;

    // トルク
    let torque = this.curve.torqueAt(this.rpm) * clamp01(input.throttle);

    // 変速中はトルクを切る
    if (this.shiftTimer > 0) {
      const k = 1 - this.shiftTimer / Math.max(0.001, g.shiftTime);
      torque *= lerp(0.05, 1, smoothstep(0.55, 1, k));
    }

    // ターボのブースト(立ち上がり/オフの遅れ)
    const wantsBoost = e.aspiration === "turbo" || e.aspiration === "twin-turbo" ? clamp01(input.throttle) : 0;
    const boostTarget = wantsBoost * clamp01((this.rpm - e.idle * 1.4) / (e.redline * 0.42));
    const boostRate = boostTarget > this.boost ? 2.6 : 5.5;
    this.boost = lerp(this.boost, boostTarget, clamp01(boostRate * dt));
    if (e.aspiration === "turbo") torque *= 1 + this.boost * 0.22;
    if (e.aspiration === "twin-turbo") torque *= 1 + this.boost * 0.28;
    if (e.aspiration === "supercharged") torque *= 1 + clamp01(input.throttle) * 0.16;

    // エンジンブレーキ(スロットルオフ時に負トルク)
    if (Math.abs(input.speed) > 1) {
      const engineBrake = (1 - clamp01(input.throttle)) * lerp(18, 62, clamp01(this.rpm / e.redline));
      torque -= engineBrake;
    }

    // クラッチスリップの計算
    const wheelTorqueDemand = Math.abs(torque * newRatio);
    this.clutchSlip = clamp01(Math.abs(this.rpm - targetRpm) / Math.max(200, e.redline * 0.3));

    // 駆動トルク(AWD 配分は呼び出し側で使う)
    const driveTorque = torque * newRatio * 0.92;

    return {
      driveTorque,
      rpm: this.rpm,
      gear: this.gear,
      shifting: this.shiftTimer > 0,
      clutchSlip: this.clutchSlip,
      boost: this.boost,
      ratio: newRatio,
      load: clamp01(torque / (e.torqueNm * 1.05)),
      limiter: this.limiter,
    };
  }

  /** 現在の速度での理論回転数(シフトインジケータ用) */
  rpmForSpeed(speedMs: number, gear = this.gear): number {
    const ratio = gear === 0 ? 0 : gear < 0 ? -3.2 * this.gearbox.finalDrive : this.gearbox.ratios[Math.min(this.gearbox.ratios.length - 1, gear - 1)] * this.gearbox.finalDrive;
    const wheelRpm = (speedMs / (2 * Math.PI * this.spec.dims.wheelRadiusRear)) * 60;
    return Math.abs(wheelRpm * ratio);
  }

  /** 推奨ギア(オートマの表示用) */
  suggestGear(speedMs: number): number {
    for (let gi = 1; gi <= this.gearCount; gi++) {
      const rpm = this.rpmForSpeed(speedMs, gi);
      if (rpm > this.spec.engine.redline * 0.86) continue;
      return gi;
    }
    return this.gearCount;
  }

  /** パワーバンドの開始/終了(UIのタコ表示用) */
  get powerBand(): { start: number; end: number } {
    return { start: this.spec.engine.torqueRpm * 0.65, end: this.spec.engine.powerRpm };
  }
}
