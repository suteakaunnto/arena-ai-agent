/**
 * audio/Ambient.ts
 * 責務: 環境音(風・虫・波)と UI 効果音、簡易 BGM(コード進行シーケンサ)
 * 公開API: AmbientAudio
 * 依存: three(なし), core/math.ts
 *
 * 設計メモ:
 *  - 環境音はノイズをバンドパスして「風」を作り、バイオームに応じてフィルタを変える。
 *  - BGM は 4 音のオシレータでゆっくりしたアンビエント・パッド(外部音源なし)。
 *  - 起動直後はユーザー操作待ちなので、unlock されるまで無音。
 */
import { clamp01 } from "../core/math.js";
import { Vehicle } from "../physics/Vehicle.js";

export class AmbientAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private padGain: GainNode | null = null;
  private padOscs: OscillatorNode[] = [];
  private active = false;
  private muted = false;
  private chordTimer = 0;
  private chordIndex = 0;
  private unlocked = false;

  /** Cmaj9 → Am9 → Fmaj7#11 → G6 のゆるい進行(A4=440) */
  private chords: number[][] = [
    [130.81, 164.81, 196.0, 246.94],
    [110.0, 130.81, 164.81, 196.0],
    [87.31, 130.81, 164.81, 196.0],
    [98.0, 123.47, 146.83, 196.0],
  ];

  constructor() {
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
      this.unlocked = true;
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  private ensure(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(this.ctx.destination);

    // 風
    const size = 3 * this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < size; i++) {
      // ブラウンノイズ(風らしい低域)
      last = (last + (Math.random() * 2 - 1) * 0.02) * 0.995;
      d[i] = last;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 420;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.35;
    src.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    src.start();

    // パッド
    this.padGain = this.ctx.createGain();
    this.padGain.gain.value = 0.0;
    this.padGain.connect(this.master);
    for (let i = 0; i < 4; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = i === 3 ? "triangle" : "sine";
      osc.frequency.value = this.chords[0][i];
      const g = this.ctx.createGain();
      g.gain.value = 0.055;
      osc.connect(g);
      g.connect(this.padGain);
      osc.start();
      this.padOscs.push(osc);
    }
  }

  setActive(v: boolean): void {
    this.active = v;
  }

  setMuted(m: boolean): void {
    this.muted = m;
  }

  /** 短い UI 音 */
  blip(freq = 660, duration = 0.08, type: OscillatorType = "sine", volume = 0.12): void {
    if (!this.ctx || !this.master || this.muted) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, this.ctx.currentTime);
    g.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
    osc.connect(g);
    g.connect(this.master);
    osc.start();
    osc.stop(this.ctx.currentTime + duration + 0.02);
  }

  update(dt: number, vehicle?: Vehicle): void {
    if (!this.ctx || !this.master) return;
    const target = this.active && !this.muted ? 0.45 : 0;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.6);
    if (!this.active || this.muted) return;

    // 風の強さ(車速)
    if (this.windGain && this.windFilter) {
      const speed = vehicle ? Math.abs(vehicle.state.forwardSpeed) : 0;
      this.windGain.gain.setTargetAtTime(0.28 + clamp01(speed / 70) * 0.35, this.ctx.currentTime, 0.4);
      this.windFilter.frequency.setTargetAtTime(320 + speed * 14, this.ctx.currentTime, 0.5);
    }

    // パッド(ゆっくり)
    this.chordTimer += dt;
    if (this.padGain) {
      this.padGain.gain.setTargetAtTime(this.active ? 0.16 : 0, this.ctx.currentTime, 1.2);
    }
    if (this.chordTimer > 7.5) {
      this.chordTimer = 0;
      this.chordIndex = (this.chordIndex + 1) % this.chords.length;
      const chord = this.chords[this.chordIndex];
      this.padOscs.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(chord[i], this.ctx!.currentTime, 1.6);
      });
    }
  }

  dispose(): void {
    for (const o of this.padOscs) {
      try {
        o.stop();
      } catch {
        /* noop */
      }
    }
    void this.ctx?.close();
    this.ctx = null;
  }
}
