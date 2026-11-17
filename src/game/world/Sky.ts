/**
 * world/Sky.ts
 * 責務: 大気散乱風の空シェーダ、太陽/月、雲、星、時刻・天候による環境光とフォグの制御
 * 公開API: SkySystem, TIME_PRESETS, WeatherState
 * 依存: core/math.ts, world/WorldConfig.ts
 *
 * 設計メモ:
 *  - 空は巨大な球の内側に 1 枚のシェーダ。Rayleigh/Mie を簡易近似。
 *  - 太陽位置は時刻(0..24)から決まり、DirectionalLight とフォグ色が連動する。
 *  - 雲はフラクタルノイズをシェーダで積層(テクスチャ不要)。
 */
import * as THREE from "three";
import { clamp, clamp01, lerp, smoothstep, DEG2RAD } from "../core/math.js";
import { BIOMES, BiomeId } from "./WorldConfig.js";

export interface TimePreset {
  id: string;
  name: string;
  /** 時刻(0..24) */
  hour: number;
  /** 太陽高度の補正 */
  sunTilt: number;
  /** 太陽色 */
  sunColor: number;
  /** 環境光の強さ */
  ambient: number;
  /** フォグ色 */
  fogColor: number;
  /** フォグ密度 */
  fogDensity: number;
  /** 露出(ポストで使う) */
  exposure: number;
  /** 星の強さ */
  stars: number;
}

export const TIME_PRESETS: TimePreset[] = [
  { id: "dawn", name: "夜明け", hour: 6.1, sunTilt: 0.05, sunColor: 0xffb27a, ambient: 0.42, fogColor: 0xb9a894, fogDensity: 0.00042, exposure: 1.45, stars: 0.25 },
  { id: "morning", name: "朝", hour: 8.5, sunTilt: 0.1, sunColor: 0xfff0d4, ambient: 0.9, fogColor: 0xc4d6e2, fogDensity: 0.0003, exposure: 1.15, stars: 0 },
  { id: "noon", name: "昼", hour: 12.5, sunTilt: 0.0, sunColor: 0xfffdf6, ambient: 1.1, fogColor: 0xd6e6f2, fogDensity: 0.00022, exposure: 1.0, stars: 0 },
  { id: "sunset", name: "夕暮れ", hour: 18.2, sunTilt: 0.08, sunColor: 0xff9a4a, ambient: 0.5, fogColor: 0xe9a273, fogDensity: 0.00038, exposure: 1.3, stars: 0.15 },
  { id: "night", name: "夜", hour: 22.0, sunTilt: 0.0, sunColor: 0x8ea6d6, ambient: 0.16, fogColor: 0x0d1420, fogDensity: 0.0005, exposure: 1.75, stars: 1 },
];

export type WeatherState = "clear" | "cloudy" | "rain" | "storm";

/* ------------------------------------------------------------------ */
/* 空シェーダ                                                          */
/* ------------------------------------------------------------------ */

