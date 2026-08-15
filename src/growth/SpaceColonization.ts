import * as THREE from 'three';
import type { ForestConfig } from '../config/Config';
import { AttractionPoint } from './AttractionPoint';
import {
  Branch,
  depthBiasForLayer,
  resetBranchIds,
  type DepthLayer,
} from './Branch';

export type ColonizationVolume = {
  /** Center of the growth volume. */
  center: THREE.Vector3;
  /** Half-extents of the attraction cloud. */
  extent: THREE.Vector3;
};

export type ColonyOptions = {
  /** Preferred depth band for this colony. */
  depthLayer: DepthLayer;
  /** Stagger before colonization steps begin (seconds). */
  startDelay: number;
  /** Seed root count. */
  seedRoots?: number;
  /** Attraction count scale vs config (default 1). */
  attractionScale?: number;
};

/**
 * Classic space-colonization: attraction cloud pulls nodes; kill radius consumes points.
 * Irregular asymmetric growth via jittered directions and delayed branching.
 */
export class SpaceColonization {
  attractions: AttractionPoint[] = [];
  nodes: Branch[] = [];
  readonly roots: Branch[] = [];

  readonly colonyId: number;
  readonly depthLayer: DepthLayer;
  readonly startDelay: number;

  private readonly volume: ColonizationVolume;
  private readonly tmp = new THREE.Vector3();
  private readonly avg = new THREE.Vector3();
  private stalledFrames = 0;
  private age = 0;
  private attractionScale = 1;
  private seedRoots = 2;

  constructor(volume: ColonizationVolume, colonyId: number, opts: ColonyOptions) {
    this.volume = volume;
    this.colonyId = colonyId;
    this.depthLayer = opts.depthLayer;
    this.startDelay = opts.startDelay;
    this.seedRoots = opts.seedRoots ?? 2;
    this.attractionScale = opts.attractionScale ?? 1;
  }

  get isStalled(): boolean {
    return this.stalledFrames > 50 || this.activeAttractionCount === 0;
  }

  get activeAttractionCount(): number {
    let n = 0;
    for (const a of this.attractions) if (a.active) n++;
    return n;
  }

  get isReady(): boolean {
    return this.age >= this.startDelay;
  }

  reset(cfg: ForestConfig): void {
    this.attractions = [];
    this.nodes = [];
    this.roots.length = 0;
    this.stalledFrames = 0;
    this.age = 0;

    const { center, extent } = this.volume;
    const count = Math.max(40, Math.round(cfg.attractionCount * this.attractionScale));

    // Depth-layer Z bias: far colonies sit deeper into the photo plane
    const zPush =
      this.depthLayer === 'far' ? -0.35 : this.depthLayer === 'near' ? 0.28 : 0;

    for (let i = 0; i < count; i++) {
      const u = Math.random();
      const v = Math.random();
      const w = Math.random();
      const radial = Math.pow(Math.random(), 0.7);
      const angle = Math.random() * Math.PI * 2;
      let x = center.x + Math.cos(angle) * radial * extent.x * (0.3 + u * 0.8);
      let y = center.y + (v - 0.52) * extent.y * 1.05;
      let z = center.z + zPush + Math.sin(angle) * radial * extent.z * (0.35 + w * 0.75);

      // Non-uniform: denser pockets, sparse edges
      if (Math.random() < 0.09) {
        x = center.x + (Math.random() - 0.5) * extent.x * 2.1;
        y = center.y + (Math.random() - 0.5) * extent.y * 1.5;
        z = center.z + zPush + (Math.random() - 0.5) * extent.z * 1.9;
      }
      this.attractions.push(new AttractionPoint(x, y, z));
    }

    const seeds = this.seedRoots;
    for (let i = 0; i < seeds; i++) {
      const t = seeds === 1 ? 0.5 : i / (seeds - 1);
      const px = center.x + (t - 0.5) * extent.x * (0.7 + Math.random() * 0.35);
      const py = center.y - extent.y * (0.28 + Math.random() * 0.28);
      const pz = center.z + zPush + (Math.random() - 0.5) * extent.z * 0.4;
      const dir = new THREE.Vector3(
        (Math.random() - 0.5) * 0.45,
        0.75 + Math.random() * 0.4,
        (Math.random() - 0.5) * 0.4,
      ).normalize();

      const depthBias = depthBiasForLayer(this.depthLayer);
      const root = new Branch({
        parent: null,
        position: new THREE.Vector3(px, py, pz),
        direction: dir,
        thickness: 0.009 + Math.random() * 0.008,
        luminosity: 0.45 + Math.random() * 0.4,
        depthBias,
        depthLayer: this.depthLayer,
        branchDelay: 0.2 + Math.random() * 0.7,
        colonyId: this.colonyId,
      });
      this.roots.push(root);
      this.nodes.push(root);
    }
  }

