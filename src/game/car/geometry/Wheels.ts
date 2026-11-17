/**
 * car/geometry/Wheels.ts
 * 責務: ホイール(リム/スポーク/リップ/センターキャップ)・タイヤ断面・ブレーキディスク・キャリパーの生成
 * 公開API: buildWheel, WheelAssembly, WHEEL_PRESETS
 * 依存: three, car/spec/CarSpec.ts, car/materials/CarMaterials.ts, core/math.ts
 *
 * 設計メモ:
 *  - タイヤは回転体(ラテス)で作り、トレッドとサイドウォールのR形状を断面で表現。
 *  - リムは「スポーク数 + 形状タイプ」で手続き生成。コンケーブで深リムを表現。
 *  - ブレーキディスクは回転体 + ドリルド穴(テクスチャ不要、頂点で表現)。
 *  - ホイールは Z 軸回転で車軸方向。左側は全体を X 反転して使う。
 */
import * as THREE from "three";
import { CarSpec, WheelStyleSpec } from "../spec/CarSpec.js";
import { CarMaterialLibrary } from "../materials/CarMaterials.js";
import { TAU, lerp, clamp01, Rng } from "../../core/math.js";

export interface WheelAssembly {
  group: THREE.Group;
  /** タイヤ(回転させる対象) */
  spin: THREE.Group;
  radius: number;
  width: number;
  /** ブレーキディスク(発光色制御用) */
  discMaterial: THREE.MeshStandardMaterial;
  triangles: number;
}

const TIRE_SEGMENTS = 40;
const TIRE_SECTION = 16;

/** タイヤの断面(回転体の元になる輪郭) 半径方向 r と 軸方向 y */
function tireProfile(rimRadius: number, outerRadius: number, halfWidth: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const bulge = halfWidth * 1.02;
  // トレッド(外周)からサイドウォールへ
  const treadHalf = halfWidth * 0.86;
  const shoulderR = (outerRadius - rimRadius) * 0.32;
  // 外周
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const y = lerp(-treadHalf, treadHalf, u);
    // トレッドのクラウン(中央がわずかに高い)
    const crown = Math.cos((u - 0.5) * Math.PI) * 0.004 * outerRadius;
    pts.push(new THREE.Vector2(outerRadius + crown, y));
  }
  // 右サイドウォール(外側)
  const side = 6;
  for (let i = 1; i <= side; i++) {
    const k = i / side;
    const y = lerp(treadHalf, bulge, k);
    const r = lerp(outerRadius, rimRadius, Math.pow(k, 0.72)) - Math.sin(k * Math.PI) * shoulderR * 0.18;
    pts.push(new THREE.Vector2(r, y));
  }
  // 内側へ戻る(リムに接する部分)
  const inner = halfWidth * 0.92;
  pts.push(new THREE.Vector2(rimRadius - 0.004, inner));
  // 左サイドウォール(内側)
  for (let i = 1; i <= side; i++) {
    const k = i / side;
    const y = lerp(-inner, -bulge, k);
    const r = lerp(rimRadius, outerRadius, Math.pow(k, 0.72)) - Math.sin(k * Math.PI) * shoulderR * 0.18;
    pts.push(new THREE.Vector2(r, y));
  }
  for (let i = 1; i <= N; i++) {
    const u = i / N;
    const y = lerp(-treadHalf, treadHalf, u);
    const crown = Math.cos((u - 0.5) * Math.PI) * 0.004 * outerRadius;
    pts.push(new THREE.Vector2(outerRadius + crown, y));
  }
  return pts;
}

/** 回転体(Lathe)を XY 平面断面から作る */
function lathe(points: THREE.Vector2[], segments: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(points, segments);
  // Lathe は Y 軸回転。車軸(Z)方向へ向けるため X 軸で 90 度回す…のではなく、
  // 断面の (x=半径, y=軸) をそのまま使いたいので Z 軸回転体に変換する。
  g.rotateX(Math.PI / 2);
  return g;
}

