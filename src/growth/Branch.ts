import * as THREE from 'three';

let nextBranchId = 1;

/** Discrete depth layer for mid-ground integration without a depth map. */
export type DepthLayer = 'near' | 'mid' | 'far';

export function depthLayerFromBias(bias: number): DepthLayer {
  if (bias < 0.38) return 'near';
  if (bias < 0.68) return 'mid';
  return 'far';
}

export function depthBiasForLayer(layer: DepthLayer, jitter = Math.random()): number {
  if (layer === 'near') return 0.12 + jitter * 0.22;
  if (layer === 'mid') return 0.4 + jitter * 0.24;
  return 0.72 + jitter * 0.22;
}

/**
 * One colonization node / segment tip. Parent chain forms the organic network.
 * `growth` 0→1 elongates the segment from parent toward `position` over time.
 */
export class Branch {
  readonly id: number;
  readonly parent: Branch | null;
  readonly position: THREE.Vector3;
  /** Direction used when this node was spawned (unit-ish). */
  readonly direction: THREE.Vector3;
  /** Base thickness before taper (world units). */
  thickness: number;
  /** 0 = dim / dead, 1 = full luminosity. */
  luminosity: number;
  /** Elongation of the segment from parent → this node. */
  growth: number;
  /** True when this branch fades and no longer grows children. */
  dead: boolean;
  /** Phase offset for subtle sway. */
  swayPhase: number;
  /** Continuous depth bias (0 near → 1 far). */
  depthBias: number;
  /** Discrete layer used for materials / blur contribution. */
  depthLayer: DepthLayer;
  /** Children grown from this node. */
  readonly children: Branch[] = [];
  /** Delay before this node may spawn children (seconds remaining). */
  branchDelay: number;
  /** Growth rate multiplier (variable speed). */
  speedMul: number;
  /** Colony index (staggered multi-colony growth). */
  colonyId: number;
  /** Cached animated world tip (updated by GrowthSystem each frame). */
  readonly worldTip = new THREE.Vector3();

  constructor(opts: {
    parent: Branch | null;
    position: THREE.Vector3;
    direction: THREE.Vector3;
    thickness: number;
    luminosity: number;
    depthBias?: number;
    depthLayer?: DepthLayer;
    dead?: boolean;
    branchDelay?: number;
    speedMul?: number;
    colonyId?: number;
  }) {
    this.id = nextBranchId++;
    this.parent = opts.parent;
    this.position = opts.position.clone();
    this.direction = opts.direction.clone().normalize();
    this.thickness = opts.thickness;
    this.luminosity = opts.luminosity;
    this.growth = opts.parent ? 0 : 1;
    this.dead = opts.dead ?? false;
    this.swayPhase = Math.random() * Math.PI * 2;
    this.depthBias = opts.depthBias ?? 0.5;
    this.depthLayer = opts.depthLayer ?? depthLayerFromBias(this.depthBias);
    this.branchDelay = opts.branchDelay ?? 0;
    this.speedMul = opts.speedMul ?? 0.7 + Math.random() * 0.7;
    this.colonyId = opts.colonyId ?? 0;
    this.worldTip.copy(this.position);
    if (opts.parent) opts.parent.children.push(this);
  }
}

export function resetBranchIds(): void {
  nextBranchId = 1;
}

