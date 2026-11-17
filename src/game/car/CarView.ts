/**
 * car/CarView.ts
 * 責務: CarSpec + 物理状態 → Three.js の車オブジェクト。ボディ/ガラス/灯火/ホイール/内装を組み立て、
 *       サス連動・ステア・ブレーキ発光・ダメージを毎フレーム反映する
 * 公開API: CarView, CarViewOptions
 * 依存: car/geometry/*, car/materials/CarMaterials.ts, physics/Vehicle.ts, car/spec/CarSpec.ts
 *
 * 設計メモ:
 *  - メッシュ生成は build() で 1 回だけ。以降は transform のみ(負荷を抑える)。
 *  - ホイールは物理のサス圧縮量から Y 位置を、ステア角から Y 回転を与える。
 *  - ブレーキランプは「ブレーキ入力」と「減速G」の両方で点灯(実際の車に近い)。
 *  - ダメージはバンパー/フェンダーの頂点をシェーダではなくメッシュ変形で表現(簡易)。
 */
import * as THREE from "three";
import { CarSpec } from "./spec/CarSpec.js";
import { CarMaterialLibrary } from "./materials/CarMaterials.js";
import { buildBody, BodyParts } from "./geometry/BodyBuilder.js";
import { buildGlass, buildLights, buildMirrors, buildDetails, LightParts } from "./geometry/GlassAndLamps.js";
import { buildWheel, WheelAssembly } from "./geometry/Wheels.js";
import { countTriangles } from "./geometry/Loft.js";
import { Vehicle } from "../physics/Vehicle.js";
import { clamp, clamp01, lerp, damp, smoothstep } from "../core/math.js";

export interface CarViewOptions {
  quality?: number;
  showDriver?: boolean;
  isPlayer?: boolean;
}

export interface CarViewStats {
  triangles: number;
  meshes: number;
}

export class CarView {
  readonly root = new THREE.Group();
  readonly spec: CarSpec;
  readonly mats: CarMaterialLibrary;
  readonly body: BodyParts;
  readonly lights: LightParts;
  readonly wheels: WheelAssembly[] = [];
  private quality: number;
  private headlightSpot: THREE.SpotLight | null = null;
  private headlightTarget = new THREE.Object3D();
  private tailGlow: THREE.PointLight | null = null;
  private brakeLevel = 0;
  private indicatorPhase = 0;
  private indicatorOn = false;
  private damage = 0;
  private stats: CarViewStats = { triangles: 0, meshes: 0 };
  private bodyGroup = new THREE.Group();
  private spinGroups: THREE.Group[] = [];
  private headGroup = new THREE.Group();

