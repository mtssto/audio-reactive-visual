import * as THREE from 'three';
import gsap from 'gsap';
import vertexShader from './shaders/vertex.glsl?raw';
import fragmentShader from './shaders/fragment.glsl?raw';
import { TouchField, type TouchHoldOptions } from './TouchField';
import type { FrequencyBands } from '../../audio/AudioReactive';
import type { PresenceState } from '../../core/PresenceSensor';
import {
  DEFAULT_PRESET_ID,
  getPreset,
  type VisualPreset,
  type VisualPresetId,
} from './visualPresets';
import {
  loadImageFromFile,
  sampleImageToParticles,
} from './sampleImageParticles';

type ParticleUniforms = {
  time: { value: number };
  offsetSize: { value: number };
  size: { value: number };
  frequency: { value: number };
  amplitude: { value: number };
  offsetGain: { value: number };
  maxDistance: { value: number };
  startColor: { value: THREE.Color };
  endColor: { value: THREE.Color };
  uImageMode: { value: number };
  uBreak: { value: number };
  uTouchNdc: { value: Float32Array };
  uTouchStrength: { value: Float32Array };
  uTouchAge: { value: Float32Array };
  uTouchRadius: { value: Float32Array };
  uTouchMode: { value: Float32Array };
};

export type ParticleFieldMode = 'mesh' | 'image';

/**
 * Codrops-style reactive particle cloud with presence + hand verbs,
 * plus an Image mode that samples a photo into a disintegrating field.
 */
export class ReactiveParticleField extends THREE.Object3D {
  readonly touches = new TouchField();
  readonly particleCamera: THREE.PerspectiveCamera;

  private material: THREE.ShaderMaterial;
  private holderObjects = new THREE.Object3D();
  private pointsMesh: THREE.Object3D | THREE.Points | null = null;
  private time = 0;
  private enabled = true;
  private autoMix = true;
  private remixCooldown = 0;
  private uniforms: ParticleUniforms;
  private preset: VisualPreset = getPreset(DEFAULT_PRESET_ID);

  private presenceEnergy = 0;
  private baseFrequency = 2;
  private baseSize = 1.1;
  private spinRate = 0.08;
  private mode: ParticleFieldMode = 'mesh';
  private hasImage = false;
  private breakAmount = 0;
  private lastLoudness = 0;
  private lastImageSample: {
    positions: Float32Array;
    colors: Float32Array;
    seeds: Float32Array;
    halfWidth: number;
    halfHeight: number;
  } | null = null;

