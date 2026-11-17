/**
 * car/geometry/Loft.ts
 * 責務: 車体形状の「断面ロフト」計算。仕様パラメータ → 断面列 → ストリップ(帯)メッシュ
 * 公開API: SectionFrame, buildSections, sectionRing, surfacePoint, loftStrip, loftCap, profileAt
 * 依存: three, core/math.ts, car/spec/CarSpec.ts
 *
 * 設計メモ:
 *  - 車体を「t(後端0→前端1)方向の断面」と「s(断面周方向0..1)」の2パラメータ曲面として扱う。
 *  - s は 0=下面中心 → 0.25=下面外側 → 0.55=ベルトライン(最幅) → 0.85=肩 → 1=上面中心。
 *  - 帯を s で 4 分割(下面/下半/上半/上面)し、それぞれ独立した頂点列にすることで
 *    ベルトラインやフェンダーの稜線にシャープなハイライトが出る(設計書の「ハードエッジ分離」)。
 *  - 座標系: 車体ローカル。+Z = 前, +X = 右, +Y = 上, y=0 = 接地(タイヤ接地面)。
 */
import * as THREE from "three";
import { CarSpec, BodyProfile } from "../spec/CarSpec.js";
import { catmullRom1, clamp, clamp01, lerp, smoothstep, DEG2RAD } from "../../core/math.js";

/** s の帯境界(下面/下半/上半/上面) */
export const S_BANDS: Array<[number, number]> = [
  [0.0, 0.25],
  [0.25, 0.55],
  [0.55, 0.85],
  [0.85, 1.0],
];

export const BAND_NAMES = ["floor", "lower", "upper", "top"] as const;
export type BandName = (typeof BAND_NAMES)[number];

/** 1つの断面(車体の z 位置ごとの横断面) */
export interface SectionFrame {
  /** 0..1 (後端→前端) */
  t: number;
  /** z 座標(m) */
  z: number;
  /** 最幅(半幅, m) */
  halfWidth: number;
  /** 下面の半幅 */
  bottomHalfWidth: number;
  /** 上面の半幅(ルーフ/ボンネット) */
  topHalfWidth: number;
  /** 床の高さ */
  floorY: number;
  /** 最大幅の高さ(ベルトライン) */
  beltY: number;
  /** 肩の高さ(上面外側) */
  deckY: number;
  /** 上面中心の高さ */
  centerTopY: number;
  /** 下面の角ばり(2=丸, 8=箱) */
  sideExp: number;
  /** 上面の角ばり */
  topExp: number;
  /** キャビン内か(0..1) */
  greenhouse: number;
  /** 屋根の盛り上がり */
  crown: number;
  /** ウィンドシールド斜面か */
  windshield: number;
  /** リアガラス斜面か */
  rearGlass: number;
  /** 前後方向の傾斜(法線計算用) */
  slope: number;
}

/** 11点プロファイルを t で補間 */
export function profileAt(arr: number[], t: number): number {
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  const x = clamp01(t) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const f = x - i;
  const p0 = arr[Math.max(0, i - 1)];
  const p1 = arr[i];
  const p2 = arr[i + 1];
  const p3 = arr[Math.min(n - 1, i + 2)];
  return catmullRom1(p0, p1, p2, p3, f, 0.5);
}

/**
 * 屋根の高さプロファイル(キャビン形状)を求める。
 * 戻り値: { topY, greenhouse, windshield, rearGlass }
 */