const SKY_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SKY_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;

  uniform vec3 uSunDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform float uSunIntensity;
  uniform float uStarAmount;
  uniform float uCloudCover;
  uniform float uCloudTime;
  uniform float uHaze;
  uniform vec3 uMoonDir;

  // --- ハッシュノイズ ---
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vWorldPos - cameraPosition);
    float h = clamp(dir.y, -1.0, 1.0);

    // 空のグラデーション(高度で補間)
    float t = pow(clamp(h * 1.25 + 0.06, 0.0, 1.0), 0.55);
    vec3 col = mix(uHorizon, uZenith, t);

    // 地平線付近のもや
    float hazeBand = exp(-abs(h) * 9.0);
    col = mix(col, uHorizon * 1.06 + 0.02, hazeBand * uHaze);

    // 太陽
    float sd = max(dot(dir, normalize(uSunDir)), 0.0);
    float sunDisc = smoothstep(0.9992, 0.99965, sd);
    float sunGlow = pow(sd, 12.0) * 0.35 + pow(sd, 220.0) * 0.85;
    col += uSunColor * (sunDisc * 9.0 + sunGlow) * uSunIntensity;

    // 太陽付近の地平線の赤み
    float horizonRed = pow(sd, 3.0) * (1.0 - t) * 0.5;
    col += uSunColor * horizonRed * uSunIntensity * 0.6;

    // 星
    if (uStarAmount > 0.001 && h > -0.02) {
      vec2 sp = dir.xz / max(0.08, abs(dir.y) + 0.12) * 34.0;
      vec2 cell = floor(sp);
      float r = hash(cell);
      float star = step(0.9955, r) * (0.4 + 0.6 * hash(cell + 7.3));
      float twinkle = 0.7 + 0.3 * sin(uCloudTime * 2.0 + r * 40.0);
      col += vec3(0.85, 0.9, 1.0) * star * twinkle * uStarAmount * smoothstep(0.0, 0.25, dir.y);
    }

    // 月
    float md = max(dot(dir, normalize(uMoonDir)), 0.0);
    col += vec3(0.85, 0.88, 1.0) * smoothstep(0.9995, 0.9998, md) * 3.4 * uStarAmount;

    // 雲(平面投影 + フラクタルノイズ)
    if (uCloudCover > 0.01 && h > 0.0) {
      vec2 cuv = dir.xz / (dir.y + 0.18) * 0.55 + uCloudTime * vec2(0.006, 0.0022);
      float c1 = fbm(cuv * 1.4);
      float c2 = fbm(cuv * 3.1 + 12.7);
      float cloud = smoothstep(0.62 - uCloudCover * 0.34, 0.95, c1 * 0.7 + c2 * 0.3);
      float fade = smoothstep(0.0, 0.18, dir.y);
      vec3 cloudCol = mix(uHorizon * 1.15, vec3(1.0), 0.55);
      cloudCol += uSunColor * pow(sd, 5.0) * 0.5;
      col = mix(col, cloudCol, cloud * fade * 0.92);
    }

    // 地面より下(遠景の地平線を隠す)
    if (h < 0.0) {
      col = mix(col, uGround, smoothstep(-0.02, -0.28, h));
    }

    gl_FragColor = vec4(col, 1.0);
    // トーンマップはポストで行う
  }
