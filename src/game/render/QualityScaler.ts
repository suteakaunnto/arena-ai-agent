/**
 * render/QualityScaler.ts
 * 責務: フレーム時間を監視して動的解像度スケールと品質ティアを自動調整(発熱・重いシーンの対策)
 * 公開API: QualityScaler, QUALITY_TIERS
 * 依存: render/Pipeline.ts, core/math.ts
 *
 * 設計メモ:
 *  - ヒステリシスを入れて、毎フレーム上下しないようにする。
 *  - 30fps を下回り続けたら「重い」、55fps を上回り続けたら「軽い」と判断。
 *  - 画質ティア(物量)は頻繁に変えるとポップするので、変更は 4 秒間隔に制限。
 */
import { clamp, clamp01, Hysteresis, Ring } from "../core/math.js";
import { RenderPipeline } from "./Pipeline.js";

export interface QualityTier {
  name: string;
  /** 解像度スケール */
  resolution: number;
  /** 植生密度 */
  vegetation: number;
  /** 影の有無 */
  shadows: boolean;
  /** ポストエフェクト */
  bloom: boolean;
  ssao: boolean;
  motionBlur: boolean;
  /** 描画距離 */
  drawDistance: number;
}

/**
 * 物量ティア(解像度とは独立に調整)
 */
export const QUALITY_TIERS: QualityTier[] = [
  { name: "very-low", resolution: 0.6, vegetation: 0.35, shadows: false, bloom: false, ssao: false, motionBlur: false, drawDistance: 2600 },
  { name: "low", resolution: 0.72, vegetation: 0.5, shadows: true, bloom: true, ssao: false, motionBlur: false, drawDistance: 3800 },
  { name: "medium", resolution: 0.85, vegetation: 0.7, shadows: true, bloom: true, ssao: false, motionBlur: false, drawDistance: 5200 },
  { name: "high", resolution: 1.0, vegetation: 0.9, shadows: true, bloom: true, ssao: true, motionBlur: true, drawDistance: 7000 },
  { name: "ultra", resolution: 1.0, vegetation: 1.0, shadows: true, bloom: true, ssao: true, motionBlur: true, drawDistance: 9000 },
];

export interface ScalerState {
  tier: number;
  resolution: number;
  fps: number;
  adjusting: boolean;
  reason: string;
}

export class QualityScaler {
  private tier: number;
  private resolution = 1;
  private frameRing = new Ring(60);
  private changeTimer = 0;
  private fpsRing = new Ring(30);
  private state: ScalerState;
  private auto = true;
  private lastReason = "";
  private slowHysteresis = new Hysteresis(28, 42);
  private fastHysteresis = new Hysteresis(56, 68);
  private baseTier: number;

  constructor(private pipeline: RenderPipeline, startTier = 3) {
    this.tier = clamp(startTier, 0, QUALITY_TIERS.length - 1);
    this.baseTier = this.tier;
    this.resolution = QUALITY_TIERS[this.tier].resolution;
    this.state = { tier: this.tier, resolution: this.resolution, fps: 60, adjusting: false, reason: "" };
    this.apply();
  }

  setAuto(v: boolean): void {
    this.auto = v;
  }

  get isAuto(): boolean {
    return this.auto;
  }

  get currentTier(): QualityTier {
    return QUALITY_TIERS[this.tier];
  }

  get stats(): ScalerState {
    return this.state;
  }

  /** 手動でティアを指定 */
  setTier(t: number): void {
    this.tier = clamp(t, 0, QUALITY_TIERS.length - 1);
    this.baseTier = this.tier;
    this.resolution = QUALITY_TIERS[this.tier].resolution;
    this.apply();
  }

  /** 毎フレーム呼ぶ */
  update(dt: number): ScalerState {
    const frameMs = dt * 1000;
    this.frameRing.push(frameMs);
    const fps = frameMs > 0 ? 1 / dt : 60;
    this.fpsRing.push(fps);
    this.changeTimer += dt;

    if (this.auto && this.frameRing.count > 20 && this.changeTimer > 1.2) {
      const avg = this.frameRing.trimmedAvg(0.9);
      const avgFps = 1000 / Math.max(1, avg);

      if (this.slowHysteresis.test(avgFps) && this.resolution > 0.62) {
        // 重い: まず解像度を下げる
        this.resolution = clamp(this.resolution - 0.08, 0.6, 1);
        this.changeTimer = 0;
        this.lastReason = `フレーム時間 ${avg.toFixed(1)}ms → 解像度 ${Math.round(this.resolution * 100)}%`;
        this.apply();
      } else if (this.slowHysteresis.test(avgFps) && this.tier > 0) {
        // それでも重い: 物量を下げる
        this.tier--;
        this.resolution = QUALITY_TIERS[this.tier].resolution;
        this.changeTimer = 0;
        this.lastReason = `物量を ${QUALITY_TIERS[this.tier].name} へ`;
        this.apply();
      } else if (this.fastHysteresis.test(avgFps)) {
        // 軽い: 解像度を戻す → 物量を戻す
        if (this.resolution < QUALITY_TIERS[this.tier].resolution) {
          this.resolution = clamp(this.resolution + 0.05, 0.6, QUALITY_TIERS[this.tier].resolution);
          this.changeTimer = 0;
          this.lastReason = `余裕あり → 解像度 ${Math.round(this.resolution * 100)}%`;
          this.apply();
        } else if (this.tier < this.baseTier) {
          this.tier++;
          this.changeTimer = 0;
          this.lastReason = `物量を ${QUALITY_TIERS[this.tier].name} へ戻す`;
          this.apply();
        }
      }
    }

    this.state = {
      tier: this.tier,
      resolution: this.resolution,
      fps: Math.round(this.fpsRing.avg()),
      adjusting: this.changeTimer < 0.3,
      reason: this.lastReason,
    };
    return this.state;
  }

  private apply(): void {
    const t = QUALITY_TIERS[this.tier];
    this.pipeline.setResolutionScale(this.resolution / Math.max(0.01, t.resolution));
    this.pipeline.setQuality(this.tier);
  }

  /** 表示用 */
  get label(): string {
    const t = QUALITY_TIERS[this.tier];
    const names: Record<string, string> = {
      "very-low": "最低",
      low: "低",
      medium: "中",
      high: "高",
      ultra: "最高",
    };
    return `${names[t.name] ?? t.name} (${Math.round(this.resolution * 100)}%)`;
  }

  get autoLabel(): string {
    return this.auto ? "自動" : "固定";
  }
}
