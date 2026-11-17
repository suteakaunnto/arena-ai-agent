#!/usr/bin/env node
/**
 * scripts/test.mjs
 * 責務: 自己診断(地形・道路・車ジオメトリ・物理・入力・ノイズ)。ブラウザ無しで実行する。
 * 使い方: node --import ./scripts/domstub.mjs scripts/test.mjs
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CASES = String.raw`
import * as THREE from "three";
import { Terrain, buildChunkGeometry } from "../src/game/world/Terrain.ts";
import { RoadNetwork } from "../src/game/world/Road.ts";
import { WORLD, SETTLEMENTS } from "../src/game/world/WorldConfig.ts";
import { CARS, getCar, theoreticalTopSpeed } from "../src/game/car/spec/CarSpec.ts";
import { buildBody } from "../src/game/car/geometry/BodyBuilder.ts";
import { CarMaterialLibrary } from "../src/game/car/materials/CarMaterials.ts";
import { buildGlass, buildLights } from "../src/game/car/geometry/GlassAndLamps.ts";
import { buildWheel } from "../src/game/car/geometry/Wheels.ts";
import { buildSections, countTriangles } from "../src/game/car/geometry/Loft.ts";
import { Vehicle, PHYSICS_DT } from "../src/game/physics/Vehicle.ts";
import { updateTire, createTireState } from "../src/game/physics/Tire.ts";
import { SteeringFilter } from "../src/game/input/SteeringFilter.ts";
import { SimplexNoise, fbm2 } from "../src/game/world/Noise.ts";
import { VegetationSystem } from "../src/game/world/Vegetation.ts";
import { Rng, clamp, TAU } from "../src/game/core/math.ts";
import { buildAllCircuits, formatTime, CIRCUIT_DEFS } from "../src/game/race/Circuit.ts";
import { RaceSession } from "../src/game/race/RaceSession.ts";

const results = [];
const check = (name, fn, opts = {}) => {
  const t0 = performance.now();
  try {
    const detail = fn();
    results.push({ name, ok: true, detail, ms: performance.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e && e.stack || e), ms: performance.now() - t0 });
  }
};

/* ---------------- 数学 ---------------- */
check("math: Rng 決定論", () => {
  const a = new Rng(42), b = new Rng(42);
  for (let i = 0; i < 100; i++) if (a.next() !== b.next()) throw new Error("再現性がない");
  const r = new Rng(7);
  let sum = 0;
  for (let i = 0; i < 10000; i++) sum += r.next();
  const mean = sum / 10000;
  if (Math.abs(mean - 0.5) > 0.02) throw new Error("平均が偏っている: " + mean);
  return "mean=" + mean.toFixed(4);
});

/* ---------------- ノイズ ---------------- */
check("noise: 範囲と連続性", () => {
  const n = new SimplexNoise(1234);
  let min = 1e9, max = -1e9, maxDelta = 0, prev = n.noise2(0, 0);
  for (let i = 0; i < 20000; i++) {
    const v = n.noise2(i * 0.013, i * 0.0071);
    min = Math.min(min, v); max = Math.max(max, v);
    maxDelta = Math.max(maxDelta, Math.abs(v - prev));
    prev = v;
  }
  if (min < -1.05 || max > 1.05) throw new Error("範囲外: " + min + " / " + max);
  if (maxDelta > 0.45) throw new Error("不連続: " + maxDelta);
  const f = fbm2(n, 3.3, 4.4, { octaves: 5 });
  if (!isFinite(f)) throw new Error("fbm が NaN");
  return "min=" + min.toFixed(3) + " max=" + max.toFixed(3);
});

/* ---------------- 地形 ---------------- */
const terrain = new Terrain(WORLD.seed);
check("terrain: 高さの範囲", () => {
  let min = 1e9, max = -1e9;
  for (let z = -WORLD.half; z <= WORLD.half; z += 240) {
    for (let x = -WORLD.half; x <= WORLD.half; x += 240) {
      const h = terrain.heightAt(x, z);
      if (!isFinite(h)) throw new Error("NaN at " + x + "," + z);
      min = Math.min(min, h); max = Math.max(max, h);
    }
  }
  if (min < -120 || max > 1300) throw new Error("高さが想定外: " + min + " .. " + max);
  return "min=" + min.toFixed(1) + " max=" + max.toFixed(1) + " (海面0m)";
});

