import * as THREE from 'three';

export type FitMode = 'cover' | 'contain';

/**
 * Full-viewport forest photo with depth-aware integration:
 * desaturation, dim, soft blur, vignette, atmospheric cool cast,
 * and restrained contact glow where growth is dense.
 */
export class ForestBackground {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /** Soft haze plane between far growth and mid photo. */
  readonly farHaze: THREE.Mesh;
  /** Soft haze / vignette closer to camera. */
  readonly nearHaze: THREE.Mesh;

  private readonly planeGeo: THREE.PlaneGeometry;
  private readonly hazeGeo: THREE.PlaneGeometry;
  private texture: THREE.Texture | null = null;
  private fit: FitMode = 'cover';
  private dim = 0.38;
  private desat = 0.28;
  private hazeStrength = 0.22;
  private contactGlow = 0;
  private imageAspect = 16 / 9;
  private viewW = 1;
  private viewH = 1;
  private distance = 8;
  private objectUrl: string | null = null;
  private readonly camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.planeGeo = new THREE.PlaneGeometry(1, 1);
    this.hazeGeo = new THREE.PlaneGeometry(1, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null as THREE.Texture | null },
        uDim: { value: this.dim },
        uDesat: { value: this.desat },
        uContact: { value: 0 },
        uTime: { value: 0 },
        uAspect: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform float uDim;
        uniform float uDesat;
        uniform float uContact;
        uniform float uTime;
        uniform float uAspect;
        varying vec2 vUv;

        vec3 sampleBlur(sampler2D tex, vec2 uv, float amount) {
          // Soft depth-of-field stand-in (no real depth map)
          vec2 px = vec2(amount / uAspect, amount) * 0.0045;
          vec3 c = texture2D(tex, uv).rgb * 0.36;
          c += texture2D(tex, uv + vec2( px.x, 0.0)).rgb * 0.16;
          c += texture2D(tex, uv + vec2(-px.x, 0.0)).rgb * 0.16;
          c += texture2D(tex, uv + vec2(0.0,  px.y)).rgb * 0.16;
          c += texture2D(tex, uv + vec2(0.0, -px.y)).rgb * 0.16;
          return c;
        }