/** リム(スポーク) */
function buildRim(spec: WheelStyleSpec, rimRadius: number, halfWidth: number, mats: CarMaterialLibrary): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];

  // バレル(内側の筒)
  const barrel = new THREE.CylinderGeometry(rimRadius * 0.985, rimRadius * 0.985, halfWidth * 2 * 0.9, 32, 1, true);
  barrel.rotateX(Math.PI / 2);
  parts.push(barrel);

  // リップ(外周の縁)
  const lipR = rimRadius * 1.005;
  const lipGeo = new THREE.TorusGeometry(lipR, rimRadius * (0.02 + spec.lip * 0.06), 6, 36);
  lipGeo.translate(0, 0, halfWidth * 0.82);
  parts.push(lipGeo);
  const lipGeo2 = new THREE.TorusGeometry(lipR, rimRadius * (0.016 + spec.lip * 0.04), 6, 36);
  lipGeo2.translate(0, 0, -halfWidth * 0.6);
  parts.push(lipGeo2);

  // ハブ
  const hubR = rimRadius * 0.3;
  const hub = new THREE.CylinderGeometry(hubR, hubR * 0.92, halfWidth * 1.5, 20, 1);
  hub.rotateX(Math.PI / 2);
  parts.push(hub);

  // スポーク
  const spokes = Math.max(3, spec.spokes);
  const concavity = spec.concave;
  const zFront = halfWidth * 0.62;
  const zHub = halfWidth * 1.1;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * TAU;
    const arms = spec.spokeStyle === "split" ? 2 : 1;
    for (let armI = 0; armI < arms; armI++) {
      const spread = spec.spokeStyle === "split" ? (armI === 0 ? -1 : 1) * 0.055 : 0;
      const aa = a + spread;
      const spoke = makeSpokeGeometry(
        hubR * 0.85,
        rimRadius * 0.92,
        rimRadius * 0.075,
        rimRadius * 0.045,
        zHub,
        zFront - concavity * halfWidth * 0.12,
        aa,
        spec.spokeStyle
      );
      parts.push(spoke);
    }
  }

  // メッシュタイプは補助リングを足す
  if (spec.spokeStyle === "mesh") {
    const ring = new THREE.TorusGeometry(rimRadius * 0.62, rimRadius * 0.035, 5, 28);
    ring.translate(0, 0, zFront - concavity * halfWidth * 0.1);
    parts.push(ring);
  }

  const merged = mergeGeoms(parts);
  const mat = mats.chrome(spec.rimColor, spec.rimColor === 0x151719 ? 0.42 : 0.16);
  // 色が暗い場合はメタル寄りの標準マテリアル
  const rimMat = new THREE.MeshStandardMaterial({
    color: spec.rimColor,
    roughness: spec.rimColor === 0x151719 ? 0.4 : 0.18,
    metalness: 0.92,
    envMapIntensity: 1.3,
  });
  void mat;
  const mesh = new THREE.Mesh(merged, rimMat);
  mesh.castShadow = true;
  return mesh;
}

