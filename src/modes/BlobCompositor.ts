import type { BlobConfig } from '../core/blobConfig';
import {
  isHighDensity,
  loadBlobConfig,
  saveBlobConfig,
  secondaryLensZoom,
} from '../core/blobConfig';
import { BlobTracker, type TrackedBlob } from '../core/BlobTracker';

export type SmoothBlob = {
  id: number;
  x: number;
  y: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  radius: number;
  confidence: number;
  featureStrength: number;
};

type FrameDest = { x: number; y: number; w: number; h: number };

/**
 * Canvas compositor for Blob preset: contain-fit video, rect outlines, lens, matrix.
 */
export class BlobCompositor {
  readonly tracker = new BlobTracker();
  cfg: BlobConfig = loadBlobConfig();

  private readonly crop: HTMLCanvasElement;
  private readonly bloom: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly cropCtx: CanvasRenderingContext2D;
  private readonly bloomCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly scratch = document.createElement('canvas');
  private readonly scratchCtx: CanvasRenderingContext2D;
  private readonly smooth = new Map<number, SmoothBlob>();
  readonly frameDest: FrameDest = { x: 0, y: 0, w: 0, h: 0 };

  constructor(
    crop: HTMLCanvasElement,
    bloom: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
  ) {
    this.crop = crop;
    this.bloom = bloom;
    this.overlay = overlay;
    this.cropCtx = crop.getContext('2d')!;
    this.bloomCtx = bloom.getContext('2d')!;
    this.overlayCtx = overlay.getContext('2d')!;
    this.scratchCtx = this.scratch.getContext('2d', { willReadFrequently: true })!;
    this.applyCfgToTracker();
    this.syncBloomCss();
  }

  applyCfgToTracker(): void {
    const hd = isHighDensity(this.cfg);
    this.tracker.setOptions({
      threshold: this.cfg.threshold,
      minArea: Math.round(this.cfg.minArea),
      maxBlobs: hd ? Math.round(this.cfg.maxBlobs) : Math.round(this.cfg.classicMaxBlobs),
      morphPasses: Math.round(this.cfg.morphPasses),
      minHeight: this.cfg.minHeight,
      highDensityTracking: hd,
      blobDensity: this.cfg.blobDensity,
      minBlobRadius: this.cfg.minBlobRadius,
      maxBlobRadius: this.cfg.maxBlobRadius,
      featureThreshold: this.cfg.featureThreshold,
      spawnRate: this.cfg.spawnRate,
      confidenceDecay: this.cfg.confidenceDecay,
      mergeDistance: this.cfg.mergeDistance,
      mergeOverlapThreshold: this.cfg.mergeOverlapThreshold,
      minimumBlobDistance: this.cfg.minimumBlobDistance,
    });
  }

  setConfig(cfg: BlobConfig, persist = true): void {
    const modeChanged = cfg.trackingMode !== this.cfg.trackingMode;
    this.cfg = { ...cfg, highDensityTracking: isHighDensity(cfg) };
    this.applyCfgToTracker();
    if (modeChanged) {
      this.tracker.reset();
      this.smooth.clear();
    }
    this.syncBloomCss();
    if (persist) saveBlobConfig(this.cfg);
  }

  syncBloomCss(): void {
    const a = this.cfg.bloomAmount;
    this.bloom.style.opacity = String(0.18 + a * 0.42);
    this.bloom.style.filter = `blur(${8 + a * 10}px) brightness(${1.05 + a * 0.22}) saturate(${1 + a * 0.12})`;
  }

