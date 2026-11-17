/**
 * car/materials/CarMaterials.ts
 * 責務: 車体の多層塗装(クリアコート/メタリックフレーク/オレンジピール/パール)と
 *       ガラス・ゴム・クローム・カーボン・灯火のマテリアル生成
 * 公開API: CarMaterialLibrary, PaintParams, FINISH_PRESETS
 * 依存: three, car/spec/CarSpec.ts
 *
 * 設計メモ:
 *  - MeshPhysicalMaterial を onBeforeCompile で拡張し、シェーダに
 *    「フレーク法線」「オレンジピール法線」「フレネル色シフト」「ダスト/濡れ」を注入する。
 *  - 環境マップはシーン側(EnvProbe)から渡す。ここでは uniform 参照のみ。
 *  - 全マテリアルはライブラリで管理し、車の生成/破棄でリークしないようにする。
 */
import * as THREE from "three";
import { PaintFinish } from "../spec/CarSpec.js";

export interface PaintParams {
  color: THREE.Color;
  finish: PaintFinish;
  /** メタリックの強さ(0..1) */
  metallic: number;
  /** 表面の粗さ */
  roughness: number;
  /** クリアコートの粗さ */
  clearcoatRoughness: number;
  /** フレークのスケール */
  flakeScale: number;
  /** フレークの強さ */
  flakeStrength: number;
  /** オレンジピールの強さ */
  peel: number;
  /** パールシフトの色 */
  pearlColor: THREE.Color;
  /** パールシフトの強さ */
  pearlStrength: number;
}

export const FINISH_PRESETS: Record<PaintFinish, Omit<PaintParams, "color" | "pearlColor">> = {
  gloss: { finish: "gloss", metallic: 0.05, roughness: 0.22, clearcoatRoughness: 0.045, flakeScale: 900, flakeStrength: 0.04, peel: 0.0025, pearlStrength: 0 },
  metallic: { finish: "metallic", metallic: 0.62, roughness: 0.28, clearcoatRoughness: 0.05, flakeScale: 1600, flakeStrength: 0.5, peel: 0.003, pearlStrength: 0 },
  pearl: { finish: "pearl", metallic: 0.42, roughness: 0.26, clearcoatRoughness: 0.05, flakeScale: 2100, flakeStrength: 0.34, peel: 0.0028, pearlStrength: 0.55 },
  matte: { finish: "matte", metallic: 0.0, roughness: 0.68, clearcoatRoughness: 0.5, flakeScale: 700, flakeStrength: 0.02, peel: 0.0016, pearlStrength: 0 },
  satin: { finish: "satin", metallic: 0.2, roughness: 0.42, clearcoatRoughness: 0.28, flakeScale: 1100, flakeStrength: 0.12, peel: 0.002, pearlStrength: 0 },
  carbon: { finish: "carbon", metallic: 0.3, roughness: 0.34, clearcoatRoughness: 0.02, flakeScale: 0, flakeStrength: 0, peel: 0.001, pearlStrength: 0 },
  chrome: { finish: "chrome", metallic: 1.0, roughness: 0.05, clearcoatRoughness: 0.02, flakeScale: 0, flakeStrength: 0, peel: 0.001, pearlStrength: 0 },
};

const PAINT_VERT_HEAD = /* glsl */ `
  varying vec3 vPaintWorldPos;
  varying vec3 vPaintNormalW;
`;

const PAINT_VERT_BODY = /* glsl */ `
  {
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    vPaintWorldPos = wp.xyz;
    vPaintNormalW = normalize(mat3(modelMatrix) * objectNormal);
  }
`;

const PAINT_FRAG_HEAD = /* glsl */ `
  varying vec3 vPaintWorldPos;
  varying vec3 vPaintNormalW;
  uniform float uFlakeScale;
  uniform float uFlakeStrength;
  uniform float uPeel;
  uniform float uPearlStrength;
  uniform vec3 uPearlColor;
  uniform float uWetness;
  uniform float uDust;

  float phash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  vec3 pnoise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return vec3(
      mix(mix(mix(phash(i), phash(i + vec3(1,0,0)), f.x), mix(phash(i + vec3(0,1,0)), phash(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(phash(i + vec3(0,0,1)), phash(i + vec3(1,0,1)), f.x), mix(phash(i + vec3(0,1,1)), phash(i + vec3(1,1,1)), f.x), f.y), f.z),
      mix(mix(mix(phash(i + vec3(0,1,0)), phash(i + vec3(1,1,0)), f.x), mix(phash(i + vec3(0,2,0)), phash(i + vec3(1,2,0)), f.x), f.y),
          mix(mix(phash(i + vec3(0,1,1)), phash(i + vec3(1,1,1)), f.x), mix(phash(i + vec3(0,2,1)), phash(i + vec3(1,2,1)), f.x), f.y), f.z),
      f.y)
    ) - 0.5;
  }
`;

