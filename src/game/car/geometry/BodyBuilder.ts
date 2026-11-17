/**
 * car/geometry/BodyBuilder.ts
 * 責務: 断面セクションから車体パネル群(ボンネット/ドア/ルーフ/フェンダー/バンパー)を組み立てる
 * 公開API: BodyBuilder, BodyParts
 * 依存: three, car/geometry/Loft.ts, car/spec/CarSpec.ts, car/materials/CarMaterials.ts
 *
 * 設計メモ:
 *  - 帯(floor/lower/upper/top)ごとに独立メッシュを作り、パネルギャップを t 方向の切り分けで表現。
 *  - 前後はキャップ(バンパー面)、下は床、キャビン部には別途ガラスを載せる。
 *  - フェンダーの張り出しは変形関数で外側へ押し出す。
 *  - 全体の三角形数は spec.profile.sections で調整可能(設計書の LOD と対応)。
 */
import * as THREE from "three";
import { CarSpec } from "../spec/CarSpec.js";
import {
  buildSections,
  SectionFrame,
  loftStrip,
  loftCap,
  sectionAt,
  halfSectionPoint,
  makeArchDeformer,
  S_BANDS,
} from "./Loft.js";
import { CarMaterialLibrary } from "../materials/CarMaterials.js";
import { clamp, clamp01, lerp, smoothstep } from "../../core/math.js";

export interface BodyParts {
  group: THREE.Group;
  /** 塗装対象のマテリアル(1台ごとに独立) */
  paint: THREE.MeshPhysicalMaterial;
  sections: SectionFrame[];
  /** ホイール位置(ローカル座標) */
  axles: { frontZ: number; rearZ: number };
  /** ガラス面の情報 */
  cabin: { frontZ: number; rearZ: number; topY: number };
  triangles: number;
}

/** 軸位置を計算(オーバーハング比から) */
export function computeAxles(spec: CarSpec): { frontZ: number; rearZ: number } {
  const L = spec.dims.length;
  const wb = spec.chassis.wheelbase;
  const p = spec.profile;
  // 前後のオーバーハング比を正規化
  const fo = p.frontOverhang;
  const ro = p.rearOverhang;
  const total = fo + ro;
  const overhangSum = Math.max(0.05, L - wb);
  const frontOver = (fo / total) * overhangSum;
  const rearOver = overhangSum - frontOver;
  const rearZ = -L * 0.5 + rearOver;
  const frontZ = rearZ + wb;
  return { frontZ: Math.min(frontZ, L * 0.5 - 0.2), rearZ };
}

/**
 * 車体を組み立てる
 * @param quality 0=LOD2(簡略) 1=LOD1 2=LOD0(高精細)
 */
