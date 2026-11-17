/**
 * car/spec/CarSpec.ts
 * 責務: オリジナル車16台の「見た目パラメータ + 性能パラメータ」を一元管理
 * 公開API: CarSpec, CARS, getCar, PAINT_FINISHES, WHEEL_STYLES, carStats
 * 依存: core/math.ts のみ(純データ)
 *
 * 設計メモ:
 *  - すべて架空の車。実在ブランド・車名・ロゴは使わない。
 *  - 数値は「寸法(m)・質量(kg)・出力(hp)」など実車に近いレンジで統一。
 *  - profile の各配列は「後端→前端」の 11 要素。値は比率(0..1)で、
 *    実際の寸法は dims と掛け合わせて決まる。
 *  - 物理(physics/)と ジオメトリ(car/geometry/)の両方が同じ数値を参照する。
 */

export type DriveType = "FF" | "FR" | "MR" | "AWD" | "RR";
export type BodyStyle =
  | "hatch"
  | "coupe"
  | "sedan"
  | "muscle"
  | "sport"
  | "super"
  | "hyper"
  | "rally"
  | "suv"
  | "pickup"
  | "classic"
  | "roadster"
  | "lightweight"
  | "gt4"
  | "buggy"
  | "classicRally";

export type PaintFinish = "gloss" | "metallic" | "pearl" | "matte" | "satin" | "carbon" | "chrome";

/** 断面形状を決める 11 点の比率データ(後端 → 前端) */
export interface BodyProfile {
  /** 平面視の半幅(0..1, 1 = dims.width/2) */
  planHalfWidth: number[];
  /** ベルトライン(肩)の高さ(0..1, 1 = dims.height) */
  belt: number[];
  /** フロア高さ(0..1 は車高比、地面からの絶対高さに変換) */
  floor: number[];
  /** 上端(ボンネット/デッキ)の高さ(0..1) */
  deck: number[];
  /** 側面の角ばり(2=楕円, 6=箱) */
  sideExponent: number[];
  /** 上面の角ばり */
  topExponent: number[];
  /** 上半分の絞り(0=ストレート, 0.35=強いテーパー) */
  tumblehome: number;
  /** ルーフの反り(0..0.08) */
  roofCrown: number;
  /** キャビンの開始位置(0=後端, 1=前端) */
  cabinStart: number;
  cabinEnd: number;
  /** 屋根の高さ(0..1) */
  roofHeight: number;
  /** ウィンドシールドの寝かせ角(度) */
  windshieldAngle: number;
  /** リアウィンドウの傾斜(度) */
  rearGlassAngle: number;
  /** フェンダーの張り出し(0..0.16) */
  fenderFlare: number;
  /** 前後オーバーハング比 */
  frontOverhang: number;
  rearOverhang: number;
  /** 最低地上高(m) */
  rideHeight: number;
  /** 断面数(品質) */
  sections: number;
}

export interface EngineSpec {
  /** 総排気量(L) */
  displacement: number;
  /** 最高出力 hp */
  powerHp: number;
  /** 最高出力回転数 */
  powerRpm: number;
  /** 最大トルク Nm */
  torqueNm: number;
  /** 最大トルク回転数 */
  torqueRpm: number;
  /** レッドライン */
  redline: number;
  /** アイドル */
  idle: number;
  /** 過給 */
  aspiration: "na" | "turbo" | "supercharged" | "twin-turbo";
  /** シリンダー数(音の合成に使用) */
  cylinders: number;
  /** トルクカーブの性格(0=フラット, 1=尖った) */
  peakiness: number;
  /** サウンドの基準周波数(Hz) */
  soundBase: number;
}

export interface GearboxSpec {
  /** 変速比(1速→トップ) */
  ratios: number[];
  /** ファイナルドライブ */
  finalDrive: number;
  /** 変速時間(秒) */
  shiftTime: number;
  /** デュアルクラッチか */
  dct: boolean;
  /** 自動変速を行うか */
  auto: boolean;
}

export interface ChassisSpec {
  mass: number;
  /** 前後重量配分(前の割合) */
  frontWeight: number;
  /** 重心高さ(m) */
  cgHeight: number;
  /** ホイールベース(m) */
  wheelbase: number;
  /** トレッド(前/後, m) */
  trackFront: number;
  trackRear: number;
  /** 空気抵抗係数 */
  dragCd: number;
  /** 前面投影面積(m²) */
  frontalArea: number;
  /** リフト係数(負ならダウンフォース) */
  liftCoef: number;
  /** タイヤグリップ(1.0 = μ1.0) */
  tireGripFront: number;
  tireGripRear: number;
  /** サスペンション: ばね定数(N/m) 前後 */
  springFront: number;
  springRear: number;
  /** ダンパー(N·s/m) */
  damperFront: number;
  damperRear: number;
  /** スタビライザー(N/m) */
  arbFront: number;
  arbRear: number;
  /** ステアリング最大舵角(度) */
  steerLock: number;
  /** ブレーキトルク(Nm) */
  brakeTorque: number;
  /** ハンドブレーキトルク */
  handbrakeTorque: number;
  /** 駆動配分(前輪への割合, AWDのみ意味を持つ) */
  driveBias: number;
  /** LSD の効き(0..1) */
  limitedSlip: number;
  /** アンチロール剛性の見た目用ロール係数 */
  rollStiffness: number;
}

export interface WheelStyleSpec {
  /** リム径(インチ) */
  rimInch: number;
  /** スポーク数 */
  spokes: number;
  /** スポーク形状 */
  spokeStyle: "straight" | "split" | "mesh" | "turbine" | "dish" | "5star";
  /** コンケーブ(0=フラット, 1=深い) */
  concave: number;
  /** リップの太さ */
  lip: number;
  /** リムの色 */
  rimColor: number;
  /** センターキャップの色 */
  capColor: number;
}

export interface CarSpec {
  id: string;
  name: string;
  maker: string;
  year: number;
  style: BodyStyle;
  drive: DriveType;
  /** クラス(ゲーム内の区分) */
  tier: "D" | "C" | "B" | "A" | "S" | "X";
  description: string;
  dims: {
    length: number;
    width: number;
    height: number;
    wheelRadiusFront: number;
    wheelRadiusRear: number;
    wheelWidthFront: number;
    wheelWidthRear: number;
  };
  profile: BodyProfile;
  engine: EngineSpec;
  gearbox: GearboxSpec;
  chassis: ChassisSpec;
  wheel: WheelStyleSpec;
  /** 塗装 */
  finish: PaintFinish;
  /** ボディカラー(0xRRGGBB) */
  colors: number[];
  /** 内装色 */
  interiorColor: number;
  /** ライト形状 */
  lights: {
    headStyle: "strip" | "round" | "quad" | "angular" | "popup";
    tailStyle: "bar" | "split" | "round" | "lshape";
    drl: number;
    headColor: number;
  };
  /** 0-100km/h の公称値(表示用) */
  zeroTo100: number;
  /** 最高速(km/h, 表示用) */
  topSpeed: number;
}

/* ------------------------------------------------------------------ */
/* 共通パラメータのプリセット                                        */
/* ------------------------------------------------------------------ */

const P = (
  planHalfWidth: number[],
  belt: number[],
  floor: number[],
  deck: number[],
  sideExponent: number[],
  topExponent: number[],
  extra: Partial<BodyProfile>
): BodyProfile => ({
  planHalfWidth,
  belt,
  floor,
  deck,
  sideExponent,
  topExponent,
  tumblehome: 0.16,
  roofCrown: 0.02,
  cabinStart: 0.28,
  cabinEnd: 0.68,
  roofHeight: 0.82,
  windshieldAngle: 32,
  rearGlassAngle: 44,
  fenderFlare: 0.06,
  frontOverhang: 0.16,
  rearOverhang: 0.14,
  rideHeight: 0.16,
  sections: 44,
  ...extra,
});

