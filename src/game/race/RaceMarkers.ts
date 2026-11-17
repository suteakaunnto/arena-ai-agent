/**
 * race/RaceMarkers.ts
 * 責務: チェックポイント(ゲート)の 3D 表示。通過状態で色と発光を変える
 * 公開API: RaceMarkerSet
 * 依存: three, race/Circuit.ts
 *
 * 設計メモ:
 *  - ジオメトリは 3 本の柱(左右 + 上部バー)をまとめた 1 つの BufferGeometry にし、
 *    ゲートごとに 1 メッシュ。描画コールをゲート数(最大 24)に抑える。
 *  - 通過済みは発光を落として暗く、次のゲートは明るく点滅させる。
 *  - 「次のゲート」以外は半透明にして、遠目でも目標が分かるようにする。
 */
import * as THREE from "three";
import type { Circuit } from "./Circuit.js";

const COLOR_NEXT = new THREE.Color(0xff8a3d);
const COLOR_DONE = new THREE.Color(0x2f6f4f);
const COLOR_IDLE = new THREE.Color(0x4a6a80);

export class RaceMarkerSet {
  readonly group = new THREE.Group();
  private circuit: Circuit | null = null;
  private meshes: THREE.Mesh[] = [];
  private materials: THREE.MeshBasicMaterial[] = [];
  private geometry: THREE.BufferGeometry | null = null;
  private elapsed = 0;
  /** 表示するか。setCircuit 時に group.visible へ反映する */
  private shown = true;

  constructor() {
    this.group.name = "race_gates";
    this.group.visible = false;
  }

  /** コースを差し替える。null で非表示。 */
  setCircuit(circuit: Circuit | null): void {
    if (this.circuit === circuit) return;
    this.disposeMarkers();
    this.circuit = circuit;
    if (!circuit) {
      this.group.visible = false;
      return;
    }
    this.buildMarkers(circuit);
    this.group.visible = this.shown;
  }

  /** 通過状態を反映する。毎フレーム呼ぶ。 */
  update(dt: number, nextGate: number): void {
    if (!this.circuit || this.meshes.length === 0) return;
    this.elapsed += dt;
    // 点滅: 1.6 秒周期で 0.55〜1.0
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.elapsed * 3.9));
    for (let i = 0; i < this.meshes.length; i++) {
      const mat = this.materials[i];
      if (i === nextGate) {
        mat.color.copy(COLOR_NEXT);
        mat.opacity = pulse;
      } else {
        mat.color.copy(i < nextGate ? COLOR_DONE : COLOR_IDLE);
        mat.opacity = 0.3;
      }
    }
  }

  setVisible(v: boolean): void {
    this.shown = v;
    this.group.visible = v && this.circuit !== null;
  }

  private buildMarkers(circuit: Circuit): void {
    const geo = this.buildGateGeometry();
    this.geometry = geo;
    for (const gate of circuit.gates) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      this.materials.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      // ゲートの向き: 進行方向(tx,tz)が +Z になるように回す
      mesh.position.set(gate.x, gate.y, gate.z);
      mesh.rotation.y = Math.atan2(gate.tx, gate.tz);
      // ゲート幅に合わせて横に伸ばす(基準幅 10m)
      const w = gate.width / 10;
      mesh.scale.set(w, 1, 1);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    this.group.visible = this.shown;
  }

  /**
   * 基準ゲート(幅 10m / 高さ 5.5m)の形状。
   *  左右の柱と上部のバーで「門」の形にする。地面側は少し埋める。
   */
  private buildGateGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const half = 5;
    const height = 5.5;
    const post = 0.28;
    const left = new THREE.BoxGeometry(post, height, post);
    left.translate(-half, height * 0.5 - 0.3, 0);
    const right = new THREE.BoxGeometry(post, height, post);
    right.translate(half, height * 0.5 - 0.3, 0);
    const bar = new THREE.BoxGeometry(half * 2 + post, 0.5, post);
    bar.translate(0, height - 0.55, 0);
    parts.push(left, right, bar);
    // 地面の横線(通過位置が分かるように)
    const base = new THREE.BoxGeometry(half * 2, 0.08, 0.9);
    base.translate(0, 0.04, 0);
    parts.push(base);

    // 手動でマージする(three の mergeGeometries はアドオンなので使わない)
    let totalVerts = 0;
    let totalIdx = 0;
    for (const g of parts) {
      totalVerts += g.getAttribute("position").count;
      totalIdx += g.getIndex() ? g.getIndex()!.count : 0;
    }
    const pos = new Float32Array(totalVerts * 3);
    const index = new Uint16Array(totalIdx);
    let vOff = 0;
    let iOff = 0;
    for (const g of parts) {
      const p = g.getAttribute("position");
      const arr = p.array as Float32Array;
      pos.set(arr, vOff * 3);
      const gi = g.getIndex()!;
      const ia = gi.array as ArrayLike<number>;
      for (let k = 0; k < gi.count; k++) index[iOff + k] = ia[k] + vOff;
      vOff += p.count;
      iOff += gi.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    out.setIndex(new THREE.BufferAttribute(index, 1));
    out.computeBoundingSphere();
    return out;
  }

  private disposeMarkers(): void {
    for (const m of this.meshes) this.group.remove(m);
    for (const m of this.materials) m.dispose();
    this.meshes = [];
    this.materials = [];
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
  }

  dispose(): void {
    this.disposeMarkers();
    this.circuit = null;
    this.group.visible = false;
  }
}
