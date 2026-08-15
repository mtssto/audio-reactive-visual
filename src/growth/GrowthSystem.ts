import * as THREE from 'three';
import type { ForestConfig } from '../config/Config';
import {
  beginColonyReset,
  SpaceColonization,
  type ColonizationVolume,
} from './SpaceColonization';
import type { Branch, DepthLayer } from './Branch';

/** Pale cool bioluminescence — desaturated teal / ivory, never neon. */
const CORE_NEAR = new THREE.Color(0xd8ebe4);
const CORE_MID = new THREE.Color(0xc2d8d0);
const CORE_FAR = new THREE.Color(0x9bb4ae);

const SHEATH_NEAR = new THREE.Color(0x8aa89a);
const SHEATH_MID = new THREE.Color(0x6e8a7e);
const SHEATH_FAR = new THREE.Color(0x4f6860);

const GLOW_NEAR = new THREE.Color(0xa8c4b8);
const GLOW_MID = new THREE.Color(0x7a968c);
const GLOW_FAR = new THREE.Color(0x556e66);

type LayerMats = {
  core: THREE.MeshBasicMaterial;
  sheath: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
};

type SegmentMesh = {
  core: THREE.Mesh;
  sheath: THREE.Mesh;
  glow: THREE.Mesh;
  branch: Branch;
  layer: DepthLayer;
};

type ColonyState = {
  colonization: SpaceColonization;
  stepAcc: number;
  phase: 'growing' | 'stable' | 'fading' | 'respawn';
  stableTimer: number;
  fade: number;
};

/**
 * Multi-colony procedural growth: space colonization + three-tier emissive strands
 * (bright core / soft sheath / atmospheric glow) with near/mid/far depth materials.
 */
export class GrowthSystem {
  readonly group = new THREE.Group();
  readonly colonies: ColonyState[] = [];

  private readonly segments: SegmentMesh[] = [];
  private readonly mats: Record<DepthLayer, LayerMats>;
  private readonly unitGeo: THREE.CylinderGeometry;

  private time = 0;
  private cfg: ForestConfig;
  private disposed = false;
  private contactGlowStrength = 0;

  constructor(cfg: ForestConfig, _volume?: ColonizationVolume) {
    this.cfg = { ...cfg };
    this.group.name = 'GrowthSystem';

    this.mats = {
      near: this.makeLayerMats('near'),
      mid: this.makeLayerMats('mid'),
      far: this.makeLayerMats('far'),
    };

    this.unitGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    this.unitGeo.translate(0, 0.5, 0);

    this.buildColonies();
  }

  /** Soft contact-glow hint for background (0–1), denser where growth is bright. */
  getContactGlow(): number {
    return this.contactGlowStrength;
  }

  setConfig(cfg: ForestConfig): void {
    this.cfg = { ...cfg };
  }

  reset(): void {
    this.clearMeshes();
    this.colonies.length = 0;
    this.buildColonies();
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.time += dt;
    const speed = 0.22 + this.cfg.growthSpeed * 1.25;

    let glowAccum = 0;
    let glowCount = 0;

    for (const colony of this.colonies) {
      const ready = colony.colonization.tickDelay(dt);
      if (!ready) continue;

      if (colony.phase === 'growing') {
        colony.stepAcc += dt * (1.5 + this.cfg.growthSpeed * 3.8);
        while (colony.stepAcc >= 1) {
          colony.stepAcc -= 1;
          colony.colonization.step(this.cfg);
        }
        if (colony.colonization.isStalled) {
          colony.phase = 'stable';
          colony.stableTimer = 3 + Math.random() * 4;
        }
      } else if (colony.phase === 'stable') {
        colony.stableTimer -= dt;
        if (colony.stableTimer <= 0) colony.phase = 'fading';
      } else if (colony.phase === 'fading') {
        colony.fade = Math.max(0, colony.fade - dt * 0.18);
        if (colony.fade <= 0.02) colony.phase = 'respawn';
      } else if (colony.phase === 'respawn') {
        colony.fade = 1;
        colony.phase = 'growing';
        colony.stableTimer = 0;
        colony.stepAcc = 0;
        colony.colonization.reset(this.cfg);
      }

      for (const node of colony.colonization.nodes) {
        if (node.branchDelay > 0) node.branchDelay = Math.max(0, node.branchDelay - dt);
        if (node.growth < 1 && !node.dead) {
          const rate = speed * node.speedMul * (0.5 + this.cfg.growthSpeed);
          node.growth = Math.min(1, node.growth + dt * rate);
        } else if (node.dead && node.growth < 1) {
          node.growth = Math.min(1, node.growth + dt * speed * 0.32);
        }
        if (node.parent && node.growth > 0.3 && !node.dead) {
          glowAccum += node.luminosity * (1 - node.depthBias * 0.5) * colony.fade;
          glowCount++;
        }
      }
    }

    this.contactGlowStrength =
      glowCount > 0 ? THREE.MathUtils.clamp((glowAccum / glowCount) * 0.55, 0, 0.7) : 0;

    this.updateWorldTips();
    this.syncSegmentMeshes();
    this.updateSegmentTransforms();
  }

