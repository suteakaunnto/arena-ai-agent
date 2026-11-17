/**
 * world/Props.ts
 * 責務: 集落(都市1/町3/村6)の家屋・看板・電柱・農地・風車・灯台などの手続き生成。
 *       カメラ周辺のみ生成し、遠方は非表示にする。
 * 公開API: PropsBuilder
 * 依存: three, world/Terrain.ts, world/Road.ts, world/WorldConfig.ts, core/math.ts
 *
 * 設計メモ:
 *  - 建物は「箱 + 屋根」の組み合わせで、3 タイプ(平屋根/切妻/テラス)を用意。
 *  - 集落ごとに色パレットを変え、雰囲気の差を出す。
 *  - 電柱と電線は道路沿いに配置(遠景のスケール感を出す)。
 *  - InstancedMesh で描画し、ドローコールを抑える。
 */
import * as THREE from "three";
import { Rng, clamp01, lerp, TAU } from "../core/math.js";
import { Terrain } from "./Terrain.js";
import { RoadNetwork } from "./Road.js";
import { LANDMARKS, SETTLEMENTS, Settlement, WORLD } from "./WorldConfig.js";
import { mergeGeometries } from "./Vegetation.js";

interface BuildingInstances {
  walls: THREE.InstancedMesh;
  roofs: THREE.InstancedMesh;
  windows: THREE.InstancedMesh;
}

interface VillageGroup {
  settlement: Settlement;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  center: THREE.Vector3;
}

export class PropsBuilder {
  readonly group = new THREE.Group();
  private villages: VillageGroup[] = [];
  private materials: Record<string, THREE.Material> = {};
  private rng: Rng;
  private built = new Set<string>();

  constructor(private terrain: Terrain, private roads: RoadNetwork, seed = WORLD.seed + 555) {
    this.rng = new Rng(seed);
    this.group.name = "props";
    this.initMaterials();
    this.buildLandmarks();
  }

  private initMaterials(): void {
    this.materials.wallWarm = new THREE.MeshLambertMaterial({ color: 0xd8c8a8 });
    this.materials.wallWhite = new THREE.MeshLambertMaterial({ color: 0xe4dfd2 });
    this.materials.wallTerracotta = new THREE.MeshLambertMaterial({ color: 0xc48a62 });
    this.materials.wallConcrete = new THREE.MeshLambertMaterial({ color: 0xa8a49a });
    this.materials.roofRed = new THREE.MeshLambertMaterial({ color: 0x9c4a35 });
    this.materials.roofGray = new THREE.MeshLambertMaterial({ color: 0x5a5c60 });
    this.materials.roofMetal = new THREE.MeshLambertMaterial({ color: 0x8b8f93 });
    this.materials.window = new THREE.MeshLambertMaterial({ color: 0x2c3a44, emissive: 0x0a0d10 });
    this.materials.palmTrunk = new THREE.MeshLambertMaterial({ color: 0x7a6046 });
    this.materials.wood = new THREE.MeshLambertMaterial({ color: 0x6b563c });
    this.materials.metal = new THREE.MeshStandardMaterial({ color: 0xa8adb2, roughness: 0.45, metalness: 0.7 });
    this.materials.concrete = new THREE.MeshLambertMaterial({ color: 0xb0aca2 });
    this.materials.windmill = new THREE.MeshLambertMaterial({ color: 0xe2e0d8 });
    this.materials.lighthouse = new THREE.MeshLambertMaterial({ color: 0xe8e4dc });
    this.materials.lighthouseRed = new THREE.MeshLambertMaterial({ color: 0xb03a2e });
    this.materials.foliage = new THREE.MeshLambertMaterial({ color: 0x4a6b3a });
  }

  /* ------------------------ ランドマーク ------------------------ */