function computeRoof(
  p: BodyProfile,
  t: number,
  bodyH: number,
  rideH: number
): { topY: number; greenhouse: number; windshield: number; rearGlass: number } {
  const h0 = rideH + bodyH; // 屋根の基準高さ
  // ウィンドシールド: cabinStart から立ち上がる
  const wsLen = clamp(0.14 + Math.tan((90 - p.windshieldAngle) * DEG2RAD) * 0.22, 0.09, 0.3);
  const wsStart = p.cabinStart;
  const wsEnd = Math.min(p.cabinEnd - 0.06, wsStart + wsLen);
  // リアガラス
  const rgLen = clamp(0.1 + Math.tan((90 - p.rearGlassAngle) * DEG2RAD) * 0.2, 0.06, 0.26);
  const rgEnd = p.cabinEnd;
  const rgStart = Math.max(wsEnd + 0.04, rgEnd - rgLen);

  const roofY = rideH + bodyH * p.roofHeight;

  if (t < wsStart) {
    return { topY: 0, greenhouse: 0, windshield: 0, rearGlass: 0 };
  }
  if (t < wsEnd) {
    // フード高 → ルーフ高へ
    const k = smoothstep(wsStart, wsEnd, t);
    return { topY: lerp(0, roofY, k), greenhouse: k, windshield: 1 - k * 0.3, rearGlass: 0 };
  }
  if (t < rgStart) {
    return { topY: roofY, greenhouse: 1, windshield: 0, rearGlass: 0 };
  }
  if (t < rgEnd) {
    const k = smoothstep(rgStart, rgEnd, t);
    return { topY: lerp(roofY, 0, k), greenhouse: 1 - k * 0.75, windshield: 0, rearGlass: k };
  }
  void h0;
  return { topY: 0, greenhouse: 0, windshield: 0, rearGlass: 0 };
}

/**
 * 仕様から断面列を作る。
 * @param count 断面数(多いほど滑らか)
 */
export function buildSections(spec: CarSpec, count?: number): SectionFrame[] {
  const p = spec.profile;
  const L = spec.dims.length;
  const W = spec.dims.width;
  const H = spec.dims.height;
  const rideH = p.rideHeight;
  const bodyH = Math.max(0.25, H - rideH);
  const n = count ?? p.sections;
  const out: SectionFrame[] = [];

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const halfW = (profileAt(p.planHalfWidth, t) * W * 0.5);
    const floorRatio = profileAt(p.floor, t);
    const beltRatio = profileAt(p.belt, t);
    const deckRatio = profileAt(p.deck, t);
    const roof = computeRoof(p, t, bodyH, rideH);

    const floorY = rideH + bodyH * floorRatio;
    const beltY = rideH + bodyH * beltRatio;
    const deckYRaw = rideH + bodyH * deckRatio;

    // 屋根がある区間は上面を持ち上げる
    const topOuterY = roof.topY > 0 ? Math.max(deckYRaw, roof.topY) : deckYRaw;

    // 断面の幅(キャビンでは絞る)
    const gh = roof.greenhouse;
    const narrow = lerp(1, 1 - p.tumblehome * 1.25, gh);
    const halfWOut = halfW;
    const topHalfW = halfW * narrow * (roof.topY > 0 ? 0.94 : 0.9);
    const bottomHalfW = halfW * 0.78;

    // キャビンの絞り(前後方向の屋根の丸み)
    const centerTopY = topOuterY + (roof.topY > 0 ? bodyH * p.roofCrown : bodyH * 0.012);

    const slope = i === 0 ? 0 : 0;
    out.push({
      t,
      z: -L * 0.5 + t * L,
      halfWidth: halfWOut,
      bottomHalfWidth: bottomHalfW,
      topHalfWidth: topHalfW,
      floorY,
      beltY,
      deckY: topOuterY,
      centerTopY,
      sideExp: profileAt(p.sideExponent, t),
      topExp: profileAt(p.topExponent, t),
      greenhouse: gh,
      crown: bodyH * p.roofCrown,
      windshield: roof.windshield,
      rearGlass: roof.rearGlass,
      slope,
    });
  }

  // 前後のオーバーハングを反映(車軸位置は別途計算)
  return out;
}

/* ------------------------------------------------------------------ */
/* 断面の周方向計算                                                  */
/* ------------------------------------------------------------------ */

/**
 * 断面の周方向パラメータ s(0..1) から、右側半断面の (x, y) を返す。
 * s=0 下面中心 / s=1 上面中心。
 */