  private buildColonies(): void {
    beginColonyReset();

    // Three staggered colonies across depth layers — look quality over density
    const specs: {
      layer: DepthLayer;
      delay: number;
      center: THREE.Vector3;
      extent: THREE.Vector3;
      seeds: number;
      attrScale: number;
    }[] = [
      {
        layer: 'far',
        delay: 0,
        center: new THREE.Vector3(-0.15, -0.08, -0.25),
        extent: new THREE.Vector3(1.15, 0.95, 0.55),
        seeds: 2,
        attrScale: 0.85,
      },
      {
        layer: 'mid',
        delay: 1.8,
        center: new THREE.Vector3(0.12, -0.14, 0.12),
        extent: new THREE.Vector3(1.05, 1.0, 0.7),
        seeds: 3,
        attrScale: 1,
      },
      {
        layer: 'near',
        delay: 4.2,
        center: new THREE.Vector3(-0.05, -0.18, 0.42),
        extent: new THREE.Vector3(0.75, 0.85, 0.45),
        seeds: 2,
        attrScale: 0.65,
      },
    ];

    specs.forEach((s, i) => {
      const col = new SpaceColonization(
        { center: s.center, extent: s.extent },
        i,
        {
          depthLayer: s.layer,
          startDelay: s.delay,
          seedRoots: s.seeds,
          attractionScale: s.attrScale,
        },
      );
      col.reset(this.cfg);
      this.colonies.push({
        colonization: col,
        stepAcc: 0,
        phase: 'growing',
        stableTimer: 0,
        fade: 1,
      });
    });
  }

  private makeLayerMats(layer: DepthLayer): LayerMats {
    const coreC = layer === 'near' ? CORE_NEAR : layer === 'mid' ? CORE_MID : CORE_FAR;
    const sheathC = layer === 'near' ? SHEATH_NEAR : layer === 'mid' ? SHEATH_MID : SHEATH_FAR;
    const glowC = layer === 'near' ? GLOW_NEAR : layer === 'mid' ? GLOW_MID : GLOW_FAR;

    const coreOp = layer === 'near' ? 0.88 : layer === 'mid' ? 0.72 : 0.48;
    const sheathOp = layer === 'near' ? 0.2 : layer === 'mid' ? 0.14 : 0.08;
    const glowOp = layer === 'near' ? 0.08 : layer === 'mid' ? 0.06 : 0.04;

    const mk = (color: THREE.Color, opacity: number) =>
      new THREE.MeshBasicMaterial({
        color: color.clone(),
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        side: THREE.DoubleSide,
      });

    return {
      core: mk(coreC, coreOp),
      sheath: mk(sheathC, sheathOp),
      glow: mk(glowC, glowOp),
    };
  }

  private colonyFadeFor(branch: Branch): number {
    const c = this.colonies[branch.colonyId];
    return c?.fade ?? 1;
  }

  private updateWorldTips(): void {
    const sway = 0.01;
    for (const colony of this.colonies) {
      for (const node of colony.colonization.nodes) {
        if (!node.parent) {
          node.worldTip.copy(node.position);
          continue;
        }
        const p = node.parent.worldTip;
        node.worldTip.lerpVectors(p, node.position, node.growth);
        const s = Math.sin(this.time * 0.48 + node.swayPhase) * sway * node.growth;
        const c = Math.cos(this.time * 0.37 + node.swayPhase * 1.25) * sway * 0.5 * node.growth;
        // Far strands sway less (more atmospheric, less tactile)
        const depthMul = 0.45 + (1 - node.depthBias) * 0.55;
        node.worldTip.x += s * depthMul;
        node.worldTip.z += c * depthMul;
      }
    }
  }

