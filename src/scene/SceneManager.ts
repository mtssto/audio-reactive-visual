import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type SceneManagerOptions = {
  canvas: HTMLCanvasElement;
  /** Mid-ground focus distance for growth volume. */
  lookAt?: THREE.Vector3;
};

/**
 * Perspective scene + WebGL renderer. OrbitControls off by default (toggle via setDebugOrbit).
 */
export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly clock = new THREE.Clock();
  private debugOrbit = false;
  private disposed = false;

  constructor(opts: SceneManagerOptions) {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 80);
    this.camera.position.set(0, 0.12, 4.0);
    const target = opts.lookAt ?? new THREE.Vector3(0, -0.08, 0.1);
    this.camera.lookAt(target);
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x040605, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.88;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.copy(target);
    this.controls.enabled = false;
    this.controls.enablePan = true;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 12;

    // Cool, low fill — growth is self-lit; avoid washing the photo
    const ambient = new THREE.AmbientLight(0x141c18, 0.28);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0x7a8a82, 0.16);
    key.position.set(1.8, 3.5, 2.5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x3a4842, 0.08);
    fill.position.set(-2, 1, -1);
    this.scene.add(fill);

    this.resize();
  }

  setDebugOrbit(on: boolean): void {
    this.debugOrbit = on;
    this.controls.enabled = on;
    this.renderer.domElement.style.cursor = on ? 'grab' : 'default';
  }

  toggleDebugOrbit(): boolean {
    this.setDebugOrbit(!this.debugOrbit);
    return this.debugOrbit;
  }

  get isDebugOrbit(): boolean {
    return this.debugOrbit;
  }

  resize(width?: number, height?: number): void {
    const w = width ?? (this.renderer.domElement.clientWidth || window.innerWidth);
    const h = height ?? (this.renderer.domElement.clientHeight || window.innerHeight);
    if (w < 1 || h < 1) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /** Seconds since last call (clamped for tab-switch spikes). */
  tick(): number {
    return Math.min(this.clock.getDelta(), 0.05);
  }

  getElapsed(): number {
    return this.clock.elapsedTime;
  }

  updateControls(): void {
    if (this.debugOrbit) this.controls.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controls.dispose();
    this.renderer.dispose();
  }
}

