/**
 * physics/Tire.ts
 * 責務: Pacejka 系のタイヤモデル。荷重依存・摩擦楕円(複合スリップ)・熱/摩耗の簡易モデル
 * 公開API: TireModel, TireState, PacejkaCoefficients, DEFAULT_PACEJKA
 * 依存: core/math.ts
 *
 * 設計メモ:
 *  - 「アーケード寄りシムケード」を狙うので、ピーク後の落ち込みは浅め(操りやすい)。
 *  - 縦/横の合成は正規化スリップベクトルで摩擦楕円上に載せる(実装が単純で安定)。
 *  - 荷重感度(loadSensitivity)で、荷重が増えるほど μ がわずかに下がる挙動を入れる。
 *  - 熱は「走行で上がり、止まると冷える」簡易1次遅れ。摩耗はスリップ量の積分。
 */
import { clamp, clamp01, lerp, smoothstep } from "../core/math.js";

export interface PacejkaCoefficients {
  /** 横剛性(B) */
  Bx: number;
  /** 横形状(C) */
  Cx: number;
  /** 横ピーク(D) */
  Dx: number;
  /** 横曲率(E) */
  Ex: number;
  /** 縦剛性 */
  By: number;
  Cy: number;
  Dy: number;
  Ey: number;
  /** ピークスリップ角(rad) */
  peakSlipAngle: number;
  /** ピークスリップ比 */
  peakSlipRatio: number;
  /** 荷重感度(0.05 = 10%荷重増で μ 5%減) */
  loadSensitivity: number;
  /** 滑り始めの落ち込み(0.86 = ピークの86%まで落ちる) */
  tailRatio: number;
}

export const DEFAULT_PACEJKA: PacejkaCoefficients = {
  Bx: 9.2,
  Cx: 1.42,
  Dx: 1.0,
  Ex: 0.96,
  By: 12.5,
  Cy: 1.68,
  Dy: 1.0,
  Ey: 0.88,
  peakSlipAngle: 0.136, // 約 7.8 度
  peakSlipRatio: 0.09,
  loadSensitivity: 0.055,
  tailRatio: 0.88,
};

export interface TireState {
  /** スリップ角(rad) */
  slipAngle: number;
  /** スリップ比(-1..1) */
  slipRatio: number;
  /** 縦力(N) */
  fx: number;
  /** 横力(N) */
  fy: number;
  /** 垂直荷重(N) */
  load: number;
  /** 路面μ(1.0 = ドライ舗装) */
  surfaceMu: number;
  /** 温度(0..1, 0.5 = 適正) */
  temperature: number;
  /** 摩耗(0..1) */
  wear: number;
  /** グリップ係数(合成) */
  gripFactor: number;
  /** スリップの大きさ(0..1, 音/煙/振動用) */
  slipAmount: number;
  /** ロックしているか */
  locked: boolean;
  /** スピンしているか */
  spinning: boolean;
}

export function createTireState(): TireState {
  return {
    slipAngle: 0,
    slipRatio: 0,
    fx: 0,
    fy: 0,
    load: 4000,
    surfaceMu: 1,
    temperature: 0.5,
    wear: 0,
    gripFactor: 1,
    slipAmount: 0,
    locked: false,
    spinning: false,
  };
}

/**
 * 単一タイヤの力を計算する。
 * @param state 更新対象
 * @param slipAngleRad スリップ角
 * @param slipRatio スリップ比
 * @param load 垂直荷重(N)
 * @param mu 路面μ × タイヤ特性
 * @param dt デルタタイム
 * @param brakeInput ブレーキ入力(ロック判定用)
 * @param driveInput 駆動入力(スピン判定用)
 */