check("terrain: 連続性(隣接差)", () => {
  let maxJump = 0;
  for (let i = 0; i < 4000; i++) {
    const x = (Math.random() - 0.5) * WORLD.size;
    const z = (Math.random() - 0.5) * WORLD.size;
    const h0 = terrain.heightAt(x, z);
    const h1 = terrain.heightAt(x + 8, z + 8);
    maxJump = Math.max(maxJump, Math.abs(h1 - h0));
  }
  if (maxJump > 40) throw new Error("段差が大きすぎる: " + maxJump.toFixed(1) + "m / 11m");
  return "8m格子での最大差 " + maxJump.toFixed(1) + "m";
});

check("terrain: バイオーム分布", () => {
  const counts = {};
  for (let z = -WORLD.half; z < WORLD.half; z += 300) {
    for (let x = -WORLD.half; x < WORLD.half; x += 300) {
      const b = terrain.biomeAt(x, z);
      counts[b] = (counts[b] ?? 0) + 1;
    }
  }
  const keys = Object.keys(counts);
  if (keys.length < 4) throw new Error("バイオームが少なすぎる: " + keys.join(","));
  return keys.map(k => k + ":" + counts[k]).join(" ");
});

check("terrain: チャンク生成(3段LOD)", () => {
  const out = [];
  for (const lod of [0, 1, 2]) {
    const data = buildChunkGeometry(terrain, 20, 20, lod);
    if (!data.positions.length) throw new Error("空のジオメトリ");
    if (data.indices.length % 3 !== 0) throw new Error("インデックスが3の倍数でない");
    // 境界チェック
    for (let i = 0; i < data.positions.length; i++) {
      if (!isFinite(data.positions[i])) throw new Error("NaN 頂点");
    }
    out.push("LOD" + lod + ":" + (data.indices.length / 3) + "tri");
  }
  return out.join(" ");
});

/* ---------------- 道路 ---------------- */
const roads = new RoadNetwork(terrain);
check("road: 生成", () => {
  const t0 = performance.now();
  roads.generate();
  const ms = performance.now() - t0;
  const stats = roads.getStats();
  if (stats.roads < 5) throw new Error("道路が少ない: " + stats.roads);
  for (const r of roads.roads) {
    if (r.samples.length < 3) throw new Error("サンプル不足: " + r.id);
    for (const s of r.samples) {
      if (!isFinite(s.x) || !isFinite(s.y) || !isFinite(s.z)) throw new Error("NaN サンプル: " + r.id);
    }
  }
  return stats.roads + " roads / " + stats.lengthKm + " km / " + Math.round(ms) + "ms";
});

check("road: 勾配制限", () => {
  let worst = 0, worstId = "";
  for (const r of roads.roads) {
    const limit = Math.tan(r.style.maxGrade) * 1.9 + 0.02;
    for (let i = 1; i < r.samples.length; i++) {
      const a = r.samples[i - 1], b = r.samples[i];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 0.01) continue;
      const grade = Math.abs(b.y - a.y) / d;
      if (grade > worst) { worst = grade; worstId = r.id; }
    }
  }
  if (worst > 0.34) throw new Error("急勾配すぎる: " + worst.toFixed(3) + " (" + worstId + ")");
  return "最大勾配 " + (worst * 100).toFixed(1) + "% (" + worstId + ")";
});

check("road: プロジェクト(位置→道路)", () => {
  const road = roads.roads[0];
  const sm = road.samples[Math.floor(road.samples.length / 2)];
  const q = road.project(sm.x + 2, sm.z + 2);
  if (q.distance > 6) throw new Error("投影誤差が大きい: " + q.distance.toFixed(2));
  if (Math.abs(q.lateral) > 6) throw new Error("横オフセット異常: " + q.lateral.toFixed(2));
  const n = roads.nearest(sm.x, sm.z);
  if (!n.road) throw new Error("nearest が道路を見つけられない");
  if (!n.onRoad) throw new Error("道路上で onRoad=false");
  return "dist=" + q.distance.toFixed(2) + " lateral=" + q.lateral.toFixed(2) + " grip=" + n.grip.toFixed(2);
});

/* ---------------- レース(タイムトライアル) ---------------- */

const circuits = buildAllCircuits(roads);