/** 11 要素を滑らかに生成するヘルパ(制御点の少ない指定から) */
function curve11(...values: number[]): number[] {
  // 与えられた制御点を 1次補間で 11 点へ
  const out: number[] = [];
  const n = values.length;
  for (let i = 0; i < 11; i++) {
    const t = (i / 10) * (n - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(n - 1, i0 + 1);
    const f = t - i0;
    out.push(values[i0] + (values[i1] - values[i0]) * f);
  }
  return out;
}

/** 楕円的な膨らみを持つ配列を作る(前後端で絞る) */
function bulge(peak: number, ends: number, center = 0.5, sharp = 1.4): number[] {
  const out: number[] = [];
  for (let i = 0; i < 11; i++) {
    const t = i / 10;
    const d = Math.abs(t - center) / 0.5;
    out.push(ends + (peak - ends) * Math.pow(Math.max(0, 1 - Math.pow(d, sharp)), 0.9));
  }
  return out;
}

const GEAR_6 = [3.62, 2.19, 1.6, 1.24, 1.0, 0.82];
const GEAR_7 = [3.82, 2.4, 1.8, 1.42, 1.16, 0.95, 0.78];
const GEAR_8 = [4.5, 2.9, 2.1, 1.6, 1.28, 1.05, 0.88, 0.74];

/* ------------------------------------------------------------------ */
/* 16台のデータ                                                      */
/* ------------------------------------------------------------------ */

export const CARS: CarSpec[] = [
  /* 01 ---------------------------------------------------------- */
  {
    id: "vela_gt",
    name: "ヴェラ GT",
    maker: "ノルテ",
    year: 2021,
    style: "hatch",
    drive: "FF",
    tier: "D",
    description: "1.5Lターボのホットハッチ。軽量ボディと回頭性で峠を得意とする入門者向けの1台。",
    dims: { length: 4.06, width: 1.76, height: 1.42, wheelRadiusFront: 0.315, wheelRadiusRear: 0.315, wheelWidthFront: 0.225, wheelWidthRear: 0.215 },
    profile: P(
      curve11(0.62, 0.9, 0.97, 0.98, 0.95, 0.82),
      curve11(0.74, 0.78, 0.8, 0.8, 0.78, 0.7),
      curve11(0.1, 0.08, 0.08, 0.08, 0.09, 0.12),
      curve11(0.64, 0.74, 0.78, 0.77, 0.72, 0.52),
      curve11(3.4, 3.8, 3.8, 3.6, 3.4, 3.0),
      curve11(2.6, 3.0, 3.2, 3.1, 2.8, 2.4),
      { cabinStart: 0.22, cabinEnd: 0.72, roofHeight: 0.96, tumblehome: 0.12, windshieldAngle: 30, rearGlassAngle: 38, fenderFlare: 0.05, rideHeight: 0.145 }
    ),
    engine: { displacement: 1.5, powerHp: 198, powerRpm: 6200, torqueNm: 260, torqueRpm: 2600, redline: 6800, idle: 850, aspiration: "turbo", cylinders: 4, peakiness: 0.35, soundBase: 118 },
    gearbox: { ratios: GEAR_6, finalDrive: 4.06, shiftTime: 0.16, dct: false, auto: true },
    chassis: {
      mass: 1268, frontWeight: 0.62, cgHeight: 0.52, wheelbase: 2.56, trackFront: 1.52, trackRear: 1.5,
      dragCd: 0.32, frontalArea: 2.1, liftCoef: -0.02, tireGripFront: 1.02, tireGripRear: 0.98,
      springFront: 32000, springRear: 28000, damperFront: 2600, damperRear: 2400, arbFront: 18000, arbRear: 12000,
      steerLock: 34, brakeTorque: 2100, handbrakeTorque: 1500, driveBias: 1, limitedSlip: 0.35, rollStiffness: 1.0,
    },
    wheel: { rimInch: 18, spokes: 5, spokeStyle: "5star", concave: 0.3, lip: 0.1, rimColor: 0x2b2d31, capColor: 0xc23a2b },
    finish: "metallic",
    colors: [0x1c5d8c, 0xe8e8e8, 0xc23a2b, 0x2f9e6e, 0x2b2f36],
    interiorColor: 0x1a1a1c,
    lights: { headStyle: "angular", tailStyle: "split", drl: 0xfff4e0, headColor: 0xfff6e8 },
    zeroTo100: 6.6,
    topSpeed: 232,
  },
  /* 02 ---------------------------------------------------------- */
  {
    id: "lumen_coupe",
    name: "ルーメン クーペ",
    maker: "ノルテ",
    year: 2019,
    style: "coupe",
    drive: "FR",
    tier: "C",
    description: "2.0L自然吸気のコンパクトFRクーペ。素直なハンドリングで運転の基本を学べる。",
    dims: { length: 4.24, width: 1.78, height: 1.31, wheelRadiusFront: 0.32, wheelRadiusRear: 0.325, wheelWidthFront: 0.225, wheelWidthRear: 0.235 },
    profile: P(
      curve11(0.58, 0.88, 0.96, 0.98, 0.96, 0.8),
      curve11(0.66, 0.72, 0.74, 0.74, 0.72, 0.62),
      curve11(0.09, 0.07, 0.07, 0.07, 0.08, 0.1),
      curve11(0.56, 0.66, 0.7, 0.7, 0.66, 0.44),
      curve11(3.6, 4.0, 4.0, 3.8, 3.5, 3.0),
      curve11(2.8, 3.2, 3.3, 3.2, 3.0, 2.5),
      { cabinStart: 0.2, cabinEnd: 0.64, roofHeight: 0.86, tumblehome: 0.2, windshieldAngle: 26, rearGlassAngle: 34, fenderFlare: 0.055, rideHeight: 0.125 }
    ),
    engine: { displacement: 2.0, powerHp: 208, powerRpm: 7000, torqueNm: 225, torqueRpm: 4800, redline: 7500, idle: 800, aspiration: "na", cylinders: 4, peakiness: 0.7, soundBase: 142 },
    gearbox: { ratios: GEAR_6, finalDrive: 4.1, shiftTime: 0.14, dct: false, auto: true },
    chassis: {
      mass: 1280, frontWeight: 0.53, cgHeight: 0.48, wheelbase: 2.57, trackFront: 1.52, trackRear: 1.54,
      dragCd: 0.29, frontalArea: 1.95, liftCoef: -0.05, tireGripFront: 1.04, tireGripRear: 1.06,
      springFront: 34000, springRear: 30000, damperFront: 2800, damperRear: 2600, arbFront: 20000, arbRear: 14000,
      steerLock: 36, brakeTorque: 2300, handbrakeTorque: 1600, driveBias: 0, limitedSlip: 0.45, rollStiffness: 1.1,
    },
    wheel: { rimInch: 18, spokes: 10, spokeStyle: "split", concave: 0.35, lip: 0.12, rimColor: 0x3a3d42, capColor: 0x1c5d8c },
    finish: "pearl",
    colors: [0xf2f0ea, 0x1b1f26, 0xb8863b, 0x8f2f3a, 0x3b6ea8],
    interiorColor: 0x2a2320,
    lights: { headStyle: "quad", tailStyle: "round", drl: 0xfff0d8, headColor: 0xfff8ee },
    zeroTo100: 6.4,
    topSpeed: 238,
  },
  /* 03 ---------------------------------------------------------- */
  {
    id: "campo_rs",
    name: "カンポ RS",
    maker: "ノルテ",
    year: 2022,
    style: "sedan",
    drive: "AWD",
    tier: "B",
    description: "2.0Lターボ+可変AWDのラリー由来セダン。荒れた路面でも安定して速い。",
    dims: { length: 4.62, width: 1.82, height: 1.47, wheelRadiusFront: 0.335, wheelRadiusRear: 0.335, wheelWidthFront: 0.245, wheelWidthRear: 0.245 },
    profile: P(
      curve11(0.66, 0.92, 0.99, 0.99, 0.96, 0.86),
      curve11(0.68, 0.72, 0.73, 0.73, 0.72, 0.66),
      curve11(0.1, 0.08, 0.08, 0.08, 0.09, 0.11),
      curve11(0.58, 0.68, 0.71, 0.71, 0.68, 0.5),
      curve11(3.6, 4.0, 4.0, 3.9, 3.6, 3.2),
      curve11(2.8, 3.2, 3.3, 3.3, 3.0, 2.6),
      { cabinStart: 0.26, cabinEnd: 0.68, roofHeight: 0.9, tumblehome: 0.17, windshieldAngle: 30, rearGlassAngle: 40, fenderFlare: 0.07, rideHeight: 0.14 }
    ),
    engine: { displacement: 2.0, powerHp: 296, powerRpm: 5800, torqueNm: 420, torqueRpm: 3000, redline: 6800, idle: 850, aspiration: "turbo", cylinders: 4, peakiness: 0.3, soundBase: 108 },
    gearbox: { ratios: GEAR_6, finalDrive: 3.9, shiftTime: 0.12, dct: true, auto: true },
    chassis: {
      mass: 1465, frontWeight: 0.59, cgHeight: 0.53, wheelbase: 2.67, trackFront: 1.56, trackRear: 1.56,
      dragCd: 0.33, frontalArea: 2.25, liftCoef: -0.06, tireGripFront: 1.1, tireGripRear: 1.1,
      springFront: 38000, springRear: 33000, damperFront: 3200, damperRear: 2900, arbFront: 22000, arbRear: 15000,
      steerLock: 33, brakeTorque: 2900, handbrakeTorque: 1700, driveBias: 0.52, limitedSlip: 0.6, rollStiffness: 1.25,
    },
    wheel: { rimInch: 19, spokes: 10, spokeStyle: "split", concave: 0.32, lip: 0.1, rimColor: 0x4a4d52, capColor: 0x1a7fb5 },
    finish: "metallic",
    colors: [0x1a7fb5, 0xd9dde2, 0x2b2f36, 0xe5b32c, 0x9b2b35],
    interiorColor: 0x1b1d21,
    lights: { headStyle: "strip", tailStyle: "lshape", drl: 0xfff6e6, headColor: 0xfffaf0 },
    zeroTo100: 4.9,
    topSpeed: 258,
  },
  /* 04 ---------------------------------------------------------- */
  {
    id: "toro_muscle",
    name: "トロ・マッスル",
    maker: "サンタナ",
    year: 1970,
    style: "muscle",
    drive: "FR",
    tier: "C",
    description: "6.4L V8のアメリカン・マッスル。直線番長だが、丁寧に扱えば峠も面白い。",
    dims: { length: 4.86, width: 1.94, height: 1.34, wheelRadiusFront: 0.345, wheelRadiusRear: 0.36, wheelWidthFront: 0.235, wheelWidthRear: 0.285 },
    profile: P(
      curve11(0.72, 0.96, 1.0, 1.0, 0.98, 0.9),
      curve11(0.68, 0.71, 0.72, 0.72, 0.7, 0.64),
      curve11(0.08, 0.07, 0.07, 0.07, 0.07, 0.09),
      curve11(0.56, 0.62, 0.64, 0.64, 0.61, 0.5),
      curve11(5.0, 5.4, 5.4, 5.2, 4.8, 4.2),
      curve11(3.4, 3.8, 3.8, 3.6, 3.2, 2.8),
      { cabinStart: 0.3, cabinEnd: 0.66, roofHeight: 0.84, tumblehome: 0.1, windshieldAngle: 42, rearGlassAngle: 50, fenderFlare: 0.02, rideHeight: 0.16, rearOverhang: 0.24 }
    ),
    engine: { displacement: 6.4, powerHp: 390, powerRpm: 4600, torqueNm: 590, torqueRpm: 3200, redline: 5600, idle: 700, aspiration: "na", cylinders: 8, peakiness: 0.25, soundBase: 62 },
    gearbox: { ratios: [2.66, 1.78, 1.3, 1.0], finalDrive: 3.55, shiftTime: 0.3, dct: false, auto: false },
    chassis: {
      mass: 1690, frontWeight: 0.56, cgHeight: 0.56, wheelbase: 2.95, trackFront: 1.6, trackRear: 1.58,
      dragCd: 0.44, frontalArea: 2.4, liftCoef: 0.02, tireGripFront: 0.9, tireGripRear: 0.94,
      springFront: 24000, springRear: 22000, damperFront: 2100, damperRear: 2000, arbFront: 12000, arbRear: 8000,
      steerLock: 38, brakeTorque: 2200, handbrakeTorque: 1400, driveBias: 0, limitedSlip: 0.25, rollStiffness: 0.75,
    },
    wheel: { rimInch: 18, spokes: 5, spokeStyle: "straight", concave: 0.12, lip: 0.3, rimColor: 0xb9bcc0, capColor: 0x8a2b2b },
    finish: "gloss",
    colors: [0x9b2b35, 0xe0a52e, 0x1b1c1e, 0x2f6b46, 0xe8e4da],
    interiorColor: 0x2b2118,
    lights: { headStyle: "quad", tailStyle: "bar", drl: 0xffe9c8, headColor: 0xfff2d8 },
    zeroTo100: 5.9,
    topSpeed: 249,
  },
  /* 05 ---------------------------------------------------------- */
  {
    id: "espada_mr",
    name: "エスパダ MR",
    maker: "ベガ",
    year: 2020,
    style: "sport",
    drive: "MR",
    tier: "B",
    description: "3.5L V6ミッドシップ。低重心と回頭性でサーキットを得意とする純2シーター。",
    dims: { length: 4.1, width: 1.88, height: 1.18, wheelRadiusFront: 0.325, wheelRadiusRear: 0.34, wheelWidthFront: 0.225, wheelWidthRear: 0.275 },
    profile: P(
      curve11(0.6, 0.9, 0.98, 0.99, 0.95, 0.72),
      curve11(0.6, 0.66, 0.68, 0.67, 0.63, 0.5),
      curve11(0.07, 0.06, 0.06, 0.06, 0.07, 0.09),
      curve11(0.5, 0.58, 0.61, 0.6, 0.56, 0.34),
      curve11(4.0, 4.6, 4.8, 4.6, 4.2, 3.4),
      curve11(3.0, 3.4, 3.6, 3.5, 3.2, 2.6),
      { cabinStart: 0.24, cabinEnd: 0.62, roofHeight: 0.78, tumblehome: 0.24, windshieldAngle: 24, rearGlassAngle: 30, fenderFlare: 0.1, rideHeight: 0.105, frontOverhang: 0.13 }
    ),
    engine: { displacement: 3.5, powerHp: 405, powerRpm: 6800, torqueNm: 460, torqueRpm: 4600, redline: 7600, idle: 850, aspiration: "na", cylinders: 6, peakiness: 0.6, soundBase: 96 },
    gearbox: { ratios: GEAR_7, finalDrive: 3.85, shiftTime: 0.09, dct: true, auto: true },
    chassis: {
      mass: 1395, frontWeight: 0.42, cgHeight: 0.43, wheelbase: 2.48, trackFront: 1.59, trackRear: 1.56,
      dragCd: 0.32, frontalArea: 1.9, liftCoef: -0.18, tireGripFront: 1.12, tireGripRear: 1.18,
      springFront: 42000, springRear: 46000, damperFront: 3600, damperRear: 3800, arbFront: 24000, arbRear: 18000,
      steerLock: 30, brakeTorque: 3400, handbrakeTorque: 1600, driveBias: 0, limitedSlip: 0.7, rollStiffness: 1.45,
    },
    wheel: { rimInch: 20, spokes: 5, spokeStyle: "5star", concave: 0.6, lip: 0.08, rimColor: 0x1d1f22, capColor: 0xd8a23a },
    finish: "metallic",
    colors: [0xd8492b, 0xf0f2f4, 0x1d1f22, 0x2a4d8f, 0xc9b464],
    interiorColor: 0x141416,
    lights: { headStyle: "strip", tailStyle: "split", drl: 0xf0f6ff, headColor: 0xf4f8ff },
    zeroTo100: 4.2,
    topSpeed: 291,
  },
  /* 06 ---------------------------------------------------------- */
  {
    id: "aurora_s",
    name: "オーロラ S",
    maker: "ベガ",
    year: 2023,
    style: "super",
    drive: "AWD",
    tier: "A",
    description: "4.0L V8ツインターボ+電動アシスト。日常もこなす高速GT系スーパースポーツ。",
    dims: { length: 4.5, width: 1.96, height: 1.22, wheelRadiusFront: 0.34, wheelRadiusRear: 0.355, wheelWidthFront: 0.255, wheelWidthRear: 0.305 },
    profile: P(
      curve11(0.62, 0.92, 1.0, 1.0, 0.97, 0.76),
      curve11(0.6, 0.67, 0.69, 0.68, 0.64, 0.52),
      curve11(0.07, 0.06, 0.06, 0.06, 0.07, 0.08),
      curve11(0.52, 0.6, 0.63, 0.62, 0.58, 0.36),
      curve11(4.2, 4.8, 5.0, 4.8, 4.4, 3.6),
      curve11(3.0, 3.5, 3.7, 3.6, 3.2, 2.7),
      { cabinStart: 0.26, cabinEnd: 0.6, roofHeight: 0.76, tumblehome: 0.26, windshieldAngle: 23, rearGlassAngle: 28, fenderFlare: 0.11, rideHeight: 0.1, frontOverhang: 0.15 }
    ),
    engine: { displacement: 4.0, powerHp: 660, powerRpm: 6500, torqueNm: 800, torqueRpm: 2500, redline: 7200, idle: 900, aspiration: "twin-turbo", cylinders: 8, peakiness: 0.2, soundBase: 74 },
    gearbox: { ratios: GEAR_8, finalDrive: 3.6, shiftTime: 0.07, dct: true, auto: true },
    chassis: {
      mass: 1620, frontWeight: 0.45, cgHeight: 0.44, wheelbase: 2.62, trackFront: 1.66, trackRear: 1.62,
      dragCd: 0.31, frontalArea: 2.05, liftCoef: -0.28, tireGripFront: 1.18, tireGripRear: 1.24,
      springFront: 50000, springRear: 52000, damperFront: 4200, damperRear: 4400, arbFront: 28000, arbRear: 21000,
      steerLock: 28, brakeTorque: 4200, handbrakeTorque: 1800, driveBias: 0.38, limitedSlip: 0.8, rollStiffness: 1.6,
    },
    wheel: { rimInch: 21, spokes: 10, spokeStyle: "turbine", concave: 0.5, lip: 0.06, rimColor: 0x2a2d31, capColor: 0xd8492b },
    finish: "pearl",
    colors: [0x2a2d31, 0xd8492b, 0xe9ecef, 0x1f4f7a, 0xb9a15f],
    interiorColor: 0x1a1414,
    lights: { headStyle: "strip", tailStyle: "bar", drl: 0xf2f8ff, headColor: 0xf6faff },
    zeroTo100: 3.1,
    topSpeed: 325,
  },
  /* 07 ---------------------------------------------------------- */
  {
    id: "meridian_x",
    name: "メリディアン X",
    maker: "ベガ",
    year: 2024,
    style: "hyper",
    drive: "AWD",
    tier: "X",
    description: "6.5L V12自然吸気+3モーター。1,050馬力のハイパーカー。空力と電子制御で異次元の速さ。",
    dims: { length: 4.72, width: 2.04, height: 1.16, wheelRadiusFront: 0.345, wheelRadiusRear: 0.365, wheelWidthFront: 0.265, wheelWidthRear: 0.335 },
    profile: P(
      curve11(0.6, 0.94, 1.02, 1.02, 0.98, 0.72),
      curve11(0.58, 0.65, 0.67, 0.66, 0.62, 0.48),
      curve11(0.06, 0.05, 0.05, 0.05, 0.06, 0.07),
      curve11(0.48, 0.56, 0.59, 0.58, 0.54, 0.32),
      curve11(4.4, 5.0, 5.2, 5.0, 4.6, 3.8),
      curve11(3.2, 3.6, 3.8, 3.7, 3.4, 2.8),
      { cabinStart: 0.28, cabinEnd: 0.58, roofHeight: 0.72, tumblehome: 0.3, windshieldAngle: 21, rearGlassAngle: 24, fenderFlare: 0.13, rideHeight: 0.085, frontOverhang: 0.14 }
    ),
    engine: { displacement: 6.5, powerHp: 1050, powerRpm: 8700, torqueNm: 900, torqueRpm: 5200, redline: 9500, idle: 1000, aspiration: "na", cylinders: 12, peakiness: 0.75, soundBase: 58 },
    gearbox: { ratios: GEAR_8, finalDrive: 3.4, shiftTime: 0.05, dct: true, auto: true },
    chassis: {
      mass: 1685, frontWeight: 0.44, cgHeight: 0.4, wheelbase: 2.72, trackFront: 1.72, trackRear: 1.68,
      dragCd: 0.34, frontalArea: 2.15, liftCoef: -0.55, tireGripFront: 1.24, tireGripRear: 1.32,
      springFront: 62000, springRear: 64000, damperFront: 5200, damperRear: 5400, arbFront: 34000, arbRear: 26000,
      steerLock: 27, brakeTorque: 5200, handbrakeTorque: 2000, driveBias: 0.35, limitedSlip: 0.9, rollStiffness: 1.8,
    },
    wheel: { rimInch: 21, spokes: 5, spokeStyle: "dish", concave: 0.25, lip: 0.05, rimColor: 0x151719, capColor: 0xc9b464 },
    finish: "carbon",
    colors: [0x151719, 0xc9b464, 0x8f1f2b, 0xe4e7ea, 0x274a6d],
    interiorColor: 0x0e0e10,
    lights: { headStyle: "strip", tailStyle: "split", drl: 0xeaf4ff, headColor: 0xf0f8ff },
    zeroTo100: 2.4,
    topSpeed: 368,
  },
  /* 08 ---------------------------------------------------------- */
  {
    id: "quebrada_r",
    name: "ケブラダ R",
    maker: "サンタナ",
    year: 2022,
    style: "rally",
    drive: "AWD",
    tier: "A",
    description: "1.6Lターボのラリー仕様。ダートの高速コーナーで真価を発揮する。",
    dims: { length: 4.08, width: 1.9, height: 1.46, wheelRadiusFront: 0.33, wheelRadiusRear: 0.33, wheelWidthFront: 0.235, wheelWidthRear: 0.235 },
    profile: P(
      curve11(0.66, 0.94, 1.0, 1.0, 0.97, 0.84),
      curve11(0.7, 0.74, 0.75, 0.75, 0.73, 0.66),
      curve11(0.14, 0.12, 0.12, 0.12, 0.13, 0.16),
      curve11(0.62, 0.7, 0.73, 0.72, 0.68, 0.52),
      curve11(3.6, 4.0, 4.0, 3.9, 3.6, 3.2),
      curve11(2.8, 3.2, 3.3, 3.2, 3.0, 2.6),
      { cabinStart: 0.24, cabinEnd: 0.7, roofHeight: 0.95, tumblehome: 0.12, windshieldAngle: 34, rearGlassAngle: 42, fenderFlare: 0.13, rideHeight: 0.17 }
    ),
    engine: { displacement: 1.6, powerHp: 320, powerRpm: 6500, torqueNm: 425, torqueRpm: 3500, redline: 7200, idle: 950, aspiration: "turbo", cylinders: 4, peakiness: 0.3, soundBase: 132 },
    gearbox: { ratios: GEAR_6, finalDrive: 4.3, shiftTime: 0.1, dct: true, auto: true },
    chassis: {
      mass: 1230, frontWeight: 0.55, cgHeight: 0.5, wheelbase: 2.52, trackFront: 1.62, trackRear: 1.62,
      dragCd: 0.36, frontalArea: 2.05, liftCoef: -0.12, tireGripFront: 1.08, tireGripRear: 1.08,
      springFront: 40000, springRear: 36000, damperFront: 3400, damperRear: 3200, arbFront: 24000, arbRear: 16000,
      steerLock: 36, brakeTorque: 3000, handbrakeTorque: 2200, driveBias: 0.48, limitedSlip: 0.75, rollStiffness: 1.2,
    },
    wheel: { rimInch: 18, spokes: 10, spokeStyle: "mesh", concave: 0.2, lip: 0.15, rimColor: 0xe4e6e8, capColor: 0xd8492b },
    finish: "gloss",
    colors: [0x1c5d8c, 0xe8e8e8, 0xd8492b, 0x2f9e6e, 0xe5b32c],
    interiorColor: 0x1b1b1d,
    lights: { headStyle: "quad", tailStyle: "lshape", drl: 0xfff2d0, headColor: 0xfff6e0 },
    zeroTo100: 3.9,
    topSpeed: 268,
  },
  /* 09 ---------------------------------------------------------- */
  {
    id: "sierra_suv",
    name: "シエラ 4x4",
    maker: "サンタナ",
    year: 2021,
    style: "suv",
    drive: "AWD",
    tier: "D",
    description: "3.0L V6の本格SUV。悪路に強く、山道の上でも安定感がある。",
    dims: { length: 4.88, width: 1.98, height: 1.79, wheelRadiusFront: 0.4, wheelRadiusRear: 0.4, wheelWidthFront: 0.255, wheelWidthRear: 0.265 },
    profile: P(
      curve11(0.76, 0.98, 1.0, 1.0, 1.0, 0.94),
      curve11(0.72, 0.75, 0.76, 0.77, 0.77, 0.72),
      curve11(0.16, 0.14, 0.14, 0.14, 0.15, 0.18),
      curve11(0.78, 0.86, 0.88, 0.9, 0.88, 0.78),
      curve11(5.0, 5.4, 5.4, 5.4, 5.0, 4.4),
      curve11(3.4, 3.8, 3.8, 3.8, 3.4, 3.0),
      { cabinStart: 0.16, cabinEnd: 0.82, roofHeight: 1.0, tumblehome: 0.08, windshieldAngle: 44, rearGlassAngle: 70, fenderFlare: 0.09, rideHeight: 0.245, rearOverhang: 0.2 }
    ),
    engine: { displacement: 3.0, powerHp: 355, powerRpm: 6200, torqueNm: 480, torqueRpm: 2800, redline: 6600, idle: 700, aspiration: "turbo", cylinders: 6, peakiness: 0.25, soundBase: 84 },
    gearbox: { ratios: GEAR_8, finalDrive: 3.7, shiftTime: 0.18, dct: false, auto: true },
    chassis: {
      mass: 2180, frontWeight: 0.55, cgHeight: 0.72, wheelbase: 2.92, trackFront: 1.68, trackRear: 1.7,
      dragCd: 0.38, frontalArea: 2.9, liftCoef: 0.06, tireGripFront: 0.96, tireGripRear: 0.98,
      springFront: 34000, springRear: 32000, damperFront: 3400, damperRear: 3200, arbFront: 20000, arbRear: 12000,
      steerLock: 32, brakeTorque: 3200, handbrakeTorque: 1600, driveBias: 0.45, limitedSlip: 0.5, rollStiffness: 0.85,
    },
    wheel: { rimInch: 20, spokes: 6, spokeStyle: "straight", concave: 0.18, lip: 0.18, rimColor: 0x6d7175, capColor: 0x2b2f36 },
    finish: "gloss",
    colors: [0x2b2f36, 0xd9d4c8, 0x2f6b46, 0x8a6a4a, 0x1f4f7a],
    interiorColor: 0x2b2723,
    lights: { headStyle: "quad", tailStyle: "lshape", drl: 0xfff0d0, headColor: 0xfff4e4 },
    zeroTo100: 6.8,
    topSpeed: 232,
  },
  /* 10 ---------------------------------------------------------- */
  {
    id: "pampa_pickup",
    name: "パンパ ピックアップ",
    maker: "サンタナ",
    year: 2020,
    style: "pickup",
    drive: "AWD",
    tier: "D",
    description: "5.0L V8のピックアップ。砂漠の高速走行でも底が抜けないタフさが売り。",
    dims: { length: 5.42, width: 2.02, height: 1.86, wheelRadiusFront: 0.42, wheelRadiusRear: 0.42, wheelWidthFront: 0.265, wheelWidthRear: 0.285 },
    profile: P(
      curve11(0.82, 1.0, 1.0, 1.0, 1.0, 0.96),
      curve11(0.72, 0.75, 0.76, 0.77, 0.77, 0.74),
      curve11(0.2, 0.18, 0.18, 0.18, 0.19, 0.22),
      curve11(0.8, 0.88, 0.9, 0.92, 0.9, 0.8),
      curve11(5.4, 5.8, 5.8, 5.8, 5.4, 4.8),
      curve11(3.6, 4.0, 4.0, 4.0, 3.6, 3.2),
      { cabinStart: 0.08, cabinEnd: 0.46, roofHeight: 1.0, tumblehome: 0.06, windshieldAngle: 48, rearGlassAngle: 82, fenderFlare: 0.1, rideHeight: 0.27, rearOverhang: 0.3 }
    ),
    engine: { displacement: 5.0, powerHp: 400, powerRpm: 5900, torqueNm: 555, torqueRpm: 3900, redline: 6300, idle: 680, aspiration: "na", cylinders: 8, peakiness: 0.3, soundBase: 70 },
    gearbox: { ratios: [4.7, 3.13, 2.1, 1.67, 1.29, 1.0, 0.84], finalDrive: 3.55, shiftTime: 0.2, dct: false, auto: true },
    chassis: {
      mass: 2420, frontWeight: 0.58, cgHeight: 0.78, wheelbase: 3.28, trackFront: 1.72, trackRear: 1.74,
      dragCd: 0.42, frontalArea: 3.1, liftCoef: 0.08, tireGripFront: 0.94, tireGripRear: 0.96,
      springFront: 36000, springRear: 30000, damperFront: 3600, damperRear: 3200, arbFront: 20000, arbRear: 9000,
      steerLock: 34, brakeTorque: 3300, handbrakeTorque: 1800, driveBias: 0.4, limitedSlip: 0.55, rollStiffness: 0.8,
    },
    wheel: { rimInch: 20, spokes: 6, spokeStyle: "straight", concave: 0.14, lip: 0.22, rimColor: 0x8d9195, capColor: 0x1b1c1e },
    finish: "matte",
    colors: [0x3d4247, 0x8a6a4a, 0xd9d4c8, 0x2f6b46, 0x9b2b35],
    interiorColor: 0x2b2723,
    lights: { headStyle: "angular", tailStyle: "bar", drl: 0xfff0d0, headColor: 0xfff4e4 },
    zeroTo100: 5.7,
    topSpeed: 222,
  },
  /* 11 ---------------------------------------------------------- */
  {
    id: "abuelo_1600",
    name: "アブエロ 1600",
    maker: "サンタナ",
    year: 1968,
    style: "classic",
    drive: "FR",
    tier: "D",
    description: "1.6Lのクラシック・スポーツ。軽い車体と繊細な足回りで、ゆっくりでも楽しい。",
    dims: { length: 3.86, width: 1.56, height: 1.24, wheelRadiusFront: 0.295, wheelRadiusRear: 0.295, wheelWidthFront: 0.175, wheelWidthRear: 0.185 },
    profile: P(
      curve11(0.6, 0.88, 0.96, 0.96, 0.92, 0.8),
      curve11(0.7, 0.73, 0.74, 0.73, 0.7, 0.64),
      curve11(0.1, 0.08, 0.08, 0.08, 0.09, 0.12),
      curve11(0.6, 0.68, 0.7, 0.69, 0.64, 0.54),
      curve11(3.2, 3.4, 3.4, 3.4, 3.2, 2.8),
      curve11(2.6, 2.8, 2.8, 2.8, 2.6, 2.4),
      { cabinStart: 0.26, cabinEnd: 0.66, roofHeight: 0.9, tumblehome: 0.14, windshieldAngle: 36, rearGlassAngle: 40, fenderFlare: 0.04, rideHeight: 0.17 }
    ),
    engine: { displacement: 1.6, powerHp: 118, powerRpm: 6000, torqueNm: 145, torqueRpm: 4200, redline: 6600, idle: 900, aspiration: "na", cylinders: 4, peakiness: 0.65, soundBase: 128 },
    gearbox: { ratios: [3.75, 2.16, 1.46, 1.0], finalDrive: 3.9, shiftTime: 0.28, dct: false, auto: false },
    chassis: {
      mass: 890, frontWeight: 0.53, cgHeight: 0.5, wheelbase: 2.3, trackFront: 1.3, trackRear: 1.32,
      dragCd: 0.42, frontalArea: 1.6, liftCoef: 0.04, tireGripFront: 0.86, tireGripRear: 0.88,
      springFront: 22000, springRear: 20000, damperFront: 1800, damperRear: 1700, arbFront: 8000, arbRear: 5000,
      steerLock: 40, brakeTorque: 1400, handbrakeTorque: 900, driveBias: 0, limitedSlip: 0.15, rollStiffness: 0.6,
    },
    wheel: { rimInch: 15, spokes: 8, spokeStyle: "mesh", concave: 0.08, lip: 0.34, rimColor: 0xc9ccd0, capColor: 0x5a4a3a },
    finish: "gloss",
    colors: [0x2f6b46, 0xe8e4da, 0xb8863b, 0x8f2f3a, 0x2a4d8f],
    interiorColor: 0x5a4632,
    lights: { headStyle: "round", tailStyle: "round", drl: 0xffe4b0, headColor: 0xffeec8 },
    zeroTo100: 10.4,
    topSpeed: 186,
  },
  /* 12 ---------------------------------------------------------- */
  {
    id: "brisa_roadster",
    name: "ブリサ ロードスター",
    maker: "ノルテ",
    year: 2022,
    style: "roadster",
    drive: "FR",
    tier: "C",
    description: "2.0Lのオープン2シーター。屋根が無いぶん軽く、曲がり始めの反応が鋭い。",
    dims: { length: 3.94, width: 1.74, height: 1.22, wheelRadiusFront: 0.315, wheelRadiusRear: 0.32, wheelWidthFront: 0.215, wheelWidthRear: 0.225 },
    profile: P(
      curve11(0.6, 0.9, 0.98, 0.98, 0.94, 0.78),
      curve11(0.66, 0.7, 0.71, 0.7, 0.67, 0.6),
      curve11(0.08, 0.07, 0.07, 0.07, 0.08, 0.1),
      curve11(0.56, 0.64, 0.66, 0.65, 0.6, 0.46),
      curve11(3.6, 4.0, 4.0, 3.9, 3.6, 3.0),
      curve11(2.8, 3.2, 3.3, 3.2, 3.0, 2.6),
      { cabinStart: 0.3, cabinEnd: 0.68, roofHeight: 0.62, tumblehome: 0.22, windshieldAngle: 28, rearGlassAngle: 30, fenderFlare: 0.06, rideHeight: 0.12 }
    ),
    engine: { displacement: 2.0, powerHp: 184, powerRpm: 7000, torqueNm: 205, torqueRpm: 4000, redline: 7500, idle: 800, aspiration: "na", cylinders: 4, peakiness: 0.7, soundBase: 146 },
    gearbox: { ratios: GEAR_6, finalDrive: 4.1, shiftTime: 0.13, dct: false, auto: true },
    chassis: {
      mass: 1058, frontWeight: 0.52, cgHeight: 0.46, wheelbase: 2.31, trackFront: 1.5, trackRear: 1.5,
      dragCd: 0.34, frontalArea: 1.72, liftCoef: -0.03, tireGripFront: 1.04, tireGripRear: 1.06,
      springFront: 30000, springRear: 27000, damperFront: 2500, damperRear: 2300, arbFront: 17000, arbRear: 10000,
      steerLock: 38, brakeTorque: 2000, handbrakeTorque: 1300, driveBias: 0, limitedSlip: 0.4, rollStiffness: 1.0,
    },
    wheel: { rimInch: 17, spokes: 10, spokeStyle: "split", concave: 0.28, lip: 0.12, rimColor: 0x3a3d42, capColor: 0xc23a2b },
    finish: "metallic",
    colors: [0xd8492b, 0x1c5d8c, 0xf2f0ea, 0x2b2f36, 0x2f9e6e],
    interiorColor: 0x2a2320,
    lights: { headStyle: "angular", tailStyle: "round", drl: 0xfff2d8, headColor: 0xfff8ee },
    zeroTo100: 7.2,
    topSpeed: 219,
  },
  /* 13 ---------------------------------------------------------- */
  {
    id: "pluma_light",
    name: "プルマ ライト",
    maker: "ベガ",
    year: 2018,
    style: "lightweight",
    drive: "FR",
    tier: "C",
    description: "780kgの超軽量FR。パワーは控えめだが、コーナー出口の加速が気持ちいい。",
    dims: { length: 3.72, width: 1.66, height: 1.16, wheelRadiusFront: 0.3, wheelRadiusRear: 0.305, wheelWidthFront: 0.195, wheelWidthRear: 0.215 },
    profile: P(
      curve11(0.58, 0.88, 0.96, 0.96, 0.92, 0.76),
      curve11(0.62, 0.66, 0.67, 0.66, 0.63, 0.56),
      curve11(0.07, 0.06, 0.06, 0.06, 0.07, 0.09),
      curve11(0.5, 0.57, 0.59, 0.58, 0.53, 0.4),
      curve11(3.8, 4.2, 4.2, 4.0, 3.8, 3.2),
      curve11(3.0, 3.4, 3.4, 3.3, 3.0, 2.6),
      { cabinStart: 0.24, cabinEnd: 0.64, roofHeight: 0.84, tumblehome: 0.2, windshieldAngle: 30, rearGlassAngle: 36, fenderFlare: 0.07, rideHeight: 0.1 }
    ),
    engine: { displacement: 1.8, powerHp: 158, powerRpm: 7200, torqueNm: 178, torqueRpm: 5200, redline: 7800, idle: 900, aspiration: "na", cylinders: 4, peakiness: 0.8, soundBase: 152 },
    gearbox: { ratios: GEAR_6, finalDrive: 4.2, shiftTime: 0.11, dct: false, auto: true },
    chassis: {
      mass: 782, frontWeight: 0.5, cgHeight: 0.39, wheelbase: 2.22, trackFront: 1.44, trackRear: 1.46,
      dragCd: 0.33, frontalArea: 1.55, liftCoef: -0.08, tireGripFront: 1.02, tireGripRear: 1.02,
      springFront: 28000, springRear: 26000, damperFront: 2200, damperRear: 2100, arbFront: 14000, arbRear: 9000,
      steerLock: 40, brakeTorque: 1500, handbrakeTorque: 1000, driveBias: 0, limitedSlip: 0.4, rollStiffness: 0.95,
    },
    wheel: { rimInch: 16, spokes: 5, spokeStyle: "5star", concave: 0.2, lip: 0.14, rimColor: 0x2b2d31, capColor: 0xe5b32c },
    finish: "gloss",
    colors: [0xe5b32c, 0x1b1c1e, 0xf2f0ea, 0xd8492b, 0x2f6b46],
    interiorColor: 0x1a1a1c,
    lights: { headStyle: "round", tailStyle: "round", drl: 0xfff0cc, headColor: 0xfff6e2 },
    zeroTo100: 6.9,
    topSpeed: 224,
  },
  /* 14 ---------------------------------------------------------- */
  {
    id: "corriente_gt4",
    name: "コリエンテ GT4",
    maker: "ベガ",
    year: 2023,
    style: "gt4",
    drive: "FR",
    tier: "A",
    description: "4.0L自然吸気+サーキット仕様の4ドアGT。高速域の安定性と快適性を両立。",
    dims: { length: 4.84, width: 1.92, height: 1.36, wheelRadiusFront: 0.345, wheelRadiusRear: 0.355, wheelWidthFront: 0.265, wheelWidthRear: 0.295 },
    profile: P(
      curve11(0.66, 0.94, 1.0, 1.0, 0.98, 0.86),
      curve11(0.64, 0.69, 0.7, 0.7, 0.67, 0.58),
      curve11(0.08, 0.07, 0.07, 0.07, 0.08, 0.1),
      curve11(0.56, 0.63, 0.66, 0.65, 0.61, 0.46),
      curve11(4.0, 4.4, 4.6, 4.4, 4.0, 3.4),
      curve11(3.0, 3.4, 3.6, 3.5, 3.2, 2.7),
      { cabinStart: 0.24, cabinEnd: 0.64, roofHeight: 0.86, tumblehome: 0.22, windshieldAngle: 25, rearGlassAngle: 32, fenderFlare: 0.09, rideHeight: 0.115 }
    ),
    engine: { displacement: 4.0, powerHp: 502, powerRpm: 8250, torqueNm: 480, torqueRpm: 6100, redline: 9000, idle: 850, aspiration: "na", cylinders: 6, peakiness: 0.8, soundBase: 88 },
    gearbox: { ratios: GEAR_7, finalDrive: 3.6, shiftTime: 0.08, dct: true, auto: true },
    chassis: {
      mass: 1540, frontWeight: 0.52, cgHeight: 0.46, wheelbase: 2.8, trackFront: 1.62, trackRear: 1.6,
      dragCd: 0.3, frontalArea: 2.1, liftCoef: -0.2, tireGripFront: 1.16, tireGripRear: 1.2,
      springFront: 48000, springRear: 46000, damperFront: 4000, damperRear: 3900, arbFront: 26000, arbRear: 18000,
      steerLock: 30, brakeTorque: 3900, handbrakeTorque: 1600, driveBias: 0, limitedSlip: 0.75, rollStiffness: 1.5,
    },
    wheel: { rimInch: 20, spokes: 10, spokeStyle: "turbine", concave: 0.4, lip: 0.08, rimColor: 0x24272b, capColor: 0xd8a23a },
    finish: "satin",
    colors: [0x24272b, 0xe9ecef, 0x274a6d, 0x8f1f2b, 0xb9a15f],
    interiorColor: 0x1a1414,
    lights: { headStyle: "strip", tailStyle: "lshape", drl: 0xf2f8ff, headColor: 0xf6faff },
    zeroTo100: 3.7,
    topSpeed: 312,
  },
  /* 15 ---------------------------------------------------------- */
  {
    id: "duna_buggy",
    name: "ドゥナ バギー",
    maker: "サンタナ",
    year: 2021,
    style: "buggy",
    drive: "AWD",
    tier: "C",
    description: "砂丘用の軽量バギー。サスペンションストロークが長く、ジャンプの着地も破綻しない。",
    dims: { length: 3.98, width: 1.94, height: 1.62, wheelRadiusFront: 0.42, wheelRadiusRear: 0.44, wheelWidthFront: 0.265, wheelWidthRear: 0.315 },
    profile: P(
      curve11(0.68, 0.94, 1.0, 1.0, 0.96, 0.8),
      curve11(0.72, 0.76, 0.77, 0.77, 0.75, 0.7),
      curve11(0.3, 0.26, 0.24, 0.24, 0.26, 0.3),
      curve11(0.66, 0.72, 0.74, 0.73, 0.68, 0.56),
      curve11(4.0, 4.4, 4.4, 4.2, 3.8, 3.4),
      curve11(3.0, 3.4, 3.4, 3.3, 3.0, 2.6),
      { cabinStart: 0.18, cabinEnd: 0.58, roofHeight: 0.84, tumblehome: 0.05, windshieldAngle: 40, rearGlassAngle: 74, fenderFlare: 0.18, rideHeight: 0.34, frontOverhang: 0.18 }
    ),
    engine: { displacement: 2.4, powerHp: 310, powerRpm: 6200, torqueNm: 380, torqueRpm: 3400, redline: 7000, idle: 950, aspiration: "turbo", cylinders: 4, peakiness: 0.35, soundBase: 120 },
    gearbox: { ratios: GEAR_6, finalDrive: 4.4, shiftTime: 0.12, dct: false, auto: true },
    chassis: {
      mass: 1145, frontWeight: 0.5, cgHeight: 0.58, wheelbase: 2.6, trackFront: 1.7, trackRear: 1.7,
      dragCd: 0.46, frontalArea: 2.3, liftCoef: 0.1, tireGripFront: 0.98, tireGripRear: 1.0,
      springFront: 30000, springRear: 26000, damperFront: 3800, damperRear: 3400, arbFront: 16000, arbRear: 10000,
      steerLock: 38, brakeTorque: 2400, handbrakeTorque: 1800, driveBias: 0.45, limitedSlip: 0.6, rollStiffness: 0.9,
    },
    wheel: { rimInch: 18, spokes: 6, spokeStyle: "straight", concave: 0.1, lip: 0.26, rimColor: 0xd8d4c8, capColor: 0x2b2f36 },
    finish: "matte",
    colors: [0xe5b32c, 0x3d4247, 0xd8492b, 0x2f9e6e, 0xf2f0ea],
    interiorColor: 0x1b1b1d,
    lights: { headStyle: "quad", tailStyle: "round", drl: 0xfff2d0, headColor: 0xfff6e0 },
    zeroTo100: 4.6,
    topSpeed: 238,
  },
  /* 16 ---------------------------------------------------------- */
  {
    id: "memoria_rs",
    name: "メモリア RS",
    maker: "ノルテ",
    year: 1975,
    style: "classicRally",
    drive: "FR",
    tier: "C",
    description: "1970年代のクラシック・ラリー車。小排気量NAの高回転ユニットと軽い車体。",
    dims: { length: 3.98, width: 1.7, height: 1.34, wheelRadiusFront: 0.31, wheelRadiusRear: 0.315, wheelWidthFront: 0.195, wheelWidthRear: 0.205 },
    profile: P(
      curve11(0.62, 0.9, 0.97, 0.97, 0.94, 0.82),
      curve11(0.7, 0.73, 0.74, 0.74, 0.72, 0.66),
      curve11(0.1, 0.09, 0.09, 0.09, 0.1, 0.13),
      curve11(0.66, 0.72, 0.74, 0.73, 0.68, 0.58),
      curve11(3.4, 3.6, 3.6, 3.6, 3.4, 3.0),
      curve11(2.6, 3.0, 3.0, 3.0, 2.8, 2.4),
      { cabinStart: 0.24, cabinEnd: 0.68, roofHeight: 0.94, tumblehome: 0.12, windshieldAngle: 38, rearGlassAngle: 46, fenderFlare: 0.11, rideHeight: 0.2 }
    ),
    engine: { displacement: 1.8, powerHp: 148, powerRpm: 7400, torqueNm: 168, torqueRpm: 5600, redline: 8000, idle: 950, aspiration: "na", cylinders: 4, peakiness: 0.85, soundBase: 156 },
    gearbox: { ratios: [3.36, 2.1, 1.58, 1.24, 1.0], finalDrive: 4.1, shiftTime: 0.24, dct: false, auto: false },
    chassis: {
      mass: 985, frontWeight: 0.54, cgHeight: 0.5, wheelbase: 2.4, trackFront: 1.4, trackRear: 1.42,
      dragCd: 0.4, frontalArea: 1.72, liftCoef: 0.02, tireGripFront: 0.92, tireGripRear: 0.94,
      springFront: 26000, springRear: 24000, damperFront: 2000, damperRear: 1900, arbFront: 12000, arbRear: 7000,
      steerLock: 39, brakeTorque: 1700, handbrakeTorque: 1100, driveBias: 0, limitedSlip: 0.55, rollStiffness: 0.8,
    },
    wheel: { rimInch: 15, spokes: 8, spokeStyle: "mesh", concave: 0.12, lip: 0.3, rimColor: 0xd0d3d6, capColor: 0x8a2b2b },
    finish: "gloss",
    colors: [0x2a4d8f, 0xf2f0ea, 0xd8492b, 0xe5b32c, 0x1b1c1e],
    interiorColor: 0x3a3229,
    lights: { headStyle: "quad", tailStyle: "round", drl: 0xffe4b0, headColor: 0xffeec8 },
    zeroTo100: 7.8,
    topSpeed: 198,
  },
];

/** 塗装の選択肢 */
export const PAINT_FINISHES: Array<{ id: PaintFinish; name: string; description: string }> = [
  { id: "gloss", name: "グロス", description: "深い艶のある標準塗装。色が最も鮮やかに出る。" },
  { id: "metallic", name: "メタリック", description: "アルミフレークで角度により明るさが変化する。" },
  { id: "pearl", name: "パール", description: "パール顔料で、見る角度により色味がわずかにシフトする。" },
  { id: "satin", name: "サテン", description: "半艶。光を柔らかく受け止める上品な質感。" },
  { id: "matte", name: "マット", description: "艶消し。ボディラインが陰影で浮かび上がる。" },
  { id: "carbon", name: "カーボン", description: "カーボン綾織りが透ける軽量パネル風の仕上げ。" },
  { id: "chrome", name: "クローム", description: "鏡面。周囲の景色を完全に映し込む。" },
];

/** ホイールの選択肢 */
export const WHEEL_STYLES: Array<{ id: string; name: string; spec: Partial<WheelStyleSpec> }> = [
  { id: "stock", name: "純正", spec: {} },
  { id: "race", name: "レース", spec: { spokes: 10, spokeStyle: "split", rimColor: 0x2a2d31, lip: 0.06, concave: 0.45 } },
  { id: "classic", name: "クラシック", spec: { spokes: 8, spokeStyle: "mesh", rimColor: 0xc9ccd0, lip: 0.3, concave: 0.1 } },
  { id: "turbine", name: "タービン", spec: { spokes: 12, spokeStyle: "turbine", rimColor: 0x1d1f22, lip: 0.05, concave: 0.5 } },
  { id: "deep", name: "ディープリム", spec: { spokes: 5, spokeStyle: "dish", rimColor: 0xb0b4b8, lip: 0.4, concave: 0.2 } },
];

export function getCar(id: string): CarSpec {
  const c = CARS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown car: ${id}`);
  return c;
}

/** 表示用のスペック文字列をまとめる */
export function carStats(c: CarSpec): Array<{ label: string; value: string }> {
  return [
    { label: "最高出力", value: `${c.engine.powerHp} hp / ${c.engine.powerRpm} rpm` },
    { label: "最大トルク", value: `${c.engine.torqueNm} Nm / ${c.engine.torqueRpm} rpm` },
    { label: "排気量", value: `${c.engine.displacement.toFixed(1)} L ${aspirationLabel(c.engine.aspiration)}` },
    { label: "駆動方式", value: c.drive },
    { label: "重量", value: `${c.chassis.mass} kg` },
    { label: "パワーウェイトレシオ", value: `${(c.chassis.mass / c.engine.powerHp).toFixed(2)} kg/hp` },
    { label: "0-100km/h", value: `${c.zeroTo100.toFixed(1)} 秒` },
    { label: "最高速", value: `${c.topSpeed} km/h` },
    { label: "全長×全幅×全高", value: `${(c.dims.length * 1000).toFixed(0)}×${(c.dims.width * 1000).toFixed(0)}×${(c.dims.height * 1000).toFixed(0)} mm` },
    { label: "ホイールベース", value: `${(c.chassis.wheelbase * 1000).toFixed(0)} mm` },
  ];
}

export function aspirationLabel(a: EngineSpec["aspiration"]): string {
  switch (a) {
    case "na":
      return "自然吸気";
    case "turbo":
      return "ターボ";
    case "supercharged":
      return "スーパーチャージャー";
    case "twin-turbo":
      return "ツインターボ";
  }
}

/** ギア比から理論最高速を計算(表示用) */
export function theoreticalTopSpeed(c: CarSpec): number {
  const topGear = c.gearbox.ratios[c.gearbox.ratios.length - 1];
  const wheelR = c.dims.wheelRadiusRear;
  const wheelRpm = (c.engine.redline / (topGear * c.gearbox.finalDrive));
  const ms = (wheelRpm / 60) * 2 * Math.PI * wheelR;
  return Math.round(ms * 3.6);
}

/** カテゴリ表示 */
export const TIER_COLORS: Record<CarSpec["tier"], string> = {
  D: "#8f9aa8",
  C: "#3ea36b",
  B: "#2f8fd0",
  A: "#c98a2b",
  S: "#d24b3e",
  X: "#a45fd6",
};

export const STYLE_LABELS: Record<BodyStyle, string> = {
  hatch: "ハッチバック",
  coupe: "クーペ",
  sedan: "セダン",
  muscle: "マッスルカー",
  sport: "ミッドシップ・スポーツ",
  super: "スーパーカー",
  hyper: "ハイパーカー",
  rally: "ラリーカー",
  suv: "SUV",
  pickup: "ピックアップ",
  classic: "クラシック",
  roadster: "オープンカー",
  lightweight: "軽量FR",
  gt4: "4ドアGT",
  buggy: "バギー",
  classicRally: "クラシック・ラリー",
};
