import * as THREE from 'three';
import gsap from 'gsap';
import vertexShader from './shaders/vertex.glsl?raw';
import fragmentShader from './shaders/fragment.glsl?raw';
import { TouchField } from './TouchField';
import type { FrequencyBands } from '../../audio/AudioReactive';

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
  uTouchNdc: { value: Float32Array };
  uTouchStrength: { value: Float32Array };
  uTouchAge: { value: Float32Array };
  uTouchRadius: { value: number };
};

/**
 * Codrops-style reactive particle cloud with mic + touch scatter/ripple.
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
      amplitude: { value: 1 },
      offsetGain: { value: 0 },
      maxDistance: { value: 1.8 },
      startColor: { value: new THREE.Color(0xff00ff) },
      endColor: { value: new THREE.Color(0x00ffff) },
      uTouchNdc: { value: new Float32Array(8) },
      uTouchStrength: { value: new Float32Array(4) },
      uTouchAge: { value: new Float32Array(4) },
      uTouchRadius: { value: 0.22 },
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
    this.createCylinderMesh();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.visible = on;
  }

  get isEnabled(): boolean {
    return this.enabled;
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

  pulseNormalized(nx: number, ny: number, strength = 1, id?: string): void {
    const ndc = this.normalizedToNdc(nx, ny);
    this.touches.pulse(ndc.x, ndc.y, strength, id);
  }

  holdNormalized(nx: number, ny: number, strength = 0.75, id: string): void {
    const ndc = this.normalizedToNdc(nx, ny);
    this.touches.hold(ndc.x, ndc.y, strength, id);
  }

  releaseTouch(id: string): void {
    this.touches.release(id);
  }

  remix(): void {
    if (!this.autoMix) return;
    this.destroyMesh();
    if (Math.random() < 0.5) this.createCylinderMesh();
    else this.createBoxMesh();
    gsap.to(this.material.uniforms.frequency, {
      duration: 1.2,
      value: THREE.MathUtils.randFloat(0.5, 3),
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

    this.remixCooldown = Math.max(0, this.remixCooldown - dt);

    if (audioActive && bands) {
      this.uniforms.amplitude.value =
        0.8 + THREE.MathUtils.mapLinear(bands.high, 0, 0.6, -0.1, 0.2);
      this.uniforms.offsetGain.value = bands.mid * 0.6;
      const t = THREE.MathUtils.mapLinear(bands.low, 0.6, 1, 0.2, 0.5);
      this.time += THREE.MathUtils.clamp(t, 0.2, 0.5) * (dt * 60);
    } else {
      this.uniforms.frequency.value = 0.8;
      this.uniforms.amplitude.value = 1;
      this.time += 0.2 * (dt * 60);
    }

    // Soft auto-rotate
    this.holderObjects.rotation.z += dt * 0.15;

    this.uniforms.time.value = this.time;
  }

  /** Trigger remix from mic transient or pinch. */
  maybeRemixFromSignal(signal: number): void {
    if (signal > 0.12 && this.remixCooldown <= 0 && Math.random() < 0.45) {
      this.remix();
      this.remixCooldown = 1.8;
    }
  }

  private createBoxMesh(): void {
    const widthSeg = Math.floor(THREE.MathUtils.randInt(5, 20));
    const heightSeg = Math.floor(THREE.MathUtils.randInt(1, 40));
    const depthSeg = Math.floor(THREE.MathUtils.randInt(5, 80));
    const geometry = new THREE.BoxGeometry(1, 1, 1, widthSeg, heightSeg, depthSeg);

    this.uniforms.offsetSize.value = Math.floor(THREE.MathUtils.randInt(30, 60));
    this.uniforms.size.value = 1.1;

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
    const radialSeg = Math.floor(THREE.MathUtils.randInt(1, 3));
    const heightSeg = Math.floor(THREE.MathUtils.randInt(1, 5));
    const geometry = new THREE.CylinderGeometry(
      1,
      1,
      4,
      64 * radialSeg,
      64 * heightSeg,
      true,
    );

    this.uniforms.offsetSize.value = Math.floor(THREE.MathUtils.randInt(30, 60));
    this.uniforms.size.value = 2;

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
