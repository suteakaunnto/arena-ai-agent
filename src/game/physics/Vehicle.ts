/**
 * physics/Vehicle.ts
 * 責務: 車両の剛体運動(ヨー/ピッチ/ロール)、4輪のタイヤ力、サスペンション接地、
 *       空力、駆動配分、ブレーキ、アシスト、地形との接地判定
 * 公開API: Vehicle, VehicleState, createVehicle, VehicleInput
 * 依存: core/math.ts, car/spec/CarSpec.ts, physics/Tire.ts, physics/Drivetrain.ts, world/Road.ts, world/Terrain.ts
 *
 * 設計メモ:
 *  - 固定 120Hz ステップで積分する(描画とは分離)。
 *  - 4輪それぞれでスリップ角/スリップ比を計算し、摩擦円で合力を出す(標準的な車両モデル)。
 *  - 車体は「4点の接地」でサスペンション荷重を配分。地形の高さと法線を使う。
 *  - 浮遊/ジャンプ時は重力のみ、着地時にサスが縮む。
 *  - アシスト(ABS/TCS/STM)はゲーム向けに強めに効かせられる。
 */
import * as THREE from "three";
import { CarSpec } from "../car/spec/CarSpec.js";
import { clamp, clamp01, lerp, smoothstep, wrapAngle, damp, TAU } from "../core/math.js";
import { createTireState, updateTire, TireState, DEFAULT_PACEJKA, rollingResistance } from "./Tire.js";
import { Drivetrain, DrivetrainOutput } from "./Drivetrain.js";
import { Terrain } from "../world/Terrain.js";
import { RoadNetwork } from "../world/Road.js";

export interface AssistConfig {
  abs: number;
  tcs: number;
  stm: number;
  /** 自動カウンターステア */
  counterSteer: number;
}

const UP_VEC = new THREE.Vector3(0, 1, 0);

export const DEFAULT_ASSISTS: AssistConfig = {
  abs: 0.8,
  tcs: 0.6,
  stm: 0.35,
  counterSteer: 0.35,
};

export interface VehicleInput {
  /** -1..1 (右が正) */
  steer: number;
  throttle: number;
  brake: number;
  handbrake: number;
  shiftUp: boolean;
  shiftDown: boolean;
  autoGear: boolean;
  /** 外部から直接操舵角を指定(AI用, ラジアン) */
  directSteer?: number;
  /** リセット要求 */
  reset?: boolean;
}

export interface WheelState {
  /** ローカル座標 */
  local: THREE.Vector3;
  /** ワールド座標 */
  world: THREE.Vector3;
  /** 接地しているか */
  grounded: boolean;
  /** サス圧縮量(0..1, 0=伸び切り, 1=底付き) */
  compression: number;
  /** サス長さ(m) */
  length: number;
  /** 荷重(N) */
  load: number;
  /** ステア角(rad) */
  steerAngle: number;
  /** ホイール回転角(rad) */
  spin: number;
  /** スピン速度(rad/s) */
  omega: number;
  tire: TireState;
  isFront: boolean;
  isLeft: boolean;
  /** スリップによる煙の量 */
  smoke: number;
}

export interface VehicleState {
  position: THREE.Vector3;
  /** 進行方向(ラジアン, XZ平面)。0 = +Z */
  heading: number;
  /** ピッチ(前上がり正) */
  pitch: number;
  /** ロール(右が下がる正) */
  roll: number;
  /** 速度ベクトル(ワールド) */
  velocity: THREE.Vector3;
  /** ヨー角速度(rad/s) */
  yawRate: number;
  /** 前後速度(m/s) */
  forwardSpeed: number;
  /** 横速度(m/s) */
  lateralSpeed: number;
  /** 上下速度 */
  verticalSpeed: number;
  /** 接地しているか */
  grounded: boolean;
  /** エアボーン(4輪浮き) */
  airborne: boolean;
  /** 現在の路面μ */
  surfaceMu: number;
  /** 現在の路面種別 */
  surfaceLabel: string;
  /** 現在のギア */
  gear: number;
  /** エンジン回転数 */
  rpm: number;
  /** 操舵角(rad) */
  steerAngle: number;
  /** 走行距離(m) */
  odometer: number;
  /** G フォース(表示用) */
  gForce: { lateral: number; longitudinal: number };
}

/** 固定ステップ */
export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;

export class Vehicle {
  readonly spec: CarSpec;
  readonly drivetrain: Drivetrain;
  readonly wheels: WheelState[] = [];
  readonly state: VehicleState;
  readonly tireTemps: number[] = [];
  assists: AssistConfig = { ...DEFAULT_ASSISTS };