check("race: コース構築", () => {
  if (circuits.length === 0) throw new Error("走行可能なコースが 0 本");
  const ids = circuits.map((c) => c.def.id);
  for (const def of CIRCUIT_DEFS) {
    if (!ids.includes(def.id)) throw new Error("コースが構築できない: " + def.id);
  }
  return circuits
    .map((c) => c.def.id + ":" + (c.length / 1000).toFixed(1) + "km/" + c.gates.length + "門")
    .join(" ");
});

check("race: ゲート配置の妥当性", () => {
  for (const c of circuits) {
    if (c.gates.length < 8) throw new Error(c.def.id + ": ゲートが少なすぎる " + c.gates.length);
    for (let i = 1; i < c.gates.length; i++) {
      if (c.gates[i].s <= c.gates[i - 1].s) {
        throw new Error(c.def.id + ": ゲートの s が昇順でない @" + i);
      }
    }
    if (Math.abs(c.gates[0].s) > 1e-6) throw new Error(c.def.id + ": スタートが s=0 でない");
    const last = c.gates[c.gates.length - 1];
    if (last.s >= c.length) throw new Error(c.def.id + ": ゲートが周回長を超過");
  }
  return circuits.map((c) => c.def.id + ":" + c.gates.length).join(" ");
});

check("race: ゲート判定(位置と幅)", () => {
  const c = circuits[0];
  const g = c.gates[1];
  if (!c.isAtGate(1, g.x, g.z)) throw new Error("ゲート中心で通過判定にならない");
  const lat = g.width * 0.5 + 5;
  if (c.isAtGate(1, g.x - g.tz * lat, g.z + g.tx * lat)) throw new Error("ゲート外なのに通過判定");
  if (c.isAtGate(1, g.x + g.tx * 20, g.z + g.tz * 20)) throw new Error("ゲートから離れているのに通過判定");
  return "width=" + g.width.toFixed(1) + "m";
});

check("race: 周回判定(シミュレーション)", () => {
  const c = circuits[0];
  const session = new RaceSession(c, 2);
  const DT = 1 / 60;
  for (let i = 0; i < 200 && session.state === "countdown"; i++) {
    session.update(session.startPose.x, session.startPose.z, true, DT);
  }
  if (session.state !== "running") throw new Error("カウントダウンが終わらない: " + session.state);

  const gates = c.gates;
  const samples = c.road.samples;
  let steps = 0;
  for (let lap = 0; lap < 2 && session.state === "running"; lap++) {
    for (let gi = 0; gi < gates.length && session.state === "running"; gi++) {
      const a = gates[gi];
      const b = gates[(gi + 1) % gates.length];
      let sCur = a.s;
      let sEnd = b.s;
      if (sEnd <= sCur) sEnd += c.length;
      while (sCur < sEnd && session.state === "running" && steps < 400000) {
        const sm = samples[c.road.indexAtS(sCur % c.length)];
        session.update(sm.x, sm.z, true, DT);
        sCur += 4;
        steps++;
      }
    }
  }
  if (session.state !== "finished") {
    throw new Error("2 周してもフィニッシュしない: state=" + session.state + " lap=" + session.lap);
  }
  if (session.records.length !== 2) throw new Error("ラップ記録が 2 でない: " + session.records.length);
  const best = Math.min(...session.records.map((r) => r.time));
  if (!isFinite(best) || best <= 0) throw new Error("ラップタイムが不正: " + best);
  return "2 周 / best " + formatTime(best) + " / " + steps + " step";
});

check("race: 取りこぼし救済とリセット耐性", () => {
  const c = circuits[0];
  const session = new RaceSession(c, 2);
  const DT = 1 / 60;
  for (let i = 0; i < 200 && session.state === "countdown"; i++) {
    session.update(session.startPose.x, session.startPose.z, true, DT);
  }
  const skipped = session.nextGate;
  const g = c.gates[(skipped + 1) % c.gates.length];
  session.update(g.x, g.z, true, DT);
  if (session.nextGate === skipped) throw new Error("飛ばしたゲートが救済されない");
  const d0 = session.distance;
  session.update(g.x + 5000, g.z + 5000, true, DT);
  if (session.distance - d0 > 100) throw new Error("テレポートで走行距離が暴発した");
  return "skip救済 OK / dist +" + (session.distance - d0).toFixed(0) + "m";
});