function makeSpokeGeometry(
  r0: number,
  r1: number,
  w0: number,
  w1: number,
  z0: number,
  z1: number,
  angle: number,
  style: WheelStyleSpec["spokeStyle"]
): THREE.BufferGeometry {
  // スポークは「細長い角柱」を4点で表現。角度方向に幅 w。
  const radial = 6;
  const verts: number[] = [];
  const idx: number[] = [];
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (let i = 0; i <= radial; i++) {
    const k = i / radial;
    const r = lerp(r0, r1, k);
    // 幅は根元が太く先端で細い
    let w = lerp(w0, w1, Math.pow(k, 0.7));
    // タービンは途中でねじる
    const twist = style === "turbine" ? k * 0.22 : 0;
    // 深さ(軸方向)
    let z = lerp(z0, z1, Math.pow(k, 0.85));
    if (style === "dish") z = lerp(z0, z1 * 0.55, k);
    // 断面は台形(表側が広い)
    const frontZ = z + 0.012;
    const backZ = z - 0.014;
    // 4点 x 2 (front / back)
    for (const [ww, zz] of [
      [-w, frontZ],
      [w, frontZ],
      [w * 0.8, backZ],
      [-w * 0.8, backZ],
    ] as Array<[number, number]>) {
      const aa = angle + twist;
      const caa = Math.cos(aa);
      const saa = Math.sin(aa);
      // 幅方向は接線方向
      const tx = -saa * ww;
      const ty = caa * ww * 0.0; // パネル面内の幅は XZ 平面で扱う
      // 実際の座標: 半径方向 (caa, 0, saa) を XZ 平面に置く
      verts.push(caa * r + tx, ty + ww * 0.0, saa * r + zz * 0);
      // 上記だと軸方向が消えるので、Y を軸方向に使う
      verts.pop();
      verts.pop();
      verts.pop();
      verts.push(caa * r + tx, zz, saa * r);
    }
    void ca;
    void sa;
    if (i > 0) {
      const b = (i - 1) * 4;
      const c = i * 4;
      for (let f = 0; f < 4; f++) {
        const f2 = (f + 1) % 4;
        idx.push(b + f, c + f, b + f2, b + f2, c + f, c + f2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** ブレーキディスク + キャリパー */
function buildBrakes(
  rimRadius: number,
  mats: CarMaterialLibrary,
  caliperColor: number
): { disc: THREE.Mesh; caliper: THREE.Mesh; discMat: THREE.MeshStandardMaterial } {
  const discR = rimRadius * 0.82;
  const discMat = mats.brakeDisc().clone();
  const discGeom = new THREE.CylinderGeometry(discR, discR, 0.028, 32, 1, false);
  discGeom.rotateX(Math.PI / 2);
  const disc = new THREE.Mesh(discGeom, discMat);
  disc.castShadow = true;

  // ドリルド穴(小さな円柱で表現)
  const holes: THREE.BufferGeometry[] = [];
  const holeR = discR * 0.86;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    const r = holeR * (i % 2 === 0 ? 0.78 : 0.62);
    const h = new THREE.CylinderGeometry(0.008, 0.008, 0.034, 6, 1, true);
    h.rotateX(Math.PI / 2);
    h.translate(Math.cos(a) * r, Math.sin(a) * r, 0);
    holes.push(h);
  }
  const holeMesh = new THREE.Mesh(mergeGeoms(holes), mats.plastic(0x0c0c0e, 1));
  disc.add(holeMesh);

  // キャリパー(6ポット風)
  const calGeom = new THREE.BoxGeometry(rimRadius * 0.16, rimRadius * 0.42, 0.09);
  const calMat = mats.caliper(caliperColor);
  const caliper = new THREE.Mesh(calGeom, calMat);
  caliper.position.set(discR * 0.62, discR * 0.55, -0.01);
  caliper.rotateZ(0.7);
  caliper.castShadow = true;

  return { disc, caliper, discMat };
}

/** ジオメトリ結合(簡易) */
function mergeGeoms(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  const prepared = geoms.map((g) => {
    const geo = g.index ? g : g.toNonIndexed();
    vCount += geo.getAttribute("position").count;
    const idx = geo.getIndex();
    iCount += idx ? idx.count : geo.getAttribute("position").count;
    return geo;
  });
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const indices = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const geo of prepared) {
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const n = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute | undefined;
    positions.set(p.array as Float32Array, vo * 3);
    if (n) normals.set(n.array as Float32Array, vo * 3);
    if (uv) uvs.set(uv.array as Float32Array, vo * 2);
    const idx = geo.getIndex();
    if (idx) {
      const arr = idx.array;
      for (let i = 0; i < arr.length; i++) indices[io + i] = arr[i] + vo;
      io += arr.length;
    } else {
      for (let i = 0; i < p.count; i++) indices[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * 1つのホイールを生成する。
 * @param spec 車のスペック
 * @param mats マテリアルライブラリ
 * @param isFront 前輪か
 * @param mirror 左側か(X 反転)
 */
export function buildWheel(spec: CarSpec, mats: CarMaterialLibrary, isFront: boolean, mirror: boolean, quality = 2): WheelAssembly {
  const group = new THREE.Group();
  const spin = new THREE.Group();

  const radius = isFront ? spec.dims.wheelRadiusFront : spec.dims.wheelRadiusRear;
  const width = isFront ? spec.dims.wheelWidthFront : spec.dims.wheelWidthRear;
  const rimInch = spec.wheel.rimInch;
  const rimRadius = Math.min(radius * 0.76, (rimInch * 0.0254) / 2);

  // タイヤ
  const profile = tireProfile(rimRadius, radius, width * 0.5);
  const tireGeom = lathe(profile, quality >= 2 ? TIRE_SEGMENTS : 20);
  const tire = new THREE.Mesh(tireGeom, mats.rubber());
  tire.castShadow = true;
  tire.receiveShadow = true;
  tire.name = "tire";
  spin.add(tire);

  // トレッドパターン(細い溝)
  if (quality >= 2) {
    const grooves = 3;
    for (let g = 0; g < grooves; g++) {
      const y = lerp(-width * 0.38, width * 0.38, g / (grooves - 1));
      const torus = new THREE.TorusGeometry(radius * 0.995, 0.006, 3, 32);
      torus.rotateX(Math.PI / 2);
      torus.translate(0, y, 0);
      const groove = new THREE.Mesh(torus, mats.plastic(0x0a0a0b, 1));
      spin.add(groove);
    }
  }

  // リム
  const rim = buildRim(spec.wheel, rimRadius, width * 0.5, mats);
  spin.add(rim);

  // センターキャップ
  const capGeom = new THREE.CylinderGeometry(rimRadius * 0.22, rimRadius * 0.22, 0.03, 16);
  capGeom.rotateX(Math.PI / 2);
  capGeom.translate(0, 0, width * 0.56);
  const capMat = new THREE.MeshStandardMaterial({ color: spec.wheel.capColor, roughness: 0.35, metalness: 0.6 });
  const cap = new THREE.Mesh(capGeom, capMat);
  spin.add(cap);

  // ブレーキ
  const brakes = buildBrakes(rimRadius, mats, spec.colors[0]);
  spin.add(brakes.disc);

  group.add(spin);
  // キャリパーは回転しないので外側グループへ
  group.add(brakes.caliper);

  if (mirror) {
    group.scale.x = -1;
  }

  let tris = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry as THREE.BufferGeometry;
    tris += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });

  return { group, spin, radius, width, discMaterial: brakes.discMat, triangles: Math.round(tris) };
}

/** ホイールプリセット(見た目のバリエーション) */
export const WHEEL_PRESETS: Array<{ name: string; apply: (spec: CarSpec) => void }> = [
  { name: "純正", apply: () => {} },
  { name: "レース(10本)", apply: (s) => { s.wheel.spokes = 10; s.wheel.spokeStyle = "split"; s.wheel.rimColor = 0x2a2d31; } },
  { name: "クラシック(メッシュ)", apply: (s) => { s.wheel.spokes = 8; s.wheel.spokeStyle = "mesh"; s.wheel.rimColor = 0xc9ccd0; } },
  { name: "タービン(12本)", apply: (s) => { s.wheel.spokes = 12; s.wheel.spokeStyle = "turbine"; s.wheel.rimColor = 0x1d1f22; } },
  { name: "ディープリム", apply: (s) => { s.wheel.spokes = 5; s.wheel.spokeStyle = "dish"; s.wheel.concave = 0.15; s.wheel.lip = 0.42; } },
];

export { clamp01, Rng };
