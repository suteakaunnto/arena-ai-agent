/**
 * world/WorldConfig.ts
 * 責務: ワールド全体で共有するスケール定数とオリジナル地域「コスタ・ソル」の基本設計値
 * 公開API: WORLD, BiomeId, BIOMES, SETTLEMENTS
 * 依存: なし
 */

export const WORLD = {
  /** 一辺の長さ(m)。12km 四方 */
  size: 12000,
  get half() {
    return this.size / 2;
  },
  /** チャンク一辺(m) */
  chunk: 256,
  get chunksPerSide() {
    return Math.ceil(this.size / this.chunk); // 47
  },
  /** 海面の高さ */
  seaLevel: 0,
  /** 山頂の最大高さ */
  maxHeight: 1150,
  /** 高精細地形の描画距離 */
  nearDistance: 1500,
  /** 中精細 */
  midDistance: 3000,
  /** 遠景クリップマップ */
  farDistance: 8000,
  /** チャンク生成の1フレーム予算(ms) */
  frameBudgetMs: 8,
  /** 固定シード */
  seed: 20261117,
  /** フローティングオリジンの再基準化距離 */
  originRebaseDistance: 2000,
} as const;

export type BiomeId = "ocean" | "coast" | "desert" | "jungle" | "volcano" | "farmland" | "wetland";

export interface BiomeDef {
  id: BiomeId;
  name: string;
  nameEn: string;
  /** UI 表示用カラー */
  color: string;
  /** 地表のベースカラー */
  ground: [number, number, number];
  /** サブカラー(まだら模様) */
  ground2: [number, number, number];
  /** 岩の色 */
  rock: [number, number, number];
  /** 植生密度(0..1) */
  vegetation: number;
  /** 樹種 */
  trees: Array<"palm" | "jungle" | "pine" | "cactus" | "olive" | "dead">;
  /** 草の色 */
  grass: [number, number, number];
  /** 色温度(空気感) */
  haze: [number, number, number];
  /** 難易度(路面グリップ係数) */
  grip: number;
}

export const BIOMES: Record<BiomeId, BiomeDef> = {
  ocean: {
    id: "ocean",
    name: "海",
    nameEn: "Ocean",
    color: "#1e6091",
    ground: [0.32, 0.28, 0.22],
    ground2: [0.4, 0.36, 0.28],
    rock: [0.35, 0.33, 0.3],
    vegetation: 0,
    trees: [],
    grass: [0, 0, 0],
    haze: [0.55, 0.72, 0.92],
    grip: 0.75,
  },
  coast: {
    id: "coast",
    name: "海岸",
    nameEn: "Coast",
    color: "#f4d35e",
    ground: [0.86, 0.78, 0.58],
    ground2: [0.78, 0.7, 0.5],
    rock: [0.62, 0.58, 0.5],
    vegetation: 0.22,
    trees: ["palm", "olive"],
    grass: [0.66, 0.66, 0.4],
    haze: [0.72, 0.8, 0.86],
    grip: 0.88,
  },
  desert: {
    id: "desert",
    name: "砂漠",
    nameEn: "Desert",
    color: "#e08c4a",
    ground: [0.84, 0.6, 0.38],
    ground2: [0.74, 0.48, 0.3],
    rock: [0.66, 0.44, 0.33],
    vegetation: 0.06,
    trees: ["cactus", "dead"],
    grass: [0.6, 0.52, 0.34],
    haze: [0.86, 0.72, 0.55],
    grip: 0.8,
  },
  jungle: {
    id: "jungle",
    name: "ジャングル",
    nameEn: "Jungle",
    color: "#2f7d32",
    ground: [0.24, 0.36, 0.19],
    ground2: [0.19, 0.3, 0.16],
    rock: [0.36, 0.34, 0.3],
    vegetation: 1,
    trees: ["jungle", "palm"],
    grass: [0.3, 0.46, 0.22],
    haze: [0.55, 0.7, 0.6],
    grip: 0.86,
  },
  volcano: {
    id: "volcano",
    name: "火山山岳",
    nameEn: "Volcanic Highlands",
    color: "#6b4f4f",
    ground: [0.3, 0.26, 0.25],
    ground2: [0.24, 0.2, 0.2],
    rock: [0.28, 0.24, 0.23],
    vegetation: 0.18,
    trees: ["pine", "dead"],
    grass: [0.34, 0.36, 0.3],
    haze: [0.6, 0.62, 0.68],
    grip: 0.84,
  },
  farmland: {
    id: "farmland",
    name: "農地平原",
    nameEn: "Farmland Plains",
    color: "#c9b458",
    ground: [0.62, 0.56, 0.32],
    ground2: [0.72, 0.66, 0.4],
    rock: [0.55, 0.52, 0.46],
    vegetation: 0.5,
    trees: ["olive", "pine"],
    grass: [0.5, 0.58, 0.3],
    haze: [0.7, 0.78, 0.7],
    grip: 0.93,
  },
  wetland: {
    id: "wetland",
    name: "湿地湖",
    nameEn: "Wetland Lakes",
    color: "#3f7f6f",
    ground: [0.33, 0.42, 0.3],
    ground2: [0.27, 0.36, 0.26],
    rock: [0.45, 0.45, 0.4],
    vegetation: 0.78,
    trees: ["jungle", "pine"],
    grass: [0.36, 0.52, 0.34],
    haze: [0.62, 0.74, 0.7],
    grip: 0.85,
  },
};

