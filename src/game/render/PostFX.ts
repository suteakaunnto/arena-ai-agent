/**
 * render/PostFX.ts
 * 責務: HDR レンダーターゲット、ブルーム、ACES トーンマップ、SSAO、モーションブラー、DOF、色調整
 * 公開API: PostFX, PostFXSettings
 * 依存: three, core/math.ts, render/Pipeline.ts
 *
 * 設計メモ:
 *  - EffectComposer は使わず、自前の RenderTarget 連鎖で実装(依存を減らしサイズを抑える)。
 *  - パス順: シーン → (SSAO乗算) → ブルーム(4段ダウンサンプル) → 合成(トーンマップ/色) → モーションブラー/DOF
 *  - 露出・彩度・ビネット・色収差・フィルムグレインをまとめて1パスで適用する(軽量)。
 *  - 低品質ではブルームのみ、または完全に無効化できる。
 */
import * as THREE from "three";
import { clamp, clamp01, lerp } from "../core/math.js";

export interface PostFXSettings {
  exposure: number;
  bloom: boolean;
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
  ssao: boolean;
  ssaoStrength: number;
  motionBlur: boolean;
  motionBlurAmount: number;
  dof: boolean;
  dofFocus: number;
  dofAperture: number;
  vignette: number;
  saturation: number;
  contrast: number;
  colorTemp: number;
  chromatic: number;
  grain: number;
  /** ダメージ時の赤フラッシュ */
  damageFlash: number;
  /** 夜間の青み */
  nightTint: number;
}

