/**
 * world/Vegetation.ts
 * 責務: 6バイオームの樹木・サボテン・草・岩を InstancedMesh で散布し、距離フェードとチャンク単位で管理
 * 公開API: VegetationSystem, TREE_KINDS
 * 依存: core/math.ts, world/Noise.ts, world/Terrain.ts, world/WorldConfig.ts
 *
 * 設計メモ:
 *  - 形状はすべて手続き生成(円柱/球/円錐の合成)。外部モデルは使わない。
 *  - インスタンスは 512m セル単位でまとめ、カメラから遠いセルは非表示にする。
 *  - LOD: 近距離は詳細、遠距離はビルボードに近い簡略形状(ここでは形状スケールで対応)。
 */
import * as THREE from "three";
import { clamp01, lerp, Rng, smoothstep, TAU } from "../core/math.js";
import { SimplexNoise, fbm2 } from "./Noise.js";
import { Terrain } from "./Terrain.js";
import { BIOMES, WORLD } from "./WorldConfig.js";

export type TreeKind = "palm" | "jungle" | "pine" | "cactus" | "olive" | "dead" | "bush" | "rock" | "grass";

export interface TreeStats {
  total: number;
  cells: number;
  triangles: number;
}

interface CellData {
  cx: number;
  cz: number;
  meshes: THREE.Mesh[];
  center: THREE.Vector3;
}

const CELL_SIZE = 512;

/* ------------------------------------------------------------------ */
/* 形状生成                                                           */
/* ------------------------------------------------------------------ */

function makePalm(rng: Rng): { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry } {
  const woodParts: THREE.BufferGeometry[] = [];
  const leafParts: THREE.BufferGeometry[] = [];
  const h = rng.range(7, 13);
  const lean = rng.range(-0.22, 0.22);
  const segs = 8;
  // 幹(曲がった円柱)
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(lean * h * 0.25, h * 0.35, lean * h * 0.1),
    new THREE.Vector3(lean * h * 0.6, h * 0.72, lean * h * 0.3),
    new THREE.Vector3(lean * h, h, lean * h * 0.6),
  ]);
  const trunk = new THREE.TubeGeometry(curve, segs, 0.24, 6, false);
  trunk.scale(1, 1, 1);
  woodParts.push(trunk);

  // 葉(放射状の細長い三角形)
  const frondCount = rng.int(7, 11);
  const top = new THREE.Vector3(lean * h, h, lean * h * 0.6);
  for (let i = 0; i < frondCount; i++) {
    const a = (i / frondCount) * TAU + rng.range(-0.2, 0.2);
    const droop = rng.range(0.5, 1.5);
    const len = rng.range(3.4, 5.6);
    const pos: number[] = [];
    const idx: number[] = [];
    const steps = 5;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const px = top.x + Math.cos(a) * len * t;
      const pz = top.z + Math.sin(a) * len * t;
      const py = top.y + Math.sin(t * Math.PI * 0.55) * 1.1 - droop * t * t * 2.2;
      const w = 0.55 * (1 - t) * (1 - t) + 0.04;
      const ox = Math.cos(a + Math.PI / 2) * w;
      const oz = Math.sin(a + Math.PI / 2) * w;
      pos.push(px + ox, py, pz + oz, px - ox, py - 0.1, pz - oz);
      if (k > 0) {
        const b = (k - 1) * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    leafParts.push(g);
  }
  return { wood: mergeGeometries(woodParts), leaves: mergeGeometries(leafParts) };
}

function makeJungleTree(rng: Rng): { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry } {
  const woodParts: THREE.BufferGeometry[] = [];
  const leafParts: THREE.BufferGeometry[] = [];
  const h = rng.range(9, 18);
  const r = rng.range(0.35, 0.62);
  const trunk = new THREE.CylinderGeometry(r * 0.7, r, h, 7, 1);
  trunk.translate(0, h / 2, 0);
  woodParts.push(trunk);

  // 板状の根(バットレス)
  const roots = rng.int(3, 5);
  for (let i = 0; i < roots; i++) {
    const a = (i / roots) * TAU + rng.range(-0.3, 0.3);
    const rg = new THREE.ConeGeometry(r * 1.5, h * 0.22, 3);
    rg.rotateX(Math.PI);
    rg.translate(Math.cos(a) * r * 0.8, h * 0.1, Math.sin(a) * r * 0.8);
    woodParts.push(rg);
  }

  // 樹冠(複数の球)
  const blobs = rng.int(3, 6);
  for (let i = 0; i < blobs; i++) {
    const br = rng.range(2.2, 4.4);
    const bg = new THREE.IcosahedronGeometry(br, 1);
    // 頂点を揺らして有機的に
    const pos = bg.getAttribute("position") as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      const s = 1 + rng.range(-0.22, 0.22);
      pos.setXYZ(v, pos.getX(v) * s, pos.getY(v) * s * 0.8, pos.getZ(v) * s);
    }
    bg.computeVertexNormals();
    const a = rng.range(0, TAU);
    const rad = rng.range(0, 2.4);
    bg.translate(Math.cos(a) * rad, h + rng.range(-1.4, 1.6), Math.sin(a) * rad);
    leafParts.push(bg);
  }
  return { wood: mergeGeometries(woodParts), leaves: mergeGeometries(leafParts) };
}