export function halfSectionPoint(sec: SectionFrame, s: number): { x: number; y: number } {
  const sc = clamp01(s);
  if (sc <= 0.25) {
    // 下面: 中心 → 下面外側(やや下がりながら)
    const k = sc / 0.25;
    const x = sec.bottomHalfWidth * Math.pow(k, 0.72);
    const y = sec.floorY + 0.012 * smoothstep(0, 1, k) * (sec.beltY - sec.floorY) * 0.35;
    return { x, y };
  }
  if (sc <= 0.55) {
    // 下半: 下面外側 → ベルトライン(スーパー楕円の1/4)
    const k = (sc - 0.25) / 0.3;
    const e = sec.sideExp;
    const x0 = sec.bottomHalfWidth;
    const y0 = sec.floorY;
    const x1 = sec.halfWidth;
    const y1 = sec.beltY;
    const cx = clamp01(Math.sin(k * Math.PI * 0.5));
    const cy = clamp01(1 - Math.cos(k * Math.PI * 0.5));
    // スーパー楕円的に外へ張り出す
    const bulge = Math.pow(Math.max(0, Math.sin(k * Math.PI)), 0.75) * (e > 4 ? 0.01 : 0.022) * (x1 - x0);
    const x = lerp(x0, x1, Math.pow(cx, 2 / e)) + bulge;
    const y = lerp(y0, y1, Math.pow(cy, 0.8));
    return { x, y };
  }
  if (sc <= 0.85) {
    // 上半: ベルトライン → 上面外側( tumblehome )
    const k = (sc - 0.55) / 0.3;
    const x0 = sec.halfWidth;
    const y0 = sec.beltY;
    const x1 = sec.topHalfWidth;
    const y1 = sec.deckY;
    const e = sec.topExp;
    // 立ち上がりを急に、上で寝かせる
    const x = lerp(x0, x1, Math.pow(smoothstep(0.05, 0.95, k), 0.72));
    const y = lerp(y0, y1, Math.pow(k, 0.82));
    void e;
    // ショルダーの張り出し
    const flare = Math.sin(k * Math.PI) * 0.012 * (x0 - x1 < 0 ? -1 : 1);
    return { x: x + flare, y };
  }
  // 上面: 上面外側 → 中心(クラウン)
  const k = (sc - 0.85) / 0.15;
  const x0 = sec.topHalfWidth;
  const y0 = sec.deckY;
  const x1 = 0;
  const y1 = sec.centerTopY;
  const x = lerp(x0, x1, Math.pow(k, 0.85));
  const y = lerp(y0, y1, Math.pow(Math.sin(k * Math.PI * 0.5), 0.72));
  return { x, y };
}

/**
 * 断面リング(右側 s∈[s0,s1])の点列を作る。mirror で左側。
 */
export function sectionRing(sec: SectionFrame, s0: number, s1: number, segments: number, mirror = false): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= segments; i++) {
    const s = lerp(s0, s1, i / segments);
    const p = halfSectionPoint(sec, s);
    pts.push(new THREE.Vector2(mirror ? -p.x : p.x, p.y));
  }
  return pts;
}

/**
 * 斷面上の任意の (t, s) 位置をワールド(ローカル)座標で返す。ライトやモールの配置に使う。
 */
export function surfacePoint(sections: SectionFrame[], t: number, s: number, mirror = false, out = new THREE.Vector3()): THREE.Vector3 {
  const sec = sectionAt(sections, t);
  const p = halfSectionPoint(sec, s);
  return out.set(mirror ? -p.x : p.x, p.y, sec.z);
}

/** t に対応する断面を得る(線形補間) */
export function sectionAt(sections: SectionFrame[], t: number): SectionFrame {
  const n = sections.length;
  const x = clamp01(t) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const f = x - i;
  const a = sections[i];
  const b = sections[i + 1];
  if (f <= 0) return a;
  return {
    t,
    z: lerp(a.z, b.z, f),
    halfWidth: lerp(a.halfWidth, b.halfWidth, f),
    bottomHalfWidth: lerp(a.bottomHalfWidth, b.bottomHalfWidth, f),
    topHalfWidth: lerp(a.topHalfWidth, b.topHalfWidth, f),
    floorY: lerp(a.floorY, b.floorY, f),
    beltY: lerp(a.beltY, b.beltY, f),
    deckY: lerp(a.deckY, b.deckY, f),
    centerTopY: lerp(a.centerTopY, b.centerTopY, f),
    sideExp: lerp(a.sideExp, b.sideExp, f),
    topExp: lerp(a.topExp, b.topExp, f),
    greenhouse: lerp(a.greenhouse, b.greenhouse, f),
    crown: lerp(a.crown, b.crown, f),
    windshield: lerp(a.windshield, b.windshield, f),
    rearGlass: lerp(a.rearGlass, b.rearGlass, f),
    slope: lerp(a.slope, b.slope, f),
  };
}