export function updateTire(
  state: TireState,
  slipAngleRad: number,
  slipRatio: number,
  load: number,
  mu: number,
  dt: number,
  coeff: PacejkaCoefficients = DEFAULT_PACEJKA,
  brakeInput = 0,
  driveInput = 0
): TireState {
  const loadClamped = Math.max(0, load);
  state.slipAngle = slipAngleRad;
  state.slipRatio = clamp(slipRatio, -2, 2);
  state.load = loadClamped;

  // 荷重感度: 荷重が基準より大きいと μ が下がる
  const nominalLoad = 4000;
  const loadFactor = 1 - coeff.loadSensitivity * Math.log(Math.max(1, loadClamped) / nominalLoad);
  state.surfaceMu = mu;
  // 摩耗と温度でグリップが変化
  const tempFactor = 1 - Math.pow((state.temperature - 0.55) / 0.55, 2) * 0.18;
  const wearFactor = 1 - state.wear * 0.35;
  state.gripFactor = clamp(loadFactor * tempFactor * wearFactor, 0.35, 1.25);

  const maxMu = mu * state.gripFactor;

  // ピークスリップ(荷重が軽いと早く滑る)
  const loadRatio = clamp(loadClamped / nominalLoad, 0.35, 1.6);
  const peakAlpha = coeff.peakSlipAngle * lerp(1.22, 0.92, clamp01((loadRatio - 0.35) / 1.25)) * (1 - state.wear * 0.1);
  const peakKappa = coeff.peakSlipRatio * lerp(1.15, 0.95, clamp01((loadRatio - 0.35) / 1.25));

  const alpha = clamp(slipAngleRad, -1.2, 1.2);
  const kappa = clamp(slipRatio, -1.5, 1.5);

  // 正規化スリップ(円で合成)
  const sa = alpha / peakAlpha;
  const sk = kappa / peakKappa;
  const combined = Math.hypot(sa, sk);
  // ピークで 1.0、その後 tailRatio へ落ち着く
  let forceFactor: number;
  if (combined < 1) {
    // 線形〜ピークへのなめらかな遷移(sin カーブでピークを滑らかに)
    forceFactor = Math.sin((combined * Math.PI) / 2) * (0.96 + 0.04 * combined);
  } else {
    const over = clamp01((combined - 1) / 2.2);
    forceFactor = lerp(1, coeff.tailRatio, smoothstep(0, 1, over));
  }

  const totalForce = maxMu * loadClamped * forceFactor;

  // 向き(合成スリップの方向)
  const dirX = combined > 1e-5 ? sa / combined : 0;
  const dirZ = combined > 1e-5 ? sk / combined : 0;

  // 横力・縦力に配分
  //  横力: スリップ角と逆方向(タイヤが進行方向を向き直させる)
  //  縦力: スリップ比と同方向(空転している車輪は前方へ蹴り出す / ロックは後方へ引く)
  state.fy = -dirX * totalForce;
  state.fx = dirZ * totalForce;

  // 低速ではスリップ角の計算が不安定なので、スリップ量を 0 に寄せる
  const lowSpeedFade = clamp01(Math.abs(kappa) * 0.2 + Math.abs(alpha) * 8);
  state.slipAmount = clamp01((combined - 0.86) / 0.9) * clamp01(lowSpeedFade);

  state.locked = clamp01(brakeInput) > 0.8 && Math.abs(state.slipRatio) > 0.55 && loadClamped > 500;
  state.spinning = clamp01(driveInput) > 0.5 && Math.abs(state.slipRatio) > 0.42 && loadClamped > 500;

  // 熱: スリップで上がる、空冷で下がる
  const heat = state.slipAmount * 2.4 + (state.locked || state.spinning ? 0.8 : 0) * clamp01(state.slipAmount * 2);
  const cooling = (state.temperature - 0.35) * 0.55;
  state.temperature = clamp01(state.temperature + (heat - cooling) * dt * 0.35);

  // 摩耗: 滑っている量に比例
  state.wear = clamp01(state.wear + state.slipAmount * dt * 0.0016 * (1 + state.temperature));

  return state;
}

/**
 * タイヤの転がり抵抗と空転の影響
 */
export function rollingResistance(load: number, speed: number, wear: number): number {
  const base = 0.012 + wear * 0.008;
  const speedFactor = 1 + Math.abs(speed) * 0.0022;
  return load * base * speedFactor;
}

/**
 * タイヤの音・煙の閾値
 */
export function slipIntensity(state: TireState): number {
  return clamp01(state.slipAmount);
}

/** 温度の表示ラベル */
export function temperatureLabel(t: number): string {
  if (t < 0.3) return "冷間";
  if (t < 0.5) return "適正";
  if (t < 0.72) return "良好";
  if (t < 0.88) return "高温";
  return "過熱";
}

/**
 * 4輪の平均的なグリップ(UI表示用)
 */
export function averageGrip(tires: TireState[]): number {
  if (!tires.length) return 1;
  let s = 0;
  for (const t of tires) s += t.gripFactor * t.surfaceMu;
  return s / tires.length;
}

export { clamp, lerp };