  resize(viewW: number, viewH: number): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    for (const c of [this.crop, this.bloom, this.overlay]) {
      c.width = Math.floor(viewW * dpr);
      c.height = Math.floor(viewH * dpr);
      c.style.width = `${viewW}px`;
      c.style.height = `${viewH}px`;
    }
    this.cropCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bloomCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.cropCtx.clearRect(0, 0, w, h);
    this.bloomCtx.clearRect(0, 0, w, h);
    this.overlayCtx.clearRect(0, 0, w, h);
    this.smooth.clear();
  }

  resetCrop(): void {
    this.frameDest.x = 0;
    this.frameDest.y = 0;
    this.frameDest.w = 0;
    this.frameDest.h = 0;
    this.smooth.clear();
  }

  render(
    video: HTMLVideoElement,
    tracked: readonly TrackedBlob[],
    dt: number,
    mirror: boolean,
  ): SmoothBlob[] {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    this.drawContainVideo(video, viewW, viewH, mirror);
    this.applyBgLook();
    const smooth = this.updateSmooth(tracked, dt);
    if (!isHighDensity(this.cfg)) {
      this.drawLenses(video, smooth, mirror);
    }
    this.refreshBloomHalo(viewW, viewH);
    this.drawOverlay(smooth);
    return smooth;
  }

  private drawContainVideo(
    video: HTMLVideoElement,
    viewW: number,
    viewH: number,
    mirror: boolean,
  ): void {
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const scale = Math.min(viewW / vw, viewH / vh);
    const w = vw * scale;
    const h = vh * scale;
    const x = (viewW - w) * 0.5;
    const y = (viewH - h) * 0.5;
    this.frameDest.x = x;
    this.frameDest.y = y;
    this.frameDest.w = w;
    this.frameDest.h = h;

    this.cropCtx.clearRect(0, 0, viewW, viewH);
    this.cropCtx.fillStyle = '#000';
    this.cropCtx.fillRect(0, 0, viewW, viewH);
    this.cropCtx.save();
    if (mirror) {
      this.cropCtx.translate(x + w, y);
      this.cropCtx.scale(-1, 1);
      this.cropCtx.drawImage(video, 0, 0, w, h);
    } else {
      this.cropCtx.drawImage(video, x, y, w, h);
    }
    this.cropCtx.restore();
  }

  private applyBgLook(): void {
    const { x, y, w, h } = this.frameDest;
    if (w < 1) return;
    const dim = this.cfg.bgDim;
    this.cropCtx.fillStyle = `rgba(0,0,0,${dim * 0.55})`;
    this.cropCtx.fillRect(x, y, w, h);
    if (this.cfg.bgVeil > 0.01) {
      this.cropCtx.fillStyle = `rgba(0,0,0,${this.cfg.bgVeil})`;
      this.cropCtx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  private updateSmooth(list: readonly TrackedBlob[], dt: number): SmoothBlob[] {
    const rate = 1 - Math.exp(-this.cfg.smoothRate * dt);
    const seen = new Set<number>();
    for (const b of list) {
      seen.add(b.id);
      const prev = this.smooth.get(b.id);
      if (!prev) {
        this.smooth.set(b.id, {
          id: b.id,
          x: b.x,
          y: b.y,
          x0: b.x0,
          y0: b.y0,
          x1: b.x1,
          y1: b.y1,
          area: b.area,
          radius: b.radius,
          confidence: b.confidence,
          featureStrength: b.featureStrength,
        });
      } else {
        prev.x += (b.x - prev.x) * rate;
        prev.y += (b.y - prev.y) * rate;
        prev.x0 += (b.x0 - prev.x0) * rate;
        prev.y0 += (b.y0 - prev.y0) * rate;
        prev.x1 += (b.x1 - prev.x1) * rate;
        prev.y1 += (b.y1 - prev.y1) * rate;
        prev.area += (b.area - prev.area) * rate;
        prev.radius += (b.radius - prev.radius) * rate;
        prev.confidence += (b.confidence - prev.confidence) * rate;
        prev.featureStrength += (b.featureStrength - prev.featureStrength) * rate;
      }
    }
    for (const id of [...this.smooth.keys()]) {
      if (!seen.has(id)) this.smooth.delete(id);
    }
    if (isHighDensity(this.cfg)) {
      return [...this.smooth.values()];
    }
    return [...this.smooth.values()].sort((a, b) => b.area - a.area);
  }

  private screenRect(b: SmoothBlob): { x: number; y: number; w: number; h: number } {
    const { x: fx, y: fy, w: fw, h: fh } = this.frameDest;
    const pad = this.cfg.lensPadding;
    const sx = this.cfg.sizeScale;
    const hy = this.cfg.heightScale;
    let x0 = b.x0;
    let x1 = b.x1;
    const cx = (x0 + x1) * 0.5;
    const half = ((x1 - x0) * 0.5 + pad) * sx;
    x0 = cx - half;
    x1 = cx + half;
    let y0 = b.y0 - pad;
    let y1 = b.y1 + pad;
    const cy = (y0 + y1) * 0.5;
    const hh = ((y1 - y0) * 0.5) * hy;
    y0 = cy - hh - this.cfg.lensPadY;
    y1 = cy + hh + this.cfg.lensPadY;
    return {
      x: fx + x0 * fw,
      y: fy + y0 * fh,
      w: (x1 - x0) * fw,
      h: (y1 - y0) * fh,
    };
  }

  private drawLenses(
    video: HTMLVideoElement,
    smooth: SmoothBlob[],
    mirror: boolean,
  ): void {
    if (!this.cfg.showLens || smooth.length === 0) return;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    for (let i = 0; i < Math.min(2, smooth.length); i++) {
      const b = smooth[i]!;
      const zoom = i === 0 ? this.cfg.lensZoom : secondaryLensZoom(this.cfg.lensZoom);
      const r = this.screenRect(b);
      const srcW = Math.max(4, (b.x1 - b.x0) * vw / zoom);
      const srcH = Math.max(4, (b.y1 - b.y0) * vh / zoom);
      let sx = b.x * vw - srcW * 0.5;
      let sy = b.y * vh - srcH * 0.5;
      if (mirror) sx = vw - sx - srcW;
      sx = Math.max(0, Math.min(vw - srcW, sx));
      sy = Math.max(0, Math.min(vh - srcH, sy));
      this.cropCtx.save();
      this.cropCtx.beginPath();
      this.cropCtx.rect(r.x, r.y, r.w, r.h);
      this.cropCtx.clip();
      this.cropCtx.drawImage(video, sx, sy, srcW, srcH, r.x, r.y, r.w, r.h);
      this.cropCtx.restore();
    }
  }

  private refreshBloomHalo(viewW: number, viewH: number): void {
    this.bloomCtx.clearRect(0, 0, viewW, viewH);
    if (this.cfg.bloomAmount < 0.02) return;
    this.bloomCtx.globalAlpha = 0.2 + this.cfg.bloomAmount * 0.35;
    this.bloomCtx.drawImage(this.crop, 0, 0, this.crop.width, this.crop.height, 0, 0, viewW, viewH);
    this.bloomCtx.globalAlpha = 1;
  }

  private drawOverlay(smooth: SmoothBlob[]): void {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    this.overlayCtx.clearRect(0, 0, viewW, viewH);
    if (smooth.length === 0) return;

    if (isHighDensity(this.cfg)) {
      this.drawHighDensityOverlay(smooth);
      return;
    }

    // Constellation lines
    this.overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    this.overlayCtx.lineWidth = 1.25;
    this.overlayCtx.beginPath();
    for (let i = 0; i < smooth.length; i++) {
      for (let j = i + 1; j < smooth.length; j++) {
        const a = smooth[i]!;
        const b = smooth[j]!;
        const ax = this.frameDest.x + a.x * this.frameDest.w;
        const ay = this.frameDest.y + a.y * this.frameDest.h;
        const bx = this.frameDest.x + b.x * this.frameDest.w;
        const by = this.frameDest.y + b.y * this.frameDest.h;
        const dx = ax - bx;
        const dy = ay - by;
        if (dx * dx + dy * dy > (Math.min(viewW, viewH) * 0.45) ** 2) continue;
        this.overlayCtx.moveTo(ax, ay);
        this.overlayCtx.lineTo(bx, by);
      }
    }
    this.overlayCtx.stroke();

    for (const b of smooth) {
      const r = this.screenRect(b);
      if (this.cfg.matrixFill) this.drawMatrix(r, b.id);
      if (this.cfg.showContours) {
        const t = this.cfg.contourThickness;
        this.overlayCtx.strokeStyle = 'rgba(255,255,255,0.85)';
        this.overlayCtx.lineWidth = 1.2 * t;
        this.overlayCtx.shadowColor = `rgba(255,255,255,${0.35 * this.cfg.contourGlow})`;
        this.overlayCtx.shadowBlur = 6 * this.cfg.contourGlow;
        this.overlayCtx.strokeRect(r.x, r.y, r.w, r.h);
        this.overlayCtx.shadowBlur = 0;
      }
      if (this.cfg.showBoxes) {
        this.overlayCtx.strokeStyle = 'rgba(57,255,106,0.9)';
        this.overlayCtx.lineWidth = 1.2;
        this.overlayCtx.strokeRect(r.x, r.y, r.w, r.h);
        this.overlayCtx.font = '600 11px "Segoe UI", system-ui, sans-serif';
        this.overlayCtx.fillStyle = 'rgba(57,255,106,0.9)';
        this.overlayCtx.fillText(String(b.id), r.x + 3, Math.max(12, r.y - 4));
      }
    }
  }

  private drawHighDensityOverlay(smooth: SmoothBlob[]): void {
    const ctx = this.overlayCtx;
    const { x: fx, y: fy, w: fw, h: fh } = this.frameDest;
    const debug = this.cfg.debugHighDensityTracking;
    const showIds = this.cfg.debugShowIds;
    const n = smooth.length;
    const drawRings = debug && n <= 1400;

    ctx.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      const b = smooth[i]!;
      const cx = fx + b.x * fw;
      const cy = fy + b.y * fh;
      const a = 0.25 + 0.75 * Math.min(1, Math.max(0, b.confidence));
      const fs = Math.min(1, Math.max(0, b.featureStrength));
      const g = Math.round(180 + fs * 75);
      ctx.fillStyle = `rgba(${g},${g},${g},${a})`;
      ctx.fillRect(cx - 1, cy - 1, 2, 2);

      if (drawRings) {
        const rr = Math.max(1.2, 0.5 * (b.x1 - b.x0) * fw);
        ctx.strokeStyle = `rgba(255,255,255,${0.18 + a * 0.22})`;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (!debug || !showIds) return;
    ctx.font = '7px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.textBaseline = 'bottom';
    const limit = Math.min(n, 900);
    for (let i = 0; i < limit; i++) {
      const b = smooth[i]!;
      const cx = fx + b.x * fw;
      const cy = fy + b.y * fh;
      ctx.fillText(String(b.id), cx + 2, cy - 1);
    }
  }

  private drawMatrix(
    r: { x: number; y: number; w: number; h: number },
    seed: number,
  ): void {
    const dens = this.cfg.matrixDensity;
    const cols = Math.max(3, Math.floor((r.w / 10) * dens));
    const rows = Math.max(3, Math.floor((r.h / 12) * dens));
    const cellW = r.w / cols;
    const cellH = r.h / rows;
    const glyphs = '01アイウエオｶｷｸｹｺﾊﾞｲﾄ';
    const hue = this.cfg.matrixHue;
    this.overlayCtx.save();
    this.overlayCtx.beginPath();
    this.overlayCtx.rect(r.x, r.y, r.w, r.h);
    this.overlayCtx.clip();
    this.overlayCtx.font = `${Math.max(8, cellH * 0.7)}px monospace`;
    this.overlayCtx.fillStyle = `hsla(${hue}, 90%, 60%, ${0.35 + this.cfg.matrixBrightness * 0.5})`;
    for (let c = 0; c < cols; c++) {
      for (let row = 0; row < rows; row++) {
        const n = Math.sin(seed * 12.1 + c * 3.7 + row * 5.3 + performance.now() * 0.001 * this.cfg.matrixSpeed) ;
        if (n < 0.15) continue;
        const g = glyphs[Math.abs(Math.floor((n + 1) * 40 + c * row)) % glyphs.length]!;
        this.overlayCtx.fillText(g, r.x + c * cellW + 1, r.y + row * cellH + cellH * 0.8);
      }
    }
    this.overlayCtx.restore();
  }
}