        void main() {
          // Mid-frame slightly sharper; edges softer (atmospheric falloff)
          vec2 d = vUv - vec2(0.5);
          float radial = length(d * vec2(uAspect, 1.0));
          float blurAmt = 0.55 + radial * 1.4;

          vec3 col = sampleBlur(map, vUv, blurAmt);

          // Desaturate toward cool midtones
          float luma = dot(col, vec3(0.299, 0.587, 0.114));
          vec3 cool = mix(vec3(luma), vec3(luma * 0.92, luma * 0.98, luma * 1.02), 0.35);
          col = mix(col, cool, uDesat);

          // Dim + slight cool cast
          float k = 1.0 - uDim;
          col *= k;
          col *= vec3(0.94, 0.97, 0.98);

          // Soft vignette / atmospheric edge darkening
          float vig = smoothstep(0.95, 0.25, radial);
          col *= mix(0.55, 1.0, vig);

          // Restrained contact glow — pale teal where growth is dense (screen-center bias)
          float glowMask = exp(-radial * radial * 3.2) * uContact;
          vec3 glowCol = vec3(0.55, 0.72, 0.68) * glowMask * 0.22;
          col += glowCol;

          // Barely perceptible breathing of mist
          float breathe = 0.01 * sin(uTime * 0.15);
          col += vec3(0.02, 0.03, 0.028) * (0.5 + breathe) * (1.0 - vig);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(this.planeGeo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'ForestBackground';

    const farHazeMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x1a2420),
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: THREE.NormalBlending,
    });
    this.farHaze = new THREE.Mesh(this.hazeGeo, farHazeMat);
    this.farHaze.frustumCulled = false;
    this.farHaze.renderOrder = -900;
    this.farHaze.name = 'ForestFarHaze';

    const nearHazeMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x0c1210),
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: THREE.NormalBlending,
    });
    this.nearHaze = new THREE.Mesh(this.hazeGeo, nearHazeMat);
    this.nearHaze.frustumCulled = false;
    this.nearHaze.renderOrder = 50;
    this.nearHaze.name = 'ForestNearHaze';

    camera.add(this.mesh);
    camera.add(this.farHaze);
    camera.add(this.nearHaze);

    this.applyPlaceholder();
    this.layout(camera);
  }

  setDim(dim: number): void {
    this.dim = THREE.MathUtils.clamp(dim, 0, 0.75);
    this.material.uniforms.uDim!.value = this.dim;
  }

  setDesat(desat: number): void {
    this.desat = THREE.MathUtils.clamp(desat, 0, 0.7);
    this.material.uniforms.uDesat!.value = this.desat;
  }

  setHazeStrength(strength: number): void {
    this.hazeStrength = THREE.MathUtils.clamp(strength, 0, 0.6);
    const farMat = this.farHaze.material as THREE.MeshBasicMaterial;
    const nearMat = this.nearHaze.material as THREE.MeshBasicMaterial;
    farMat.opacity = 0.06 + this.hazeStrength * 0.35;
    nearMat.opacity = 0.04 + this.hazeStrength * 0.22;
  }

  setContactGlow(amount: number): void {
    this.contactGlow = THREE.MathUtils.clamp(amount, 0, 1);
    this.material.uniforms.uContact!.value = this.contactGlow;
  }

  setFit(fit: FitMode): void {
    this.fit = fit;
    this.updateScale();
  }

  getFit(): FitMode {
    return this.fit;
  }

  update(time: number): void {
    this.material.uniforms.uTime!.value = time;
  }

  /** Call on resize / FOV change. */
  layout(camera: THREE.PerspectiveCamera, viewW?: number, viewH?: number): void {
    this.viewW = viewW ?? 1;
    this.viewH = viewH ?? 1;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const visibleH = 2 * Math.tan(vFov / 2) * this.distance;
    const visibleW = visibleH * camera.aspect;
    this.mesh.position.set(0, 0, -this.distance);
    this.mesh.userData.visibleW = visibleW;
    this.mesh.userData.visibleH = visibleH;

    // Haze planes at intermediate depths (between photo and near growth)
    const farDist = 5.2;
    const nearDist = 2.4;
    const farH = 2 * Math.tan(vFov / 2) * farDist;
    const nearH = 2 * Math.tan(vFov / 2) * nearDist;
    this.farHaze.position.set(0, 0, -farDist);
    this.farHaze.scale.set(farH * camera.aspect * 1.05, farH * 1.05, 1);
    this.nearHaze.position.set(0, 0, -nearDist);
    this.nearHaze.scale.set(nearH * camera.aspect * 1.05, nearH * 1.05, 1);

    this.material.uniforms.uAspect!.value = camera.aspect;
    this.updateScale();
  }

  async setImageFromFile(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) return;
    this.revokeObjectUrl();
    this.objectUrl = URL.createObjectURL(file);
    await this.setImageFromUrl(this.objectUrl);
  }

  async setImageFromUrl(url: string): Promise<void> {
    const loader = new THREE.TextureLoader();
    const tex = await loader.loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.applyTexture(tex);
  }

  private applyPlaceholder(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 900;
    const ctx = canvas.getContext('2d')!;

    const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
    sky.addColorStop(0, '#161e1a');
    sky.addColorStop(0.45, '#1e2822');
    sky.addColorStop(1, '#0a0e0c');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const haze = ctx.createRadialGradient(
      canvas.width * 0.5,
      canvas.height * 0.58,
      40,
      canvas.width * 0.5,
      canvas.height * 0.55,
      canvas.width * 0.42,
    );
    haze.addColorStop(0, 'rgba(70, 90, 82, 0.22)');
    haze.addColorStop(0.55, 'rgba(35, 48, 42, 0.1)');
    haze.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(6, 10, 8, 0.88)';
    for (let i = 0; i < 14; i++) {
      const left = i < 7;
      const x = left
        ? canvas.width * (0.02 + Math.random() * 0.22)
        : canvas.width * (0.72 + Math.random() * 0.26);
      const w = 18 + Math.random() * 42;
      const top = canvas.height * (0.15 + Math.random() * 0.25);
      ctx.beginPath();
      ctx.moveTo(x, canvas.height);
      ctx.lineTo(x + w * 0.15, top);
      ctx.lineTo(x + w, top + 20);
      ctx.lineTo(x + w * 0.85, canvas.height);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(10, 16, 13, 0.72)';
    for (let i = 0; i < 10; i++) {
      const x = Math.random() * canvas.width;
      const y = Math.random() * canvas.height * 0.4;
      const r = 80 + Math.random() * 160;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const ground = ctx.createLinearGradient(0, canvas.height * 0.62, 0, canvas.height);
    ground.addColorStop(0, 'rgba(16, 22, 18, 0)');
    ground.addColorStop(0.35, 'rgba(14, 20, 16, 0.55)');
    ground.addColorStop(1, 'rgba(5, 7, 6, 0.95)');
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const vig = ctx.createRadialGradient(
      canvas.width * 0.5,
      canvas.height * 0.5,
      canvas.height * 0.2,
      canvas.width * 0.5,
      canvas.height * 0.5,
      canvas.width * 0.72,
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.58)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.applyTexture(tex);
  }

  private applyTexture(tex: THREE.Texture): void {
    if (this.texture) this.texture.dispose();
    this.texture = tex;
    const img = tex.image as { width?: number; height?: number };
    if (img?.width && img?.height) this.imageAspect = img.width / img.height;
    this.material.uniforms.map!.value = tex;
    this.material.needsUpdate = true;
    this.updateScale();
  }

  private updateScale(): void {
    const visibleW = (this.mesh.userData.visibleW as number) || 1;
    const visibleH = (this.mesh.userData.visibleH as number) || 1;
    const viewAspect = visibleW / visibleH;
    const imgAspect = this.imageAspect;

    let w = visibleW;
    let h = visibleH;
    if (this.fit === 'cover') {
      if (imgAspect > viewAspect) {
        h = visibleH;
        w = h * imgAspect;
      } else {
        w = visibleW;
        h = w / imgAspect;
      }
    } else {
      if (imgAspect > viewAspect) {
        w = visibleW;
        h = w / imgAspect;
      } else {
        h = visibleH;
        w = h * imgAspect;
      }
    }
    this.mesh.scale.set(w, h, 1);
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  dispose(): void {
    this.revokeObjectUrl();
    this.camera.remove(this.mesh);
    this.camera.remove(this.farHaze);
    this.camera.remove(this.nearHaze);
    this.planeGeo.dispose();
    this.hazeGeo.dispose();
    this.material.dispose();
    (this.farHaze.material as THREE.Material).dispose();
    (this.nearHaze.material as THREE.Material).dispose();
    this.texture?.dispose();
  }
}

