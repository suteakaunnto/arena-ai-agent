/**
 * systems/Camera.ts
 * 責務: チェイス/ボンネット/コックピット/シネマ/フォトのカメラワーク、速度に応じた FOV と揺れ
 * 公開API: CameraRig, CameraMode
 * 依存: three, physics/Vehicle.ts, world/Terrain.ts, core/math.ts
 */
import * as THREE from "three";
import { Vehicle } from "../physics/Vehicle.js";
import { Terrain } from "../world/Terrain.js";
import { clamp, clamp01, damp, lerp, smoothstep, wrapAngle, DEG2RAD } from "../core/math.js";

export type CameraMode = "chase" | "hood" | "cockpit" | "cinematic" | "photo";

export const CAMERA_MODES: Array<{ id: CameraMode; name: string; description: string }> = [
  { id: "chase", name: "チェイス", description: "車の後方からの標準視点。速度で距離と画角が変化。" },
  { id: "hood", name: "ボンネット", description: "ボンネット先端の低い視点。速度感が最も強い。" },
  { id: "cockpit", name: "コックピット", description: "運転席から。ハンドルとダッシュボードが見える。" },
  { id: "cinematic", name: "シネマ", description: "自動で切り替わる映画的なカメラ。" },
  { id: "photo", name: "フォト", description: "自由に動かせる撮影用カメラ。" },
];

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = "chase";
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private shake = 0;
  private shakeOffset = new THREE.Vector3();
  private cineTimer = 0;
  private cineAngle = 0;
  private cineDist = 9;
  private cineHeight = 2.2;
  private photoTarget = new THREE.Vector3();
  private orbit = { yaw: 0, pitch: 0.18, dist: 8 };
  private lookBackFactor = 0;
  private terrain: Terrain | null;
  private baseFov = 62;
  /** 追従の遅れ(大きいほど機敏) */
  private chaseLambda = 6.5;

  constructor(camera: THREE.PerspectiveCamera, terrain?: Terrain) {
    this.camera = camera;
    this.terrain = terrain ?? null;
  }

  setTerrain(t: Terrain): void {
    this.terrain = t;
  }

  cycle(): CameraMode {
    const order: CameraMode[] = ["chase", "hood", "cockpit", "cinematic"];
    const i = order.indexOf(this.mode);
    this.mode = order[(i + 1) % order.length];
    return this.mode;
  }

  setMode(m: CameraMode): void {
    this.mode = m;
    if (m === "cinematic") this.cineTimer = 0;
  }

  /** 画面揺れを追加(衝突・段差) */
  addShake(v: number): void {
    this.shake = Math.min(1.2, this.shake + v);
  }

  setLookBack(v: boolean): void {
    this.lookBackFactor = v ? 1 : 0;
  }

  /** フォトモードの操作 */
  photoOrbit(dx: number, dy: number, zoom: number): void {
    this.orbit.yaw -= dx * 0.005;
    this.orbit.pitch = clamp(this.orbit.pitch + dy * 0.004, -0.4, 1.2);
    this.orbit.dist = clamp(this.orbit.dist * (1 + zoom * 0.0016), 2.2, 42);
  }

  /**
   * 毎フレーム更新
   */
  update(vehicle: Vehicle, dt: number, lookBack = false): void {
    const s = vehicle.state;
    const speed = Math.abs(s.forwardSpeed);
    const speedNorm = clamp01(speed / 90);

    // 揺れの減衰
    this.shake = damp(this.shake, 0, 3.2, dt);
    const vibration = speedNorm * 0.012 + vehicle.slipAmount * 0.02;
    this.shakeOffset.set(
      (Math.random() - 0.5) * (this.shake * 0.35 + vibration),
      (Math.random() - 0.5) * (this.shake * 0.28 + vibration),
      (Math.random() - 0.5) * (this.shake * 0.2 + vibration * 0.6)
    );

    const heading = s.heading + (lookBack ? Math.PI : 0);

    if (this.mode === "chase") {
      const dist = lerp(7.4, 5.6, smoothstep(0, 1, speedNorm)) + (vehicle.isDrifting ? 1.1 : 0);
      const height = lerp(2.55, 1.95, smoothstep(0, 1, speedNorm));
      // 進行方向ではなく「車の向き + 少し横滑り方向」を見る
      const driftBias = clamp(-s.lateralSpeed * 0.06, -0.5, 0.5);
      const targetHeading = heading + driftBias;
      const desired = new THREE.Vector3(
        s.position.x - Math.sin(targetHeading) * dist,
        s.position.y + height,
        s.position.z - Math.cos(targetHeading) * dist
      );
      // 地形にめり込まないように
      if (this.terrain) {
        const gy = this.terrain.heightAt(desired.x, desired.z) + 0.9;
        if (desired.y < gy) desired.y = gy;
      }
      this.pos.lerp(desired, clamp01(dt * this.chaseLambda * (0.6 + speedNorm * 0.8)));
      const lookTarget = new THREE.Vector3(
        s.position.x + Math.sin(heading) * 5.2,
        s.position.y + 1.05,
        s.position.z + Math.cos(heading) * 5.2
      );
      this.look.lerp(lookTarget, clamp01(dt * 9));
      this.baseFov = lerp(62, 76, Math.pow(speedNorm, 1.4));
    } else if (this.mode === "hood") {
      const fz = vehicle.axleFront;
      const p = new THREE.Vector3(
        s.position.x + Math.sin(heading) * fz,
        s.position.y + 0.98,
        s.position.z + Math.cos(heading) * fz
      );
      this.pos.copy(p);
      this.look.set(
        p.x + Math.sin(heading) * 30,
        p.y - 0.6 + s.pitch * 8,
        p.z + Math.cos(heading) * 30
      );
      this.baseFov = lerp(68, 82, Math.pow(speedNorm, 1.2));
    } else if (this.mode === "cockpit") {
      const fz = vehicle.axleFront - vehicle.wheelbase * 0.5 + 0.18;
      const p = new THREE.Vector3(
        s.position.x + Math.sin(heading) * fz - Math.sin(heading + Math.PI / 2) * 0.34,
        s.position.y + 1.14,
        s.position.z + Math.cos(heading) * fz - Math.cos(heading + Math.PI / 2) * 0.34
      );
      this.pos.copy(p);
      this.look.set(
        p.x + Math.sin(heading) * 30,
        p.y - 0.35 + s.pitch * 10,
        p.z + Math.cos(heading) * 30
      );
      this.baseFov = lerp(70, 80, speedNorm);
    } else if (this.mode === "cinematic") {
      this.cineTimer += dt;
      if (this.cineTimer > 6.5) {
        this.cineTimer = 0;
        this.cineAngle = Math.random() * Math.PI * 2;
        this.cineDist = 7 + Math.random() * 9;
        this.cineHeight = 1.2 + Math.random() * 3.4;
      }
      const a = this.cineAngle + Math.sin(this.cineTimer * 0.35) * 0.35;
      const desired = new THREE.Vector3(
        s.position.x + Math.cos(a) * this.cineDist,
        s.position.y + this.cineHeight,
        s.position.z + Math.sin(a) * this.cineDist
      );
      if (this.terrain) {
        const gy = this.terrain.heightAt(desired.x, desired.z) + 0.7;
        if (desired.y < gy) desired.y = gy;
      }
      this.pos.lerp(desired, clamp01(dt * 3.2));
      this.look.lerp(new THREE.Vector3(s.position.x, s.position.y + 0.8, s.position.z), clamp01(dt * 5));
      this.baseFov = 46;
    } else {
      // photo
      const target = new THREE.Vector3(s.position.x, s.position.y + 0.7, s.position.z);
      this.photoTarget.lerp(target, clamp01(dt * 6));
      const cp = Math.cos(this.orbit.pitch);
      const desired = new THREE.Vector3(
        this.photoTarget.x + Math.sin(this.orbit.yaw) * this.orbit.dist * cp,
        this.photoTarget.y + Math.sin(this.orbit.pitch) * this.orbit.dist,
        this.photoTarget.z + Math.cos(this.orbit.yaw) * this.orbit.dist * cp
      );
      this.pos.lerp(desired, clamp01(dt * 8));
      this.look.copy(this.photoTarget);
      this.baseFov = 42;
    }

    this.camera.position.copy(this.pos).add(this.shakeOffset);
    // 車体のロール/ピッチをわずかに反映
    this.camera.up.set(0, 1, 0);
    if (this.mode === "chase" || this.mode === "cinematic") {
      this.camera.up.set(Math.sin(-s.roll * 0.35), 1, Math.cos(-s.roll * 0.35)).normalize();
    }
    this.camera.lookAt(this.look);

    // FOV を滑らかに
    const targetFov = this.baseFov;
    this.camera.fov = damp(this.camera.fov, targetFov, 4, dt);
    this.camera.updateProjectionMatrix();

    // 地球の丸みに沿った「地平線」を保つため、遠い平面は fog に任せる
    this.camera.near = this.mode === "cockpit" ? 0.12 : 0.35;
    this.camera.far = 16000;
  }

  /** 振り向き(ルックバック)を滑らかに */
  updateLookBack(target: boolean, dt: number): void {
    this.lookBackFactor = damp(this.lookBackFactor, target ? 1 : 0, 10, dt);
  }

  snap(vehicle: Vehicle): void {
    const s = vehicle.state;
    this.pos.set(
      s.position.x - Math.sin(s.heading) * 7.4,
      s.position.y + 2.55,
      s.position.z - Math.cos(s.heading) * 7.4
    );
    this.look.set(
      s.position.x + Math.sin(s.heading) * 5,
      s.position.y + 1,
      s.position.z + Math.cos(s.heading) * 5
    );
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}

export { wrapAngle, DEG2RAD };
