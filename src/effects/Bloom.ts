import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * Restrained UnrealBloomPass — soft atmospheric spill from emissive cores, never neon wash.
 */
export class BloomEffect {
  readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly renderPass: RenderPass;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    strength = 0.14,
  ) {
    const size = new THREE.Vector2();
    renderer.getSize(size);

    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // High threshold + soft radius → only the thin cores bloom; sheaths stay restrained
    this.bloomPass = new UnrealBloomPass(size.clone(), strength, 0.48, 0.88);
    this.bloomPass.threshold = 0.86;
    this.bloomPass.strength = strength;
    this.bloomPass.radius = 0.42;
    this.composer.addPass(this.bloomPass);

    this.composer.addPass(new OutputPass());
  }

  setStrength(strength: number): void {
    this.bloomPass.strength = Math.max(0, Math.min(0.5, strength));
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.bloomPass.resolution.set(width, height);
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}