  constructor(spec: CarSpec, mats: CarMaterialLibrary, options: CarViewOptions = {}) {
    this.spec = spec;
    this.mats = mats;
    this.quality = options.quality ?? 2;
    this.root.name = `car_${spec.id}`;

    this.body = buildBody(spec, mats, this.quality);
    this.bodyGroup.add(this.body.group);
    this.root.add(this.bodyGroup);

    const glass = buildGlass(spec, this.body.sections, mats);
    this.bodyGroup.add(glass.all);

    this.lights = buildLights(spec, this.body.sections, mats);
    this.bodyGroup.add(this.lights.group);

    this.bodyGroup.add(buildMirrors(spec, this.body.sections, mats, this.body.paint));
    this.bodyGroup.add(buildDetails(spec, this.body.sections, mats, this.body.paint));

    // ホイール
    const halfTrackF = spec.chassis.trackFront * 0.5;
    const halfTrackR = spec.chassis.trackRear * 0.5;
    const positions: Array<[number, number, boolean, boolean]> = [
      [halfTrackF, this.body.axles.frontZ, true, false],
      [-halfTrackF, this.body.axles.frontZ, true, true],
      [halfTrackR, this.body.axles.rearZ, false, false],
      [-halfTrackR, this.body.axles.rearZ, false, true],
    ];
    for (const [x, z, isFront, mirror] of positions) {
      const w = buildWheel(spec, mats, isFront, mirror, this.quality);
      w.group.position.set(x, spec.dims.wheelRadiusFront, z);
      this.root.add(w.group);
      this.wheels.push(w);
    }

    // ヘッドライトのスポット(夜間のみ有効)
    this.headlightSpot = new THREE.SpotLight(0xfff2dc, 0, 95, Math.PI / 6.2, 0.45, 1.2);
    this.headlightSpot.position.set(0, this.body.cabin.topY * 0.55, this.body.axles.frontZ + 0.4);
    this.headlightSpot.castShadow = false;
    this.headlightTarget.position.set(0, -0.4, this.body.axles.frontZ + 22);
    this.headlightSpot.target = this.headlightTarget;
    this.headGroup.add(this.headlightSpot, this.headlightTarget);
    this.root.add(this.headGroup);

    // テールのグロー(夜間用)
    this.tailGlow = new THREE.PointLight(0xff2a10, 0, 4.5, 2);
    this.tailGlow.position.set(0, this.body.cabin.topY * 0.45, -spec.dims.length * 0.5 - 0.1);
    this.root.add(this.tailGlow);

    this.stats.triangles = countTriangles(this.root);
    let meshes = 0;
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    this.stats.meshes = meshes;
  }

  get triangleCount(): number {
    return this.stats.triangles;
  }

  get meshCount(): number {
    return this.stats.meshes;
  }

  /** 塗装色の変更(ガレージ用) */
  setPaintColor(color: number): void {
    this.body.paint.color.set(color);
    this.spec.colors[0] = color;
  }

  /** 塗装の仕上げ変更 */
  setFinish(finish: CarSpec["finish"]): void {
    this.spec.finish = finish;
  }

  /** 夜間のライト点灯 */
  setLightsOn(on: boolean, intensity = 1): void {
    const s = this.lights;
    s.headMaterial.emissiveIntensity = on ? 6.5 * intensity : 0.05;
    s.headMaterial.emissive.setHex(on ? this.spec.lights.headColor : 0x111111);
    s.headMaterial.color.setHex(on ? this.spec.lights.headColor : 0x2a2a2e);
    if (this.headlightSpot) this.headlightSpot.intensity = on ? 5.2 * intensity : 0;
    s.tailMaterial.emissiveIntensity = on ? 1.9 : 0.45;
    if (this.tailGlow) this.tailGlow.intensity = on ? 1.1 : 0;
  }

  /** ブレーキランプ */
  setBrake(level: number): void {
    this.brakeLevel = clamp01(level);
    const s = this.lights;
    s.brakeMaterial.emissiveIntensity = lerp(0.05, 7.5, this.brakeLevel);
    s.brakeMaterial.color.setHex(this.brakeLevel > 0.05 ? 0xff1a10 : 0x3a0a08);
    if (this.tailGlow) {
      this.tailGlow.intensity = Math.max(this.tailGlow.intensity * 0.9, this.brakeLevel * 2.2);
    }
  }

  /** ウィンカー */
  setIndicator(on: boolean, dt: number): void {
    this.indicatorOn = on;
    if (!on) {
      this.lights.indicatorMaterial.emissiveIntensity = 0.05;
      return;
    }
    this.indicatorPhase += dt * 3.4;
    const blink = Math.sin(this.indicatorPhase * Math.PI) > 0;
    this.lights.indicatorMaterial.emissiveIntensity = blink ? 5.5 : 0.05;
    this.lights.indicatorMaterial.emissive.setHex(0xff8c1a);
  }

  /** リバースランプ */
  setReverse(on: boolean): void {
    this.lights.reverseMaterial.emissiveIntensity = on ? 3.2 : 0.05;
  }