  private buildLandmarks(): void {
    for (const lm of LANDMARKS) {
      const h = this.terrain.heightAt(lm.x, lm.z);
      const g = new THREE.Group();
      g.position.set(lm.x, h, lm.z);
      if (lm.kind === "lighthouse") {
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.6, 24, 12), this.materials.lighthouse);
        tower.position.y = 12;
        g.add(tower);
        for (let i = 0; i < 3; i++) {
          const band = new THREE.Mesh(new THREE.CylinderGeometry(3.1 - i * 0.32, 3.1 - i * 0.32, 3.4, 12), this.materials.lighthouseRed);
          band.position.y = 6 + i * 7;
          g.add(band);
        }
        const lamp = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.4, 4.2, 12), this.materials.window);
        lamp.position.y = 26;
        g.add(lamp);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 2.6, 12), this.materials.roofRed);
        roof.position.y = 29.2;
        g.add(roof);
        const keeper = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 7), this.materials.wallWhite);
        keeper.position.set(9, 3, 2);
        g.add(keeper);
      } else if (lm.kind === "dam") {
        const dam = new THREE.Mesh(new THREE.BoxGeometry(520, 34, 26), this.materials.concrete);
        dam.position.y = -4;
        dam.rotation.y = 0.35;
        g.add(dam);
        const road = new THREE.Mesh(new THREE.BoxGeometry(560, 1.2, 22), this.materials.roofGray);
        road.position.y = 13.5;
        road.rotation.y = 0.35;
        g.add(road);
      } else if (lm.kind === "airstrip") {
        const runway = new THREE.Mesh(new THREE.BoxGeometry(34, 0.3, 1500), this.materials.roofGray);
        runway.position.y = 0.4;
        g.add(runway);
        for (let i = 0; i < 18; i++) {
          const mark = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.32, 26), this.materials.wallWhite);
          mark.position.set(0, 0.45, -700 + i * 80);
          g.add(mark);
        }
      } else if (lm.kind === "observatory") {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, 5, 16), this.materials.concrete);
        base.position.y = 2.5;
        g.add(base);
        const dome = new THREE.Mesh(new THREE.SphereGeometry(7.4, 18, 12, 0, TAU, 0, Math.PI / 2), this.materials.metal);
        dome.position.y = 5;
        g.add(dome);
      } else if (lm.kind === "ruins") {
        const rng = new Rng(WorldSeedRuin);
        for (let i = 0; i < 22; i++) {
          const w = rng.range(1.4, 4.2);
          const hh = rng.range(1.5, 7);
          const pillar = new THREE.Mesh(new THREE.BoxGeometry(w, hh, w), this.materials.wallTerracotta);
          const a = rng.range(0, TAU);
          const r = rng.range(6, 46);
          pillar.position.set(Math.cos(a) * r, hh / 2, Math.sin(a) * r);
          pillar.rotation.y = rng.range(0, TAU);
          g.add(pillar);
        }
        const altar = new THREE.Mesh(new THREE.CylinderGeometry(11, 13, 2.4, 8), this.materials.concrete);
        altar.position.y = 1.2;
        g.add(altar);
      }
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      this.group.add(g);
    }
  }

  /* ------------------------ 集落 ------------------------ */

  private buildSettlement(s: Settlement): VillageGroup | null {
    if (this.built.has(s.id)) return this.villages.find((v) => v.settlement.id === s.id) ?? null;
    this.built.add(s.id);
    const rng = new Rng(WORLD.seed + s.id.length * 7919 + Math.round(s.x));
    const g = new THREE.Group();
    g.name = `settlement_${s.id}`;
    const meshes: THREE.Mesh[] = [];

    const palettes: Record<Settlement["kind"], Array<"wallWarm" | "wallWhite" | "wallTerracotta" | "wallConcrete">> = {
      city: ["wallWhite", "wallConcrete", "wallWarm"],
      town: ["wallWarm", "wallTerracotta", "wallWhite"],
      village: ["wallTerracotta", "wallWarm"],
    };
    const roofPalettes: Record<Settlement["kind"], Array<"roofRed" | "roofGray" | "roofMetal">> = {
      city: ["roofGray", "roofMetal"],
      town: ["roofRed", "roofGray"],
      village: ["roofRed", "roofMetal"],
    };

    // 建物の生成(グリッド上の街区に沿わせる)
    const count = Math.min(s.buildings, s.kind === "city" ? 260 : s.kind === "town" ? 120 : 46);
    const wallBatches = new Map<string, Array<{ m: THREE.Matrix4; h: number; w: number }>>();
    const roofBatches = new Map<string, THREE.Matrix4[]>();
    const windowMats: THREE.Matrix4[] = [];

    let placed = 0;
    let guard = 0;
    while (placed < count && guard < count * 6) {
      guard++;
      // 中心からの距離で密度を変える(郊外ほどまばら)
      const a = rng.range(0, TAU);
      const rr = Math.sqrt(rng.next()) * s.radius;
      const x = s.x + Math.cos(a) * rr;
      const z = s.z + Math.sin(a) * rr;
      const h = this.terrain.heightAt(x, z);
      if (h < 3) continue;
      const slope = this.terrain.slopeAt(x, z);
      if (slope > 0.24) continue;
      // 道路の上は避ける
      const q = this.roads.nearest(x, z);
      if (q.distance < 14) continue;
      // 建物サイズ
      const kind = s.kind;
      const minS = kind === "city" ? 8 : kind === "town" ? 7 : 6;
      const maxS = kind === "city" ? 24 : kind === "town" ? 16 : 12;
      const w = rng.range(minS, maxS);
      const d = rng.range(minS, maxS) * rng.range(0.7, 1.2);
      const floors = kind === "city" ? rng.int(1, 6) : kind === "town" ? rng.int(1, 3) : 1;
      const bh = floors * 3.2 + 0.6;

      const m = new THREE.Matrix4();
      const q4 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, TAU));
      m.compose(new THREE.Vector3(x, h + bh / 2, z), q4, new THREE.Vector3(w, bh, d));

      const wallKey = rng.pick(palettes[kind]);
      const arrW = wallBatches.get(wallKey) ?? [];
      arrW.push({ m: m.clone(), h: bh, w });
      wallBatches.set(wallKey, arrW);

      // 屋根
      const roofKey = rng.pick(roofPalettes[kind]);
      const rm = new THREE.Matrix4();
      const roofH = kind === "city" ? 0.6 : 2.2;
      rm.compose(
        new THREE.Vector3(x, h + bh + roofH / 2, z),
        q4,
        new THREE.Vector3(w * 1.08, roofH, d * 1.08)
      );
      const arrR = roofBatches.get(roofKey) ?? [];
      arrR.push(rm.clone());
      roofBatches.set(roofKey, arrR);

      // 窓(前面に 2〜5 個)
      const winCount = Math.min(6, Math.floor(w / 3));
      for (let i = 0; i < winCount; i++) {
        for (let f = 0; f < floors; f++) {
          const wm = new THREE.Matrix4();
          const lx = -w / 2 + (i + 0.5) * (w / winCount);
          const ly = h + 1.2 + f * 3.2;
          const lz = d / 2 + 0.02;
          const v = new THREE.Vector3(lx, ly, lz).applyQuaternion(q4);
          wm.compose(
            new THREE.Vector3(x + v.x, ly, z + v.z),
            q4,
            new THREE.Vector3(1.2, 1.1, 0.1)
          );
          windowMats.push(wm.clone());
        }
      }
      placed++;
    }

    // バッチを実体化
    for (const [key, arr] of wallBatches) {
      const geom = new THREE.BoxGeometry(1, 1, 1);
      const mesh = new THREE.InstancedMesh(geom, this.materials[key] ?? this.materials.wallWarm, arr.length);
      arr.forEach((it, i) => {
        mesh.setMatrixAt(i, it.m);
        // 高さに応じた色のばらつき
        const c = new THREE.Color(1, 1, 1).multiplyScalar(0.82 + rng.next() * 0.3);
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      meshes.push(mesh);
    }
    for (const [key, arr] of roofBatches) {
      const geom = new THREE.BoxGeometry(1, 1, 1);
      const mesh = new THREE.InstancedMesh(geom, this.materials[key] ?? this.materials.roofRed, arr.length);
      arr.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      meshes.push(mesh);
    }
    if (windowMats.length > 0) {
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.materials.window, windowMats.length);
      windowMats.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      g.add(mesh);
      meshes.push(mesh);
    }

    // 街灯と電柱
    const poleGeom = new THREE.CylinderGeometry(0.16, 0.2, 9, 6);
    poleGeom.translate(0, 4.5, 0);
    const poles: THREE.Matrix4[] = [];
    const streetlights: THREE.Matrix4[] = [];
    for (let i = 0; i < Math.min(60, Math.round(s.radius / 12)); i++) {
      const a = rng.range(0, TAU);
      const r = rng.range(s.radius * 0.15, s.radius * 0.95);
      const x = s.x + Math.cos(a) * r;
      const z = s.z + Math.sin(a) * r;
      const h = this.terrain.heightAt(x, z);
      if (h < 3) continue;
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(x, h, z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      if (i % 3 === 0) streetlights.push(m.clone());
      else poles.push(m.clone());
    }
    if (poles.length) {
      const mesh = new THREE.InstancedMesh(poleGeom, this.materials.wood, poles.length);
      poles.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      g.add(mesh);
      meshes.push(mesh);
    }
    if (streetlights.length) {
      const lampGeom = new THREE.CylinderGeometry(0.1, 0.14, 7, 6);
      lampGeom.translate(0, 3.5, 0);
      const mesh = new THREE.InstancedMesh(lampGeom, this.materials.metal, streetlights.length);
      streetlights.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      g.add(mesh);
      meshes.push(mesh);
      // 笠
      const headGeom = new THREE.BoxGeometry(0.5, 0.16, 0.9);
      headGeom.translate(0, 7, 0.35);
      const heads = new THREE.InstancedMesh(headGeom, this.materials.metal, streetlights.length);
      streetlights.forEach((m, i) => heads.setMatrixAt(i, m));
      heads.instanceMatrix.needsUpdate = true;
      g.add(heads);
      meshes.push(heads);
    }

    // 農地(村・町のみ)
    if (s.kind !== "city") {
      const fieldGeom = new THREE.PlaneGeometry(1, 1);
      fieldGeom.rotateX(-Math.PI / 2);
      const fieldMat = new THREE.MeshLambertMaterial({ color: 0x7a8a3c, side: THREE.DoubleSide });
      const fields: THREE.Matrix4[] = [];
      for (let i = 0; i < 26; i++) {
        const a = rng.range(0, TAU);
        const r = rng.range(s.radius * 1.1, s.radius * 2.2);
        const x = s.x + Math.cos(a) * r;
        const z = s.z + Math.sin(a) * r;
        const h = this.terrain.heightAt(x, z);
        if (h < 3) continue;
        if (this.terrain.slopeAt(x, z) > 0.3) continue;
        const m = new THREE.Matrix4();
        m.compose(
          new THREE.Vector3(x, h + 0.08, z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, TAU)),
          new THREE.Vector3(rng.range(24, 70), 1, rng.range(24, 70))
        );
        fields.push(m.clone());
      }
      if (fields.length) {
        const mesh = new THREE.InstancedMesh(fieldGeom, fieldMat, fields.length);
        fields.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.receiveShadow = true;
        g.add(mesh);
        meshes.push(mesh);
      }
      // 風車(農地平原)
      if (s.kind === "village" || s.id === "el_rosario") {
        for (let i = 0; i < 3; i++) {
          const x = s.x + rng.range(-s.radius * 2, s.radius * 2);
          const z = s.z + rng.range(-s.radius * 2, s.radius * 2);
          const h = this.terrain.heightAt(x, z);
          if (h < 4) continue;
          const mill = new THREE.Group();
          mill.position.set(x, h, z);
          const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.6, 16, 8), this.materials.windmill);
          tower.position.y = 8;
          mill.add(tower);
          const blades = new THREE.Group();
          for (let b = 0; b < 4; b++) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 0.2), this.materials.windmill);
            blade.position.y = 3.5;
            const holder = new THREE.Group();
            holder.rotation.z = (b / 4) * TAU;
            holder.add(blade);
            blades.add(holder);
          }
          blades.position.set(0, 16, 2.2);
          mill.add(blades);
          mill.traverse((o) => {
            const mm = o as THREE.Mesh;
            if (mm.isMesh) mm.castShadow = true;
          });
          g.add(mill);
        }
      }
    }

    this.group.add(g);
    const vg: VillageGroup = { settlement: s, group: g, meshes, center: new THREE.Vector3(s.x, this.terrain.heightAt(s.x, s.z), s.z) };
    this.villages.push(vg);
    return vg;
  }

  /** カメラ位置に応じて集落を生成/表示 */
  update(focus: THREE.Vector3, _quality: number): void {
    for (const s of SETTLEMENTS) {
      const d = Math.hypot(s.x - focus.x, s.z - focus.z);
      const near = d < s.radius * 4 + 1400;
      const existing = this.villages.find((v) => v.settlement.id === s.id);
      if (near && !existing) {
        this.buildSettlement(s);
      } else if (existing) {
        const visible = d < s.radius * 4 + 2200;
        existing.group.visible = visible;
      }
    }
  }

  /** 事前生成(起動時のロードで呼ぶ) */
  primeAll(): void {
    for (const s of SETTLEMENTS) this.buildSettlement(s);
  }

  dispose(): void {
    for (const v of this.villages) {
      v.meshes.forEach((m) => {
        (m as THREE.InstancedMesh).geometry.dispose();
      });
    }
    this.villages.length = 0;
    for (const m of Object.values(this.materials)) m.dispose();
  }
}

const WorldSeedRuin = 991733;
export { clamp01, lerp };
