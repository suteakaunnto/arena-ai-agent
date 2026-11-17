/**
 * car/geometry/GlassAndLamps.ts
 * 責務: 窓ガラス、ヘッドライト(レンズ+リフレクタ+LED)、テールライト、ウィンカー、ミラーガラス
 * 公開API: buildGlass, buildLights, buildMirrors
 * 依存: three, car/geometry/Loft.ts, car/spec/CarSpec.ts, car/materials/CarMaterials.ts
 *
 * 設計メモ:
 *  - ガラスは車体断面から少し内側にオフセットした帯で作る(干渉を避ける)。
 *  - ライトは本体(発光) + レンズ(半透明) + ハウジング(暗い凹み)の3層。
 *  - デイライトは細い帯を複数並べて「現代的」に見せる。
 */
import * as THREE from "three";
import { CarSpec } from "../spec/CarSpec.js";
import { SectionFrame, sectionAt, halfSectionPoint, loftStrip } from "./Loft.js";
import { CarMaterialLibrary } from "../materials/CarMaterials.js";
import { clamp01, lerp } from "../../core/math.js";

export interface GlassParts {
  front: THREE.Mesh;
  rear: THREE.Mesh;
  sides: THREE.Mesh[];
  all: THREE.Group;
}

/** 窓ガラス(フロント/リア/サイド) */
export function buildGlass(spec: CarSpec, sections: SectionFrame[], mats: CarMaterialLibrary): GlassParts {
  const group = new THREE.Group();
  group.name = "glass";
  const mat = mats.glass(0x18242e, 0.93);
  const p = spec.profile;

  // キャビン範囲
  const tFront = p.cabinStart + 0.035;
  const tRear = p.cabinEnd - 0.02;

  // フロントガラス(上面の t 範囲)
  const wsT0 = p.cabinStart + 0.01;
  const wsT1 = Math.min(p.cabinEnd - 0.1, p.cabinStart + 0.2);
  const frontGeom = loftStrip(sections, {
    s0: 0.86,
    s1: 1.0,
    segments: 8,
    t0: wsT0,
    t1: wsT1,
    deform: (v, _t, s) => {
      // 少し内側へ
      v.x *= 0.985;
      v.y -= 0.004;
      void s;
    },
  });
  const front = new THREE.Mesh(frontGeom, mat);
  front.name = "glass_front";
  group.add(front);

  // リアガラス
  const rgT0 = Math.max(wsT1 + 0.05, p.cabinEnd - 0.2);
  const rgT1 = p.cabinEnd - 0.005;
  const rearGeom = loftStrip(sections, {
    s0: 0.86,
    s1: 1.0,
    segments: 8,
    t0: rgT0,
    t1: rgT1,
    deform: (v) => {
      v.x *= 0.985;
      v.y -= 0.004;
    },
  });
  const rear = new THREE.Mesh(rearGeom, mat);
  rear.name = "glass_rear";
  group.add(rear);

  // サイドガラス(上半の帯を、キャビン区間だけ切り出す)
  const sides: THREE.Mesh[] = [];
  for (const mirror of [false, true]) {
    const sideGeom = loftStrip(sections, {
      s0: 0.6,
      s1: 0.88,
      segments: 6,
      mirror,
      t0: tFront,
      t1: tRear,
      deform: (v, t, s) => {
        v.x *= 0.985;
        // ウィンドウの形(下端を少し上げる)
        if (s < 0.63) v.y += 0.012;
        // Bピラー付近を分割…は頂点だけでは難しいので、細い帯を後で重ねる
        void t;
      },
    });
    const side = new THREE.Mesh(sideGeom, mat);
    side.name = mirror ? "glass_side_l" : "glass_side_r";
    side.renderOrder = 2;
    group.add(side);
    sides.push(side);
  }

  front.renderOrder = 2;
  rear.renderOrder = 2;

  return { front, rear, sides, all: group };
}

export interface LightParts {
  group: THREE.Group;
  headLights: THREE.Mesh[];
  tailLights: THREE.Mesh[];
  brakeLights: THREE.Mesh[];
  indicators: THREE.Mesh[];
  reverseLights: THREE.Mesh[];
  /** 発光マテリアル(点灯制御用) */
  headMaterial: THREE.MeshStandardMaterial;
  tailMaterial: THREE.MeshStandardMaterial;
  brakeMaterial: THREE.MeshStandardMaterial;
  indicatorMaterial: THREE.MeshStandardMaterial;
  reverseMaterial: THREE.MeshStandardMaterial;
}