  private prevInput: VehicleInput = {
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: 0,
    shiftUp: false,
    shiftDown: false,
    autoGear: true,
  };
  private roadQueryCache: { grip: number; label: string; y: number } = { grip: 1, label: "舗装路", y: 0 };
  private terrain: Terrain | null = null;
  private roads: RoadNetwork | null = null;
  private driftAngle = 0;
  private collisionTimer = 0;
  private lastImpact = 0;
  /** サスペンションの見た目用スムージング */
  private visualPitch = 0;
  private visualRoll = 0;
  private wheelBase: number;
  private trackF: number;
  private trackR: number;
  /** 前輪/後輪の重量配分 */
  private staticFrontLoad = 0;
  private staticRearLoad = 0;
  private bodyAccel = new THREE.Vector3();
  private lastVelocity = new THREE.Vector3();

  constructor(spec: CarSpec, terrain?: Terrain, roads?: RoadNetwork) {
    this.spec = spec;
    this.terrain = terrain ?? null;
    this.roads = roads ?? null;
    this.drivetrain = new Drivetrain(spec);

    this.wheelBase = spec.chassis.wheelbase;
    this.trackF = spec.chassis.trackFront;
    this.trackR = spec.chassis.trackRear;

    const mass = spec.chassis.mass;
    this.staticFrontLoad = mass * 9.81 * spec.chassis.frontWeight;
    this.staticRearLoad = mass * 9.81 * (1 - spec.chassis.frontWeight);

    // 車輪配置(ローカル: +Z 前, +X 右)
    const halfTrackF = this.trackF * 0.5;
    const halfTrackR = this.trackR * 0.5;
    const frontZ = this.wheelBase * 0.5;
    const rearZ = -this.wheelBase * 0.5;
    const frontR = spec.dims.wheelRadiusFront;
    const rearR = spec.dims.wheelRadiusRear;

    const mk = (x: number, z: number, r: number, isFront: boolean, isLeft: boolean): WheelState => ({
      local: new THREE.Vector3(x, r, z),
      world: new THREE.Vector3(),
      grounded: true,
      compression: 0.35,
      length: 0,
      load: 0,
      steerAngle: 0,
      spin: 0,
      omega: 0,
      tire: createTireState(),
      isFront,
      isLeft,
      smoke: 0,
    });

    this.wheels.push(
      mk(halfTrackF, frontZ, frontR, true, false), // FR
      mk(-halfTrackF, frontZ, frontR, true, true), // FL
      mk(halfTrackR, rearZ, rearR, false, false), // RR
      mk(-halfTrackR, rearZ, rearR, false, true) // RL
    );
    for (let i = 0; i < 4; i++) this.tireTemps.push(0.5);

    this.state = {
      position: new THREE.Vector3(),
      heading: 0,
      pitch: 0,
      roll: 0,
      velocity: new THREE.Vector3(),
      yawRate: 0,
      forwardSpeed: 0,
      lateralSpeed: 0,
      verticalSpeed: 0,
      grounded: true,
      airborne: false,
      surfaceMu: 1,
      surfaceLabel: "舗装路",
      gear: 1,
      rpm: spec.engine.idle,
      steerAngle: 0,
      odometer: 0,
      gForce: { lateral: 0, longitudinal: 0 },
    };
  }

  get mass(): number {
    return this.spec.chassis.mass;
  }

  /** 前軸のローカル Z 位置(カメラ/ライト用) */
  get axleFront(): number {
    return this.wheels[0].local.z;
  }

  /** 後軸のローカル Z 位置 */
  get axleRear(): number {
    return this.wheels[2].local.z;
  }

  get wheelbase(): number {
    return this.wheelBase;
  }