const PAINT_FRAG_NORMAL = /* glsl */ `
  {
    // フレーク(メタリック粒子)による法線の揺らぎ
    if (uFlakeScale > 0.5 && uFlakeStrength > 0.001) {
      vec3 fp = vPaintWorldPos * uFlakeScale;
      vec3 fn = pnoise3(fp);
      normal = normalize(normal + fn * uFlakeStrength * 0.35);
    }
    // オレンジピール(塗装表面の微細なしわ)
    if (uPeel > 0.0001) {
      vec3 pp = vPaintWorldPos * 320.0;
      vec3 pn = pnoise3(pp);
      normal = normalize(normal + pn * uPeel * 6.0);
    }
  }
`;

const PAINT_FRAG_COLOR = /* glsl */ `
  {
    // パール: 視線角度による色シフト
    if (uPearlStrength > 0.001) {
      vec3 vdir = normalize(cameraPosition - vPaintWorldPos);
      float f = pow(1.0 - clamp(dot(normalize(vPaintNormalW), vdir), 0.0, 1.0), 1.6);
      diffuseColor.rgb = mix(diffuseColor.rgb, uPearlColor, f * uPearlStrength * 0.5);
    }
    // 濡れ: 下部が暗く、ツヤが増す
    if (uWetness > 0.001) {
      float low = clamp(0.5 - vPaintWorldPos.y * 0.2, 0.0, 1.0);
      diffuseColor.rgb *= mix(1.0, 0.82, uWetness * low);
    }
    // ダスト(砂埃)
    if (uDust > 0.001) {
      float n = pnoise3(vPaintWorldPos * 26.0).x + 0.5;
      float low = clamp(0.55 - vPaintWorldPos.y * 0.22, 0.0, 1.0);
      vec3 dustCol = vec3(0.62, 0.55, 0.44);
      diffuseColor.rgb = mix(diffuseColor.rgb, dustCol, clamp(n * low * uDust, 0.0, 0.8));
    }
  }
`;