/** 灯火類 */
export function buildLights(spec: CarSpec, sections: SectionFrame[], mats: CarMaterialLibrary): LightParts {
  const group = new THREE.Group();
  group.name = "lights";
  const headMaterial = mats.light(spec.lights.headColor, 0.15, false);
  const tailMaterial = mats.light(0xff2a1a, 0.5, false);
  const brakeMaterial = mats.light(0xff1a10, 2.6, true);
  const indicatorMaterial = mats.light(0xff8c1a, 0.2, false);
  const reverseMaterial = mats.light(0xffffff, 0.2, false);

  const headLights: THREE.Mesh[] = [];
  const tailLights: THREE.Mesh[] = [];
  const brakeLights: THREE.Mesh[] = [];
  const indicators: THREE.Mesh[] = [];
  const reverseLights: THREE.Mesh[] = [];

  const halfW = spec.dims.width * 0.5;
  const L = spec.dims.length;
  const style = spec.lights;

  // --- ヘッドライト ---
  const frontT = 0.955;
  const frontSec = sectionAt(sections, frontT);
  const headY = center(frontSec.beltY, frontSec.deckY) + 0.02;
  const headZ = frontSec.z - 0.01;

  const mkLamp = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rotY = 0,
    mat: THREE.Material
  ): THREE.Mesh => {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    return m;
  };

  const lenses: THREE.Mesh[] = [];
  for (const side of [1, -1]) {
    const x = side * (frontSec.topHalfWidth * 0.68 + 0.02);
    if (style.headStyle === "strip") {
      // 細い横長の LED ストリップ
      const w = frontSec.topHalfWidth * 0.42;
      const strip = mkLamp(w, 0.055, 0.05, x, headY + 0.02, headZ, 0, headMaterial);
      headLights.push(strip);
      group.add(strip);
      // 下側のメインランプ
      const main = mkLamp(w * 0.7, 0.11, 0.07, x, headY - 0.075, headZ, 0, headMaterial);
      headLights.push(main);
      group.add(main);
      const lens = mkLamp(w * 0.74, 0.15, 0.075, x, headY - 0.045, headZ + 0.03, 0, mats.lampLens(0xdce8ff));
      lenses.push(lens);
    } else if (style.headStyle === "round") {
      const r = 0.085;
      const g = new THREE.CylinderGeometry(r, r, 0.05, 16);
      g.rotateX(Math.PI / 2);
      const lamp = new THREE.Mesh(g, headMaterial);
      lamp.position.set(x, headY, headZ);
      headLights.push(lamp);
      group.add(lamp);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.06, 0.008, 4, 20), mats.chrome(0xc8ccd0, 0.2));
      ring.position.copy(lamp.position);
      ring.position.z += 0.02;
      group.add(ring);
      // DRL リング
      const drlRing = new THREE.Mesh(new THREE.TorusGeometry(r * 1.16, 0.007, 4, 20), mats.light(0xfff2d8, 0.4, false));
      drlRing.position.copy(lamp.position);
      drlRing.position.z += 0.025;
      headLights.push(drlRing);
      group.add(drlRing);
    } else if (style.headStyle === "quad") {
      for (const [dx, dy, r] of [
        [0, 0.0, 0.062],
        [0.14, 0.0, 0.062],
      ] as Array<[number, number, number]>) {
        const g = new THREE.CylinderGeometry(r, r, 0.045, 14);
        g.rotateX(Math.PI / 2);
        const lamp = new THREE.Mesh(g, headMaterial);
        lamp.position.set(x + side * dx * -1, headY + dy, headZ);
        headLights.push(lamp);
        group.add(lamp);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.1, 0.007, 4, 16), mats.chrome(0xc8ccd0, 0.25));
        ring.position.copy(lamp.position);
        ring.position.z += 0.018;
        group.add(ring);
      }
    } else if (style.headStyle === "angular") {
      const w = frontSec.topHalfWidth * 0.36;
      const lamp = mkLamp(w, 0.085, 0.06, x, headY, headZ, side * 0.12, headMaterial);
      headLights.push(lamp);
      group.add(lamp);
      const drl = mkLamp(w * 0.92, 0.016, 0.05, x, headY + 0.055, headZ + 0.005, side * 0.12, mats.light(0xfff4e0, 1.2, true));
      group.add(drl);
      headLights.push(drl);
    } else {
      // popup
      const w = frontSec.topHalfWidth * 0.4;
      const housing = mkLamp(w, 0.06, 0.2, x, headY + 0.02, headZ - 0.08, 0, mats.plastic(0x1a1a1c, 0.7));
      group.add(housing);
      const lamp = mkLamp(w * 0.9, 0.05, 0.06, x, headY + 0.05, headZ + 0.01, 0, headMaterial);
      headLights.push(lamp);
      group.add(lamp);
    }

    // レンズ(共通)
    const lens = mkLamp(frontSec.topHalfWidth * 0.5, 0.19, 0.05, x, headY - 0.02, headZ + 0.045, 0, mats.lampLens(0xe8f0ff));
    group.add(lens);
    lenses.push(lens);
  }

  // --- テールライト ---
  const rearT = 0.03;
  const rearSec = sectionAt(sections, rearT);
  const tailY = center(rearSec.beltY, rearSec.deckY) + 0.06;
  const tailZ = rearSec.z + 0.005;
  for (const side of [1, -1]) {
    const x = side * (rearSec.topHalfWidth * 0.7 + 0.02);
    if (style.tailStyle === "bar") {
      const w = rearSec.topHalfWidth * 0.82;
      const bar = mkLamp(w, 0.062, 0.05, x * 0.82, tailY, tailZ, 0, tailMaterial);
      tailLights.push(bar);
      group.add(bar);
      const brake = mkLamp(w * 0.9, 0.03, 0.055, x * 0.82, tailY + 0.04, tailZ + 0.004, 0, brakeMaterial);
      brakeLights.push(brake);
      group.add(brake);
      const rev = mkLamp(w * 0.24, 0.03, 0.05, x * 0.5, tailY - 0.045, tailZ + 0.004, 0, reverseMaterial);
      reverseLights.push(rev);
      group.add(rev);
      const ind = mkLamp(w * 0.2, 0.03, 0.05, x * 1.15, tailY - 0.045, tailZ + 0.004, 0, indicatorMaterial);
      indicators.push(ind);
      group.add(ind);
    } else if (style.tailStyle === "split") {
      const w = rearSec.topHalfWidth * 0.36;
      const lamp = mkLamp(w, 0.103, 0.05, x, tailY + 0.02, tailZ, 0, tailMaterial);
      tailLights.push(lamp);
      group.add(lamp);
      const brake = mkLamp(w * 0.85, 0.055, 0.055, x, tailY - 0.055, tailZ + 0.004, 0, brakeMaterial);
      brakeLights.push(brake);
      group.add(brake);
      const ind = mkLamp(w * 0.3, 0.03, 0.05, x - side * 0.02, tailY + 0.085, tailZ + 0.004, 0, indicatorMaterial);
      indicators.push(ind);
      group.add(ind);
    } else if (style.tailStyle === "round") {
      const r = 0.072;
      const g = new THREE.CylinderGeometry(r, r, 0.05, 16);
      g.rotateX(Math.PI / 2);
      const lamp = new THREE.Mesh(g, tailMaterial);
      lamp.position.set(x, tailY, tailZ);
      tailLights.push(lamp);
      group.add(lamp);
      const brake = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.72, r * 0.72, 0.052, 14), brakeMaterial);
      brake.geometry.rotateX(Math.PI / 2);
      brake.position.copy(lamp.position);
      brake.position.z += 0.003;
      brakeLights.push(brake);
      group.add(brake);
      const ind = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.3, 0.054, 10), indicatorMaterial);
      ind.geometry.rotateX(Math.PI / 2);
      ind.position.set(x + side * 0.1, tailY - 0.05, tailZ + 0.004);
      indicators.push(ind);
      group.add(ind);
    } else {
      // lshape
      const w = rearSec.topHalfWidth * 0.4;
      const vert = mkLamp(0.045, 0.19, 0.05, x + side * 0.02, tailY, tailZ, 0, tailMaterial);
      tailLights.push(vert);
      group.add(vert);
      const horiz = mkLamp(w, 0.05, 0.05, x - side * w * 0.35, tailY + 0.075, tailZ, 0, tailMaterial);
      tailLights.push(horiz);
      group.add(horiz);
      const brake = mkLamp(w * 0.6, 0.03, 0.055, x - side * w * 0.27, tailY + 0.075, tailZ + 0.004, 0, brakeMaterial);
      brakeLights.push(brake);
      group.add(brake);
      const ind = mkLamp(0.035, 0.1, 0.052, x + side * 0.045, tailY, tailZ + 0.004, 0, indicatorMaterial);
      indicators.push(ind);
      group.add(ind);
    }
  }

  // サイドウィンカー
  for (const side of [1, -1]) {
    const sec = sectionAt(sections, 0.9);
    const p = halfSectionPoint(sec, 0.62);
    const ind = mkLamp(0.075, 0.028, 0.03, side * (p.x + 0.005), p.y + 0.02, sec.z, 0, indicatorMaterial);
    indicators.push(ind);
    group.add(ind);
  }

  // ナンバープレート(後)
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xd8d4c0, roughness: 0.7, metalness: 0.05 });
  const plate = mkLamp(0.34, 0.12, 0.012, 0, rearSec.floorY + 0.16, rearSec.z - 0.02, 0, plateMat);
  group.add(plate);

  return {
    group,
    headLights,
    tailLights,
    brakeLights,
    indicators,
    reverseLights,
    headMaterial,
    tailMaterial,
    brakeMaterial,
    indicatorMaterial,
    reverseMaterial,
  };

  void halfW;
  void L;
}