  /** 車両の前方向ベクトル(XZ) */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.sin(this.state.heading), 0, Math.cos(this.state.heading));
  }

  get speedKmh(): number {
    return Math.abs(this.state.forwardSpeed) * 3.6;
  }

  get speedMs(): number {
    return this.state.forwardSpeed;
  }

  get position(): THREE.Vector3 {
    return this.state.position;
  }

  /** 操舵角の最大値(速度依存) */
  private get maxSteerRad(): number {
    const base = (this.spec.chassis.steerLock * Math.PI) / 180 * 0.5;
    const speedT = smoothstep(8, 65, Math.abs(this.state.forwardSpeed));
    return base * lerp(1, 0.32, speedT);
  }

  /** ヨーモーメントを生む「接地荷重の移動」を計算 */
  private transferLoads(dt: number, accelLong: number, accelLat: number): void {
    const m = this.mass;
    const h = this.spec.chassis.cgHeight;
    const wb = Math.max(0.5, this.wheelBase);
    const avgTrack = (this.trackF + this.trackR) * 0.5;
    // 前後: 加速で後輪へ、減速で前輪へ
    const longTransfer = (m * accelLong * h) / wb;
    // 左右: 横加速で外側へ
    const latTransfer = (m * accelLat * h) / Math.max(0.5, avgTrack);
    const front = Math.max(0, this.staticFrontLoad - longTransfer);
    const rear = Math.max(0, this.staticRearLoad + longTransfer);
    // 左右配分(右が正の横G)
    const rightBias = latTransfer * 0.5;
    const idxFrontRight = 0;
    const idxFrontLeft = 1;
    const idxRearRight = 2;
    const idxRearLeft = 3;
    this.wheels[idxFrontRight].load = Math.max(0, front * 0.5 - rightBias);
    this.wheels[idxFrontLeft].load = Math.max(0, front * 0.5 + rightBias);
    this.wheels[idxRearRight].load = Math.max(0, rear * 0.5 - rightBias);
    this.wheels[idxRearLeft].load = Math.max(0, rear * 0.5 + rightBias);
    void dt;
  }

  /**
   * 固定ステップで 1 回更新する。
   */
  step(input: VehicleInput, dt: number): void {
    const s = this.state;
    const spec = this.spec;
    const ch = spec.chassis;

    // --- 入力の平滑化 ---
    this.prevInput = { ...input };

    // --- 操舵角 ---
    let steerCmd = input.directSteer !== undefined ? input.directSteer : input.steer * this.maxSteerRad;
    // STM(カウンターステア補助)
    if (this.assists.counterSteer > 0.01 && Math.abs(s.forwardSpeed) > 6) {
      const slip = Math.atan2(s.lateralSpeed, Math.abs(s.forwardSpeed));
      if (Math.abs(slip) > 0.06) {
        const counter = -slip * this.assists.counterSteer * 1.4;
        steerCmd += clamp(counter, -0.28, 0.28);
      }
    }
    s.steerAngle = damp(s.steerAngle, steerCmd, 22, dt);

    // --- 路面情報 ---
    this.updateSurface();

    // --- 座標系の基底 ---
    const heading = s.heading;
    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);

    // 速度の分解
    const v = s.velocity;
    let vLong = v.x * fwdX + v.z * fwdZ;
    let vLat = v.x * rightX + v.z * rightZ;

    // --- サスペンション/接地 ---
    const ground = this.sampleGround(s.position.x, s.position.z);
    const wheelContacts = this.updateWheelContacts(s.position, heading, s.pitch, s.roll);
    const groundedCount = wheelContacts.filter((w) => w).length;

    s.grounded = groundedCount > 0;
    const airtime = groundedCount === 0;

    // --- 空力 ---
    const speed = Math.abs(vLong);
    const downforce = 0.5 * AIR_DENSITY * speed * speed * ch.frontalArea * Math.max(0, -ch.liftCoef);
    const dragForce = 0.5 * AIR_DENSITY * speed * speed * ch.dragCd * ch.frontalArea;
    const airResistance = -dragForce * Math.sign(vLong);

    // --- 駆動系 ---
    // 駆動輪のみの平均角速度を使う(非駆動輪に引きずられないように)
    let drivenSum = 0;
    let drivenCount = 0;
    for (const w of this.wheels) {
      const driven =
        spec.drive === "AWD" ||
        (spec.drive === "FF" && w.isFront) ||
        ((spec.drive === "FR" || spec.drive === "MR" || spec.drive === "RR") && !w.isFront);
      if (driven) {
        drivenSum += w.omega;
        drivenCount++;
      }
    }
    const wheelOmegaAvg = drivenCount > 0 ? drivenSum / drivenCount : vLong / Math.max(0.2, spec.dims.wheelRadiusRear);
    const drivetrainOut = this.drivetrain.update({
      throttle: input.throttle,
      shiftUp: input.shiftUp,
      shiftDown: input.shiftDown,
      speed: vLong,
      wheelOmega: Math.abs(wheelOmegaAvg),
      wheelRadius: spec.dims.wheelRadiusRear,
      auto: input.autoGear,
      dt,
      gradeResistance: Math.sin(s.pitch) * GRAVITY,
    });
    s.gear = drivetrainOut.gear;
    s.rpm = drivetrainOut.rpm;

    // ハンドブレーキ: 後輪をロック
    const handbrake = clamp01(input.handbrake);

    // --- 各輪のタイヤ力 ---
    let totalFx = 0;
    let totalFz = 0;
    let totalTorqueY = 0;

    const absActive = this.assists.abs > 0.01;
    const tcsActive = this.assists.tcs > 0.01;
    const stmActive = this.assists.stm > 0.01;
    let lockCount = 0;

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const isFront = w.isFront;
      const wheelRadius = isFront ? spec.dims.wheelRadiusFront : spec.dims.wheelRadiusRear;
      const grip = isFront ? ch.tireGripFront : ch.tireGripRear;
      w.steerAngle = s.steerAngle;

      // --- 接地点の速度(ヨー成分を含む) ---
      const relX = w.local.x;
      const relZ = w.local.z;
      const wx = v.x - s.yawRate * relZ;
      const wz = v.z + s.yawRate * relX;

      // --- 車輪の向き(ステア角を含む) ---
      const wheelHeading = heading + s.steerAngle * (isFront ? 1 : 0);
      const wfx = Math.sin(wheelHeading);
      const wfz = Math.cos(wheelHeading);
      const wrx = Math.cos(wheelHeading);
      const wrz = -Math.sin(wheelHeading);

      // --- 車輪座標系の速度 ---
      const wLong = wx * wfx + wz * wfz;
      const wLat = wx * wrx + wz * wrz;

      // --- 横方向: Pacejka(スリップ角) ---
      // 極低速ではスリップ角が発散するので車速でフェードさせる
      const speedFade = smoothstep(0.35, 2.4, Math.abs(wLong));
      const slipAngle = Math.atan2(wLat, Math.max(1.4, Math.abs(wLong))) * speedFade;

      // --- 垂直荷重 ---
      const downforceShare = downforce * (isFront ? ch.frontWeight : 1 - ch.frontWeight);
      const loaded = w.grounded && !airtime;
      const load = loaded ? Math.max(0, w.load + downforceShare) : 0;
      const mu = this.state.surfaceMu * grip;
      const maxF = mu * load;

      // 横力を求める(この時点ではスリップ比0で評価)
      updateTire(w.tire, slipAngle, 0, load, mu, dt, DEFAULT_PACEJKA, 0, 0);
      let fy = w.tire.fy;

      // STM: 横滑りを抑える(横力を足すのではなく、ヨーを落とす方向へ)
      if (stmActive && Math.abs(vLat) > 1.4 && loaded) {
        fy -= Math.sign(vLat) * maxF * 0.25 * this.assists.stm;
      }

      // --- 縦方向: 摩擦円で制限した準静的モデル ---
      //  車輪回転を状態として積分すると I=2.35 kg·m² / dt=1/120 では固有振動数が高すぎて発散する。
      //  ここでは駆動トルクを「力」に換算し、摩擦円の残容量でクリップする(ゲーム向けに安定)。
      const isDriven =
        spec.drive === "AWD" ||
        (spec.drive === "FF" && isFront) ||
        (spec.drive === "FR" && !isFront) ||
        (spec.drive === "MR" && !isFront) ||
        (spec.drive === "RR" && !isFront);
      let driveShare = 0;
      if (isDriven && loaded) {
        if (spec.drive === "AWD") {
          const frontShare = ch.driveBias;
          driveShare = isFront ? frontShare * 0.5 : (1 - frontShare) * 0.5;
        } else {
          driveShare = 0.5;
        }
      }

      // ブレーキトルク(前後配分 + ハンドブレーキ)
      let brakeTorqueVal = 0;
      if (input.brake > 0.02) brakeTorqueVal = ch.brakeTorque * input.brake * (isFront ? 0.62 : 0.38);
      if (!isFront && handbrake > 0.02) brakeTorqueVal += ch.handbrakeTorque * handbrake;
      if (absActive && brakeTorqueVal > 0 && Math.abs(vLong) > 3.5) {
        brakeTorqueVal *= lerp(1, 0.62, this.assists.abs);
      }

      // 駆動力(N)。リバースは負方向。
      let driveForce = (drivetrainOut.driveTorque * driveShare) / wheelRadius;
      if (this.drivetrain.gear < 0) driveForce = -Math.abs(driveForce);
      // TCS: 発生しうる駆動力が摩擦円を超える場合、あらかじめ絞る
      const driveCap = maxF * 0.92;
      if (tcsActive && Math.abs(driveForce) > driveCap && driveForce * vLong >= 0) {
        driveForce = lerp(driveForce, Math.sign(driveForce) * driveCap, this.assists.tcs);
      }

      // 要求縦力の合成(ブレーキが入っていれば制動が優先)
      let fxDemand = driveForce;
      const brakeForce = brakeTorqueVal / wheelRadius;
      if (brakeForce > 0.5) {
        if (Math.abs(wLong) > 0.45) fxDemand = -Math.sign(wLong) * brakeForce;
        else fxDemand = -wLong * 2600; // 停止保持(クリープ防止)
      }

      // 摩擦円: 横力分の余容量
      const latUsed = Math.min(1, Math.abs(fy) / Math.max(1, maxF));
      const capLong = maxF * Math.sqrt(Math.max(0, 1 - latUsed * latUsed));
      let fx = clamp(fxDemand, -capLong, capLong);
      // 横力と縦力の合成が摩擦円を超えないよう、横力を縮める
      const totalMag = Math.hypot(fx, fy);
      if (totalMag > maxF && totalMag > 1) {
        const k = maxF / totalMag;
        fx *= k;
        fy *= k;
      }
      const spinExcess = Math.abs(fxDemand) - capLong;

      // --- 車輪の回転(見た目・空転/ロック判定・エンジン回転の入力) ---
      const omegaRoll = wLong / Math.max(0.12, wheelRadius);
      if (spinExcess > 0 && loaded) {
        const excess = clamp(spinExcess / Math.max(1, capLong), 0, 3);
        const target = omegaRoll + Math.sign(fxDemand) * (3 + excess * 45);
        w.omega = lerp(w.omega, target, 1 - Math.exp(-13 * dt));
      } else if (brakeTorqueVal > 0.01 && Math.abs(wLong) > 0.4) {
        w.omega = lerp(w.omega, omegaRoll * 0.12, 1 - Math.exp(-24 * dt));
      } else {
        w.omega = lerp(w.omega, omegaRoll, 1 - Math.exp(-28 * dt));
      }
      if (Math.abs(w.omega) < 0.06 && input.throttle < 0.02) w.omega = 0;

      // タイヤ状態の更新(fx は上で決めた値を採用)
      w.tire.fx = fx;
      w.tire.fy = fy;
      w.tire.slipRatio = clamp((w.omega * wheelRadius - wLong) / Math.max(2.2, Math.abs(wLong)), -1.5, 1.5);
      w.tire.spinning = spinExcess > 0.02 && loaded;
      w.tire.locked = brakeTorqueVal > 0.01 && Math.abs(wLong) > 1.2 && Math.abs(w.omega * wheelRadius) < Math.abs(wLong) * 0.45;
      w.tire.slipAmount = clamp01(
        Math.max(Math.abs(w.tire.slipRatio) * 0.9, Math.abs(slipAngle) / 0.22 - 0.55)
      );
      // 熱・摩耗の積分(updateTire 内のロジックを簡易再現)
      const heat = w.tire.slipAmount * 2.4;
      const cooling = (w.tire.temperature - 0.35) * 0.55;
      w.tire.temperature = clamp01(w.tire.temperature + (heat - cooling) * dt * 0.35);
      w.tire.wear = clamp01(w.tire.wear + w.tire.slipAmount * dt * 0.0016 * (1 + w.tire.temperature));

      // --- 車体へ伝達 ---
      const worldX = fx * wfx + fy * wrx;
      const worldZ = fx * wfz + fy * wrz;
      const fwdComp = worldX * fwdX + worldZ * fwdZ;
      const latComp = worldX * rightX + worldZ * rightZ;
      if (loaded) {
        totalFx += fwdComp;
        totalFz += latComp;
        // ヨーモーメント: τ_y = r_z * F_lat - r_x * F_long
        totalTorqueY += relZ * latComp - relX * fwdComp;
      }

      w.smoke = clamp01((w.tire.slipAmount - 0.35) * 2.2);
      if (w.tire.locked) lockCount++;
      w.spin += w.omega * dt;
    }

    // --- 縦方向の力 ---
    // 勾配: 上り(前が高い=ピッチ負)では減速方向に働く
    const gradeForce = Math.sin(s.pitch) * this.mass * GRAVITY;
    const rolling = rollingResistance(this.mass * GRAVITY, vLong, 0.04);
    const engineBrakeForce = -Math.sign(vLong) * (1 - clamp01(input.throttle)) * Math.min(1400, Math.abs(vLong) * 78 * (this.drivetrain.gear / 6));
    const totalForceLong = totalFx + airResistance + gradeForce + engineBrakeForce - Math.sign(vLong) * rolling;
    if ((this as unknown as { _dbg?: number })._dbg === 1) {
      console.log("SUM", { totalFx: Math.round(totalFx), forceLong: Math.round(totalForceLong), accel: (totalForceLong / this.mass).toFixed(2), mass: this.mass, vLong: vLong.toFixed(2) });
    }

    // --- 横方向: 遠心力(ヨーの反作用) ---
    // 車体の横力はタイヤが担うが、旋回に伴う求心力は yawRate と速度から決まる
    const centripetal = this.mass * vLong * s.yawRate;

    // --- 加速度 ---
    const accelLong = totalForceLong / this.mass;
    let accelLat = (totalFz - centripetal) / this.mass;

    // 接地していない場合は重力のみ
    if (airtime) {
      accelLat = 0;
    }

    // 速度の更新
    vLong += accelLong * dt;
    vLat += accelLat * dt;
    // 横速度の自然減衰(タイヤの横剛性による)
    if (!airtime) {
      const latDamp = lerp(2.2, 0.35, smoothstep(0.5, 2.4, Math.abs(vLat) / Math.max(1, Math.abs(vLong))));
      vLat *= 1 - clamp01(latDamp * dt);
    }

    // 速度を再構成
    v.x = vLong * fwdX + vLat * rightX;
    v.z = vLong * fwdZ + vLat * rightZ;

    // 水平位置の積分(鉛直は接地判定側で解決する)
    s.position.x += v.x * dt;
    s.position.z += v.z * dt;

    // --- ヨー運動 ---
    // 慣性モーメント近似 I = m * (L² + W²) / 12
    const inertiaY = (this.mass * (spec.dims.length * spec.dims.length + spec.dims.width * spec.dims.width)) / 12;
    const yawAccel = totalTorqueY / inertiaY;
    s.yawRate += yawAccel * dt;
    // ヨー角速度の減衰(タイヤのグリップ)
    const yawDamp = airtime ? 0.4 : lerp(7.5, 2.6, smoothstep(0, 0.9, Math.abs(vLat) / Math.max(1, Math.abs(vLong))));
    s.yawRate *= 1 - clamp01(yawDamp * dt);
    s.yawRate = clamp(s.yawRate, -3.4, 3.4);

    // ステアによる追加ヨー(低速での切れ味)
    if (Math.abs(vLong) > 0.4 && groundedCount >= 2) {
      const steerYaw = (vLong / Math.max(1, this.wheelBase)) * Math.tan(s.steerAngle) * 0.8;
      // タイヤ力によるヨーを優先し、低速時のみ操舵角の運動学的な値を混ぜる
      const kinematicBlend = clamp01((4 - Math.abs(vLong)) / 4) * 0.6 + 0.1;
      s.yawRate = lerp(s.yawRate, steerYaw, clamp01(kinematicBlend * 9 * dt));
    }

    s.heading = wrapAngle(s.heading + s.yawRate * dt);

    // --- 鉛直方向(ジャンプ/接地) ---
    // 地面より下にいる場合は押し上げる
    if (this.terrain) {
      const clearance = this.groundClearance(s.position, s.heading);
      if (clearance < 0) {
        const impact = Math.abs(s.verticalSpeed);
        s.position.y -= clearance;
        if (impact > 3.5) this.lastImpact = impact;
        s.verticalSpeed = 0;
      }
    }
    if (airtime) {
      s.verticalSpeed -= GRAVITY * dt;
      s.position.y += s.verticalSpeed * dt;
      s.airborne = true;
    } else {
      // 接地している間は車体を地面に沿わせる。
      //  「最も低い車輪の接地点が地面に一致」するよう、残差をなめらかに詰める。
      if (this.terrain) {
        const clear = this.groundClearance(s.position, s.heading);
        s.position.y -= clear * clamp01(18 * dt);
      }
      s.verticalSpeed = 0;
      s.airborne = false;
    }

    // --- 姿勢(ピッチ/ロール) ---
    const gLat = vLong * s.yawRate;
    const targetPitch = this.computePitchFromGround();
    const targetRoll = this.computeRollFromGround() - clamp(gLat * 0.0075, -0.09, 0.09);
    s.pitch = damp(s.pitch, targetPitch, 7, dt);
    s.roll = damp(s.roll, targetRoll, 7, dt);

    // --- 状態の更新 ---
    s.velocity.copy(v);
    s.forwardSpeed = vLong;
    s.lateralSpeed = vLat;
    s.odometer += Math.abs(vLong) * dt;
    s.gForce.lateral = gLat / GRAVITY;
    s.gForce.longitudinal = accelLong / GRAVITY;
    this.driftAngle = Math.abs(Math.atan2(vLat, Math.max(1, Math.abs(vLong))));

    // 加速度(見た目のロール/ピッチ用)
    this.bodyAccel.lerp(
      new THREE.Vector3(accelLat / GRAVITY, accelLong / GRAVITY, 0),
      clamp01(dt * 8)
    );
    this.lastVelocity.copy(v);

    // タイヤ温度の同期
    for (let i = 0; i < 4; i++) this.tireTemps[i] = this.wheels[i].tire.temperature;

    // 接地荷重の移動(次フレーム用)
    this.transferLoads(dt, accelLong, gLat);

    // 衝突タイマー
    if (this.collisionTimer > 0) this.collisionTimer -= dt;
  }

  /** 路面情報の更新 */
  private updateSurface(): void {
    if (!this.roads || !this.terrain) {
      this.state.surfaceMu = 1;
      this.state.surfaceLabel = "舗装路";
      return;
    }
    const q = this.roads.nearest(this.state.position.x, this.state.position.z);
    this.roadQueryCache.grip = q.grip;
    this.roadQueryCache.y = q.y;
    // 路面種別ラベル
    if (q.road && q.onRoad) {
      const cls = q.road.style.cls;
      this.state.surfaceLabel =
        cls === "dirt" ? "ダート" : cls === "street" ? "市街" : cls === "mountain" ? "山道" : "舗装路";
      this.state.surfaceMu = q.grip;
    } else {
      // オフロード: 地形から推定
      const biome = this.terrain.biomeAt(this.state.position.x, this.state.position.z);
      const h = this.state.position.y - this.terrain.heightAt(this.state.position.x, this.state.position.z);
      if (h < 0.3 && this.terrain.heightAt(this.state.position.x, this.state.position.z) < 0.2) {
        this.state.surfaceLabel = "水";
        this.state.surfaceMu = 0.62;
      } else if (biome === "desert" || biome === "coast") {
        this.state.surfaceLabel = "砂";
        this.state.surfaceMu = 0.72;
      } else if (biome === "jungle" || biome === "wetland") {
        this.state.surfaceLabel = "草地";
        this.state.surfaceMu = 0.8;
      } else if (biome === "volcano") {
        this.state.surfaceLabel = "岩";
        this.state.surfaceMu = 0.82;
      } else {
        this.state.surfaceLabel = "草地";
        this.state.surfaceMu = 0.78;
      }
    }
  }

  /* --- 地形サンプリング --- */

  private sampleGround(x: number, z: number): { y: number; normal: THREE.Vector3 } {
    if (!this.terrain) return { y: 0, normal: UP_VEC };
    return { y: this.terrain.heightAt(x, z), normal: this.terrain.normalAt(x, z) };
  }

  /** 地面の高さだけを取る(毎フレーム4輪×2回呼ばれるので軽量版) */
  private groundHeightAt(x: number, z: number): number {
    if (!this.terrain) return 0;
    return this.terrain.heightAt(x, z);
  }

  private computePitchFromGround(): number {
    if (!this.terrain) return 0;
    const heading = this.state.heading;
    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);
    const d = 1.35;
    const hf = this.groundHeightAt(this.state.position.x + fwdX * d, this.state.position.z + fwdZ * d);
    const hb = this.groundHeightAt(this.state.position.x - fwdX * d, this.state.position.z - fwdZ * d);
    return -Math.atan2(hf - hb, d * 2);
  }

  private computeRollFromGround(): number {
    if (!this.terrain) return 0;
    const heading = this.state.heading;
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);
    const d = 0.9;
    const hr = this.groundHeightAt(this.state.position.x + rightX * d, this.state.position.z + rightZ * d);
    const hl = this.groundHeightAt(this.state.position.x - rightX * d, this.state.position.z - rightZ * d);
    return Math.atan2(hr - hl, d * 2);
  }

  /**
   * 車輪の接地点ローカル位置(x,z)をワールドへ変換する。
   * ここではヨー角のみを考慮する(ピッチ/ロールは見た目用の微小量なので無視)。
   */
  private wheelWorldPos(w: WheelState, pos: THREE.Vector3, heading: number): { x: number; z: number } {
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    return {
      x: pos.x + w.local.x * cos + w.local.z * sin,
      z: pos.z - w.local.x * sin + w.local.z * cos,
    };
  }

  /** 車輪の接地点(タイヤ底面)の高さ - 地面の高さ。正=浮いている、負=めり込んでいる */
  private contactGap(w: WheelState, pos: THREE.Vector3, heading: number, groundY: number): number {
    const radius = w.isFront ? this.spec.dims.wheelRadiusFront : this.spec.dims.wheelRadiusRear;
    return pos.y + w.local.y - radius - groundY;
  }

  /**
   * 4輪の接地判定とサスペンション状態の更新。
   * サスは「伸び切り長 EXTEND まで下がれる」と考え、接地点のギャップで接地を決める。
   */
  private updateWheelContacts(pos: THREE.Vector3, heading: number, pitch: number, roll: number): WheelState[] {
    const extend = 0.22;
    for (const w of this.wheels) {
      const radius = w.isFront ? this.spec.dims.wheelRadiusFront : this.spec.dims.wheelRadiusRear;
      const p = this.wheelWorldPos(w, pos, heading);
      const groundY = this.groundHeightAt(p.x, p.z);
      // バネ上の車体のロール/ピッチで各輪の高さが変わる
      const leverX = w.local.x;
      const leverZ = w.local.z;
      const tilt = leverX * Math.sin(roll) * 0.55 + leverZ * Math.sin(pitch) * 0.55;
      const gap = pos.y + w.local.y - radius + tilt - groundY;

      w.world.set(p.x, groundY, p.z);
      const grounded = gap <= extend;
      w.grounded = grounded;
      if (grounded) {
        w.compression = clamp01(1 - clamp01(gap / extend));
        w.length = Math.max(0.01, extend - gap);
      } else {
        w.compression = 0;
        w.length = extend;
      }
    }
    return this.wheels;
  }

  /** 最も低い車輪の接地点ギャップ(車体の目標高さを決める) */
  private groundClearance(pos: THREE.Vector3, heading: number): number {
    let minGap = Infinity;
    for (const w of this.wheels) {
      const radius = w.isFront ? this.spec.dims.wheelRadiusFront : this.spec.dims.wheelRadiusRear;
      const p = this.wheelWorldPos(w, pos, heading);
      const gap = pos.y + w.local.y - radius - this.groundHeightAt(p.x, p.z);
      if (gap < minGap) minGap = gap;
    }
    return minGap === Infinity ? 0 : minGap;
  }

  /** 位置を直接設定(スポーン/リセット) */
  teleport(x: number, z: number, heading: number): void {
    this.state.position.set(x, this.groundHeightAt(x, z), z);
    this.state.heading = wrapAngle(heading);
    this.state.velocity.set(0, 0, 0);
    this.state.yawRate = 0;
    this.state.steerAngle = 0;
    this.state.pitch = 0;
    this.state.roll = 0;
    this.state.forwardSpeed = 0;
    this.state.lateralSpeed = 0;
    for (const w of this.wheels) {
      w.omega = 0;
      w.spin = 0;
    }
    this.drivetrain.reset();
  }

  /** 速度ゼロは危険なので、コース上に戻す */
  rescue(): void {
    if (!this.roads) return;
    const q = this.roads.nearest(this.state.position.x, this.state.position.z);
    if (q.road) {
      const p = q.road.pointAt(q.s, 0);
      // 進行方向へ向ける
      this.teleport(p.x, p.z, q.heading);
    } else {
      this.teleport(this.state.position.x, this.state.position.z, this.state.heading);
    }
  }

  /** 衝突を適用(位置の押し戻しと速度反射) */
  applyCollision(normal: THREE.Vector3, penetration: number, restitution = 0.35): number {
    const v = this.state.velocity;
    const vn = v.dot(normal);
    if (vn >= 0) return 0;
    const impact = Math.abs(vn);
    v.addScaledVector(normal, -vn * (1 + restitution));
    this.state.position.addScaledVector(normal, penetration + 0.02);
    this.state.yawRate *= 0.6;
    // 速度の減少
    v.multiplyScalar(0.82);
    this.lastImpact = impact;
    this.collisionTimer = 0.4;
    return impact;
  }

  get impactStrength(): number {
    return this.lastImpact;
  }

  clearImpact(): void {
    this.lastImpact = 0;
  }

  /** タイヤが滑っている量(0..1, 音/煙用) */
  get slipAmount(): number {
    let s = 0;
    for (const w of this.wheels) s += w.tire.slipAmount;
    return s / 4;
  }

  /** ドリフト角(rad) */
  get driftAngleRad(): number {
    return this.driftAngle;
  }

  get isDrifting(): boolean {
    return this.driftAngle > 0.14 && Math.abs(this.state.forwardSpeed) > 8;
  }

  /** 表示用の速度(km/h) */
  get displaySpeed(): number {
    return Math.abs(this.state.forwardSpeed) * 3.6;
  }

  /** 現在のサスペンション状態(見た目用) */
  get suspensionVisual(): { pitch: number; roll: number; frontComp: number; rearComp: number } {
    const front = (this.wheels[0].compression + this.wheels[1].compression) * 0.5;
    const rear = (this.wheels[2].compression + this.wheels[3].compression) * 0.5;
    return {
      pitch: this.state.pitch + (front - rear) * 0.06,
      roll: this.state.roll + (this.wheels[0].compression - this.wheels[1].compression) * 0.05,
      frontComp: front,
      rearComp: rear,
    };
  }

  /** マシンの状態をまとめて取得(UI/音用) */
  get telemetry() {
    return {
      speedKmh: this.speedKmh,
      rpm: this.state.rpm,
      gear: this.state.gear,
      throttle: this.prevInput.throttle,
      brake: this.prevInput.brake,
      steer: this.prevInput.steer,
      lateralG: this.state.gForce.lateral,
      longitudinalG: this.state.gForce.longitudinal,
      slip: this.slipAmount,
      drifting: this.isDrifting,
      driftAngle: this.driftAngle * (180 / Math.PI),
      grounded: this.state.grounded,
      surface: this.state.surfaceLabel,
      surfaceMu: this.state.surfaceMu,
      odometerKm: this.state.odometer / 1000,
      tireTemp: this.tireTemps,
      gearLabel: this.state.gear === 0 ? "N" : this.state.gear < 0 ? "R" : String(this.state.gear),
    };
  }
}

export function createVehicle(spec: CarSpec, terrain?: Terrain, roads?: RoadNetwork): Vehicle {
  return new Vehicle(spec, terrain, roads);
}

export { TAU };