/** カーボン綾織りテクスチャ(Canvas) */
export function makeCarbonTexture(size = 256): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cell = size / 16;
  ctx.fillStyle = "#141416";
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const even = (x + y) % 2 === 0;
      const g = ctx.createLinearGradient(x * cell, y * cell, (x + 1) * cell, (y + 1) * cell);
      if (even) {
        g.addColorStop(0, "#2a2c30");
        g.addColorStop(0.5, "#3f4247");
        g.addColorStop(1, "#232529");
      } else {
        g.addColorStop(0, "#1c1e21");
        g.addColorStop(0.5, "#2f3236");
        g.addColorStop(1, "#191b1e");
      }
      ctx.fillStyle = g;
      ctx.fillRect(x * cell + 0.5, y * cell + 0.5, cell - 1, cell - 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** タイヤのサイドウォール文字・トレッドパターンを生成 */
export function makeTireTexture(size = 512): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#17181a";
  ctx.fillRect(0, 0, size, size);
  // サイドウォールの凹凸
  for (let i = 0; i < 2400; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * size * 0.5;
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    ctx.fillStyle = Math.random() > 0.5 ? "rgba(40,42,46,0.5)" : "rgba(10,10,12,0.5)";
    ctx.fillRect(x, y, 2, 2);
  }
  // 文字(架空のブランド名)
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.fillStyle = "rgba(190,190,195,0.55)";
  ctx.font = `bold ${Math.round(size * 0.055)}px sans-serif`;
  ctx.textAlign = "center";
  const text = "COSTA · RADIAL · SPORT";
  const radius = size * 0.38;
  const chars = text.split("");
  const step = (Math.PI * 1.15) / chars.length;
  for (let i = 0; i < chars.length; i++) {
    const a = -Math.PI * 0.575 + i * step;
    ctx.save();
    ctx.rotate(a + Math.PI / 2);
    ctx.translate(0, -radius);
    ctx.fillText(chars[i], 0, 0);
    ctx.restore();
  }
  ctx.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** リバリー(デカール)テクスチャ。レースナンバーと幾何学ストライプ */
export function makeLiveryTexture(seed = 1, paintColor = "#c23a2b"): THREE.Texture {
  const W = 1024;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);

  let s = seed * 9301 + 49297;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  // 斜めのストライプ
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = paintColor;
  for (let i = 0; i < 3; i++) {
    const w = 60 + rnd() * 90;
    const x = 120 + i * 260 + rnd() * 80;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + w, 0);
    ctx.lineTo(x + w - 260, H);
    ctx.lineTo(x - 260, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // レースナンバー
  ctx.save();
  ctx.translate(W * 0.62, H * 0.5);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath();
  ctx.arc(0, 0, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#14161a";
  ctx.font = "bold 190px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const num = Math.floor(rnd() * 88) + 2;
  ctx.fillText(String(num), 0, 10);
  ctx.restore();

  // スポンサー風の小さな文字(架空)
  ctx.fillStyle = "rgba(20,22,26,0.8)";
  ctx.font = "bold 44px sans-serif";
  ctx.fillText("COSTA SOL RACING", 60, H * 0.16);
  ctx.font = "bold 30px sans-serif";
  ctx.fillText("NORTE · VEGA · SANTANA", 60, H * 0.9);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/* ------------------------------------------------------------------ */
/* ライブラリ                                                         */
/* ------------------------------------------------------------------ */

export class CarMaterialLibrary {
  private cache = new Map<string, THREE.Material>();
  readonly paintUniforms: {
    uFlakeScale: { value: number };
    uFlakeStrength: { value: number };
    uPeel: { value: number };
    uPearlStrength: { value: number };
    uPearlColor: { value: THREE.Color };
    uWetness: { value: number };
    uDust: { value: number };
  };
  private carbonTex: THREE.Texture | null = null;
  private tireTex: THREE.Texture | null = null;
  envMap: THREE.Texture | null = null;

  constructor() {
    this.paintUniforms = {
      uFlakeScale: { value: 1200 },
      uFlakeStrength: { value: 0.3 },
      uPeel: { value: 0.0025 },
      uPearlStrength: { value: 0 },
      uPearlColor: { value: new THREE.Color(0x88aaff) },
      uWetness: { value: 0 },
      uDust: { value: 0 },
    };
  }

  /** 塗装マテリアルを生成(パラメータは共有 uniform なので車1台ごとに複製する) */
  createPaint(params: PaintParams): THREE.MeshPhysicalMaterial {
    const preset = FINISH_PRESETS[params.finish];
    const mat = new THREE.MeshPhysicalMaterial({
      color: params.color.clone(),
      metalness: params.metallic,
      roughness: params.roughness,
      clearcoat: params.finish === "matte" ? 0.15 : params.finish === "satin" ? 0.6 : 1.0,
      clearcoatRoughness: params.clearcoatRoughness,
      envMapIntensity: 1.15,
      side: THREE.FrontSide,
      flatShading: false,
    });

    if (params.finish === "carbon") {
      if (!this.carbonTex) this.carbonTex = makeCarbonTexture(256);
      mat.map = this.carbonTex;
      mat.color.set(0xffffff);
    }

    const uniforms = {
      uFlakeScale: { value: params.finish === "carbon" ? 0 : params.flakeScale || preset.flakeScale },
      uFlakeStrength: { value: preset.flakeStrength },
      uPeel: { value: preset.peel },
      uPearlStrength: { value: preset.pearlStrength },
      uPearlColor: { value: params.pearlColor.clone() },
      uWetness: { value: 0 },
      uDust: { value: 0 },
    };

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${PAINT_VERT_HEAD}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${PAINT_VERT_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${PAINT_FRAG_HEAD}`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${PAINT_FRAG_NORMAL}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${PAINT_FRAG_COLOR}`);
    };
    mat.customProgramCacheKey = () => "carPaint";
    (mat as unknown as { __paintUniforms: typeof uniforms }).__paintUniforms = uniforms;
    return mat;
  }

  /** 走行中に汚れ・濡れを更新 */
  updateWeather(params: { wetness: number; dust: number }, material: THREE.Material): void {
    const u = (material as unknown as { __paintUniforms?: { uWetness: { value: number }; uDust: { value: number } } })
      .__paintUniforms;
    if (!u) return;
    u.uWetness.value = params.wetness;
    u.uDust.value = params.dust;
  }

  glass(tint = 0x14202a, opacity = 0.92): THREE.MeshPhysicalMaterial {
    const key = `glass_${tint}_${opacity}`;
    const cached = this.cache.get(key) as THREE.MeshPhysicalMaterial | undefined;
    if (cached) return cached;
    const mat = new THREE.MeshPhysicalMaterial({
      color: tint,
      metalness: 0.1,
      roughness: 0.06,
      transmission: 0.0,
      transparent: true,
      opacity,
      envMapIntensity: 1.6,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.cache.set(key, mat);
    return mat;
  }

  rubber(): THREE.MeshStandardMaterial {
    const cached = this.cache.get("rubber") as THREE.MeshStandardMaterial | undefined;
    if (cached) return cached;
    if (!this.tireTex) this.tireTex = makeTireTexture(512);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.0,
      map: this.tireTex,
    });
    this.cache.set("rubber", mat);
    return mat;
  }

  chrome(color = 0xdfe3e8, roughness = 0.08): THREE.MeshStandardMaterial {
    const key = `chrome_${color}_${roughness}`;
    const cached = this.cache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (cached) return cached;
    const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness: 1.0, envMapIntensity: 1.4 });
    this.cache.set(key, mat);
    return mat;
  }

  plastic(color = 0x1a1b1e, roughness = 0.55): THREE.MeshStandardMaterial {
    const key = `plastic_${color}_${roughness}`;
    const cached = this.cache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (cached) return cached;
    const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.1 });
    this.cache.set(key, mat);
    return mat;
  }

  carbon(): THREE.MeshStandardMaterial {
    const cached = this.cache.get("carbonMat") as THREE.MeshStandardMaterial | undefined;
    if (cached) return cached;
    if (!this.carbonTex) this.carbonTex = makeCarbonTexture(256);
    const mat = new THREE.MeshStandardMaterial({ map: this.carbonTex, roughness: 0.36, metalness: 0.42, envMapIntensity: 1.2 });
    this.cache.set("carbonMat", mat);
    return mat;
  }

  /** 灯火(発光) */
  light(color: number, intensity = 2.4, emissive = true): THREE.MeshStandardMaterial {
    const key = `light_${color}_${intensity}`;
    const cached = this.cache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (cached) return cached;
    const mat = new THREE.MeshStandardMaterial({
      color: emissive ? color : 0x2a2a2e,
      emissive: emissive ? color : 0x000000,
      emissiveIntensity: intensity,
      roughness: 0.15,
      metalness: 0.2,
      toneMapped: false,
    });
    this.cache.set(key, mat);
    return mat;
  }

  lampLens(color = 0xf0f4ff): THREE.MeshPhysicalMaterial {
    const key = `lens_${color}`;
    const cached = this.cache.get(key) as THREE.MeshPhysicalMaterial | undefined;
    if (cached) return cached;
    const mat = new THREE.MeshPhysicalMaterial({
      color,
      metalness: 0.0,
      roughness: 0.05,
      transparent: true,
      opacity: 0.55,
      clearcoat: 1,
      envMapIntensity: 1.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.cache.set(key, mat);
    return mat;
  }

  /** 内装のレザー調 */
  leather(color: number): THREE.MeshStandardMaterial {
    const key = `leather_${color}`;
    const cached = this.cache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (cached) return cached;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.02 });
    this.cache.set(key, mat);
    return mat;
  }

  brakeDisc(): THREE.MeshStandardMaterial {
    const cached = this.cache.get("brakeDisc") as THREE.MeshStandardMaterial | undefined;
    if (cached) return cached;
    const mat = new THREE.MeshStandardMaterial({ color: 0x6f7176, roughness: 0.35, metalness: 0.9 });
    this.cache.set("brakeDisc", mat);
    return mat;
  }

  caliper(color: number): THREE.MeshStandardMaterial {
    const key = `caliper_${color}`;
    const cached = this.cache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (cached) return cached;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.35 });
    this.cache.set(key, mat);
    return mat;
  }

  /** すべてのマテリアルに環境マップを適用 */
  applyEnvMap(env: THREE.Texture | null): void {
    this.envMap = env;
    for (const m of this.cache.values()) {
      const mat = m as THREE.MeshStandardMaterial;
      if ("envMap" in mat) {
        mat.envMap = env;
        mat.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    this.carbonTex?.dispose();
    this.tireTex?.dispose();
  }
}

export const materialLibrary = new CarMaterialLibrary();