export interface Settlement {
  id: string;
  name: string;
  kind: "city" | "town" | "village";
  /** ワールド座標 x (m) */
  x: number;
  z: number;
  /** 半径(m) */
  radius: number;
  /** 目印の建物数 */
  buildings: number;
  description: string;
}

/** オリジナル地域の集落配置(都市1・町3・村6) */
export const SETTLEMENTS: Settlement[] = [
  {
    id: "puerto_lumbre",
    name: "プエルト・ルンブレ",
    kind: "city",
    x: -3200,
    z: 2600,
    radius: 620,
    buildings: 520,
    description: "海沿いの港湾都市。夕暮れの遊歩道と、古い灯台がシンボル。",
  },
  {
    id: "valle_rojo",
    name: "バジェ・ロホ",
    kind: "town",
    x: 1900,
    z: -2100,
    radius: 320,
    buildings: 190,
    description: "赤い土の谷あいの町。陶器市と週末のラリーで知られる。",
  },
  {
    id: "sierra_alta",
    name: "シエラ・アルタ",
    kind: "town",
    x: 3400,
    z: 1800,
    radius: 300,
    buildings: 165,
    description: "火山山岳の麓の町。石畳の坂道と展望台。",
  },
  {
    id: "lago_verde",
    name: "ラゴ・ベルデ",
    kind: "town",
    x: -800,
    z: -3700,
    radius: 280,
    buildings: 140,
    description: "湖と湿地に囲まれた町。桟橋と水上マーケット。",
  },
  {
    id: "casa_arena",
    name: "カサ・アレナ",
    kind: "village",
    x: 900,
    z: 3400,
    radius: 150,
    buildings: 54,
    description: "砂丘の入口の小さな村。ラクダの代わりにバギーが走る。",
  },
  {
    id: "el_rosario",
    name: "エル・ロサリオ",
    kind: "village",
    x: -4200,
    z: -500,
    radius: 140,
    buildings: 48,
    description: "農地の真ん中の村。風車と給水塔が目印。",
  },
  {
    id: "mirador",
    name: "ミラドール",
    kind: "village",
    x: 2600,
    z: 3900,
    radius: 130,
    buildings: 42,
    description: "渓谷を見下ろす断崖の村。吊り橋が唯一の道。",
  },
  {
    id: "playa_sorda",
    name: "プラヤ・ソルダ",
    kind: "village",
    x: -4700,
    z: 4400,
    radius: 135,
    buildings: 44,
    description: "静かな入り江の村。ヤシの木と小さな漁港。",
  },
  {
    id: "cumbres",
    name: "クンブレス",
    kind: "village",
    x: 4200,
    z: -4200,
    radius: 120,
    buildings: 36,
    description: "火山灰に覆われた高地の村。星空が最も濃い場所。",
  },
  {
    id: "boca_ancha",
    name: "ボカ・アンチャ",
    kind: "village",
    x: -2600,
    z: -2600,
    radius: 145,
    buildings: 50,
    description: "ジャングルの川口の村。カヌーと果樹園。",
  },
];

/** 主要な見どころ(フォトモード/ファストトラベル地点) */
export interface Landmark {
  id: string;
  name: string;
  x: number;
  z: number;
  kind: "lighthouse" | "volcano" | "dam" | "bridge" | "ruins" | "airstrip" | "observatory";
  description: string;
}

export const LANDMARKS: Landmark[] = [
  { id: "lighthouse", name: "ファロ・デ・ルンブレ", x: -3850, z: 3320, kind: "lighthouse", description: "1892年建造の灯台。白と赤の縞模様。" },
  { id: "volcano", name: "ボルカン・デ・クンブレス", x: 4050, z: -4550, kind: "volcano", description: "カルデラの縁まで車で上がれる活火山。" },
  { id: "dam", name: "プレサ・ベルデ", x: -1600, z: -2600, kind: "dam", description: "湖を作った巨大なダム。頂上は直線の高速区間。" },
  { id: "bridge", name: "プエンテ・ロホ", x: 2050, z: 240, kind: "bridge", description: "渓谷に架かる赤い鉄橋。長さ480m。" },
  { id: "ruins", name: "ルイナス・デル・ソル", x: -5200, z: 1200, kind: "ruins", description: "砂岩の遺跡。周囲に未舗装の周回路。" },
  { id: "airstrip", name: "ピスタ・デ・アレナ", x: 1500, z: 4200, kind: "airstrip", description: "砂漠の滑走路。直線3.2kmの最高速テスト区間。" },
  { id: "observatory", name: "オブセルバトリオ", x: 4700, z: -2900, kind: "observatory", description: "高地の天文台。夜の星空が絶景。" },
];

/** 1日の長さ(秒)。0 = 時間停止 */
export const DAY_HOURS = { secondsPerDay: 600 };
