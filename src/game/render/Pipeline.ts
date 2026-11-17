/**
 * render/Pipeline.ts
 * 責務: レンダラー初期化、解像度スケール、品質プリセット、描画ループの土台
 * 公開API: RenderPipeline, QUALITY_PRESETS
 * 依存: three, core/math.ts
 *
 * 設計メモ:
 *  - 品質は 4 段階(モバイル低 / 標準 / 高 / 最高)。値を 1 か所にまとめ、
 *    Sky / PostFX / Terrain / Vegetation が同じプリセットを参照する。
 *  - 動的解像度は QualityScaler が担当(ここでは setResolutionScale のみ)。
 *  - トーンマッピングは PostFX 側で行うため、レンダラーは NoToneMapping + ACES 相当を自作。
 */
import * as THREE from "three";
import { clamp, clamp01, lerp } from "../core/math.js";

export interface QualityPreset {
  id: number;
  name: string;
  description: string;
  /** 内部解像度スケール */
  resolutionScale: number;
  /** 影の解像度 */
  shadowMapSize: number;
  /** 影の段数(1 = 単一, 3 = CSM 風) */
  shadowCascades: number;
  /** ポストエフェクト */
  bloom: boolean;
  ssao: boolean;
  motionBlur: boolean;
  dof: boolean;
  /** 反射(動的環境マップ) */
  dynamicReflections: boolean;
  /** 植生密度 */
  vegetationDensity: number;
  /** 描画距離(m) */
  drawDistance: number;
  /** アンチエイリアス */
  antialias: boolean;
  /** パーティクル数倍率 */
  particles: number;
  /** 地形のLOD距離倍率 */
  terrainLodBias: number;
}

export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: 0,
    name: "低 (スマホ)",
    description: "解像度0.65 / 影1段 / 反射なし。ハイエンドスマホで30fpsを目標。",
    resolutionScale: 0.65,
    shadowMapSize: 1024,
    shadowCascades: 1,
    bloom: true,
    ssao: false,
    motionBlur: false,
    dof: false,
    dynamicReflections: false,
    vegetationDensity: 0.4,
    drawDistance: 3200,
    antialias: false,
    particles: 0.45,
    terrainLodBias: 0.55,
  },
  {
    id: 1,
    name: "標準",
    description: "解像度1.0 / 影1段 / ブルームのみ。ミドル級GPUで60fps。",
    resolutionScale: 0.85,
    shadowMapSize: 2048,
    shadowCascades: 1,
    bloom: true,
    ssao: false,
    motionBlur: false,
    dof: false,
    dynamicReflections: false,
    vegetationDensity: 0.7,
    drawDistance: 5200,
    antialias: true,
    particles: 0.7,
    terrainLodBias: 0.85,
  },
  {
    id: 2,
    name: "高",
    description: "解像度1.0 / 影2段 / ブルーム + SSAO + モーションブラー。",
    resolutionScale: 1.0,
    shadowMapSize: 2048,
    shadowCascades: 2,
    bloom: true,
    ssao: true,
    motionBlur: true,
    dof: false,
    dynamicReflections: true,
    vegetationDensity: 0.9,
    drawDistance: 7200,
    antialias: true,
    particles: 1,
    terrainLodBias: 1,
  },
  {
    id: 3,
    name: "最高",
    description: "解像度1.25 / 影3段 / 全ポストエフェクト。ハイエンドPC向け。",
    resolutionScale: 1.2,
    shadowMapSize: 4096,
    shadowCascades: 3,
    bloom: true,
    ssao: true,
    motionBlur: true,
    dof: true,
    dynamicReflections: true,
    vegetationDensity: 1,
    drawDistance: 9000,
    antialias: true,
    particles: 1.4,
    terrainLodBias: 1.15,
  },
];

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  resolution: { w: number; h: number; scale: number };
}

export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private quality: QualityPreset;
  private clock = new THREE.Clock();
  private frameTimes: number[] = [];
  private fpsSmooth = 60;
  private baseScale = 1;
  private currentScale = 1;
  private container: HTMLElement;

  constructor(container: HTMLElement, qualityIndex = 2) {
    this.container = container;
    this.quality = QUALITY_PRESETS[clamp(qualityIndex, 0, QUALITY_PRESETS.length - 1)];

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.quality.antialias,
      powerPreference: "high-performance",
      alpha: false,
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // PostFX で行う
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none;";
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xbfd0dc, 0.00034);

    this.camera = new THREE.PerspectiveCamera(62, this.aspect, 0.3, 16000);
    this.camera.position.set(0, 3, -8);

    window.addEventListener("resize", this.onResize);
  }

  get aspect(): number {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    return w / Math.max(1, h);
  }

  get elements(): HTMLElement {
    return this.renderer.domElement;
  }

  get preset(): QualityPreset {
    return this.quality;
  }

  setQuality(index: number): void {
    this.quality = QUALITY_PRESETS[clamp(index, 0, QUALITY_PRESETS.length - 1)];
    this.renderer.shadowMap.enabled = true;
    this.baseScale = this.quality.resolutionScale;
    this.applyResolution();
  }

  /** 動的解像度の倍率(1.0 = プリセット通り) */
  setResolutionScale(scale: number): void {
    this.currentScale = clamp(scale, 0.5, 1.0);
    this.applyResolution();
  }

  private applyResolution(): void {
    const dpr = Math.min(window.devicePixelRatio, this.quality.id >= 2 ? 2 : 1.5);
    const s = this.baseScale * this.currentScale;
    this.renderer.setPixelRatio(dpr * s);
    this.renderer.setSize(this.container.clientWidth || window.innerWidth, this.container.clientHeight || window.innerHeight, false);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  private onResize = (): void => {
    this.applyResolution();
  };

  /** 1フレーム描画(ポストなし。ポストは PostFX が担当) */
  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** フレーム時間を記録し、統計を返す */
  tick(): RenderStats {
    const dt = this.clock.getDelta();
    const ms = dt * 1000;
    this.fpsSmooth = this.fpsSmooth * 0.94 + (1 / Math.max(0.001, dt)) * 0.06;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    const info = this.renderer.info;
    return {
      fps: Math.round(this.fpsSmooth),
      frameMs: ms,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      resolution: { w: this.renderer.domElement.width, h: this.renderer.domElement.height, scale: this.currentScale },
    };
  }

  /** 直近のフレーム時間平均(95%タイル的な値) */
  get averageFrameMs(): number {
    if (!this.frameTimes.length) return 16.7;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const n = Math.max(1, Math.floor(sorted.length * 0.9));
    let s = 0;
    for (let i = 0; i < n; i++) s += sorted[i];
    return s / n;
  }

  setPixelRatioScale(v: number): void {
    this.setResolutionScale(v);
  }

  get currentQualityIndex(): number {
    return this.quality.id;
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** カメラの FOV を速度で調整(スピード感) */
export function speedFov(baseFov: number, speedKmh: number, maxSpeed = 320): number {
  const t = clamp01(speedKmh / maxSpeed);
  return lerp(baseFov, baseFov + 13, Math.pow(t, 1.5));
}