  /** Advance colony clock; returns true once stepping may begin. */
  tickDelay(dt: number): boolean {
    this.age += dt;
    return this.isReady;
  }

  /**
   * Attempt one colonization step: assign attractions → grow nodes → kill nearby points.
   * Returns number of new nodes created.
   */
  step(cfg: ForestConfig): number {
    if (!this.isReady) return 0;

    const influence2 = cfg.influenceRadius * cfg.influenceRadius;
    const kill2 = cfg.killRadius * cfg.killRadius;

    const closestNode = new Array<number>(this.attractions.length).fill(-1);
    const closestDist = new Array<number>(this.attractions.length).fill(Infinity);

    for (let ai = 0; ai < this.attractions.length; ai++) {
      const a = this.attractions[ai]!;
      if (!a.active) continue;
      for (let ni = 0; ni < this.nodes.length; ni++) {
        const node = this.nodes[ni]!;
        if (node.dead || node.growth < 0.92) continue;
        if (node.branchDelay > 0) continue;
        const d2 = node.position.distanceToSquared(a.position);
        if (d2 < influence2 && d2 < closestDist[ai]!) {
          closestDist[ai] = d2;
          closestNode[ai] = ni;
        }
      }
    }

    type Acc = { dir: THREE.Vector3; count: number };
    const pull = new Map<number, Acc>();

    for (let ai = 0; ai < this.attractions.length; ai++) {
      const ni = closestNode[ai]!;
      if (ni < 0) continue;
      const a = this.attractions[ai]!;
      let acc = pull.get(ni);
      if (!acc) {
        acc = { dir: new THREE.Vector3(), count: 0 };
        pull.set(ni, acc);
      }
      this.tmp.copy(a.position).sub(this.nodes[ni]!.position);
      const w = 1 / (0.05 + Math.sqrt(closestDist[ai]!));
      acc.dir.addScaledVector(this.tmp, w);
      acc.count++;
    }

    let grown = 0;
    const maxNew = this.depthLayer === 'far' ? 10 : 12;

    for (const [ni, acc] of pull) {
      if (grown >= maxNew) break;
      if (acc.count === 0) continue;
      const parent = this.nodes[ni]!;
      if (parent.children.length >= 3) continue;

      this.avg.copy(acc.dir).normalize();

      const jitter = new THREE.Vector3(
        (Math.random() - 0.5) * 0.58,
        (Math.random() - 0.5) * 0.42,
        (Math.random() - 0.5) * 0.58,
      );
      this.tmp
        .copy(parent.direction)
        .multiplyScalar(0.32)
        .add(this.avg.multiplyScalar(0.68))
        .add(jitter)
        .normalize();

      // Occasional sharp veer — vascular / mycelial feel
      if (Math.random() < 0.11) {
        this.tmp.applyAxisAngle(
          new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize(),
          (Math.random() - 0.5) * 0.95,
        );
      }

      const len = cfg.segmentLength * (0.65 + Math.random() * 0.6);
      const pos = parent.position.clone().addScaledVector(this.tmp, len);

      const depthBias = THREE.MathUtils.clamp(
        parent.depthBias + (Math.random() - 0.5) * 0.1,
        this.depthLayer === 'near' ? 0.08 : this.depthLayer === 'mid' ? 0.35 : 0.65,
        this.depthLayer === 'near' ? 0.42 : this.depthLayer === 'mid' ? 0.72 : 0.98,
      );
      const taper = Math.max(0.0018, parent.thickness * (0.76 + Math.random() * 0.14));
      let lum = parent.luminosity * (0.86 + Math.random() * 0.2);
      const dead = Math.random() < 0.08;
      if (dead) lum *= 0.22;

      const child = new Branch({
        parent,
        position: pos,
        direction: this.tmp.clone(),
        thickness: taper,
        luminosity: lum,
        depthBias,
        depthLayer: this.depthLayer,
        dead,
        branchDelay: 0.08 + Math.random() * 0.65,
        speedMul: 0.5 + Math.random() * 0.95,
        colonyId: this.colonyId,
      });
      this.nodes.push(child);
      grown++;
    }

    for (const a of this.attractions) {
      if (!a.active) continue;
      for (const node of this.nodes) {
        if (node.growth < 0.85) continue;
        if (node.position.distanceToSquared(a.position) < kill2) {
          a.active = false;
          break;
        }
      }
    }

    if (grown === 0) this.stalledFrames++;
    else this.stalledFrames = Math.max(0, this.stalledFrames - 3);

    return grown;
  }
}

/** Call once when rebuilding all colonies so branch IDs stay unique. */
export function beginColonyReset(): void {
  resetBranchIds();
}