`;

/* ------------------------------------------------------------------ */
/* SkySystem                                                          */
/* ------------------------------------------------------------------ */

export class SkySystem {
  readonly group = new THREE.Group();
  readonly sunLight: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  readonly fill: THREE.DirectionalLight;
  readonly fog: THREE.FogExp2;

  private dome: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private hour = 16.5;
  private weather: WeatherState = "clear";
  private weatherBlend = 0;
  private targetWeather: WeatherState = "clear";
  private cloudCover = 0.35;
  private timeScale = 1;
  private elapsed = 0;
  private userTimeScale = 0;

  constructor() {
    this.group.name = "sky";
    this.fog = new THREE.FogExp2(0xbfd0dc, 0.00034);

    const geom = new THREE.SphereGeometry(14000, 40, 24);
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.2) },
        uZenith: { value: new THREE.Color(0x2f6fb0) },
        uHorizon: { value: new THREE.Color(0xbfd6e6) },
        uGround: { value: new THREE.Color(0x6a6250) },
        uSunColor: { value: new THREE.Color(0xfff0d0) },
        uSunIntensity: { value: 1 },
        uStarAmount: { value: 0 },
        uCloudCover: { value: 0.35 },
        uCloudTime: { value: 0 },
        uHaze: { value: 0.5 },
        uMoonDir: { value: new THREE.Vector3(-0.4, 0.5, -0.3) },
      },
    });
    this.dome = new THREE.Mesh(geom, this.material);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.group.add(this.dome);

    this.sunLight = new THREE.DirectionalLight(0xfff2dc, 3.1);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 420;
    const s = 90;
    this.sunLight.shadow.camera.left = -s;
    this.sunLight.shadow.camera.right = s;
    this.sunLight.shadow.camera.top = s;
    this.sunLight.shadow.camera.bottom = -s;
    this.sunLight.shadow.bias = -0.0008;
    this.sunLight.shadow.normalBias = 0.35;
    this.group.add(this.sunLight);
    this.group.add(this.sunLight.target);

    this.ambient = new THREE.HemisphereLight(0xbfd6f0, 0x6a5f4a, 1.15);
    this.group.add(this.ambient);

    this.fill = new THREE.DirectionalLight(0xa8c2e0, 0.35);
    this.fill.position.set(-0.5, 0.4, -0.8);
    this.group.add(this.fill);

    this.setHour(this.hour);
  }

  get fogColor(): THREE.Color {
    return this.fog.color;
  }

  get currentHour(): number {
    return this.hour;
  }

  setHour(h: number): void {
    this.hour = ((h % 24) + 24) % 24;
    this.applyTime();
  }

  /** 時間の流れ(0 = 停止) */
  setTimeScale(scale: number): void {
    this.userTimeScale = scale;
  }

  setWeather(w: WeatherState, instant = false): void {
    this.targetWeather = w;
    if (instant) {
      this.weather = w;
      this.weatherBlend = 1;
    }
  }

  get weatherState(): WeatherState {
    return this.weather;
  }

  /** 太陽の方向(正規化) */
  sunDirection(out = new THREE.Vector3()): THREE.Vector3 {
    const angle = ((this.hour - 6) / 12) * Math.PI;
    return out.set(Math.cos(angle) * 0.75, Math.sin(angle), Math.sin(angle * 0.6) * 0.32).normalize();
  }

  /** 太陽高度(0..1) */
  get sunElevation(): number {
    const d = this.sunDirection(tmpV);
    return clamp01(d.y);
  }

  get isNight(): boolean {
    return this.sunElevation < 0.08;
  }

  private applyTime(): void {
    const dir = this.sunDirection(tmpV);
    const elev = dir.y;
    const dayFactor = smoothstep(-0.12, 0.28, elev);

    // 太陽色(低いほど赤い)
    const sunColor = tmpColor;
    if (elev < 0.02) {
      sunColor.setRGB(1.0, 0.45, 0.22);
    } else if (elev < 0.2) {
      sunColor.setRGB(1.0, 0.62, 0.34).lerp(new THREE.Color(1.0, 0.85, 0.66), smoothstep(0.02, 0.2, elev));
    } else if (elev < 0.45) {
      sunColor.setRGB(1.0, 0.85, 0.66).lerp(new THREE.Color(1.0, 0.96, 0.9), smoothstep(0.2, 0.45, elev));
    } else {
      sunColor.setRGB(1.0, 0.98, 0.95);
    }

    // 天頂・地平線
    const zenith = tmpColor2;
    const horizon = tmpColor3;
    if (this.isNight) {
      zenith.setRGB(0.012, 0.018, 0.045);
      horizon.setRGB(0.05, 0.07, 0.13);
    } else {
      const t = smoothstep(0.0, 0.5, elev);
      zenith.setRGB(0.09, 0.26, 0.55).lerp(new THREE.Color(0.16, 0.42, 0.78), t);
      horizon.setRGB(0.98, 0.62, 0.38).lerp(new THREE.Color(0.72, 0.84, 0.94), t);
    }
    // 天候による減光
    const cloudDim = this.cloudCover * 0.45;
    zenith.lerp(new THREE.Color(0.35, 0.38, 0.42), cloudDim);
    horizon.lerp(new THREE.Color(0.55, 0.58, 0.6), cloudDim);

    const u = this.material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(dir);
    (u.uZenith.value as THREE.Color).copy(zenith);
    (u.uHorizon.value as THREE.Color).copy(horizon);
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    u.uSunIntensity.value = lerp(0.15, 1.15, dayFactor);
    u.uStarAmount.value = (1 - smoothstep(-0.06, 0.16, elev)) * 0.9;
    u.uHaze.value = lerp(0.35, 0.72, 1 - dayFactor) + this.cloudCover * 0.2;
    u.uCloudCover.value = this.cloudCover;
    (u.uMoonDir.value as THREE.Vector3).set(-dir.x, Math.max(0.25, dir.y * 0.5 + 0.4), -dir.z).normalize();
    (u.uGround.value as THREE.Color).setRGB(0.22, 0.2, 0.16).lerp(new THREE.Color(0.06, 0.07, 0.08), 1 - dayFactor);

    // ライト
    this.sunLight.color.copy(sunColor);
    this.sunLight.intensity = lerp(0.05, 3.4, dayFactor) * (1 - this.cloudCover * 0.55);
    this.sunLight.visible = elev > -0.08;
    this.ambient.intensity = lerp(0.16, 1.05, dayFactor) * lerp(1, 0.9, this.cloudCover);
    this.ambient.color.copy(zenith).lerp(new THREE.Color(0xffffff), 0.35);
    this.ambient.groundColor.setRGB(0.28, 0.24, 0.18).lerp(new THREE.Color(0.05, 0.05, 0.06), 1 - dayFactor);
    this.fill.intensity = lerp(0.02, 0.35, dayFactor);
    this.fill.color.copy(horizon);

    // フォグ
    this.fog.color.copy(horizon).lerp(zenith, 0.15);
    this.fog.density = lerp(0.00042, 0.00022, dayFactor) * (1 + this.cloudCover * 1.2);
  }

  /** 環境マップ用の簡易グラデーション(テクスチャ不要で軽い) */
  buildEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const sky = this.material.uniforms.uZenith.value as THREE.Color;
    const hor = this.material.uniforms.uHorizon.value as THREE.Color;
    const grd = ctx.createLinearGradient(0, 0, 0, size);
    grd.addColorStop(0, `#${sky.getHexString()}`);
    grd.addColorStop(0.55, `#${hor.getHexString()}`);
    grd.addColorStop(0.62, `#${hor.getHexString()}`);
    grd.addColorStop(1, "#3a352c");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    void renderer;
    return tex;
  }

  /**
   * 毎フレーム更新。カメラ位置に空ドームを追従させる。
   */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    this.elapsed += dt;
    const ts = this.userTimeScale;
    if (ts !== 0) {
      this.setHour(this.hour + (dt * ts * 60) / 3600); // 1秒 = ts 分
    } else {
      // 天候の補間のみ
      this.applyTime();
    }

    // 天候の変化(ゆっくり)
    const targetCover =
      this.targetWeather === "clear" ? 0.22 : this.targetWeather === "cloudy" ? 0.55 : this.targetWeather === "rain" ? 0.82 : 0.96;
    this.cloudCover = lerp(this.cloudCover, targetCover, 1 - Math.exp(-0.4 * dt));
    this.material.uniforms.uCloudTime.value = this.elapsed;

    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(1);

    // 影のカメラを注視点へ
    const dir = this.sunDirection(tmpV);
    this.sunLight.position.copy(focus).addScaledVector(dir, 220);
    this.sunLight.target.position.copy(focus);
    this.sunLight.target.updateMatrixWorld();

    void BIOMES;
  }

  /** バイオーム由来の霧色ブレンド */
  applyHaze(biome: BiomeId, amount: number): void {
    const def = BIOMES[biome];
    tmpColor.setRGB(def.haze[0], def.haze[1], def.haze[2]);
    this.fog.color.lerp(tmpColor, clamp(amount, 0, 1) * 0.35);
  }

  /** 露出(ポスト用) */
  get exposure(): number {
    const elev = this.sunElevation;
    return lerp(1.55, 0.95, smoothstep(0.0, 0.55, elev));
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.material.dispose();
    this.sunLight.dispose();
  }
}

const tmpV = new THREE.Vector3();
const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const tmpColor3 = new THREE.Color();

/** 時刻 → 目安の説明 */
export function timeLabel(hour: number): string {
  const h = Math.floor(hour);
  if (h < 5) return "深夜";
  if (h < 7) return "夜明け";
  if (h < 11) return "朝";
  if (h < 15) return "昼";
  if (h < 18) return "夕方";
  if (h < 20) return "夕暮れ";
  if (h < 23) return "夜";
  return "深夜";
}

/** 時刻を "17:30" 形式へ */
export function formatTime(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 太陽高度から影の長さの目安 */
export function shadowLength(elevation: number): number {
  return elevation > 0.02 ? 1 / Math.tan(Math.asin(clamp(elevation, 0.02, 1))) : 40;
}

export { DEG2RAD };