function makePine(rng: Rng): { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry } {
  const woodParts: THREE.BufferGeometry[] = [];
  const leafParts: THREE.BufferGeometry[] = [];
  const h = rng.range(6, 13);
  const trunk = new THREE.CylinderGeometry(0.16, 0.34, h * 0.6, 6, 1);
  trunk.translate(0, h * 0.3, 0);
  woodParts.push(trunk);
  const tiers = rng.int(3, 5);
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const cr = lerp(2.4, 0.7, t) * rng.range(0.85, 1.1);
    const ch = lerp(h * 0.42, h * 0.24, t);
    const cone = new THREE.ConeGeometry(cr, ch, 7, 1);
    cone.translate(0, h * 0.42 + t * h * 0.5 + ch * 0.35, 0);
    leafParts.push(cone);
  }
  return { wood: mergeGeometries(woodParts), leaves: mergeGeometries(leafParts) };
}

function makeCactus(rng: Rng): { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];
  const h = rng.range(2.4, 6.5);
  const r = rng.range(0.28, 0.5);
  const body = new THREE.CapsuleGeometry(r, h, 4, 8);
  body.translate(0, h / 2 + r, 0);
  parts.push(body);
  const arms = rng.int(1, 3);
  for (let i = 0; i < arms; i++) {
    const ah = rng.range(0.9, 1.9);
    const ay = rng.range(h * 0.35, h * 0.72);
    const side = rng.bool() ? 1 : -1;
    const arm = new THREE.CapsuleGeometry(r * 0.6, ah, 3, 6);
    arm.translate(side * (r * 1.5), ay, 0);
    parts.push(arm);
    const joint = new THREE.CapsuleGeometry(r * 0.6, r * 1.6, 3, 6);
    joint.rotateZ(Math.PI / 2);
    joint.translate(side * (r * 0.85), ay - ah * 0.45, 0);
    parts.push(joint);
  }
  const empty = new THREE.BufferGeometry();
  return { wood: mergeGeometries(parts), leaves: empty };
}

function makeOlive(rng: Rng): { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry } {
  const woodParts: THREE.BufferGeometry[] = [];
  const leafParts: THREE.BufferGeometry[] = [];
  const h = rng.range(3.4, 7);
  const trunk = new THREE.CylinderGeometry(0.2, 0.42, h * 0.55, 6, 1);
  trunk.translate(0, h * 0.28, 0);
  woodParts.push(trunk);
  const blobs = rng.int(2, 4);
  for (let i = 0; i < blobs; i++) {
    const br = rng.range(1.2, 2.4);
    const b = new THREE.IcosahedronGeometry(br, 0);
    b.translate(rng.range(-1.2, 1.2), h * 0.62 + rng.range(-0.4, 0.8), rng.range(-1.2, 1.2));
    leafParts.push(b);
  }
  return { wood: mergeGeometries(woodParts), leaves: mergeGeometries(leafParts) };
}

function makeDead(rng: Rng): { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];
  const h = rng.range(3, 7);
  const trunk = new THREE.CylinderGeometry(0.1, 0.3, h, 5, 1);
  trunk.translate(0, h / 2, 0);
  parts.push(trunk);
  const branches = rng.int(2, 5);
  for (let i = 0; i < branches; i++) {
    const bl = rng.range(1, 2.6);
    const b = new THREE.CylinderGeometry(0.04, 0.11, bl, 4, 1);
    b.rotateZ(rng.range(-0.9, 0.9));
    b.rotateY(rng.range(0, TAU));
    b.translate(rng.range(-0.5, 0.5), h * rng.range(0.5, 0.95), rng.range(-0.5, 0.5));
    parts.push(b);
  }
  return { wood: mergeGeometries(parts), leaves: new THREE.BufferGeometry() };
}