function center(a: number, b: number): number {
  return (a + b) * 0.5;
}

/** ドアミラー */
export function buildMirrors(spec: CarSpec, sections: SectionFrame[], mats: CarMaterialLibrary, paint: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.name = "mirrors";
  const sec = sectionAt(sections, spec.profile.cabinStart + 0.055);
  const base = halfSectionPoint(sec, 0.66);
  for (const side of [1, -1]) {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.09, 8), mats.plastic(0x141416, 0.6));
    stem.position.set(side * (base.x + 0.03), base.y + 0.03, sec.z);
    stem.rotation.z = Math.PI / 2;
    group.add(stem);

    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.16), paint);
    housing.position.set(side * (base.x + 0.09), base.y + 0.055, sec.z + 0.01);
    housing.rotation.y = side * 0.12;
    housing.castShadow = true;
    group.add(housing);

    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.072, 0.13), mats.chrome(0x30363c, 0.06));
    glass.position.set(side * (base.x + 0.09 - side * 0.038), base.y + 0.055, sec.z + 0.01);
    glass.rotation.y = side * 0.12;
    group.add(glass);

    // サイドのウインカー
    const blink = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.018, 0.05), mats.light(0xff8c1a, 0.4, false));
    blink.position.set(side * (base.x + 0.09), base.y + 0.018, sec.z + 0.07);
    group.add(blink);
  }
  return group;
}