check("race: ベストラップ更新の判定", () => {
  const c = circuits[0];
  const s1 = new RaceSession(c, 1, Infinity);
  s1.state = "running";
  for (let pass = 0; pass < 2; pass++) {
    for (let gi = 0; gi < c.gates.length; gi++) {
      const g = c.gates[gi];
      s1.update(g.x, g.z, true, 0);
    }
  }
  const r = s1.result(Infinity);
  if (!isFinite(r.bestLap)) throw new Error("ベストラップが記録されない");
  if (isFinite(r.bestDelta)) throw new Error("初回なのに差分が出ている");
  return "best=" + formatTime(r.bestLap);
});

check("road: スタート地点", () => {
  const s = roads.findStart();
  if (!isFinite(s.x) || !isFinite(s.z)) throw new Error("NaN");
  const h = terrain.heightAt(s.x, s.z);
  if (Math.abs(h - s.y) > 6) throw new Error("スタート地点の高さがずれている: " + h + " vs " + s.y);
  return "x=" + s.x.toFixed(0) + " z=" + s.z.toFixed(0) + " y=" + s.y.toFixed(1);
});

/* ---------------- 車ジオメトリ ---------------- */
const mats = new CarMaterialLibrary();
check("car: 16台のセクション生成", () => {
  const bad = [];
  for (const c of CARS) {
    const secs = buildSections(c);
    if (secs.length < 8) bad.push(c.id + ":sections");
    for (const s of secs) {
      if (!isFinite(s.halfWidth) || s.halfWidth <= 0) bad.push(c.id + ":width");
      if (!isFinite(s.centerTopY)) bad.push(c.id + ":top");
      if (s.centerTopY <= s.floorY) bad.push(c.id + ":height");
      if (s.centerTopY > c.dims.height + 1.6) bad.push(c.id + ":tooTall(" + s.centerTopY.toFixed(2) + ")");
    }
  }
  if (bad.length) throw new Error(bad.slice(0, 6).join(","));
  return CARS.length + " cars OK";
});

check("car: ボディ生成と三角形数", () => {
  const lines = [];
  for (const c of CARS) {
    const body = buildBody(c, mats, 2);
    const tri = body.triangles;
    if (tri < 500) throw new Error(c.id + " 三角形が少なすぎる: " + tri);
    if (tri > 260000) throw new Error(c.id + " 三角形が多すぎる: " + tri);
    lines.push(c.id + ":" + tri);
  }
  return lines.slice(0, 5).join(" ") + " …";
});

check("car: 頂点の有限性(全車)", () => {
  for (const c of CARS) {
    const body = buildBody(c, mats, 2);
    let n = 0;
    body.group.traverse((o) => {
      const m = o;
      if (!m.isMesh) return;
      const pos = m.geometry.getAttribute("position");
      if (!pos) return;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) throw new Error(c.id + " NaN 頂点");
        if (Math.abs(x) > c.dims.width * 2) throw new Error(c.id + " 幅が異常: " + x);
        n++;
      }
    });
    if (n < 100) throw new Error(c.id + " 頂点が少ない");
  }
  return "all finite";
});

check("car: フルアセンブリ(ガラス/灯火/ホイール)", () => {
  const c = getCar("aurora_s");
  const body = buildBody(c, mats, 2);
  const glass = buildGlass(c, body.sections, mats);
  const lights = buildLights(c, body.sections, mats);
  const root = new THREE.Group();
  root.add(body.group, glass.all, lights.group);
  for (const [x, z, f, mir] of [
    [0.83, body.axles.frontZ, true, false],
    [-0.83, body.axles.frontZ, true, true],
    [0.81, body.axles.rearZ, false, false],
    [-0.81, body.axles.rearZ, false, true],
  ]) {
    const w = buildWheel(c, mats, f, mir, 2);
    w.group.position.set(x, c.dims.wheelRadiusFront, z);
    root.add(w.group);
  }
  const tris = countTriangles(root);
  if (tris < 5000) throw new Error("アセンブリの三角形が少ない: " + tris);
  return tris.toLocaleString() + " tri (LOD0)";
});

