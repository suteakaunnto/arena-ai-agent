/**
 * race/RaceSession.ts
 * 責務: 1 本のコースを走る「セッション」の進行(カウントダウン→走行→結果)
 * 公開API: RaceSession, RaceState, RaceResult, LapRecord
 * 依存: race/Circuit.ts
 *
 * 設計メモ:
 *  - 物理とは独立。Vehicle の位置を毎フレーム渡すだけで、状態遷移と計測だけを行う。
 *  - ラップ判定は「ゲートを順番に通過したか」で行う。最終ゲートの次に
 *    スタートゲートへ戻った瞬間がラップ完了。
 *  - リワインドやリセットで位置が飛んでも壊れないよう、判定は
 *    「次に通るべきゲート」1 つだけを見る(取りこぼしは 1 つ先まで許容)。
 */
import { Circuit, formatTime } from "./Circuit.js";

export type RaceState = "countdown" | "running" | "finished" | "aborted";

export interface LapRecord {
  lap: number;
  /** ラップタイム(秒) */
  time: number;
  /** 区間タイム(ゲートごと)。比較用 */
  splits: number[];
}

export interface RaceResult {
  circuitId: string;
  circuitName: string;
  /** 完了した周回数 */
  laps: number;
  /** 総走行時間(秒) */
  total: number;
  /** 最速ラップ(秒)。周回 0 なら Infinity */
  bestLap: number;
  /** 全ラップの記録 */
  records: LapRecord[];
  /** 保存済みベストとの差(秒)。初回は Infinity */
  bestDelta: number;
  /** 通算距離(m) */
  distance: number;
  /** コースアウト(路面外)だった時間(秒) */
  offRoadTime: number;
}

/** 何周でフィニッシュか */
export const DEFAULT_LAPS = 2;
/** カウントダウンの長さ(秒) */
const COUNTDOWN = 3;
/** ゲート通過を見逃したとみなす距離(m)。これを超えて進んだら取りこぼし扱い */
const GATE_SKIP_DISTANCE = 180;

export class RaceSession {
  readonly circuit: Circuit;
  readonly totalLaps: number;
  state: RaceState = "countdown";
  /** 状態が変わったフレームで true */
  stateChanged = false;

  /** カウントダウン残り(秒)。running 中は 0 */
  countdown = COUNTDOWN;
  /** 現在のラップ番号(1 始まり) */
  lap = 1;
  /** 現在のラップ経過時間(秒) */
  lapTime = 0;
  /** セッション総時間(秒)。カウントダウン終了から加算 */
  totalTime = 0;
  /** 次に通るべきゲート番号 */
  nextGate = 0;
  /** 最後に通過したゲート番号 */
  lastGate = 0;
  /** 直近のゲート通過で出た区間タイム */
  lastSplitDelta = 0;
  /** 直近のラップタイム(表示用) */
  lastLapTime = 0;
  /** コースアウトしていた累積時間 */
  offRoadTime = 0;
  distance = 0;

  readonly records: LapRecord[] = [];
  private currentSplits: number[] = [];
  private bestLaps: number[] = [];
  private sessionSplit = 0;
  private lastPos = { x: 0, z: 0 };
  private hasLastPos = false;
  /** 保存済みベストラップ。比較表示に使う */
  bestLap = Infinity;
  /** 通過したゲートの総数(取りこぼし検出用) */
  private gateProgress = 0;

  constructor(circuit: Circuit, totalLaps = DEFAULT_LAPS, bestLap = Infinity) {
    this.circuit = circuit;
    this.totalLaps = Math.max(1, Math.round(totalLaps));
    this.bestLap = bestLap;
    const st = circuit.start;
    this.lastPos = { x: st.x, z: st.z };
  }

  /** スタート地点の座標(車を置く位置) */
  get startPose(): { x: number; y: number; z: number; heading: number } {
    const g = this.circuit.start;
    return { x: g.x, y: g.y, z: g.z, heading: Math.atan2(g.tx, g.tz) };
  }

  get isActive(): boolean {
    return this.state === "countdown" || this.state === "running";
  }

  get isFinished(): boolean {
    return this.state === "finished";
  }

  /** 残り周回数 */
  get lapsRemaining(): number {
    return Math.max(0, this.totalLaps - this.lap + 1);
  }