  constructor() {
    super();
    this.name = 'ReactiveParticleField';

    this.particleCamera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
    this.particleCamera.position.z = 12;

    this.uniforms = {
      time: { value: 0 },
      offsetSize: { value: 2 },
      size: { value: 1.1 },
      frequency: { value: 2 },
      amplitude: { value: 0.42 },
      offsetGain: { value: 0 },
      maxDistance: { value: 1.8 },
      startColor: { value: new THREE.Color(this.preset.startColor) },
      endColor: { value: new THREE.Color(this.preset.endColor) },
      uImageMode: { value: 0 },
      uBreak: { value: 0 },
      uTouchNdc: { value: new Float32Array(8) },
      uTouchStrength: { value: new Float32Array(4) },
      uTouchAge: { value: new Float32Array(4) },
      uTouchRadius: { value: new Float32Array([0.2, 0.2, 0.2, 0.2]) },
      uTouchMode: { value: new Float32Array(4) },
    };

    this.material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: this.uniforms,
    });

    this.add(this.holderObjects);
    this.createPreferredMesh();
  }

  get presetId(): VisualPresetId {
    return this.preset.id;
  }

  get clearColor(): number {
    return this.preset.clearColor;
  }

  get activePreset(): VisualPreset {
    return this.preset;
  }

  get fieldMode(): ParticleFieldMode {
    return this.mode;
  }

  get hasLoadedImage(): boolean {
    return this.hasImage;
  }

  get breakLevel(): number {
    return this.breakAmount;
  }

  /**
   * Live-switch authored look. Remeshes so mesh / density bias is visible.
   * Image preset enters image mode (keeps last sampled cloud if any).
   */
  applyPreset(id: VisualPresetId, remesh = true): VisualPreset {
    this.preset = getPreset(id);
    this.uniforms.startColor.value.set(this.preset.startColor);
    this.uniforms.endColor.value.set(this.preset.endColor);
    this.material.blending =
      this.preset.blending === 'normal'
        ? THREE.NormalBlending
        : THREE.AdditiveBlending;
    // Opaque-ish stipple only once an image cloud is live; awaiting load keeps mesh soft
    this.material.depthWrite = id === 'image' && this.hasImage;
    this.material.transparent = true;
    this.material.needsUpdate = true;

    if (id === 'image') {
      this.enterImageMode(remesh);
    } else {
      this.enterMeshMode(remesh);
    }
    return this.preset;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.visible = on;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setPresence(_state: PresenceState, energy: number): void {
    this.presenceEnergy = THREE.MathUtils.clamp(energy, 0, 1);
  }

  setSize(width: number, height: number): void {
    this.particleCamera.aspect = width / Math.max(1, height);
    this.particleCamera.updateProjectionMatrix();
  }

  /** Normalized video/content coords 0–1 → NDC for the particle camera. */
  normalizedToNdc(nx: number, ny: number): { x: number; y: number } {
    return {
      x: nx * 2 - 1,
      y: 1 - ny * 2,
    };
  }

  pulseNormalized(
    nx: number,
    ny: number,
    strength = 1,
    id?: string,
    opts?: TouchHoldOptions,
  ): void {
    const ndc = this.normalizedToNdc(nx, ny);
    this.touches.pulse(ndc.x, ndc.y, strength, id, opts);
  }

  holdNormalized(
    nx: number,
    ny: number,
    strength = 0.75,
    id: string,
    opts?: TouchHoldOptions,
  ): void {
    const ndc = this.normalizedToNdc(nx, ny);
    this.touches.hold(ndc.x, ndc.y, strength, id, opts);
  }

  releaseTouch(id: string): void {
    this.touches.release(id);
  }

  releaseTouchesExcept(keep: Set<string>): void {
    this.touches.releaseExcept(keep);
  }

  /** Load PNG/JPG (or similar) and switch into Image mode. */
  async loadImage(file: File): Promise<number> {
    const img = await loadImageFromFile(file);
    return this.applyImageSource(img);
  }

  /** Apply an already-decoded image / canvas / video frame as particles. */
  applyImageSource(source: CanvasImageSource): number {
    const sample = sampleImageToParticles(source, {
      maxSide: 256,
      maxParticles: 36000,
      planeHalfWidth: 5.2,
      planeMaxHalfHeight: 3.85,
      skipWhiteAbove: 1,
    });
    if (sample.count < 8) {
      throw new Error('Image produced too few particles');
    }

    this.preset = getPreset('image');
    this.uniforms.startColor.value.set(this.preset.startColor);
    this.uniforms.endColor.value.set(this.preset.endColor);
    this.material.blending = THREE.NormalBlending;
    this.material.depthWrite = true;
    this.material.transparent = true;
    this.material.needsUpdate = true;

    this.lastImageSample = {
      positions: sample.positions.slice(),
      colors: sample.colors.slice(),
      seeds: sample.seeds.slice(),
      halfWidth: sample.halfWidth,
      halfHeight: sample.halfHeight,
    };
    this.hasImage = true;
    this.showImageCloud(true);
    return sample.count;
  }

  remix(): void {
    if (!this.autoMix || this.mode === 'image') return;
    this.destroyMesh();
    this.createPreferredMesh();
    const nextFreq = THREE.MathUtils.randFloat(0.5, 3);
    this.baseFrequency = nextFreq;
    gsap.to(this.material.uniforms.frequency, {
      duration: 1.2,
      value: nextFreq,
      ease: 'expo.inOut',
    });
  }

  update(dt: number, bands: FrequencyBands | null, audioActive: boolean): void {
    if (!this.enabled) return;

    this.touches.update(dt);
    const packed = this.touches.toUniforms();
    this.uniforms.uTouchNdc.value.set(packed.ndc);
    this.uniforms.uTouchStrength.value.set(packed.strength);
    this.uniforms.uTouchAge.value.set(packed.age);
    this.uniforms.uTouchRadius.value.set(packed.radius);
    this.uniforms.uTouchMode.value.set(packed.mode);

    this.remixCooldown = Math.max(0, this.remixCooldown - dt);

    const e = this.presenceEnergy;
    const p = this.preset;
    let amplitude = THREE.MathUtils.lerp(p.idleAmp, p.presentAmp, e);
    let sizeMul = THREE.MathUtils.lerp(0.82, 1.08, e) * p.sizeScale;
    this.spinRate = THREE.MathUtils.lerp(0.06, 0.18, e);

    let offsetGain = 0;
    let timeDrive = THREE.MathUtils.lerp(0.12, 0.28, e);
    let loudness = 0;
    if (audioActive && bands) {
      loudness = bands.low * 0.5 + bands.mid * 0.35 + bands.high * 0.15;
      this.lastLoudness = loudness;
      const emotion = THREE.MathUtils.clamp(
        THREE.MathUtils.mapLinear(loudness, 0.05, 0.55, -0.18, 0.22),
        -0.2,
        0.28,
      );
      amplitude += emotion * (0.45 + e * 0.55);
      offsetGain = loudness * 0.22 * e;
      timeDrive += loudness * 0.12 * e;
    } else {
      this.lastLoudness *= Math.exp(-dt * 3);
      loudness = this.lastLoudness;
    }

    amplitude *= p.amplitudeScale;

    const gather = this.touches.gatherStrength();
    const touchEnergy = Math.min(
      1,
      this.touches.count * 0.22 + gather * 0.55,
    );

    if (this.mode === 'image') {
      // Stay mostly formed at rest; presence/mic/touch raise break to disintegrate.
      // Soften presence so merely standing in frame doesn't keep the photo dusty.
      const presenceBreak = Math.max(0, e - 0.12) * 0.32;
      const breakTarget = THREE.MathUtils.clamp(
        presenceBreak + loudness * 0.52 + touchEnergy * 0.78,
        0,
        1,
      );
      const breakLerp = breakTarget > this.breakAmount ? dt * 3.0 : dt * 1.85;
      this.breakAmount += (breakTarget - this.breakAmount) * Math.min(1, breakLerp);
      this.uniforms.uBreak.value = this.breakAmount;
      this.spinRate = 0;
      sizeMul = THREE.MathUtils.lerp(1.0, 1.08, e) * p.sizeScale;
      // Amplitude only ramps with break so idle stays pinned to home positions
      const dustAmp = 0.55 + this.breakAmount * 1.35;
      amplitude = THREE.MathUtils.lerp(0.08, dustAmp, this.breakAmount);
      timeDrive = THREE.MathUtils.lerp(0.06, 0.3, Math.max(e * 0.5, this.breakAmount));
    } else {
      this.breakAmount *= Math.exp(-dt * 4);
      this.uniforms.uBreak.value = 0;
    }

    const freqTarget =
      this.mode === 'image'
        ? this.baseFrequency + this.breakAmount * 0.85 + gather * 0.4
        : this.baseFrequency + gather * 1.35;
    this.uniforms.frequency.value +=
      (freqTarget - this.uniforms.frequency.value) * Math.min(1, dt * 5);

    this.uniforms.amplitude.value = amplitude;
    this.uniforms.size.value = this.baseSize * sizeMul;
    this.uniforms.offsetGain.value = offsetGain;
    this.time += THREE.MathUtils.clamp(timeDrive, 0.08, 0.55) * (dt * 60);

    if (this.mode !== 'image') {
      this.holderObjects.rotation.z += dt * this.spinRate;
    }
    this.uniforms.time.value = this.time;
  }

  /** Trigger remix from mic transient or pinch edge — keep subtle. */
  maybeRemixFromSignal(signal: number): void {
    if (this.mode === 'image') return;
    if (
      signal > 0.18 &&
      this.remixCooldown <= 0 &&
      Math.random() < this.preset.remixChance
    ) {
      this.remix();
      this.remixCooldown = 2.4;
    }
  }

  private enterImageMode(_rebuild: boolean): void {
    if (!this.hasImage || !this.lastImageSample) {
      // Keep current mesh until a file is loaded; preset id is still 'image'.
      this.material.depthWrite = false;
      this.material.needsUpdate = true;
      return;
    }
    this.showImageCloud(false);
  }

  private showImageCloud(animateIn: boolean): void {
    if (!this.lastImageSample) return;

    this.destroyMesh();
    this.buildImagePoints(
      this.lastImageSample.positions,
      this.lastImageSample.colors,
      this.lastImageSample.seeds,
    );
    this.mode = 'image';
    this.uniforms.uImageMode.value = 1;
    this.breakAmount = 0;
    this.uniforms.uBreak.value = 0;
    this.baseFrequency = 1.15;
    this.uniforms.frequency.value = 1.15;
    this.autoMix = false;
    this.material.blending = THREE.NormalBlending;
    this.material.depthWrite = true;
    this.material.needsUpdate = true;

    gsap.killTweensOf(this.holderObjects.rotation);
    gsap.killTweensOf(this.position);
    this.holderObjects.rotation.set(0, 0, 0);
    // Bring the photo plane closer so it fills the view (camera at z=12)
    const framedZ = 5.2;
    this.position.set(0, 0, framedZ);
    if (animateIn) {
      gsap.fromTo(
        this.position,
        { z: framedZ + 1.6 },
        { duration: 0.75, z: framedZ, ease: 'elastic.out(0.65)' },
      );
    }
  }

  private enterMeshMode(remesh: boolean): void {
    this.mode = 'mesh';
    this.uniforms.uImageMode.value = 0;
    this.uniforms.uBreak.value = 0;
    this.breakAmount = 0;
    this.autoMix = true;
    this.material.depthWrite = false;
    this.material.blending =
      this.preset.blending === 'normal'
        ? THREE.NormalBlending
        : THREE.AdditiveBlending;
    this.material.needsUpdate = true;
    if (remesh) {
      this.destroyMesh();
      this.createPreferredMesh();
    }
  }

  private buildImagePoints(
    positions: Float32Array,
    colors: Float32Array,
    seeds: Float32Array,
  ): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions.slice(), 3),
    );
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(colors.slice(), 3),
    );
    geometry.setAttribute(
      'aSeed',
      new THREE.BufferAttribute(seeds.slice(), 1),
    );
    // Dummy normals so any leftover normal refs are safe
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < normals.length; i += 3) {
      normals[i + 2] = 1;
    }
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

    this.uniforms.offsetSize.value = this.randomOffsetSize();
    // Smaller points for denser sampling — slight overlap, not muddy blobs
    this.baseSize = 0.34;
    this.uniforms.size.value = this.baseSize * this.preset.sizeScale;
    this.uniforms.maxDistance.value = 4.5;

    const points = new THREE.Points(geometry, this.material);
    this.pointsMesh = points;
    this.holderObjects.add(points);
  }

  private ensureColorAttribute(geometry: THREE.BufferGeometry): void {
    if (geometry.getAttribute('color')) return;
    const pos = geometry.getAttribute('position');
    const count = pos?.count ?? 0;
    const colors = new Float32Array(count * 3);
    colors.fill(1);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  private createPreferredMesh(): void {
    const pref = this.preset.meshPreference;
    if (pref === 'image') {
      // No procedural mesh for image-only preset without a source
      return;
    }
    let useBox: boolean;
    if (pref === 'box') useBox = Math.random() < 0.82;
    else if (pref === 'cylinder') useBox = Math.random() < 0.18;
    else useBox = Math.random() < 0.5;

    if (useBox) this.createBoxMesh();
    else this.createCylinderMesh();
  }

  private densityScale(): number {
    return THREE.MathUtils.clamp(this.preset.density, 0.5, 2);
  }

  private randomOffsetSize(): number {
    const { offsetSizeMin, offsetSizeMax } = this.preset;
    return Math.floor(THREE.MathUtils.randInt(offsetSizeMin, offsetSizeMax));
  }

  private createBoxMesh(): void {
    const d = this.densityScale();
    const widthSeg = Math.floor(
      THREE.MathUtils.randInt(5, 20) * Math.min(1.35, d),
    );
    const heightSeg = Math.floor(
      THREE.MathUtils.randInt(1, 40) * Math.min(1.35, d),
    );
    const depthSeg = Math.floor(
      THREE.MathUtils.randInt(5, 80) * Math.min(1.4, d),
    );
    const geometry = new THREE.BoxGeometry(
      1,
      1,
      1,
      Math.max(2, widthSeg),
      Math.max(1, heightSeg),
      Math.max(2, depthSeg),
    );
    this.ensureColorAttribute(geometry);

    this.uniforms.offsetSize.value = this.randomOffsetSize();
    this.uniforms.maxDistance.value = 1.8;
    this.baseSize = 1.1;
    this.uniforms.size.value = this.baseSize * this.preset.sizeScale;

    this.pointsMesh = new THREE.Object3D();
    this.pointsMesh.rotateX(Math.PI / 2);
    this.holderObjects.add(this.pointsMesh);

    const points = new THREE.Points(geometry, this.material);
    this.pointsMesh.add(points);

    gsap.to(this.pointsMesh.rotation, {
      duration: 3,
      x: Math.random() * Math.PI,
      z: Math.random() * Math.PI * 2,
      ease: 'none',
    });

    gsap.to(this.position, {
      duration: 0.6,
      z: THREE.MathUtils.randInt(9, 11),
      ease: 'elastic.out(0.8)',
    });
  }

  private createCylinderMesh(): void {
    const d = this.densityScale();
    const radialSeg = Math.floor(
      THREE.MathUtils.randInt(1, 3) * Math.min(1.5, d),
    );
    const heightSeg = Math.floor(
      THREE.MathUtils.randInt(1, 5) * Math.min(1.4, d),
    );
    const geometry = new THREE.CylinderGeometry(
      1,
      1,
      4,
      Math.max(32, 64 * Math.max(1, radialSeg)),
      Math.max(16, 64 * Math.max(1, heightSeg)),
      true,
    );
    this.ensureColorAttribute(geometry);

    this.uniforms.offsetSize.value = this.randomOffsetSize();
    this.uniforms.maxDistance.value = 1.8;
    this.baseSize = 2;
    this.uniforms.size.value = this.baseSize * this.preset.sizeScale;

    this.pointsMesh = new THREE.Points(geometry, this.material);
    this.pointsMesh.rotation.set(Math.PI / 2, 0, 0);
    this.holderObjects.add(this.pointsMesh);

    let rotY = 0;
    let posZ = THREE.MathUtils.randInt(9, 11);
    if (Math.random() < 0.2) {
      rotY = Math.PI / 2;
      posZ = THREE.MathUtils.randInt(10, 12);
    }

    gsap.to(this.holderObjects.rotation, {
      duration: 0.2,
      y: rotY,
      ease: 'elastic.out(0.2)',
    });

    gsap.to(this.position, {
      duration: 0.6,
      z: posZ,
      ease: 'elastic.out(0.8)',
    });
  }

  private destroyMesh(): void {
    if (!this.pointsMesh) return;
    this.holderObjects.remove(this.pointsMesh);
    this.pointsMesh.traverse((obj) => {
      const mesh = obj as THREE.Points;
      mesh.geometry?.dispose();
    });
    this.pointsMesh = null;
  }
}
