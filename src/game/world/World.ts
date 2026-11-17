/**
 * world/World.ts
 * 責務: 地形・道路・植生・空・水・集落・小物をまとめて「走れる世界」にする
 * 公開API: World
 * 依存: world/* 全般, render/*, core/math.ts
 *
 * 設計メモ:
 *  - 生成順序: 地形 → 道路(整地) → 地形の整地を反映したチャンク生成 → 植生 → 小物。
 *  - 1フレームの生成予算を守るため、TerrainStreamer と Vegetation は update で少しずつ進める。
 */
import * as THREE from "three";
import { Terrain, TerrainStreamer } from "./Terrain.js";
import { RoadNetwork } from "./Road.js";
import { VegetationSystem } from "./Vegetation.js";
import { SkySystem } from "./Sky.js";
import { WaterSystem } from "./Water.js";
import { PropsBuilder } from "./Props.js";
import { WORLD, SETTLEMENTS, LANDMARKS } from "./WorldConfig.js";
import { SkySystem as Sky } from "./Sky.js";

export interface WorldStats {
  roads: number;
  roadKm: number;
  chunks: number;
  trees: number;
  drawCallsHint: number;
}

export class World {
  readonly terrain: Terrain;
  readonly roads: RoadNetwork;
  readonly vegetation: VegetationSystem;
  readonly sky: Sky;
  readonly water: WaterSystem;
  readonly props: PropsBuilder;
  readonly streamer: TerrainStreamer;
  readonly group = new THREE.Group();

  constructor(qualityIndex = 2) {
    this.terrain = new Terrain(WORLD.seed);
    // 集落を平らにする(道路より先)
    this.terrain.flattenSettlements();
    this.roads = new RoadNetwork(this.terrain);
    this.roads.generate();
    // 道路で整地した地形を反映してからチャンクを生成する必要があるため、
    // TerrainStreamer は道路生成の後に作る
    this.streamer = new TerrainStreamer(this.terrain);
    this.vegetation = new VegetationSystem(this.terrain);
    this.sky = new SkySystem();
    this.water = new WaterSystem();
    this.props = new PropsBuilder(this.terrain, this.roads);

    this.group.add(this.streamer.group, this.roads.group, this.roads.guardrailGroup, this.vegetation.group, this.sky.group, this.water.group, this.props.group);
    this.setQuality(qualityIndex);
  }

  setQuality(qualityIndex: number): void {
    const veg = qualityIndex >= 3 ? 1 : qualityIndex >= 2 ? 0.9 : qualityIndex >= 1 ? 0.7 : 0.4;
    this.vegetation.setQuality(qualityIndex);
    this.vegetation.update(new THREE.Vector3(0, 0, 0), veg);
    this.water.setQuality(qualityIndex);
  }

  /** 起点(街の近くの舗装路) */
  spawnPoint(): { x: number; z: number; heading: number } {
    const s = this.roads.findStart();
    return { x: s.x, z: s.z, heading: s.heading };
  }

  /** 毎フレーム: 空間管理 */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3, qualityIndex = 2, elapsed = 0): void {
    this.streamer.update(focus.x, focus.z);
    this.vegetation.update(focus, qualityIndex >= 3 ? 1 : qualityIndex >= 2 ? 0.9 : qualityIndex >= 1 ? 0.7 : 0.4);
    this.sky.update(dt, camera, focus);
    this.water.update(
      dt,
      camera,
      {
        sunDirection: (out?: THREE.Vector3) => this.sky.sunDirection(out),
        sunLight: this.sky.sunLight,
        material: (this.sky as unknown as { material?: THREE.ShaderMaterial }).material ?? null,
      },
      elapsed,
      qualityIndex >= 2 ? 1 : 0.5,
      qualityIndex >= 2 ? 1 : 0.3
    );
    this.props.update(focus, qualityIndex);
  }

  getStats(): WorldStats {
    const rs = this.roads.getStats();
    const ts = this.streamer.getStats();
    const vs = this.vegetation.getStats();
    return {
      roads: rs.roads,
      roadKm: rs.lengthKm,
      chunks: ts.chunks,
      trees: vs.total,
      drawCallsHint: ts.chunks * 2 + vs.cells * 3,
    };
  }

  dispose(): void {
    this.streamer.dispose();
    this.roads.dispose();
    this.vegetation.dispose();
    this.sky.dispose();
    this.water.dispose();
    this.props.dispose();
  }
}

export { SETTLEMENTS, LANDMARKS };