/* ------------------------------------------------------------------ */
/* ストリップ生成                                                     */
/* ------------------------------------------------------------------ */

export interface StripOptions {
  s0: number;
  s1: number;
  segments: number;
  mirror?: boolean;
  /** t の範囲(0..1)。パネル分割に使う */
  t0?: number;
  t1?: number;
  /** 端のリングを内側へ寄せる量(パネルギャップ用, m) */
  insetStart?: number;
  insetEnd?: number;
  /** 頂点を法線方向に押し出す量(m) */
  offset?: number;
  /** 頂点変形コールバック */
  deform?: (p: THREE.Vector3, t: number, s: number) => void;
}

/**
 * 断面列から1枚のストリップ(帯)を作る。
 */
export function loftStrip(sections: SectionFrame[], opts: StripOptions): THREE.BufferGeometry {
  const { s0, s1, segments, mirror = false } = opts;
  const t0 = opts.t0 ?? 0;
  const t1 = opts.t1 ?? 1;
  const steps = Math.max(2, Math.round((sections.length - 1) * (t1 - t0)) + 1);

  const verts: number[] = [];
  const norms: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pos: THREE.Vector3[] = [];
  const ts: number[] = [];
  const ss: number[] = [];

  for (let j = 0; j < steps; j++) {
    const t = lerp(t0, t1, j / (steps - 1));
    const sec = sectionAt(sections, t);
    for (let i = 0; i <= segments; i++) {
      const s = lerp(s0, s1, i / segments);
      const p = halfSectionPoint(sec, s);
      const v = new THREE.Vector3(mirror ? -p.x : p.x, p.y, sec.z);

      // パネルギャップ: 端を内側へ
      const edgeInset =
        (j === 0 ? opts.insetStart ?? 0 : 0) + (j === steps - 1 ? opts.insetEnd ?? 0 : 0);
      if (edgeInset > 0) {
        // 断面中心へ寄せる
        v.x *= 1 - edgeInset;
        v.y = lerp(les(sec.beltY, sec.floorY), v.y, 1 - edgeInset * 0.6);
      }
      if (opts.deform) opts.deform(v, t, s);
      pos.push(v);
      ts.push(t);
      ss.push(s);
    }
  }

  // 法線(隣接差分の外積、帯境界では独立計算 → シャープ)
  const N = segments + 1;
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i <= segments; i++) {
      const idx = j * N + i;
      const jm = Math.max(0, j - 1);
      const jp = Math.min(steps - 1, j + 1);
      const im = Math.max(0, i - 1);
      const ip = Math.min(segments, i + 1);
      const du = new THREE.Vector3().subVectors(pos[j * N + ip], pos[j * N + im]);
      const dv = new THREE.Vector3().subVectors(pos[jp * N + i], pos[jm * N + i]);
      const n = new THREE.Vector3().crossVectors(du, dv);
      if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
      n.normalize();
      // 外向きに統一(断面中心から外向き)
      const cx = 0;
      const cy = lerp(les(sectionAt(sections, ts[idx]).beltY, 0), pos[idx].y, 0.5);
      const outward = pos[idx].x - cx === 0 ? pos[idx].y - cy : (pos[idx].x - cx) * (mirror ? -1 : 1);
      if (outward < 0 && pos[idx].x !== 0) n.negate();
      else if (pos[idx].x === 0 && n.y < 0 && s1 <= 0.26) n.negate();
      norms.push(n.x, n.y, n.z);
      verts.push(pos[idx].x, pos[idx].y, pos[idx].z);
      uvs.push(ss[idx], ts[idx]);
    }
  }

  for (let j = 0; j < steps - 1; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * N + i;
      const b = j * N + i + 1;
      const c = (j + 1) * N + i;
      const d = (j + 1) * N + i + 1;
      if (mirror) {
        indices.push(a, b, c, b, d, c);
      } else {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(norms, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

function les(_a: number, b: number): number {
  return b;
}

/**
 * 前後端のキャップ(バンパー面)を作る。リングを中心点へ扇状に繋ぐ。
 */
export function loftCap(sections: SectionFrame[], atFront: boolean, segments = 24, bulge = 0.04): THREE.BufferGeometry {
  const t = atFront ? 1 : 0;
  const sec = sectionAt(sections, t);
  const verts: number[] = [];
  const norms: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // 全周リング(s=-0.25..1 を右→左へ回すのではなく、右半分と左半分を結合)
  const ring: THREE.Vector2[] = [];
  const total = segments * 2;
  for (let i = 0; i <= total; i++) {
    // s: 1(上面中心) → 0(下面中心) → 右側へ戻る
    const u = i / total;
    let s: number;
    let mirror = false;
    if (u <= 0.5) {
      s = lerp(1, 0, u * 2);
    } else {
      s = lerp(0, 1, (u - 0.5) * 2);
      mirror = true;
    }
    const p = halfSectionPoint(sec, s);
    ring.push(new THREE.Vector2(mirror ? -p.x : p.x, p.y));
  }

  // 中心点(断面の重心 + 前後方向の膨らみ)
  let cx = 0;
  let cy = 0;
  for (const p of ring) {
    cy += p.y;
  }
  cy /= ring.length;
  const cz = sec.z + (atFront ? 1 : -1) * bulge * (sec.deckY - sec.floorY);

  const n = ring.length;
  for (let i = 0; i < n; i++) {
    verts.push(ring[i].x, ring[i].y, sec.z);
    uvs.push(i / n, 0);
  }
  verts.push(cx, cy, cz);
  uvs.push(0.5, 1);
  const centerIdx = n;

  for (let i = 0; i < n - 1; i++) {
    if (atFront) indices.push(centerIdx, i + 1, i);
    else indices.push(centerIdx, i, i + 1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  // 法線を前後方向へ強制(なめらかに)
  const nAttr = g.getAttribute("normal") as THREE.BufferAttribute;
  for (let i = 0; i < nAttr.count; i++) {
    const y = nAttr.getY(i);
    const z = atFront ? 0.86 : -0.86;
    const v = new THREE.Vector3(0, y * 0.4, z).normalize();
    nAttr.setXYZ(i, v.x, v.y, v.z);
  }
  nAttr.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/**
 * 車輪アーチの切り欠きを頂点に適用する。
 * 車体側面の頂点を、ホイール中心からの距離に応じて内側へ押し込む。
 */
export function makeArchDeformer(
  wheels: Array<{ z: number; radius: number; archRadius: number; depth: number }>
): (p: THREE.Vector3, t: number, s: number) => void {
  return (p: THREE.Vector3, _t: number, _s: number) => {
    for (const w of wheels) {
      const dz = p.z - w.z;
      const dy = p.y - w.radius;
      const d = Math.sqrt(dz * dz + dy * dy);
      if (d > w.archRadius * 1.35) continue;
      // アーチ内側へ押し込む
      const k = 1 - smoothstep(w.archRadius * 0.72, w.archRadius * 1.15, d);
      if (k <= 0) continue;
      const push = w.depth * k;
      // 内側(= |x| を減らす)へ
      const sign = Math.sign(p.x) || 1;
      const inner = Math.max(0, Math.abs(p.x) - push);
      p.x = sign * inner;
    }
  };
}

/**
 * 三角形数を数える
 */
export function countTriangles(obj: THREE.Object3D): number {
  let tris = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry as THREE.BufferGeometry;
    const cnt = g.index ? g.index.count : g.getAttribute("position")?.count ?? 0;
    tris += cnt / 3;
  });
  return Math.round(tris);
}

export { clamp };