/* ---------------- 物理 ---------------- */
check("physics: タイヤモデル", () => {
  const st = createTireState();
  updateTire(st, 0, 0, 4000, 1, 0.016);
  if (Math.abs(st.fy) > 1) throw new Error("ゼロスリップで横力が出ている: " + st.fy);
  st.temperature = 0.5; st.wear = 0;
  updateTire(st, 0.14, 0, 4000, 1, 0.016);
  if (Math.abs(st.fy) < 2000) throw new Error("ピーク付近の横力が小さい: " + st.fy);
  const peak = Math.abs(st.fy);
  updateTire(st, 0.5, 0, 4000, 1, 0.016);
  if (Math.abs(st.fy) > peak) throw new Error("滑りすぎで横力が増えている");
  return "peakFy=" + Math.round(peak) + "N tail=" + Math.round(Math.abs(st.fy)) + "N";
});

check("physics: 0-100km/h 加速", () => {
  const rows = [];
  for (const c of [getCar("vela_gt"), getCar("aurora_s"), getCar("toro_muscle"), getCar("meridian_x")]) {
    // 加速性能は平坦路(地形なし)で測る。実ワールドの道路脇は崖なので直進テストに不適。
    const v = new Vehicle(c, null, null);
    v.teleport(0, 0, 0);
    let t = 0;
    const input = { steer: 0, throttle: 1, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false, autoGear: true };
    for (let i = 0; i < 120 * 25; i++) {
      v.step(input, PHYSICS_DT);
      t += PHYSICS_DT;
      if (v.speedKmh >= 100) break;
    }
    if (v.speedKmh < 100) throw new Error(c.id + " 100km/h に到達しない (最終 " + v.speedKmh.toFixed(1) + ")");
    rows.push(c.id + ": " + t.toFixed(2) + "s (公称 " + c.zeroTo100 + "s)");
  }
  return rows.join(" / ");
});

check("physics: 最高速", () => {
  const c = getCar("aurora_s");
  const v = new Vehicle(c, null, null);
  v.teleport(0, 0, 0);
  const input = { steer: 0, throttle: 1, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false, autoGear: true };
  let maxSpeed = 0;
  for (let i = 0; i < 120 * 70; i++) {
    v.step(input, PHYSICS_DT);
    maxSpeed = Math.max(maxSpeed, v.speedKmh);
  }
  if (maxSpeed < 180) throw new Error("最高速が低すぎる: " + maxSpeed.toFixed(0));
  return maxSpeed.toFixed(0) + " km/h (公称 " + c.topSpeed + ")";
});

check("physics: ブレーキ停止距離(100-0)", () => {
  const c = getCar("vela_gt");
  const v = new Vehicle(c, null, null);
  v.teleport(0, 0, 0);
  const start = { steer: 0, throttle: 1, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false, autoGear: true };
  for (let i = 0; i < 120 * 20; i++) {
    v.step(start, PHYSICS_DT);
    if (v.speedKmh > 100) break;
  }
  const p0 = v.state.position.clone();
  const brakeInput = { steer: 0, throttle: 0, brake: 1, handbrake: 0, shiftUp: false, shiftDown: false, autoGear: true };
  let t = 0;
  for (let i = 0; i < 120 * 12; i++) {
    v.step(brakeInput, PHYSICS_DT);
    t += PHYSICS_DT;
    if (v.speedKmh < 1) break;
  }
  const dist = p0.distanceTo(v.state.position);
  if (v.speedKmh > 3) throw new Error("停止しない: " + v.speedKmh.toFixed(1));
  if (dist < 25 || dist > 95) throw new Error("停止距離が不自然: " + dist.toFixed(1) + "m");
  return dist.toFixed(1) + " m / " + t.toFixed(2) + " s";
});

check("physics: 定常旋回(横G)", () => {
  const c = getCar("espada_mr");
  const v = new Vehicle(c, null, null);
  v.teleport(0, 0, 0);
  // 直線で加速してからステア
  const accel = { steer: 0, throttle: 1, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false, autoGear: true };
  for (let i = 0; i < 120 * 6; i++) v.step(accel, PHYSICS_DT);
  const turn = { steer: 0.6, throttle: 0.35, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false, autoGear: true };
  let maxLat = 0;
  for (let i = 0; i < 120 * 4; i++) {
    v.step(turn, PHYSICS_DT);
    maxLat = Math.max(maxLat, Math.abs(v.state.gForce.lateral));
  }
  if (maxLat < 0.6) throw new Error("旋回横Gが低すぎる: " + maxLat.toFixed(2));
  if (maxLat > 5) throw new Error("横Gが過大: " + maxLat.toFixed(2));
  return "maxLatG=" + maxLat.toFixed(2) + " yawRate=" + v.state.yawRate.toFixed(2);
});