  private syncSegmentMeshes(): void {
    let need = 0;
    for (const colony of this.colonies) {
      for (const n of colony.colonization.nodes) if (n.parent) need++;
    }

    while (this.segments.length < need) {
      const layer: DepthLayer = 'mid';
      const mats = this.mats[layer];
      const core = new THREE.Mesh(this.unitGeo, mats.core);
      const sheath = new THREE.Mesh(this.unitGeo, mats.sheath);
      const glow = new THREE.Mesh(this.unitGeo, mats.glow);
      core.frustumCulled = false;
      sheath.frustumCulled = false;
      glow.frustumCulled = false;
      // Draw glow → sheath → core for soft layering
      this.group.add(glow);
      this.group.add(sheath);
      this.group.add(core);
      this.segments.push({
        core,
        sheath,
        glow,
        branch: this.colonies[0]!.colonization.nodes[0]!,
        layer,
      });
    }

    while (this.segments.length > need) {
      const seg = this.segments.pop()!;
      this.group.remove(seg.core);
      this.group.remove(seg.sheath);
      this.group.remove(seg.glow);
    }

    let si = 0;
    for (const colony of this.colonies) {
      for (const n of colony.colonization.nodes) {
        if (!n.parent) continue;
        const seg = this.segments[si]!;
        seg.branch = n;
        if (seg.layer !== n.depthLayer) {
          seg.layer = n.depthLayer;
          const m = this.mats[n.depthLayer];
          seg.core.material = m.core;
          seg.sheath.material = m.sheath;
          seg.glow.material = m.glow;
        }
        // Far behind mid behind near for soft occlusion feel
        const order = n.depthLayer === 'far' ? 10 : n.depthLayer === 'mid' ? 20 : 30;
        seg.glow.renderOrder = order;
        seg.sheath.renderOrder = order + 1;
        seg.core.renderOrder = order + 2;
        si++;
      }
    }
  }

  private updateSegmentTransforms(): void {
    const brightness = this.cfg.coreBrightness;
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const quat = new THREE.Quaternion();

    for (const seg of this.segments) {
      const b = seg.branch;
      const parent = b.parent;
      if (!parent) {
        seg.core.visible = false;
        seg.sheath.visible = false;
        seg.glow.visible = false;
        continue;
      }

      const a = parent.worldTip;
      const tip = b.worldTip;
      dir.subVectors(tip, a);
      const len = dir.length();
      if (len < 1e-5 || b.growth < 0.02) {
        seg.core.visible = false;
        seg.sheath.visible = false;
        seg.glow.visible = false;
        continue;
      }
      dir.multiplyScalar(1 / len);
      if (Math.abs(dir.y) > 0.999) {
        quat.identity();
        if (dir.y < 0) quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
      } else {
        quat.setFromUnitVectors(up, dir);
      }

      const fade = this.colonyFadeFor(b);
      const depthScale = 1.08 - b.depthBias * 0.42;
      const depthLum = (1.08 - b.depthBias * 0.5) * fade;
      const r0 = parent.thickness * depthScale * 1.08;
      const r1 = b.thickness * depthScale;
      const radius = (r0 + r1) * 0.5;
      const wobble = 1 + Math.sin(b.id * 12.7 + this.time * 0.18) * 0.045;

      seg.core.visible = true;
      seg.sheath.visible = true;
      seg.glow.visible = true;

      const lum = b.luminosity * brightness * depthLum;
      const deadMul = b.dead ? 0.4 : 1;

      // (1) very thin bright core
      const coreR = radius * 0.28 * wobble * (0.9 + lum * 0.25) * deadMul;
      seg.core.position.copy(a);
      seg.core.quaternion.copy(quat);
      seg.core.scale.set(coreR, len, coreR);

      // (2) low-intensity emissive sheath
      const sheathR = radius * 1.15 * wobble * (0.85 + lum * 0.2) * deadMul;
      seg.sheath.position.copy(a);
      seg.sheath.quaternion.copy(quat);
      seg.sheath.scale.set(sheathR, len, sheathR);

      // (3) soft atmospheric glow — larger & softer for far layers
      const glowMul = b.depthLayer === 'far' ? 4.2 : b.depthLayer === 'mid' ? 3.4 : 2.8;
      const glowR = radius * glowMul * wobble * (0.7 + lum * 0.45) * deadMul;
      seg.glow.position.copy(a);
      seg.glow.quaternion.copy(quat);
      seg.glow.scale.set(glowR, len * 1.02, glowR);
    }

    // Shared per-layer opacity driven by brightness + global feel
    for (const layer of ['near', 'mid', 'far'] as DepthLayer[]) {
      const m = this.mats[layer];
      const base =
        layer === 'near' ? 1 : layer === 'mid' ? 0.85 : 0.62;
      m.core.opacity = (0.5 + brightness * 0.42) * base;
      m.sheath.opacity = (0.08 + brightness * 0.14) * base;
      m.glow.opacity = (0.035 + brightness * 0.055) * base;
    }
  }

  private clearMeshes(): void {
    for (const seg of this.segments) {
      this.group.remove(seg.core);
      this.group.remove(seg.sheath);
      this.group.remove(seg.glow);
    }
    this.segments.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearMeshes();
    this.unitGeo.dispose();
    for (const layer of Object.values(this.mats)) {
      layer.core.dispose();
      layer.sheath.dispose();
      layer.glow.dispose();
    }
  }
}