/** ドアハンドル・ワイパー・エアロパーツ等のディテール */
export function buildDetails(spec: CarSpec, sections: SectionFrame[], mats: CarMaterialLibrary, paint: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.name = "details";
  const p = spec.profile;

  // グリル(前)
  const frontSec = sectionAt(sections, 0.97);
  const grilleW = frontSec.topHalfWidth * 1.5;
  const grille = new THREE.Mesh(
    new THREE.BoxGeometry(grilleW, 0.16, 0.06),
    mats.plastic(0x0e0f11, 0.85)
  );
  grille.position.set(0, frontSec.beltY - 0.13, frontSec.z + 0.01);
  group.add(grille);
  // グリルのメッシュ(細い棒)
  const bars = Math.max(3, Math.round(spec.dims.width * 5));
  for (let i = 0; i < bars; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(grilleW * 0.94, 0.006, 0.012), mats.chrome(0x6a6e73, 0.35));
    bar.position.set(0, frontSec.beltY - 0.2 + (i / bars) * 0.14, frontSec.z + 0.04);
    group.add(bar);
  }

  // フロントリップ / スプリッター
  if (spec.dims.height < 1.3) {
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(spec.dims.width * 0.92, 0.02, 0.24), mats.carbon());
    splitter.position.set(0, p.rideHeight + 0.05, frontSec.z + 0.06);
    group.add(splitter);
  }

  // リアディフューザー
  const rearSec = sectionAt(sections, 0.02);
  const diff = new THREE.Mesh(new THREE.BoxGeometry(spec.dims.width * 0.72, 0.08, 0.24), mats.carbon());
  diff.position.set(0, p.rideHeight + 0.08, rearSec.z - 0.1);
  group.add(diff);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.07, 0.22), mats.carbon());
    fin.position.set((i - 1.5) * (spec.dims.width * 0.16), p.rideHeight + 0.08, rearSec.z - 0.1);
    group.add(fin);
  }

  // マフラー
  const exhaustY = p.rideHeight + 0.06;
  for (const side of spec.dims.width > 1.9 ? [1, -1] : [0]) {
    const pipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.05, 0.12, 12, 1, true),
      mats.chrome(0x9aa0a6, 0.22)
    );
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(side * (side === 0 ? 0.28 : 0.38), exhaustY, rearSec.z - 0.07);
    group.add(pipe);
    const inner = new THREE.Mesh(new THREE.CircleGeometry(0.04, 12), mats.plastic(0x080808, 1));
    inner.position.set(pipe.position.x, exhaustY, rearSec.z - 0.132);
    group.add(inner);
  }

  // リアスポイラー
  const needsWing = spec.dims.length > 4.2 && (spec.style === "super" || spec.style === "hyper" || spec.style === "gt4" || spec.style === "rally" || spec.style === "sport");
  if (needsWing) {
    const wingW = spec.dims.width * 0.78;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(wingW, 0.022, 0.28), mats.carbon());
    const wingY = rearSec.deckY + 0.18;
    wing.position.set(0, wingY, rearSec.z + 0.12);
    wing.castShadow = true;
    group.add(wing);
    for (const side of [1, -1]) {
      const stay = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.18, 0.05), mats.carbon());
      stay.position.set(side * wingW * 0.36, wingY - 0.09, rearSec.z + 0.1);
      group.add(stay);
    }
    // エンドプレート
    for (const side of [1, -1]) {
      const ep = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.09, 0.28), mats.carbon());
      ep.position.set(side * wingW * 0.5, wingY - 0.01, rearSec.z + 0.12);
      group.add(ep);
    }
  }

  // ドアハンドル
  for (const side of [1, -1]) {
    const sec = sectionAt(sections, p.cabinStart + 0.02);
    const pt = halfSectionPoint(sec, 0.6);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.03, 0.11), mats.chrome(spec.wheel.rimColor, 0.28));
    handle.position.set(side * (pt.x + 0.002), pt.y - 0.02, sec.z);
    group.add(handle);
  }

  // ワイパー
  const wsSec = sectionAt(sections, p.cabinStart + 0.03);
  for (const side of [1, -1]) {
    const wiper = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.008, 0.016), mats.plastic(0x121214, 0.85));
    wiper.position.set(side * wsSec.topHalfWidth * 0.32, wsSec.deckY + 0.01, wsSec.z + 0.02);
    wiper.rotation.y = side * 0.18;
    group.add(wiper);
  }

  // ルーフのアンテナ(セダン系)
  if (spec.style === "sedan" || spec.style === "gt4") {
    const sec = sectionAt(sections, p.cabinStart + 0.22);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.007, 0.13, 6), mats.plastic(0x141416, 0.7));
    ant.position.set(0, sec.centerTopY + 0.06, sec.z);
    group.add(ant);
  }

  // サイドスカート
  for (const side of [1, -1]) {
    const sec = sectionAt(sections, 0.5);
    const pt = halfSectionPoint(sec, 0.3);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, spec.chassis.wheelbase * 0.86), mats.plastic(0x16181a, 0.7));
    skirt.position.set(side * (pt.x - 0.01), pt.y + 0.035, 0);
    group.add(skirt);
  }

  void paint;
  return group;
}

export { clamp01, lerp };