  /**
   * 毎フレーム呼ぶ。
   *  @param x,z 車の位置
   *  @param onRoad 舗装路上か(コースアウト計測用)
   *  @param dt 経過秒
   */
  update(x: number, z: number, onRoad: boolean, dt: number): void {
    this.stateChanged = false;
    if (this.state === "finished" || this.state === "aborted") return;

    // --- カウントダウン ---
    if (this.state === "countdown") {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      if (Math.ceil(this.countdown) !== before) this.stateChanged = true;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.state = "running";
        this.stateChanged = true;
        // スタート直後のゲート(スタート地点そのもの)は通過済み扱い
        this.lastGate = this.circuit.gates.length - 1;
        this.nextGate = 0;
      }
      this.lastPos = { x, z };
      this.hasLastPos = true;
      return;
    }

    // --- 走行中 ---
    // dt はポーズ中に呼び出し側が 0 を渡す(タイマーを止める)
    this.lapTime += dt;
    this.totalTime += dt;
    this.sessionSplit += dt;

    if (!onRoad) this.offRoadTime += dt;

    // 走行距離(水平)
    if (this.hasLastPos) {
      const d = Math.hypot(x - this.lastPos.x, z - this.lastPos.z);
      // テレポート(リセット)で距離が飛ばないよう上限を掛ける
      if (d < 100) this.distance += d;
    }
    this.lastPos = { x, z };
    this.hasLastPos = true;

    // --- ゲート判定 ---
    const idx = this.nextGate;
    if (this.circuit.isAtGate(idx, x, z)) {
      this.passGate(idx);
      return;
    }
    // 取りこぼし救済: 次ゲートより十分先へ進んでいたら、通過したものとして進める
    const q = this.circuit.road.project(x, z);
    const gateS = this.circuit.gates[idx].s;
    let ds = q.s - gateS;
    if (ds < 0) ds += this.circuit.length;
    if (ds > GATE_SKIP_DISTANCE && ds < this.circuit.length * 0.5) {
      this.passGate(idx, true);
    }
  }

  /**
   * ゲート i を通過した。
   *  最後のゲートの次がスタートゲート = 1 周完了。
   */
  private passGate(i: number, skipped = false): void {
    const n = this.circuit.gates.length;
    const g = this.circuit.gates[i];
    // 区間タイム
    const split = this.sessionSplit;
    this.sessionSplit = 0;
    this.currentSplits.push(split);
    this.lastSplitDelta = split - (g.split > 0 ? g.split : split);
    // 次回以降の比較用に区間ベストを貯める(初回は記録のみ)
    if (g.split <= 0) g.split = split;
    else g.split = Math.min(g.split, split);

    this.lastGate = i;
    this.gateProgress++;
    const next = (i + 1) % n;
    this.nextGate = next;

    if (skipped) {
      // 取りこぼしても周回は進める(ペナルティとして +2 秒を課す)
      this.lapTime += 2;
      this.totalTime += 2;
    }

    // 周回完了: 最終ゲートの次がスタート(0 番)
    if (i === n - 1) {
      this.completeLap();
    }
  }

  private completeLap(): void {
    const time = this.lapTime;
    this.lastLapTime = time;
    this.records.push({
      lap: this.lap,
      time,
      splits: this.currentSplits.slice(),
    });
    this.bestLaps.push(time);
    this.bestLap = Math.min(this.bestLap, time);
    this.currentSplits = [];
    this.lapTime = 0;
    this.sessionSplit = 0;
    this.lap++;

    if (this.lap > this.totalLaps) {
      this.state = "finished";
      this.stateChanged = true;
    }
  }

  /** 中止(タイトルへ戻る等) */
  abort(): void {
    if (this.state === "finished") return;
    this.state = "aborted";
    this.stateChanged = true;
  }

  /** 現時点の結果。未完了でも「ここまでの記録」として返せる */
  result(savedBest = Infinity): RaceResult {
    const best = this.records.length ? Math.min(...this.records.map((r) => r.time)) : Infinity;
    return {
      circuitId: this.circuit.def.id,
      circuitName: this.circuit.def.name,
      laps: this.records.length,
      total: this.totalTime,
      bestLap: best,
      records: this.records.slice(),
      bestDelta: isFinite(savedBest) && isFinite(best) ? best - savedBest : Infinity,
      distance: this.distance,
      offRoadTime: this.offRoadTime,
    };
  }

  /** HUD 用の 1 行テキスト(ラップ 1/2  01:23.456) */
  hudLine(): string {
    if (this.state === "countdown") {
      const n = Math.ceil(this.countdown);
      return n > 0 ? String(n) : "GO";
    }
    return `LAP ${Math.min(this.lap, this.totalLaps)}/${this.totalLaps}   ${formatTime(this.lapTime)}`;
  }
}