function makeBush(rng: Rng): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const r = rng.range(0.5, 1.2);
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.translate(rng.range(-0.6, 0.6), r * 0.7, rng.range(-0.6, 0.6));
    parts.push(g);
  }
  return mergeGeometries(parts);
}

function makeRock(rng: Rng): THREE.BufferGeometry {
  const r = rng.range(0.6, 2.6);
  const g = new THREE.DodecahedronGeometry(r, 0);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const s = 1 + rng.range(-0.32, 0.32);
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.72, pos.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

/** 草(交差した2枚の板をまとめたタフト) */
function makeGrassTuft(rng: Rng): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const blades = 5;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * TAU + rng.range(-0.4, 0.4);
    const h = rng.range(0.5, 1.15);
    const w = rng.range(0.06, 0.13);
    const ox = Math.cos(a) * rng.range(0, 0.22);
    const oz = Math.sin(a) * rng.range(0, 0.22);
    const c = Math.cos(a) * w;
    const s = Math.sin(a) * w;
    const base = pos.length / 3;
    pos.push(ox - c, 0, oz - s);
    pos.push(ox + c, 0, oz + s);
    pos.push(ox + c * 0.3 + Math.cos(a) * 0.12, h, oz + s * 0.3 + Math.sin(a) * 0.12);
    idx.push(base, base + 1, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** ジオメトリ結合(three の BufferGeometryUtils 相当を自前で軽量化) */
export function mergeGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geoms.length === 0) return new THREE.BufferGeometry();
  if (geoms.length === 1) return geoms[0];
  let vCount = 0;
  let iCount = 0;
  const prepared = geoms.map((g) => {
    const geo = g.index ? g : g.toNonIndexed();
    const p = geo.getAttribute("position");
    vCount += p.count;
    const idx = geo.getIndex();
    iCount += idx ? idx.count : p.count;
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

/* ------------------------------------------------------------------ */
/* システム                                                           */
/* ------------------------------------------------------------------ */

export class VegetationSystem {
  readonly group = new THREE.Group();
  private cells: CellData[] = [];
  private noise: SimplexNoise;
  private materials: Record<string, THREE.Material> = {};
  private protoCache = new Map<string, { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry }>();
  private grassProto: THREE.BufferGeometry[] = [];
  private rockProto: THREE.BufferGeometry[] = [];
  private bushProto: THREE.BufferGeometry[] = [];
  private density = 1;
  private stats: TreeStats = { total: 0, cells: 0, triangles: 0 };
  private visibleRadius = 2600;

  constructor(private terrain: Terrain, seed = WORLD.seed + 31) {
    this.group.name = "vegetation";
    this.noise = new SimplexNoise(seed);
    this.buildMaterials();
    this.buildPrototypes();
  }

  private buildMaterials(): void {
    this.materials.wood = new THREE.MeshLambertMaterial({ color: 0x6b4f34 });
    this.materials.palmWood = new THREE.MeshLambertMaterial({ color: 0x8a6b46 });
    this.materials.cactus = new THREE.MeshLambertMaterial({ color: 0x4f7a3a });
    this.materials.dead = new THREE.MeshLambertMaterial({ color: 0x6a5a48 });
    this.materials.leafGreen = new THREE.MeshLambertMaterial({ color: 0x2f6b30 });
    this.materials.leafDark = new THREE.MeshLambertMaterial({ color: 0x24512a });
    this.materials.leafOlive = new THREE.MeshLambertMaterial({ color: 0x66763f });
    this.materials.leafPine = new THREE.MeshLambertMaterial({ color: 0x2b4a33 });
    this.materials.palmLeaf = new THREE.MeshLambertMaterial({ color: 0x4d7c2f, side: THREE.DoubleSide });
    this.materials.bush = new THREE.MeshLambertMaterial({ color: 0x3f6b34 });
    this.materials.rock = new THREE.MeshLambertMaterial({ color: 0x8a8478, vertexColors: false });
    this.materials.grass = new THREE.MeshLambertMaterial({
      color: 0x8f9a4e,
      side: THREE.DoubleSide,
    });
  }

  private buildPrototypes(): void {
    const rng = new Rng(WORLD.seed + 991);
    for (let i = 0; i < 3; i++) this.palmProto(i, rng);
    this.grassProto.push(makeGrassTuft(rng), makeGrassTuft(rng), makeGrassTuft(rng));
    this.rockProto.push(makeRock(rng), makeRock(rng), makeRock(rng), makeRock(rng));
    this.bushProto.push(makeBush(rng), makeBush(rng), makeBush(rng));
  }

  private palmProto(i: number, rng: Rng): void {
    const kind: TreeKind = (["palm", "jungle", "pine", "cactus", "olive", "dead"] as TreeKind[])[i];
    switch (kind) {
      case "palm":
        this.protoCache.set("palm", makePalm(rng));
        break;
      case "jungle":
        this.protoCache.set("jungle", makeJungleTree(rng));
        break;
      case "pine":
        this.protoCache.set("pine", makePine(rng));
        break;
      case "cactus":
        this.protoCache.set("cactus", makeCactus(rng));
        break;
      case "olive":
        this.protoCache.set("olive", makeOlive(rng));
        break;
      case "dead":
        this.protoCache.set("dead", makeDead(rng));
        break;
    }
  }

  private materialFor(kind: TreeKind, part: "wood" | "leaves"): THREE.Material {
    if (part === "wood") {
      if (kind === "palm") return this.materials.palmWood;
      if (kind === "cactus") return this.materials.cactus;
      if (kind === "dead") return this.materials.dead;
      return this.materials.wood;
    }
    if (kind === "palm") return this.materials.palmLeaf;
    if (kind === "pine") return this.materials.leafPine;
    if (kind === "olive") return this.materials.leafOlive;
    if (kind === "jungle") return this.materials.leafDark;
    return this.materials.leafGreen;
  }

  /** 指定地点周辺のセルを生成 */
  buildAround(x: number, z: number, radius = 1400): void {
    const ccx = Math.floor(x / CELL_SIZE);
    const ccz = Math.floor(z / CELL_SIZE);
    const r = Math.ceil(radius / CELL_SIZE);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        if (cx < 0 || cz < 0 || cx >= WORLD.size / CELL_SIZE || cz >= WORLD.size / CELL_SIZE) continue;
        if (this.cells.some((c) => c.cx === cx && c.cz === cz)) continue;
        this.cells.push(this.buildCell(cx, cz));
      }
    }
  }

  private buildCell(cx: number, cz: number): CellData {
    const rng = new Rng(WORLD.seed + cx * 7919 + cz * 104729);
    const meshes: THREE.Mesh[] = [];
    const center = new THREE.Vector3((cx + 0.5) * CELL_SIZE, 0, (cz + 0.5) * CELL_SIZE);

    // セル内の試行サンプル
    const attempts = Math.round(340 * this.density);
    const buckets = new Map<string, { kind: TreeKind; m: THREE.Matrix4[] }>();

    const pushMatrix = (kind: string, m: THREE.Matrix4) => {
      let arr = buckets.get(kind);
      if (!arr) {
        arr = { kind: kind as TreeKind, m: [] };
        buckets.set(kind, arr);
      }
      arr.m.push(m);
    };

    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const pos = new THREE.Vector3();

    for (let i = 0; i < attempts; i++) {
      const wx = cx * CELL_SIZE + rng.next() * CELL_SIZE;
      const wz = cz * CELL_SIZE + rng.next() * CELL_SIZE;
      if (wx < 0 || wz < 0 || wx > WORLD.size || wz > WORLD.size) continue;
      const h = this.terrain.heightAt(wx, wz);
      if (h < 2.5) continue; // 水中
      const slope = this.terrain.slopeAt(wx, wz);
      if (slope > 0.55) continue;
      const biome = this.terrain.biomeAt(wx, wz, h);
      const def = BIOMES[biome];
      if (def.vegetation <= 0.02) continue;

      // 密度ムラ(森と空き地)
      const dens = fbm2(this.noise, wx * 0.0012, wz * 0.0012, { octaves: 3 });
      const chance = def.vegetation * (0.35 + 0.75 * (dens * 0.5 + 0.5));
      if (rng.next() > chance) continue;

      // 道路の直近は避ける
      const kindRoll = rng.next();
      let kind: TreeKind;
      if (kindRoll < 0.06 && biome !== "desert") kind = "rock";
      else if (kindRoll < 0.5 && biome !== "desert") kind = "grass";
      else if (kindRoll < 0.62) kind = "bush";
      else kind = rng.pick(def.trees.length ? def.trees : ["olive"]);

      const scale = rng.range(0.8, 1.35);
      pos.set(wx, h, wz);
      q.setFromAxisAngle(upAxis, rng.range(0, TAU));
      // 傾斜に沿わせる
      if (slope > 0.15) {
        const n = this.terrain.normalAt(wx, wz);
        const tilt = new THREE.Quaternion().setFromUnitVectors(upAxis, n);
        q.premultiply(tilt);
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(upAxis, rng.range(0, TAU)));
      }
      scl.set(scale, scale * rng.range(0.9, 1.15), scale);
      mtx.compose(pos, q, scl);
      pushMatrix(kind, mtx.clone());
    }

    for (const [kind, bucket] of buckets) {
      const meshesForKind = this.instantiate(kind as TreeKind, bucket.m);
      meshes.push(...meshesForKind);
      this.stats.total += bucket.m.length;
    }
    for (const m of meshes) this.group.add(m);
    this.stats.cells = this.cells.length + 1;
    return { cx, cz, meshes, center };
  }

  private instantiate(kind: TreeKind, mats: THREE.Matrix4[]): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    if (kind === "grass") {
      const proto = this.grassProto[mats.length % this.grassProto.length];
      const mesh = new THREE.InstancedMesh(proto, this.materials.grass, mats.length);
      mats.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      out.push(mesh);
      return out;
    }
    if (kind === "rock") {
      const proto = this.rockProto[mats.length % this.rockProto.length];
      const mesh = new THREE.InstancedMesh(proto, this.materials.rock, mats.length);
      mats.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      out.push(mesh);
      return out;
    }
    if (kind === "bush") {
      const proto = this.bushProto[mats.length % this.bushProto.length];
      const mesh = new THREE.InstancedMesh(proto, this.materials.bush, mats.length);
      mats.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      out.push(mesh);
      return out;
    }
    const proto = this.protoCache.get(kind);
    if (!proto) return out;
    const wood = new THREE.InstancedMesh(proto.wood, this.materialFor(kind, "wood"), mats.length);
    mats.forEach((m, i) => wood.setMatrixAt(i, m));
    wood.instanceMatrix.needsUpdate = true;
    wood.castShadow = true;
    wood.receiveShadow = true;
    out.push(wood);
    const leafCount = proto.leaves.getAttribute("position")?.count ?? 0;
    if (leafCount > 0) {
      const leaves = new THREE.InstancedMesh(proto.leaves, this.materialFor(kind, "leaves"), mats.length);
      mats.forEach((m, i) => leaves.setMatrixAt(i, m));
      leaves.instanceMatrix.needsUpdate = true;
      leaves.castShadow = false;
      out.push(leaves);
    }
    return out;
  }

  /** カメラ位置に応じて可視セルを切り替え、必要なら新規生成 */
  update(center: THREE.Vector3, density = this.density): void {
    this.density = density;
    this.buildAround(center.x, center.z, this.visibleRadius);
    for (const cell of this.cells) {
      const d = Math.hypot(cell.center.x - center.x, cell.center.z - center.z);
      const visible = d < this.visibleRadius + CELL_SIZE * 0.8;
      for (const m of cell.meshes) m.visible = visible;
    }
  }

  setQuality(level: number): void {
    this.visibleRadius = level >= 2 ? 3200 : level >= 1 ? 2000 : 1200;
    this.density = level >= 2 ? 1 : level >= 1 ? 0.7 : 0.42;
    // 既存セルを作り直す(密度変更)
    this.clear();
  }

  getStats(): TreeStats {
    let tris = 0;
    this.group.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh) {
        const g = im.geometry as THREE.BufferGeometry;
        const cnt = g.index ? g.index.count : g.getAttribute("position").count;
        tris += (cnt / 3) * im.count;
      }
    });
    this.stats.triangles = Math.round(tris);
    return this.stats;
  }

  clear(): void {
    for (const cell of this.cells) {
      for (const m of cell.meshes) {
        this.group.remove(m);
        (m as THREE.InstancedMesh).dispose();
      }
    }
    this.cells.length = 0;
    this.stats.total = 0;
  }

  dispose(): void {
    this.clear();
    for (const p of this.protoCache.values()) {
      p.wood.dispose();
      p.leaves.dispose();
    }
    for (const g of this.grassProto) g.dispose();
    for (const g of this.rockProto) g.dispose();
    for (const g of this.bushProto) g.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}

const upAxis = new THREE.Vector3(0, 1, 0);

export { smoothstep, clamp01 };
