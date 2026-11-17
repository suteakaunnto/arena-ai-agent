/**
 * render/Particles.ts
 * 責務: タイヤの煙・砂埃・雨・火花を Points でまとめて描画(プール方式)
 * 公開API: ParticleSystem, ParticleKind
 * 依存: three, core/math.ts
 *
 * 設計メモ:
 *  - 1種類につき1つの Points + 1つのプール。シェーダでサイズ減衰・フェードを行う。
 *  - パーティクルは CPU で更新(数千個まで)。ビルボードはシェーダで対応。
 *  - 品質プリセットで最大数を変える。
 */
import * as THREE from "three";
import { clamp01, Rng } from "../core/math.js";

export type ParticleKind = "smoke" | "dust" | "rain" | "spark" | "water";

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uPixelRatio;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uSoft;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float a = smoothstep(0.5, uSoft, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

interface Pool {
  kind: ParticleKind;
  points: THREE.Points;
  max: number;
  count: number;
  pos: Float32Array;
  vel: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
  color: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  gravity: number;
  drag: number;
  grow: number;
}

export class ParticleSystem {
  readonly group = new THREE.Group();
  private pools = new Map<ParticleKind, Pool>();
  private rng = new Rng(4242);
  private pixelRatio: number;
  private density = 1;

  constructor(pixelRatio = 1) {
    this.group.name = "particles";
    this.pixelRatio = pixelRatio;
    this.createPool("smoke", 420, 0.4, 1.6, 2.2, new THREE.Color(0.86, 0.86, 0.88), 0.45);
    this.createPool("dust", 420, 1.1, 1.9, 2.6, new THREE.Color(0.72, 0.62, 0.46), 0.35);
    this.createPool("spark", 160, 2.2, 0.5, 0.2, new THREE.Color(1.0, 0.72, 0.3), 0.75);
    this.createPool("rain", 900, 7.0, 0.28, 0.4, new THREE.Color(0.72, 0.82, 0.92), 0.25);
    this.createPool("water", 260, 1.2, 1.2, 1.6, new THREE.Color(0.8, 0.88, 0.94), 0.4);
  }

  private createPool(
    kind: ParticleKind,
    max: number,
    gravity: number,
    baseSize: number,
    grow: number,
    color: THREE.Color,
    drag: number
  ): void {
    const pos = new Float32Array(max * 3);
    const size = new Float32Array(max);
    const alpha = new Float32Array(max);
    const col = new Float32Array(max * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geom.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
    geom.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPixelRatio: { value: this.pixelRatio },
        uSoft: { value: kind === "spark" ? 0.1 : 0.34 },
      },
      transparent: true,
      depthWrite: false,
      blending: kind === "spark" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(geom, mat);
    points.frustumCulled = false;
    points.renderOrder = 10;
    this.group.add(points);
    this.pools.set(kind, {
      kind,
      points,
      max,
      count: 0,
      pos,
      vel: new Float32Array(max * 3),
      size,
      alpha,
      color: col,
      life: new Float32Array(max),
      maxLife: new Float32Array(max),
      gravity,
      drag,
      grow,
    });
    // 初期色
    for (let i = 0; i < max; i++) {
      col[i * 3] = color.r;
      col[i * 3 + 1] = color.g;
      col[i * 3 + 2] = color.b;
    }
    void baseSize;
  }

  setDensity(d: number): void {
    this.density = clamp01(d);
    for (const pool of this.pools.values()) {
      pool.points.visible = this.density > 0.01;
    }
  }

  setPixelRatio(v: number): void {
    this.pixelRatio = v;
    for (const pool of this.pools.values()) {
      (pool.points.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = v;
    }
  }

  /** パーティクルを1個放出 */
  emit(
    kind: ParticleKind,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    life: number
  ): void {
    const pool = this.pools.get(kind);
    if (!pool) return;
    if (pool.count >= Math.floor(pool.max * Math.max(0.2, this.density))) return;
    const i = pool.count++;
    pool.pos[i * 3] = x;
    pool.pos[i * 3 + 1] = y;
    pool.pos[i * 3 + 2] = z;
    pool.vel[i * 3] = vx;
    pool.vel[i * 3 + 1] = vy;
    pool.vel[i * 3 + 2] = vz;
    pool.size[i] = size;
    pool.life[i] = life;
    pool.maxLife[i] = life;
    pool.alpha[i] = 1;
  }

  /** タイヤのスリップから煙/砂埃を出す */
  emitTireSmoke(
    x: number,
    y: number,
    z: number,
    intensity: number,
    surfaceKind: "paved" | "dirt" | "sand" | "grass" | "water",
    forward: THREE.Vector3,
    speed: number
  ): void {
    if (intensity < 0.12) return;
    const n = Math.round(intensity * 3 * Math.max(0.3, this.density));
    for (let i = 0; i < n; i++) {
      const kind: ParticleKind =
        surfaceKind === "sand" || surfaceKind === "dirt" || surfaceKind === "grass"
          ? "dust"
          : surfaceKind === "water"
            ? "water"
            : "smoke";
      const spread = 1.1;
      const vx = -forward.x * speed * 0.10 + this.rng.signed() * spread;
      const vz = -forward.z * speed * 0.10 + this.rng.signed() * spread;
      const vy = 0.6 + this.rng.next() * 1.4;
      this.emit(
        kind,
        x + this.rng.signed() * 0.2,
        y + 0.12,
        z + this.rng.signed() * 0.2,
        vx,
        vy,
        vz,
        0.55 + this.rng.next() * 0.7 * intensity,
        0.75 + this.rng.next() * 0.9
      );
    }
  }

  /** 火花(衝突) */
  emitSparks(x: number, y: number, z: number, count: number, strength: number): void {
    for (let i = 0; i < count; i++) {
      this.emit(
        "spark",
        x,
        y,
        z,
        this.rng.signed() * 6 * strength,
        2 + this.rng.next() * 5 * strength,
        this.rng.signed() * 6 * strength,
        0.08 + this.rng.next() * 0.1,
        0.3 + this.rng.next() * 0.35
      );
    }
  }

  /** 雨(カメラ周辺に降らせる) */
  updateRain(dt: number, center: THREE.Vector3, intensity: number, cameraForward: THREE.Vector3): void {
    const pool = this.pools.get("rain")!;
    if (intensity < 0.02) {
      pool.points.visible = false;
      return;
    }
    pool.points.visible = true;
    const targetCount = Math.floor(pool.max * intensity * 0.7 * Math.max(0.3, this.density));
    while (pool.count < targetCount) {
      const i = pool.count++;
      const r = 34;
      pool.pos[i * 3] = center.x + (this.rng.next() - 0.5) * r * 2 + cameraForward.x * 16;
      pool.pos[i * 3 + 1] = center.y + 10 + this.rng.next() * 14;
      pool.pos[i * 3 + 2] = center.z + (this.rng.next() - 0.5) * r * 2 + cameraForward.z * 16;
      pool.vel[i * 3] = cameraForward.x * 3;
      pool.vel[i * 3 + 1] = -26 - this.rng.next() * 8;
      pool.vel[i * 3 + 2] = cameraForward.z * 3;
      pool.size[i] = 0.16;
      pool.life[i] = 1.6;
      pool.maxLife[i] = 1.6;
      pool.alpha[i] = 0.5;
    }
  }

  update(dt: number, cameraPos: THREE.Vector3): void {
    for (const pool of this.pools.values()) {
      if (!pool.points.visible) continue;
      const { pos, vel, life, maxLife, alpha, size } = pool;
      let write = 0;
      for (let i = 0; i < pool.count; i++) {
        life[i] -= dt;
        if (life[i] <= 0) continue;
        // 移動
        vel[i * 3 + 1] += pool.gravity * dt * (pool.kind === "rain" || pool.kind === "spark" ? 1 : -0.35);
        const dragK = 1 - clamp01(pool.drag * dt);
        vel[i * 3] *= dragK;
        vel[i * 3 + 1] *= pool.kind === "rain" ? 1 : dragK;
        vel[i * 3 + 2] *= dragK;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        // サイズ成長
        size[i] += pool.grow * dt * (pool.kind === "spark" ? -0.4 : 1);
        if (size[i] < 0.02) size[i] = 0.02;
        alpha[i] = clamp01(life[i] / maxLife[i]) * (pool.kind === "rain" ? 0.45 : 0.7);

        // 圧縮(書き戻し)
        if (write !== i) {
          pos[write * 3] = pos[i * 3];
          pos[write * 3 + 1] = pos[i * 3 + 1];
          pos[write * 3 + 2] = pos[i * 3 + 2];
          vel[write * 3] = vel[i * 3];
          vel[write * 3 + 1] = vel[i * 3 + 1];
          vel[write * 3 + 2] = vel[i * 3 + 2];
          size[write] = size[i];
          alpha[write] = alpha[i];
          life[write] = life[i];
          maxLife[write] = maxLife[i];
          pool.color[write * 3] = pool.color[i * 3];
          pool.color[write * 3 + 1] = pool.color[i * 3 + 1];
          pool.color[write * 3 + 2] = pool.color[i * 3 + 2];
        }
        write++;
      }
      for (let i = write; i < pool.count; i++) alpha[i] = 0;
      pool.count = write;
      const geom = pool.points.geometry;
      geom.setDrawRange(0, Math.max(1, pool.count));
      (geom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      (geom.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
      (geom.getAttribute("aAlpha") as THREE.BufferAttribute).needsUpdate = true;
      void cameraPos;
    }
  }

  clear(kind?: ParticleKind): void {
    if (kind) {
      const p = this.pools.get(kind);
      if (p) p.count = 0;
      return;
    }
    for (const p of this.pools.values()) p.count = 0;
  }

  dispose(): void {
    for (const pool of this.pools.values()) {
      pool.points.geometry.dispose();
      (pool.points.material as THREE.Material).dispose();
    }
    this.pools.clear();
  }
}
