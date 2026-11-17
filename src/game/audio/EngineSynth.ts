/**
 * audio/EngineSynth.ts
 * 責務: WebAudio でエンジン音を合成(回転数・負荷・気筒数・ターボ/吸気音)、タイヤスキール、風切り音
 * 公開API: EngineSynth
 * 依存: three(なしでも可), physics/Vehicle.ts, car/spec/CarSpec.ts
 *
 * 設計メモ:
 *  - 4 つのオシレータ(サブ/ベース/ミッド/ハイ)を回転数に追従させ、波形を混ぜて「気筒っぽさ」を作る。
 *  - 負荷(スロットル)で倍音と音量を変え、ターボはホイッスル(ノイズ + バンドパス)を重ねる。
 *  - ブラウザの自動再生制限に対応: 最初のユーザー操作で AudioContext を resume する。
 *  - ミュート状態でも最小限の処理で済むよう、停止時は gain=0。
 */
import { CarSpec } from "../car/spec/CarSpec.js";
import { Vehicle } from "../physics/Vehicle.js";
import { clamp01, clamp, lerp } from "../core/math.js";

export class EngineSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private oscs: Array<{ osc: OscillatorNode; gain: GainNode; type: OscillatorType; ratio: number }> = [];
  private noiseSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private turboOsc: OscillatorNode | null = null;
  private turboGain: GainNode | null = null;
  private tyreGain: GainNode | null = null;
  private tyreFilter: BiquadFilterNode | null = null;
  private active = false;
  private muted = false;
  private spec: CarSpec | null = null;
  private lastRpm = 900;
  private lastBoost = 0;

  constructor(spec?: CarSpec) {
    if (spec) this.spec = spec;
    window.addEventListener("pointerdown", this.unlock, { once: true });
    window.addEventListener("keydown", this.unlock, { once: true });
  }

  setSpec(spec: CarSpec): void {
    this.spec = spec;
  }

  private unlock = (): void => {
    this.ensureContext();
    void this.ctx?.resume();
  };

  private ensureContext(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(this.ctx.destination);

    // エンジン本体
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineGain.connect(this.master);

    const types: Array<[OscillatorType, number, number]> = [
      ["sawtooth", 0.5, 0.34],
      ["square", 1.0, 0.22],
      ["sawtooth", 2.0, 0.14],
      ["triangle", 0.25, 0.3],
    ];
    for (const [type, ratio, gainValue] of types) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 60;
      const g = this.ctx.createGain();
      g.gain.value = gainValue;
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 900;
      osc.connect(filter);
      filter.connect(g);
      g.connect(this.engineGain);
      osc.start();
      this.oscs.push({ osc, gain: g, type, ratio });
    }

    // ノイズ(吸気・排気)
    const bufferSize = 2 * this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    this.noiseSrc = this.ctx.createBufferSource();
    this.noiseSrc.buffer = buffer;
    this.noiseSrc.loop = true;
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 1400;
    noiseFilter.Q.value = 0.9;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.05;
    this.noiseSrc.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.engineGain);
    this.noiseSrc.start();

    // 風切り音
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 600;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    const windNoise = this.ctx.createBufferSource();
    windNoise.buffer = buffer;
    windNoise.loop = true;
    windNoise.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    windNoise.start();

    // タイヤスキール
    this.tyreFilter = this.ctx.createBiquadFilter();
    this.tyreFilter.type = "bandpass";
    this.tyreFilter.frequency.value = 2200;
    this.tyreFilter.Q.value = 3.2;
    this.tyreGain = this.ctx.createGain();
    this.tyreGain.gain.value = 0;
    const tyreNoise = this.ctx.createBufferSource();
    tyreNoise.buffer = buffer;
    tyreNoise.loop = true;
    tyreNoise.connect(this.tyreFilter);
    this.tyreFilter.connect(this.tyreGain);
    this.tyreGain.connect(this.master);
    tyreNoise.start();

    // ターボ
    this.turboOsc = this.ctx.createOscillator();
    this.turboOsc.type = "sine";
    this.turboOsc.frequency.value = 2600;
    this.turboGain = this.ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboOsc.connect(this.turboGain);
    this.turboGain.connect(this.master);
    this.turboOsc.start();
  }

  setActive(v: boolean): void {
    this.active = v;
    if (v) this.ensureContext();
  }

  setMuted(m: boolean): void {
    this.muted = m;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  update(vehicle: Vehicle, dt: number): void {
    if (!this.ctx || !this.master) return;
    const targetMaster = this.active && !this.muted ? 0.5 : 0;
    this.master.gain.setTargetAtTime(targetMaster, this.ctx.currentTime, 0.15);
    if (!this.active || this.muted) return;

    const spec = vehicle.spec;
    const rpm = vehicle.state.rpm;
    const load = clamp01(Math.abs(vehicle.telemetry.longitudinalG));
    const throttle = Math.abs(vehicle.state.forwardSpeed) >= 0 ? clamp01(vehicle.telemetry.throttle) : 0;
    const speed = Math.abs(vehicle.state.forwardSpeed);

    // 基本周波数: 回転数 / 60 * 気筒数/2 (4ストローク)
    const cylinders = spec.engine.cylinders;
    const baseFreq = (rpm / 60) * (cylinders / 2) * 0.5;
    const idleFactor = clamp01((rpm - spec.engine.idle) / (spec.engine.redline - spec.engine.idle));

    for (const o of this.oscs) {
      const f = baseFreq * o.ratio * (1 + load * 0.03);
      o.osc.frequency.setTargetAtTime(clamp(f, 20, 4200), this.ctx.currentTime, 0.04);
      // 負荷で音量と倍音を変化
      const g = (0.12 + throttle * 0.3) * (o.type === "sawtooth" ? 1 : 0.8);
      o.gain.gain.setTargetAtTime(g * (0.55 + idleFactor * 0.6), this.ctx.currentTime, 0.08);
    }

    // 風切り音
    if (this.windGain && this.windFilter) {
      const wind = clamp01(speed / 60) * 0.16;
      this.windGain.gain.setTargetAtTime(wind, this.ctx.currentTime, 0.15);
      this.windFilter.frequency.setTargetAtTime(400 + speed * 22, this.ctx.currentTime, 0.2);
    }

    // タイヤ
    if (this.tyreGain && this.tyreFilter) {
      const slip = clamp01(vehicle.slipAmount * 1.3);
      this.tyreGain.gain.setTargetAtTime(slip * 0.16, this.ctx.currentTime, 0.08);
      this.tyreFilter.frequency.setTargetAtTime(1600 + slip * 1400 + speed * 6, this.ctx.currentTime, 0.1);
    }

    // ターボ
    if (this.turboGain && this.turboOsc) {
      const boost = vehicle.drivetrain ? clamp01((vehicle.state.rpm - spec.engine.idle * 2) / spec.engine.redline) : 0;
      const forced = spec.engine.aspiration === "turbo" || spec.engine.aspiration === "twin-turbo";
      const target = forced ? boost * throttle * 0.05 : 0;
      this.turboGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12);
      this.turboOsc.frequency.setTargetAtTime(1800 + boost * 2600, this.ctx.currentTime, 0.1);
    }

    this.lastRpm = rpm;
    this.lastBoost = load;
    void dt;
    void lerp;
  }

  dispose(): void {
    this.active = false;
    for (const o of this.oscs) {
      try {
        o.osc.stop();
      } catch {
        /* noop */
      }
    }
    this.noiseSrc?.stop();
    this.turboOsc?.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