  /** ダメージ表現(0..1) */
  applyDamage(amount: number): void {
    const d = clamp01(amount);
    if (Math.abs(d - this.damage) < 0.01) return;
    this.damage = d;
    // ボディ全体をわずかに歪ませる(バンパーの凹み)
    const cap = this.body.group.getObjectByName("bumper_front") as THREE.Mesh | undefined;
    if (cap) {
      cap.scale.set(1 - d * 0.06, 1 - d * 0.03, 1);
      cap.position.z = -d * 0.05;
    }
    const rear = this.body.group.getObjectByName("bumper_rear") as THREE.Mesh | undefined;
    if (rear) {
      rear.scale.set(1 - d * 0.04, 1 - d * 0.02, 1);
      rear.position.z = d * 0.04;
    }
  }

  /**
   * 物理状態を反映する。毎フレーム呼ぶ。
   */
  sync(vehicle: Vehicle, dt: number, opts: { night?: boolean; lightsOn?: boolean; wetness?: number; dust?: number } = {}): void {
    const s = vehicle.state;
    this.root.position.copy(s.position);

    // 姿勢(ヨー/ピッチ/ロール)
    const vis = vehicle.suspensionVisual;
    this.root.rotation.set(0, 0, 0);
    this.root.rotation.y = s.heading;
    // 車体だけを傾ける(ホイールは地面に接地させる)
    this.bodyGroup.rotation.x = -s.pitch;
    this.bodyGroup.rotation.z = -s.roll;

    // サスペンションの沈み込みで車高を微調整
    const sag = (vis.frontComp * 0.02 + vis.rearComp * 0.02) * 0.5;
    this.bodyGroup.position.y = -sag;

    // ホイール
    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i];
      const view = this.wheels[i];
      view.group.position.y = view.radius - w.compression * 0.055;
      view.group.rotation.y = w.isFront ? -s.steerAngle : 0;
      view.spin.rotation.x = w.spin;
      // ブレーキディスクの発熱
      const heat = clamp01((w.tire.temperature - 0.6) * 2.4);
      view.discMaterial.emissive.setRGB(heat * 0.9, heat * 0.18, 0);
      view.discMaterial.emissiveIntensity = heat * 1.8;
    }

    // 灯火
    const night = opts.night ?? false;
    this.setLightsOn(!!opts.lightsOn, night ? 1 : 0.8);
    // ブレーキ: 入力 + 実減速
    const decel = Math.max(0, -s.gForce.longitudinal);
    this.setBrake(Math.abs(s.forwardSpeed) > 1 ? clamp01(decel * 1.8) : 0);
    this.setReverse(s.forwardSpeed < -0.5);

    // ウィンカー(ステア入力が大きいとき)
    const steeringHard = Math.abs(s.steerAngle) > 0.32 && Math.abs(s.forwardSpeed) > 4;
    this.setIndicator(steeringHard && Math.sin(performance.now() * 0.004) > 0.4, dt);

    // ダメージ(衝突の強さ)
    if (vehicle.impactStrength > 0) {
      this.applyDamage(clamp01(this.damage + vehicle.impactStrength * 0.02));
    }

    // 汚れ・濡れ
    this.mats.updateWeather({ wetness: opts.wetness ?? 0, dust: opts.dust ?? 0 }, this.body.paint);
  }

  /** 明示的にブレーキランプを点ける(物理と独立) */
  updateBrakeLights(brakeInput: number): void {
    this.setBrake(brakeInput);
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const g = m.geometry as THREE.BufferGeometry;
        if (g && !(g as THREE.BufferGeometry & { __shared?: boolean }).__shared) g.dispose();
      }
    });
    this.headlightSpot?.dispose();
    this.tailGlow?.dispose();
  }
}

/** 車のシルエットから影用のテクスチャを生成(接地影) */
export function makeBlobShadowTexture(size = 128): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, "rgba(0,0,0,0.62)");
  g.addColorStop(0.55, "rgba(0,0,0,0.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export { clamp, lerp, damp, smoothstep };