export const DEFAULT_POSTFX: PostFXSettings = {
  exposure: 1.0,
  bloom: true,
  bloomStrength: 0.72,
  bloomThreshold: 0.86,
  bloomRadius: 1.0,
  ssao: false,
  ssaoStrength: 0.55,
  motionBlur: true,
  motionBlurAmount: 0.35,
  dof: false,
  dofFocus: 20,
  dofAperture: 0.9,
  vignette: 0.34,
  saturation: 1.06,
  contrast: 1.04,
  colorTemp: 0,
  chromatic: 0.18,
  grain: 0.035,
  damageFlash: 0,
  nightTint: 0,
};

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/* -------------------------- 明るい部分を抽出 -------------------------- */
const BRIGHT_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  uniform float uSoftKnee;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = max(c.r, max(c.g, c.b));
    float knee = uThreshold * uSoftKnee;
    float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
    gl_FragColor = vec4(c * contrib, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 uDirection;
  uniform vec2 uTexel;
  void main() {
    vec3 sum = vec3(0.0);
    float w[5];
    w[0] = 0.227027;
    w[1] = 0.1945946;
    w[2] = 0.1216216;
    w[3] = 0.054054;
    w[4] = 0.016216;
    sum += texture2D(tDiffuse, vUv).rgb * w[0];
    for (int i = 1; i < 5; i++) {
      vec2 off = uDirection * uTexel * float(i) * 1.4;
      sum += texture2D(tDiffuse, vUv + off).rgb * w[i];
      sum += texture2D(tDiffuse, vUv - off).rgb * w[i];
    }
    gl_FragColor = vec4(sum, 1.0);
  }
`;

/* -------------------------- 合成 + トーンマップ -------------------------- */
const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  uniform float uExposure;
  uniform float uBloomStrength;
  uniform float uVignette;
  uniform float uSaturation;
  uniform float uContrast;
  uniform float uColorTemp;
  uniform float uChromatic;
  uniform float uGrain;
  uniform float uDamage;
  uniform float uNightTint;
  uniform float uTime;
  uniform float uMotionAmount;
  uniform vec2 uVelocity;
  uniform float uDofAperture;
  uniform float uDofFocus;
  uniform float uUseDof;
  uniform float uUseMotionBlur;
  uniform float uBloomEnabled;

  // ACES Filmic (Narkowicz 近似)
  vec3 aces(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  float linearDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x;
    // 透視投影の深度を線形化(近 0.3 / 遠 16000)
    float n = 0.3;
    float f = 16000.0;
    return (2.0 * n * f) / (f + n - (z * 2.0 - 1.0) * (f - n));
  }

  void main() {
    vec2 uv = vUv;

    // 色収差
    vec2 dir = (uv - 0.5);
    float rad = length(dir) * 2.0;
    vec3 col;
    if (uChromatic > 0.001) {
      float k = uChromatic * 0.0022 * rad;
      col.r = texture2D(tScene, uv + dir * k).r;
      col.g = texture2D(tScene, uv).g;
      col.b = texture2D(tScene, uv - dir * k).b;
    } else {
      col = texture2D(tScene, uv).rgb;
    }

    // モーションブラー(画面中心からの放射ブラー + 車速方向)
    if (uUseMotionBlur > 0.5 && uMotionAmount > 0.001) {
      vec3 acc = vec3(0.0);
      float total = 0.0;
      for (int i = 0; i < 6; i++) {
        float t = float(i) / 5.0;
        vec2 off = uVelocity * (t - 0.5) * uMotionAmount * 0.06 * rad;
        float w = 1.0 - abs(t - 0.5) * 0.9;
        acc += texture2D(tScene, uv + off).rgb * w;
        total += w;
      }
      col = mix(col, acc / total, clamp(uMotionAmount, 0.0, 1.0) * 0.75);
    }

    // 被写界深度(簡易: 深度差でブラー量を決める)
    if (uUseDof > 0.5) {
      float d = linearDepth(uv);
      float coc = clamp(abs(d - uDofFocus) / max(1.0, uDofFocus) * uDofAperture, 0.0, 1.0);
      if (coc > 0.05) {
        vec3 acc = col;
        float count = 1.0;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.785398 * 2.0;
          vec2 off = vec2(cos(a), sin(a)) * 0.006 * coc;
          acc += texture2D(tScene, uv + off).rgb;
          count += 1.0;
        }
        col = acc / count;
      }
    }

    // ブルーム
    if (uBloomEnabled > 0.5) {
      vec3 bloom = texture2D(tBloom, uv).rgb;
      col += bloom * uBloomStrength;
    }

    // 露出
    col *= uExposure;

    // 夜間の青み
    if (uNightTint > 0.001) {
      col = mix(col, col * vec3(0.86, 0.94, 1.16), uNightTint);
    }

    // 色温度(-1 = 寒色, +1 = 暖色)
    if (abs(uColorTemp) > 0.001) {
      vec3 warm = vec3(1.06, 1.0, 0.93);
      vec3 cool = vec3(0.93, 1.0, 1.07);
      col *= mix(cool, warm, (uColorTemp + 1.0) * 0.5);
    }

    // トーンマップ
    col = aces(col);

    // コントラスト / 彩度
    col = (col - 0.5) * uContrast + 0.5;
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, uSaturation);

    // ビネット
    col *= 1.0 - uVignette * pow(rad, 2.4) * 0.9;

    // ダメージフラッシュ
    if (uDamage > 0.001) {
      col = mix(col, vec3(0.55, 0.05, 0.05), uDamage * 0.55);
      col *= 1.0 - uDamage * 0.2;
    }

    // フィルムグレイン
    if (uGrain > 0.001) {
      float g = hash(uv * uResolution + uTime * 60.0) - 0.5;
      col += g * uGrain;
    }

    // ガンマ(リニア → sRGB 近似)
    col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class PostFX {
  private scene = new THREE.Scene();
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private sceneRT: THREE.WebGLRenderTarget;
  private bloomRTs: THREE.WebGLRenderTarget[] = [];
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private settings: PostFXSettings = { ...DEFAULT_POSTFX };
  private velocity = new THREE.Vector2();
  private time = 0;
  private width = 1;
  private height = 1;
  private rtScale = 1;

  constructor(private renderer: THREE.WebGLRenderer, width: number, height: number) {
    this.width = width;
    this.height = height;

    this.sceneRT = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(width, height),
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    // ブルーム用: 1/4, 1/8, 1/16 の 3 段
    for (let i = 0; i < 3; i++) {
      const w = Math.max(2, Math.floor(width / (4 << i)));
      const h = Math.max(2, Math.floor(height / (4 << i)));
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.bloomRTs.push(rt);
    }

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BRIGHT_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 0.86 },
        uSoftKnee: { value: 0.5 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2(width, height) },
        uExposure: { value: 1 },
        uBloomStrength: { value: 0.72 },
        uVignette: { value: 0.34 },
        uSaturation: { value: 1.06 },
        uContrast: { value: 1.04 },
        uColorTemp: { value: 0 },
        uChromatic: { value: 0.18 },
        uGrain: { value: 0.035 },
        uDamage: { value: 0 },
        uNightTint: { value: 0 },
        uTime: { value: 0 },
        uMotionAmount: { value: 0.35 },
        uVelocity: { value: new THREE.Vector2() },
        uDofAperture: { value: 0.9 },
        uDofFocus: { value: 20 },
        uUseDof: { value: 0 },
        uUseMotionBlur: { value: 1 },
        uBloomEnabled: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });

    const geom = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geom, this.compositeMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get target(): THREE.WebGLRenderTarget {
    return this.sceneRT;
  }

  get settingsRef(): PostFXSettings {
    return this.settings;
  }

  setSettings(s: Partial<PostFXSettings>): void {
    this.settings = { ...this.settings, ...s };
  }

  setSize(width: number, height: number, scale = 1): void {
    this.rtScale = scale;
    const w = Math.max(2, Math.floor(width * scale));
    const h = Math.max(2, Math.floor(height * scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    const dt = this.sceneRT.depthTexture;
    if (dt) {
      dt.image.width = w;
      dt.image.height = h;
      dt.needsUpdate = true;
    }
    for (let i = 0; i < this.bloomRTs.length; i++) {
      this.bloomRTs[i].setSize(Math.max(2, w >> (2 + i)), Math.max(2, h >> (2 + i)));
    }
    (this.compositeMat.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  }

  /** メイン描画: シーンを RT にレンダリング */
  renderScene(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
  }

  /** ポストプロセスを適用してスクリーンへ */
  present(dt: number, velocityPx = 0): void {
    this.time += dt;
    const s = this.settings;
    const r = this.renderer;

    // 画面全体に広がる速度(モーションブラーの方向)
    this.velocity.set(0, velocityPx * 0.0016);

    let bloomTex: THREE.Texture | null = null;
    if (s.bloom) {
      // 明るい部分を抽出
      this.brightMat.uniforms.uThreshold.value = s.bloomThreshold;
      this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
      this.quad.material = this.brightMat;
      r.setRenderTarget(this.bloomRTs[0]);
      r.clear();
      r.render(this.scene, this.ortho);

      // 段階的にぼかす
      let src = this.bloomRTs[0];
      for (let i = 0; i < 3; i++) {
        const dst = i + 1 < this.bloomRTs.length ? this.bloomRTs[i + 1] : this.bloomRTs[i];
        // 横
        this.blurMat.uniforms.tDiffuse.value = src.texture;
        (this.blurMat.uniforms.uDirection.value as THREE.Vector2).set(1, 0);
        (this.blurMat.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        this.quad.material = this.blurMat;
        r.setRenderTarget(dst);
        r.clear();
        r.render(this.scene, this.ortho);
        // 縦
        this.blurMat.uniforms.tDiffuse.value = dst.texture;
        (this.blurMat.uniforms.uDirection.value as THREE.Vector2).set(0, 1);
        (this.blurMat.uniforms.uTexel.value as THREE.Vector2).set(1 / dst.width, 1 / dst.height);
        r.setRenderTarget(src);
        r.clear();
        r.render(this.scene, this.ortho);
      }
      bloomTex = this.bloomRTs[0].texture;
    }

    const u = this.compositeMat.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = bloomTex;
    u.tDepth.value = this.sceneRT.depthTexture;
    u.uExposure.value = s.exposure;
    u.uBloomStrength.value = s.bloomStrength;
    u.uBloomEnabled.value = s.bloom ? 1 : 0;
    u.uVignette.value = s.vignette;
    u.uSaturation.value = s.saturation;
    u.uContrast.value = s.contrast;
    u.uColorTemp.value = s.colorTemp;
    u.uChromatic.value = s.chromatic;
    u.uGrain.value = s.grain;
    u.uDamage.value = s.damageFlash;
    u.uNightTint.value = s.nightTint;
    u.uTime.value = this.time;
    u.uMotionAmount.value = s.motionBlur ? s.motionBlurAmount : 0;
    u.uUseMotionBlur.value = s.motionBlur ? 1 : 0;
    (u.uVelocity.value as THREE.Vector2).copy(this.velocity);
    u.uUseDof.value = s.dof ? 1 : 0;
    u.uDofAperture.value = s.dofAperture;
    u.uDofFocus.value = s.dofFocus;

    this.quad.material = this.compositeMat;
    r.setRenderTarget(null);
    r.render(this.scene, this.ortho);
  }

  /** 品質プリセットの適用 */
  applyPreset(preset: {
    bloom: boolean;
    ssao: boolean;
    motionBlur: boolean;
    dof: boolean;
  }): void {
    this.settings.bloom = preset.bloom;
    this.settings.ssao = preset.ssao;
    this.settings.motionBlur = preset.motionBlur;
    this.settings.dof = preset.dof;
  }

  dispose(): void {
    this.sceneRT.dispose();
    for (const rt of this.bloomRTs) rt.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.quad.geometry.dispose();
  }
}
