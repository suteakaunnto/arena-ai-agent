/**
 * world/Water.ts
 * 責務: 海・湖・川の水面シェーダ (波・反射・フレネル・太陽のきらめき)
 * 公開API: WaterSystem
 * 依存: core/math.ts, world/WorldConfig.ts
 *
 * 設計メモ:
 *  - 反射は「平面反射(PlanarReflection)」ではなく、空の近似色 + フレネルで代用。
 *    重い処理を避けつつ、夕暮れの水面らしさを出す。
 *  - 波は 4 方向の正弦波 + ノイズ法線をバンプとして適用。
 */
import * as THREE from "three";
import { WORLD } from "./WorldConfig.js";

const VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  varying vec2 vUv;

  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uSky;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uSunIntensity;
  uniform vec3 uCameraPos;
  uniform float uWaveScale;
  uniform float uChoppy;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
  }
  float wave(vec2 p, vec2 dir, float freq, float speed, float t) {
    return sin(dot(p, dir) * freq + t * speed);
  }

  void main() {
    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    vec2 p = vWorldPos.xz;

    // 4方向の波を重ねる
    float t = uTime;
    float w = 0.0;
    w += wave(p, normalize(vec2(1.0, 0.35)), 0.09 * uWaveScale, 1.1, t) * 0.55;
    w += wave(p, normalize(vec2(-0.4, 1.0)), 0.13 * uWaveScale, 1.35, t) * 0.38;
    w += wave(p, normalize(vec2(0.7, -0.8)), 0.27 * uWaveScale, 1.9, t) * 0.2;
    w += wave(p, normalize(vec2(-0.9, -0.2)), 0.51 * uWaveScale, 2.7, t) * 0.11;

    // 法線の微分(バンプ)
    float eps = 1.2;
    vec2 d = vec2(0.0);
    d.x = wave(p + vec2(eps, 0.0), normalize(vec2(1.0, 0.35)), 0.09 * uWaveScale, 1.1, t) * 0.55
        + wave(p + vec2(eps, 0.0), normalize(vec2(-0.4, 1.0)), 0.13 * uWaveScale, 1.35, t) * 0.38;
    d.y = wave(p + vec2(0.0, eps), normalize(vec2(1.0, 0.35)), 0.09 * uWaveScale, 1.1, t) * 0.55
        + wave(p + vec2(0.0, eps), normalize(vec2(-0.4, 1.0)), 0.13 * uWaveScale, 1.35, t) * 0.38;
    float dx = (d.x - (w * 0.93)) / eps;
    float dz = (d.y - (w * 0.93)) / eps;

    // 細かいチョップ
    float n = noise(p * 0.55 + vec2(t * 0.35, t * 0.22));
    dx += (n - 0.5) * 0.35 * uChoppy;
    dz += (noise(p * 0.55 + vec2(t * 0.22, -t * 0.3)) - 0.5) * 0.35 * uChoppy;

    vec3 normal = normalize(vec3(-dx * 2.2, 1.0, -dz * 2.2));

    // フレネル
    float fres = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.0);
    fres = mix(0.04, 1.0, fres);

    vec3 water = mix(uDeep, uShallow, clamp(w * 0.35 + 0.5, 0.0, 1.0) * 0.55 + clamp(n, 0.0, 1.0) * 0.15);

    // 空の映り込み(上方向ほど空、地平線寄りほど明るく)
    vec3 refl = uSky * (0.85 + 0.3 * max(0.0, dot(normal, viewDir)));
    vec3 col = mix(water, refl, fres);

    // 太陽の鏡面ハイライト
    vec3 h = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(normal, h), 0.0), 220.0);
    col += uSunColor * spec * 5.0 * uSunIntensity;

    // きらめき(疑似グリッター)
    float glint = pow(max(dot(normal, h), 0.0), 40.0) * (0.4 + 0.6 * hash(floor(p * 2.0 + t)));
    col += uSunColor * glint * 0.35 * uSunIntensity;

    // 岸の泡(浅い所)
    float shore = smoothstep(0.0, 1.0, 1.0 - length(fract(p * 0.02) - 0.5) * 0.4);
    col += vec3(0.6, 0.7, 0.72) * shore * 0.05;

    // フォグ
    float dist = length(uCameraPos - vWorldPos);
    float fogFactor = 1.0 - exp(-pow(dist * 0.00022, 2.0) * 1.2);
    col = mix(col, uSky * 0.92, clamp(fogFactor, 0.0, 0.95));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class WaterSystem {
  readonly group = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;

  constructor() {
    this.group.name = "water";
    const size = WORLD.size * 1.6;
    const geom = new THREE.PlaneGeometry(size, size, 96, 96);
    geom.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(0x3f8fa8) },
        uDeep: { value: new THREE.Color(0x0d3346) },
        uSky: { value: new THREE.Color(0xa8c8e0) },
        uSunColor: { value: new THREE.Color(0xfff0d0) },
        uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.2) },
        uSunIntensity: { value: 1 },
        uCameraPos: { value: new THREE.Vector3() },
        uWaveScale: { value: 1 },
        uChoppy: { value: 1 },
      },
      transparent: false,
    });
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.position.y = WORLD.seaLevel;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = -1;
    this.group.add(this.mesh);
  }

  update(
    dt: number,
    camera: THREE.Camera,
    sky: { sunDirection: (out?: THREE.Vector3) => THREE.Vector3; sunLight: THREE.DirectionalLight; material: THREE.ShaderMaterial | null },
    time: number,
    waveScale = 1,
    choppy = 1
  ): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uWaveScale.value = waveScale;
    u.uChoppy.value = choppy;
    (u.uCameraPos.value as THREE.Vector3).copy(camera.position);
    const sun = sky.sunDirection(tmpDir);
    (u.uSunDir.value as THREE.Vector3).copy(sun);
    (u.uSunColor.value as THREE.Color).copy(sky.sunLight.color);
    u.uSunIntensity.value = sky.sunLight.intensity * 0.5;
    if (sky.material) {
      (u.uSky.value as THREE.Color).copy(sky.material.uniforms.uHorizon.value as THREE.Color);
      (u.uShallow.value as THREE.Color).copy(u.uSky.value as THREE.Color).multiplyScalar(0.45).lerp(new THREE.Color(0x2f7d8c), 0.6);
    }
    // 水面は常にプレイヤー付近に追従(無限に見せる)
    this.mesh.position.x = Math.round(camera.position.x / 200) * 200;
    this.mesh.position.z = Math.round(camera.position.z / 200) * 200;
    void dt;
  }

  setQuality(level: number): void {
    this.material.uniforms.uChoppy.value = level >= 2 ? 1 : level >= 1 ? 0.6 : 0.3;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

const tmpDir = new THREE.Vector3();