check("physics: 120Hz 安定性(5分間)", () => {
  const c = getCar("campo_rs");
  const v = new Vehicle(c, terrain, roads);
  const st = roads.findStart();
  v.teleport(st.x, st.z, st.heading);
  const rng = new Rng(99);
  let maxSpeed = 0;
  for (let i = 0; i < 120 * 300; i++) {
    const input = {
      steer: rng.bool(0.5) ? 0.4 : -0.4,
      throttle: 0.7,
      brake: rng.next() < 0.02 ? 0.5 : 0,
      handbrake: 0,
      shiftUp: false, shiftDown: false, autoGear: true,
    };
    v.step(input, PHYSICS_DT);
    if (!isFinite(v.state.position.x) || !isFinite(v.state.position.y) || !isFinite(v.state.heading)) {
      throw new Error("発散: step " + i);
    }
    maxSpeed = Math.max(maxSpeed, v.speedKmh);
    if (i % 240 === 0) v.rescue();
  }
  return "5分/36000step 発散なし max=" + maxSpeed.toFixed(0) + "km/h";
});

/* ---------------- 入力 ---------------- */
check("input: ステアフィルタ", () => {
  const f = new SteeringFilter();
  f.setInput(1, true, 1 / 60, 0);
  let t = 1 / 60;
  for (let i = 0; i < 90; i++) { f.setInput(1, true, 1 / 60, t * 100); t += 1 / 60; }
  const high = f.value;
  f.reset();
  for (let i = 0; i < 90; i++) f.setInput(1, true, 1 / 60, 0);
  const low = f.value;
  if (!(high < low)) throw new Error("速度依存の舵角制限が効いていない: high=" + high + " low=" + low);
  return "低速 " + low.toFixed(2) + " / 高速 " + high.toFixed(2);
});

/* ---------------- 植生 ---------------- */
check("vegetation: セル生成", () => {
  const veg = new VegetationSystem(terrain);
  const t0 = performance.now();
  veg.buildAround(0, 0, 1400);
  const ms = performance.now() - t0;
  const stats = veg.getStats();
  if (stats.total < 50) throw new Error("植生が少なすぎる: " + stats.total);
  return stats.cells + " cells / " + stats.total + " instances / " + Math.round(ms) + "ms";
});

/* ---------------- 車のデータ整合性 ---------------- */
check("data: 車スペックの妥当性", () => {
  const ids = new Set();
  for (const c of CARS) {
    if (ids.has(c.id)) throw new Error("ID重複: " + c.id);
    ids.add(c.id);
    if (c.chassis.mass < 500 || c.chassis.mass > 3000) throw new Error(c.id + " 重量異常");
    if (c.engine.powerHp < 50 || c.engine.powerHp > 1300) throw new Error(c.id + " 出力異常");
    if (c.gearbox.ratios.length < 3) throw new Error(c.id + " ギア数不足");
    const top = theoreticalTopSpeed(c);
    if (top < c.topSpeed * 0.6) throw new Error(c.id + " 理論最高速が低すぎる: " + top + " vs " + c.topSpeed);
    if (c.colors.length === 0) throw new Error(c.id + " 色がない");
  }
  return CARS.length + " 台すべて合格";
});

/* ---------------- 出力 ---------------- */
let ok = 0, ng = 0;
for (const r of results) {
  if (r.ok) { ok++; console.log("  ✓ " + r.name + (r.detail !== undefined ? "  — " + r.detail : "")); }
  else { ng++; console.log("  ✗ " + r.name + "\n      " + String(r.detail).split("\n").slice(0, 4).join("\n      ")); }
}
console.log("\n" + ok + " passed, " + ng + " failed, " + results.length + " total");
if (ng > 0) process.exit(1);
`;

const testPath = path.join(root, ".cache", "selftest.mjs");
await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(testPath), { recursive: true }));
await import("node:fs/promises").then((fs) => fs.writeFile(testPath, CASES, "utf8"));

await build({
  entryPoints: [testPath],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: path.join(root, ".cache", "selftest.bundle.mjs"),
  external: ["three"],
  logLevel: "warning",
  absWorkingDir: root,
});

await import(pathToFileURL(path.join(root, ".cache", "selftest.bundle.mjs")).href);