export function buildBody(spec: CarSpec, mats: CarMaterialLibrary, quality = 2): BodyParts {
  const group = new THREE.Group();
  group.name = "body";

  const sectionCount = quality >= 2 ? spec.profile.sections : quality === 1 ? Math.max(16, Math.round(spec.profile.sections * 0.5)) : 12;
  const sSeg = quality >= 2 ? [4, 8, 8, 4] : quality === 1 ? [3, 5, 5, 3] : [2, 3, 3, 2];
  const sections = buildSections(spec, sectionCount);
  const axles = computeAxles(spec);

  // 塗装色
  const baseColor = new THREE.Color(spec.colors[0]);
  const pearl = new THREE.Color(spec.colors[0]).offsetHSL(0.08, 0.05, 0.12);
  const paint = mats.createPaint({
    color: baseColor,
    finish: spec.finish,
    metallic: 0.5,
    roughness: 0.3,
    clearcoatRoughness: 0.05,
    flakeScale: 1500,
    flakeStrength: 0.4,
    peel: 0.0025,
    pearlColor: pearl,
    pearlStrength: 0.5,
  });

  const wheelR = (spec.dims.wheelRadiusFront + spec.dims.wheelRadiusRear) * 0.5;
  const archRadius = wheelR * 1.16;
  const archDepth = (spec.dims.width * 0.5) * 0.13;
  const deformer = makeArchDeformer([
    { z: axles.frontZ, radius: wheelR, archRadius, depth: archDepth },
    { z: axles.rearZ, radius: wheelR, archRadius, depth: archDepth },
  ]);

  // フェンダーの張り出し(ホイール付近を外へ)
  const flare = spec.profile.fenderFlare * spec.dims.width;
  const flareDeform = (p: THREE.Vector3, t: number, s: number) => {
    if (s < 0.3 || s > 0.8) return;
    if (s < 0.34 || s > 0.74) return;
    const z = p.z;
    const near = Math.max(
      Math.exp(-Math.pow((z - axles.frontZ) / 0.62, 2)),
      Math.exp(-Math.pow((z - axles.rearZ) / 0.68, 2))
    );
    if (near < 0.01) return;
    const k = Math.min(1, near);
    const side = Math.sign(p.x) || 1;
    p.x += side * flare * k * smoothstep(0.3, 0.44, s) * (1 - smoothstep(0.66, 0.8, s));
  };

  const combined = (p: THREE.Vector3, t: number, s: number) => {
    flareDeform(p, t, s);
    deformer(p, t, s);
  };

  let tris = 0;

  // 4本の帯を左右それぞれ生成
  for (let b = 0; b < S_BANDS.length; b++) {
    const [s0, s1] = S_BANDS[b];
    for (const mirror of [false, true]) {
      const geom = loftStrip(sections, {
        s0,
        s1,
        segments: sSeg[b],
        mirror,
        deform: combined,
        // 帯の境目に微小なギャップ(パネル線)を入れる
        insetStart: 0,
        insetEnd: 0,
      });
      const mesh = new THREE.Mesh(geom, paint);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `panel_${["floor", "lower", "upper", "top"][b]}_${mirror ? "L" : "R"}`;
      group.add(mesh);
      tris += geom.index!.count / 3;
    }
  }

  // 前後キャップ
  for (const front of [true, false]) {
    const capGeom = loftCap(sections, front, quality >= 2 ? 22 : 12, 0.05);
    const cap = new THREE.Mesh(capGeom, paint);
    cap.castShadow = true;
    cap.receiveShadow = true;
    cap.name = front ? "bumper_front" : "bumper_rear";
    group.add(cap);
    tris += capGeom.index!.count / 3;
  }

  // パネルギャップ(細い暗いライン)
  const gapMat = mats.plastic(0x0a0a0c, 0.9);
  const gapZList: number[] = [];
  // ドアの切れ目(キャビンの前後)
  const cabinFrontT = spec.profile.cabinStart - 0.02;
  const cabinRearT = spec.profile.cabinEnd + 0.02;
  gapZList.push(sectionAt(sections, cabinFrontT).z, sectionAt(sections, cabinRearT).z);
  // ボンネットの切れ目
  if (quality >= 2) {
    const hoodT = Math.min(0.94, spec.profile.cabinStart + 0.06);
    gapZList.push(sectionAt(sections, hoodT).z);
  }
  for (const z of gapZList) {
    const t = (z + spec.dims.length * 0.5) / spec.dims.length;
    const sec = sectionAt(sections, clamp01(t));
    for (const mirror of [false, true]) {
      // 側面の縦線
      const pts: THREE.Vector3[] = [];
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const s = lerp(0.27, 0.83, i / steps);
        const p = halfSectionPoint(sec, s);
        pts.push(new THREE.Vector3(mirror ? -p.x * 1.002 : p.x * 1.002, p.y, z));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.TubeGeometry(curve, steps, 0.004, 3, false);
      const line = new THREE.Mesh(tube, gapMat);
      line.castShadow = false;
      group.add(line);
      tris += tube.index!.count / 3;
    }
  }

  // 床下(シャドウ用の暗い面)
  if (quality >= 2) {
    const under = loftStrip(sections, {
      s0: 0,
      s1: 0.16,
      segments: 4,
      deform: combined,
    });
    const underMesh = new THREE.Mesh(under, mats.plastic(0x141416, 0.9));
    underMesh.receiveShadow = true;
    group.add(underMesh);
    tris += under.index!.count / 3;
  }

  const cabinFrontZ = sectionAt(sections, spec.profile.cabinStart).z;
  const cabinRearZ = sectionAt(sections, spec.profile.cabinEnd).z;
  const topY = sectionAt(sections, 1).centerTopY;

  return {
    group,
    paint,
    sections,
    axles,
    cabin: { frontZ: cabinFrontZ, rearZ: cabinRearZ, topY },
    triangles: Math.round(tris),
  };
}

/**
 * 車体のバウンディングボックス(コリジョン用の近似値)
 */
export function bodyBounds(spec: CarSpec): { halfWidth: number; halfLength: number; height: number } {
  return {
    halfWidth: spec.dims.width * 0.5,
    halfLength: spec.dims.length * 0.5,
    height: spec.dims.height,
  };
}

export { clamp, clamp01 };
