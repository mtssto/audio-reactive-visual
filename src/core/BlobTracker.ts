/**
 * Classic CV blob tracking for the browser (MIT-friendly clean room).
 *
 * Conceptual lineage: background-subtraction + connected-component blobs
 * with persistent IDs (as in classic OpenCV blob trackers). No GPL/BSD
 * source was copied — reimplemented from first principles on canvas ImageData.
 *
 * High-density mode adds a feature-probability map (edges / contrast /
 * texture / motion / corners) and micro-blob tracks with spatial hashing.
 */

export type TrackedBlob = {
  /** Stable track id across frames (nearest-centroid association). */
  id: number;
  /** Normalized centroid 0–1 (already mirrored for selfie if requested). */
  x: number;
  y: number;
  /** Bounding box in normalized coords (mirrored with centroid). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Pixel area in the downsampled mask. */
  area: number;
  /** Approx speed in normalized units per second. */
  speed: number;
  vx: number;
  vy: number;
  /** Frames this track has been alive. */
  age: number;
  /** Mean RGB of the blob region (0–1), useful for tinting. */
  color: [number, number, number];
  radius: number;
  confidence: number;
  featureStrength: number;
};

export type BlobTrackerOptions = {
  /** Target width of the analysis buffer (height follows aspect). */
  targetWidth?: number;
  /** Max detections per update (~15 fps). */
  minIntervalMs?: number;
  /** Absolute luma delta vs background to mark foreground. */
  threshold?: number;
  /** Min / max blob area in downsampled pixels. */
  minArea?: number;
  maxArea?: number;
  /** Max tracks kept (largest by area in classic mode). */
  maxBlobs?: number;
  /** Mirror X to match selfie / MediaPipe hands. */
  mirrorX?: boolean;
  /** Background learning rate when pixel is background. */
  bgLearnRate?: number;
  /** Frames of averaging before tracking begins. */
  trainFrames?: number;
  /** Morphological open passes (0 = none, higher = smoother / less noise). */
  morphPasses?: number;
  /** Drop blobs shorter than this fraction of frame height (0–1). */
  minHeight?: number;

  /** Feature-map micro-blobs instead of large connected components. */
  highDensityTracking?: boolean;
  /** 0–1: fraction of maxBlobs allowed from the feature map. */
  blobDensity?: number;
  minBlobRadius?: number;
  maxBlobRadius?: number;
  featureThreshold?: number;
  spawnRate?: number;
  confidenceDecay?: number;
  mergeDistance?: number;
  mergeOverlapThreshold?: number;
  minimumBlobDistance?: number;
  matchDistance?: number;
  gridCellSize?: number;
  hdAnalysisWidth?: number;
};

type InternalTrack = {
  id: number;
  x: number;
  y: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  speed: number;
  vx: number;
  vy: number;
  age: number;
  missed: number;
  color: [number, number, number];
  radius: number;
  confidence: number;
  featureStrength: number;
  closeFrames: number;
  alive: boolean;
};

type Detection = {
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  color: [number, number, number];
  label: number;
  radius: number;
  featureStrength: number;
};

const DEFAULTS = {
  targetWidth: 160,
  minIntervalMs: 66,
  threshold: 30,
  minArea: 50,
  maxArea: 12_000,
  maxBlobs: 8,
  mirrorX: true,
  bgLearnRate: 0.04,
  trainFrames: 18,
  morphPasses: 1,
  minHeight: 0,
  highDensityTracking: false,
  blobDensity: 0.7,
  minBlobRadius: 1.2,
  maxBlobRadius: 4,
  featureThreshold: 0.08,
  spawnRate: 0.35,
  confidenceDecay: 0.12,
  mergeDistance: 2.4,
  mergeOverlapThreshold: 0.82,
  minimumBlobDistance: 3.5,
  matchDistance: 10,
  gridCellSize: 24,
  hdAnalysisWidth: 320,
} as const;

const W_EDGE = 1.05;
const W_CONTRAST = 0.62;
const W_TEXTURE = 0.48;
const W_MOTION = 0.85;
const W_CORNER = 0.72;

/**
 * Downsampled adaptive background subtraction → connected components →
 * nearest-centroid ID association. Optional high-density feature sampling.
 */
export class BlobTracker {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private bg: Float32Array | null = null;
  private mask: Uint8Array | null = null;
  private labels: Int32Array | null = null;
  private luma: Float32Array | null = null;
  private prevLuma: Float32Array | null = null;
  private feature: Float32Array | null = null;
  private hasPrevLuma = false;
  private trainCount = 0;
  private lastUpdateAt = 0;
  private nextId = 1;
  private tracks: InternalTrack[] = [];
  private nextTracks: InternalTrack[] = [];
  private blobs: TrackedBlob[] = [];
  private published: TrackedBlob[] = [];
  private opts: Required<BlobTrackerOptions>;

  private readonly grid = new SpatialHash();
  private readonly detGrid = new SpatialHash();
  private readonly detPool: Detection[] = [];
  private detCount = 0;
  private readonly candX = new Float32Array(8192);
  private readonly candY = new Float32Array(8192);
  private readonly candS = new Float32Array(8192);
  private readonly candIdx = new Int32Array(8192);
  private readonly usedDet = new Uint8Array(8192);
  private readonly usedTrack = new Uint8Array(8192);
  private readonly pairTi: number[] = [];
  private readonly pairDi: number[] = [];
  private readonly pairD: number[] = [];
  private pairOrder = new Int32Array(49152);

  constructor(options: BlobTrackerOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('BlobTracker: 2d context unavailable');
    this.ctx = ctx;
  }

  get isReady(): boolean {
    if (this.opts.highDensityTracking) return this.luma != null && this.width > 0;
    return this.trainCount >= this.opts.trainFrames && this.bg != null;
  }

  get current(): readonly TrackedBlob[] {
    return this.blobs;
  }

  /** Reset background model (e.g. when entering Blob mode). */
  reset(): void {
    this.bg = null;
    this.mask = null;
    this.labels = null;
    this.luma = null;
    this.prevLuma = null;
    this.feature = null;
    this.hasPrevLuma = false;
    this.trainCount = 0;
    this.tracks = [];
    this.nextTracks = [];
    this.blobs = [];
    this.published = [];
    this.lastUpdateAt = 0;
    this.nextId = 1;
    this.detCount = 0;
  }

  /** Selfie camera needs mirror; uploaded video usually does not. */
  setMirrorX(mirror: boolean): void {
    this.opts.mirrorX = mirror;
  }

  /** Live-update detection knobs (VJ panel). Does not reset the background. */
  setOptions(partial: Partial<BlobTrackerOptions>): void {
    const prevW = this.analysisWidth();
    const prevHd = this.opts.highDensityTracking;
    this.opts = { ...this.opts, ...partial };
    if (
      this.analysisWidth() !== prevW ||
      (partial.highDensityTracking != null && partial.highDensityTracking !== prevHd) ||
      (partial.hdAnalysisWidth != null && partial.hdAnalysisWidth !== this.opts.hdAnalysisWidth)
    ) {
      this.width = 0;
      this.height = 0;
    }
  }

  get options(): Readonly<Required<BlobTrackerOptions>> {
    return this.opts;
  }

  /**
   * Throttled update. Returns current tracks (may be previous frame if skipped).
   */
  update(video: HTMLVideoElement, now = performance.now()): readonly TrackedBlob[] {
    if (video.readyState < 2 || video.videoWidth === 0) return this.blobs;
    const interval = this.opts.highDensityTracking
      ? Math.min(this.opts.minIntervalMs, 16)
      : this.opts.minIntervalMs;
    if (now - this.lastUpdateAt < interval) return this.blobs;
    const dt = this.lastUpdateAt > 0 ? (now - this.lastUpdateAt) / 1000 : 1 / 15;
    this.lastUpdateAt = now;

    this.ensureSize(video.videoWidth, video.videoHeight);
    const { width: w, height: h } = this;
    const n = w * h;

    this.ctx.drawImage(video, 0, 0, w, h);
    const { data } = this.ctx.getImageData(0, 0, w, h);

    if (!this.luma || this.luma.length !== n) {
      this.luma = new Float32Array(n);
      this.prevLuma = new Float32Array(n);
      this.feature = new Float32Array(n);
      this.hasPrevLuma = false;
    }
    const luma = this.luma;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      luma[i] = data[p]! * 0.299 + data[p + 1]! * 0.587 + data[p + 2]! * 0.114;
    }

    if (this.opts.highDensityTracking) {
      this.updateHighDensity(data, Math.max(0.016, dt));
      this.publish();
      this.swapLuma();
      return this.blobs;
    }

    if (!this.bg || this.bg.length !== n) {
      this.bg = luma.slice();
      this.mask = new Uint8Array(n);
      this.labels = new Int32Array(n);
      this.trainCount = 1;
      this.blobs = [];
      return this.blobs;
    }

    if (this.trainCount < this.opts.trainFrames) {
      const t = this.trainCount;
      for (let i = 0; i < n; i++) {
        this.bg[i] = (this.bg[i]! * t + luma[i]!) / (t + 1);
      }
      this.trainCount += 1;
      this.blobs = [];
      return this.blobs;
    }

    const mask = this.mask!;
    const thr = this.opts.threshold;
    const learn = this.opts.bgLearnRate;

    for (let i = 0; i < n; i++) {
      const d = Math.abs(luma[i]! - this.bg[i]!);
      if (d > thr) {
        mask[i] = 1;
      } else {
        mask[i] = 0;
        this.bg[i] = this.bg[i]! * (1 - learn) + luma[i]! * learn;
      }
    }

    const passes = Math.max(0, Math.min(4, Math.round(this.opts.morphPasses)));
    for (let p = 0; p < passes; p++) {
      this.morphOpen(mask, w, h);
    }

    const detections = this.connectedComponents(mask, data, w, h);
    this.associate(detections, Math.max(0.016, dt));
    this.publish();
    return this.blobs;
  }

  private analysisWidth(): number {
    if (this.opts.highDensityTracking) {
      return Math.max(this.opts.targetWidth, this.opts.hdAnalysisWidth);
    }
    return this.opts.targetWidth;
  }

  private ensureSize(vw: number, vh: number): void {
    const tw = this.analysisWidth();
    const th = Math.max(24, Math.round((tw * vh) / Math.max(1, vw)));
    if (this.width === tw && this.height === th) return;
    this.width = tw;
    this.height = th;
    this.canvas.width = tw;
    this.canvas.height = th;
    this.bg = null;
    this.mask = null;
    this.labels = null;
    this.luma = null;
    this.prevLuma = null;
    this.feature = null;
    this.hasPrevLuma = false;
    this.trainCount = 0;
  }

  private swapLuma(): void {
    if (!this.luma || !this.prevLuma) return;
    const tmp = this.luma;
    this.luma = this.prevLuma;
    this.prevLuma = tmp;
    this.hasPrevLuma = true;
  }

  private morphOpen(mask: Uint8Array, w: number, h: number): void {
    const tmp = new Uint8Array(mask.length);
    // erode
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (
          mask[i] &&
          mask[i - 1] &&
          mask[i + 1] &&
          mask[i - w] &&
          mask[i + w]
        ) {
          tmp[i] = 1;
        }
      }
    }
    // dilate
    mask.fill(0);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (
          tmp[i] ||
          tmp[i - 1] ||
          tmp[i + 1] ||
          tmp[i - w] ||
          tmp[i + w]
        ) {
          mask[i] = 1;
        }
      }
    }
  }

  private connectedComponents(
    mask: Uint8Array,
    rgba: Uint8ClampedArray,
    w: number,
    h: number,
  ): Detection[] {
    const labels = this.labels!;
    labels.fill(0);
    const stackX: number[] = [];
    const stackY: number[] = [];
    const detections: Detection[] = [];
    let label = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const start = y * w + x;
        if (!mask[start] || labels[start]) continue;
        label += 1;
        stackX.length = 0;
        stackY.length = 0;
        stackX.push(x);
        stackY.push(y);
        labels[start] = label;

        let area = 0;
        let sumX = 0;
        let sumY = 0;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;

        while (stackX.length > 0) {
          const cx = stackX.pop()!;
          const cy = stackY.pop()!;
          const i = cy * w + cx;
          area += 1;
          sumX += cx;
          sumY += cy;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          const p = i * 4;
          sumR += rgba[p]!;
          sumG += rgba[p + 1]!;
          sumB += rgba[p + 2]!;

          // 4-connected
          const neighbors = [
            [cx - 1, cy],
            [cx + 1, cy],
            [cx, cy - 1],
            [cx, cy + 1],
          ] as const;
          for (const [nx, ny] of neighbors) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!mask[ni] || labels[ni]) continue;
            labels[ni] = label;
            stackX.push(nx);
            stackY.push(ny);
          }
        }

        if (area < this.opts.minArea || area > this.opts.maxArea) continue;
        const heightFrac = (maxY - minY + 1) / Math.max(1, h);
        if (heightFrac < this.opts.minHeight) continue;

        detections.push({
          cx: sumX / area,
          cy: sumY / area,
          x0: minX,
          y0: minY,
          x1: maxX,
          y1: maxY,
          area,
          color: [
            sumR / area / 255,
            sumG / area / 255,
            sumB / area / 255,
          ],
          label,
          radius: Math.max(1, Math.sqrt(area / Math.PI)),
          featureStrength: 1,
        });
      }
    }

    detections.sort((a, b) => b.area - a.area);
    if (detections.length > this.opts.maxBlobs) {
      detections.length = this.opts.maxBlobs;
    }
    return detections;
  }

  private associate(detections: Detection[], dt: number): void {
    const w = this.width;
    const h = this.height;
    const maxDist = Math.hypot(w, h) * 0.28;
    const usedDet = new Set<number>();
    const nextTracks: InternalTrack[] = [];

    // Greedy nearest-centroid matching
    const pairs: { ti: number; di: number; d: number }[] = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const t = this.tracks[ti]!;
      for (let di = 0; di < detections.length; di++) {
        const d = detections[di]!;
        const dist = Math.hypot(t.x * w - d.cx, t.y * h - d.cy);
        if (dist < maxDist) pairs.push({ ti, di, d: dist });
      }
    }
    pairs.sort((a, b) => a.d - b.d);

    const usedTrack = new Set<number>();
    for (const p of pairs) {
      if (usedTrack.has(p.ti) || usedDet.has(p.di)) continue;
      usedTrack.add(p.ti);
      usedDet.add(p.di);
      const prev = this.tracks[p.ti]!;
      const det = detections[p.di]!;
      const nx = det.cx / w;
      const ny = det.cy / h;
      const dx = (nx - prev.x) / dt;
      const dy = (ny - prev.y) / dt;
      nextTracks.push({
        id: prev.id,
        x: nx,
        y: ny,
        x0: det.x0 / w,
        y0: det.y0 / h,
        x1: det.x1 / w,
        y1: det.y1 / h,
        area: det.area,
        speed: Math.hypot(dx, dy),
        vx: dx,
        vy: dy,
        age: prev.age + 1,
        missed: 0,
        color: det.color,
        radius: det.radius,
        confidence: 1,
        featureStrength: det.featureStrength,
        closeFrames: 0,
        alive: true,
      });
    }

    // New detections → new tracks
    for (let di = 0; di < detections.length; di++) {
      if (usedDet.has(di)) continue;
      const det = detections[di]!;
      nextTracks.push({
        id: this.nextId++,
        x: det.cx / w,
        y: det.cy / h,
        x0: det.x0 / w,
        y0: det.y0 / h,
        x1: det.x1 / w,
        y1: det.y1 / h,
        area: det.area,
        speed: 0,
        vx: 0,
        vy: 0,
        age: 1,
        missed: 0,
        color: det.color,
        radius: det.radius,
        confidence: 1,
        featureStrength: det.featureStrength,
        closeFrames: 0,
        alive: true,
      });
    }

    // Keep briefly-missed tracks so IDs don't flicker
    for (let ti = 0; ti < this.tracks.length; ti++) {
      if (usedTrack.has(ti)) continue;
      const t = this.tracks[ti]!;
      if (t.missed < 4) {
        nextTracks.push({ ...t, missed: t.missed + 1, speed: t.speed * 0.7 });
      }
    }

    nextTracks.sort((a, b) => b.area - a.area);
    if (nextTracks.length > this.opts.maxBlobs) {
      nextTracks.length = this.opts.maxBlobs;
    }
    this.tracks = nextTracks;
  }

  private updateHighDensity(rgba: Uint8ClampedArray, dt: number): void {
    this.buildFeatureMap();
    this.sampleFeatureDetections(rgba);
    this.associateHighDensity(dt);
    this.mergeHighDensity();
  }

  private buildFeatureMap(): void {
    const w = this.width;
    const h = this.height;
    const luma = this.luma!;
    const prev = this.prevLuma;
    const feat = this.feature!;
    const useMotion = this.hasPrevLuma && prev != null;
    feat.fill(0);

    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        const l = luma[i]!;
        const lft = luma[i - 1]!;
        const rgt = luma[i + 1]!;
        const up = luma[i - w]!;
        const dn = luma[i + w]!;
        const ul = luma[i - w - 1]!;
        const ur = luma[i - w + 1]!;
        const dl = luma[i + w - 1]!;
        const dr = luma[i + w + 1]!;

        const gx = -ul + ur - 2 * lft + 2 * rgt - dl + dr;
        const gy = -ul - 2 * up - ur + dl + 2 * dn + dr;
        const agx = gx < 0 ? -gx : gx;
        const agy = gy < 0 ? -gy : gy;
        const edge = Math.sqrt(gx * gx + gy * gy) * (1 / 720);
        const contrast = (Math.abs(l - lft) + Math.abs(l - rgt) + Math.abs(l - up) + Math.abs(l - dn)) * (1 / 420);
        const texture = (Math.abs(lft - rgt) + Math.abs(up - dn) + Math.abs(ul - dr) + Math.abs(ur - dl)) * (1 / 520);
        const motion = useMotion ? Math.abs(l - prev[i]!) * (1 / 140) : 0;
        const corner = Math.sqrt(agx * agy) * (1 / 420);

        let s =
          edge * W_EDGE +
          contrast * W_CONTRAST +
          texture * W_TEXTURE +
          motion * W_MOTION +
          corner * W_CORNER;
        if (s < 0) s = 0;
        else if (s > 1) s = 1;
        feat[i] = s;
      }
    }
  }

  private allocDet(): Detection {
    let d = this.detPool[this.detCount];
    if (!d) {
      d = {
        cx: 0,
        cy: 0,
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        area: 0,
        color: [0, 0, 0],
        label: 0,
        radius: 1,
        featureStrength: 0,
      };
      this.detPool[this.detCount] = d;
    }
    return d;
  }

  private sampleFeatureDetections(rgba: Uint8ClampedArray): void {
    const w = this.width;
    const h = this.height;
    const feat = this.feature!;
    const thr = this.opts.featureThreshold;
    const density = Math.max(0, Math.min(1, this.opts.blobDensity));
    const minDist = Math.max(1.5, this.opts.minimumBlobDistance);
    const step = Math.max(2, Math.round(minDist / Math.max(0.12, density)));
    const maxBlobs = Math.max(1, Math.min(5000, Math.round(this.opts.maxBlobs)));
    const cap = Math.max(0, Math.min(maxBlobs, Math.round(maxBlobs * density)));
    const rMin = this.opts.minBlobRadius;
    const rMax = Math.max(rMin, this.opts.maxBlobRadius);

    let nCand = 0;
    const maxCand = this.candX.length;
    for (let y0 = 1; y0 < h - 1; y0 += step) {
      const y1 = Math.min(h - 1, y0 + step);
      for (let x0 = 1; x0 < w - 1; x0 += step) {
        const x1 = Math.min(w - 1, x0 + step);
        let best = thr;
        let bx = -1;
        let by = -1;
        for (let y = y0; y < y1; y++) {
          const row = y * w;
          for (let x = x0; x < x1; x++) {
            const s = feat[row + x]!;
            if (s > best) {
              best = s;
              bx = x;
              by = y;
            }
          }
        }
        if (bx < 0 || nCand >= maxCand) continue;
        this.candX[nCand] = bx + 0.5;
        this.candY[nCand] = by + 0.5;
        this.candS[nCand] = best;
        this.candIdx[nCand] = nCand;
        nCand += 1;
      }
    }

    const idx = this.candIdx.subarray(0, nCand);
    idx.sort((a, b) => this.candS[b]! - this.candS[a]!);

    this.detGrid.setup(w, h, Math.max(8, this.opts.gridCellSize));
    this.detCount = 0;
    const minDist2 = minDist * minDist;

    for (let k = 0; k < nCand && this.detCount < cap; k++) {
      const i = idx[k]!;
      const x = this.candX[i]!;
      const y = this.candY[i]!;
      let blocked = false;
      this.detGrid.query(x, y, (oi) => {
        if (blocked) return;
        const od = this.detPool[oi]!;
        const dx = od.cx - x;
        const dy = od.cy - y;
        if (dx * dx + dy * dy < minDist2) blocked = true;
      });
      if (blocked) continue;

      const s = this.candS[i]!;
      const radius = rMin + (rMax - rMin) * s;
      const px = Math.max(0, Math.min(w - 1, x | 0));
      const py = Math.max(0, Math.min(h - 1, y | 0));
      const p = (py * w + px) * 4;
      const d = this.allocDet();
      d.cx = x;
      d.cy = y;
      d.radius = radius;
      d.x0 = x - radius;
      d.y0 = y - radius;
      d.x1 = x + radius;
      d.y1 = y + radius;
      d.area = Math.PI * radius * radius;
      d.featureStrength = s;
      d.color[0] = rgba[p]! / 255;
      d.color[1] = rgba[p + 1]! / 255;
      d.color[2] = rgba[p + 2]! / 255;
      d.label = this.detCount;
      this.detGrid.insert(x, y, this.detCount);
      this.detCount += 1;
    }
  }

  private associateHighDensity(dt: number): void {
    const w = this.width;
    const h = this.height;
    const nDet = this.detCount;
    const nTrk = this.tracks.length;
    const matchDist = Math.max(4, this.opts.matchDistance);
    const match2 = matchDist * matchDist;
    const decay = this.opts.confidenceDecay;
    const maxBlobs = Math.max(1, Math.min(5000, Math.round(this.opts.maxBlobs)));
    const spawnBudget = Math.max(
      1,
      Math.floor(this.opts.spawnRate * maxBlobs),
    );

    this.grid.setup(w, h, Math.max(8, this.opts.gridCellSize));
    for (let ti = 0; ti < nTrk; ti++) {
      const t = this.tracks[ti]!;
      const px = (t.x + t.vx * dt) * w;
      const py = (t.y + t.vy * dt) * h;
      this.grid.insert(px, py, ti);
    }

    this.usedDet.fill(0, 0, nDet);
    this.usedTrack.fill(0, 0, nTrk);
    this.pairTi.length = 0;
    this.pairDi.length = 0;
    this.pairD.length = 0;
    const maxPairs = this.pairOrder.length;

    for (let di = 0; di < nDet; di++) {
      const det = this.detPool[di]!;
      this.grid.query(det.cx, det.cy, (ti) => {
        if (this.pairD.length >= maxPairs) return;
        const t = this.tracks[ti]!;
        const px = (t.x + t.vx * dt) * w;
        const py = (t.y + t.vy * dt) * h;
        const dx = px - det.cx;
        const dy = py - det.cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < match2) {
          this.pairTi.push(ti);
          this.pairDi.push(di);
          this.pairD.push(d2);
        }
      });
    }

    const nPairs = this.pairD.length;
    if (this.pairOrder.length < nPairs) {
      this.pairOrder = new Int32Array(nPairs);
    }
    const order = this.pairOrder.subarray(0, nPairs);
    for (let i = 0; i < nPairs; i++) order[i] = i;
    order.sort((a, b) => this.pairD[a]! - this.pairD[b]!);

    for (let k = 0; k < nPairs; k++) {
      const i = order[k]!;
      const ti = this.pairTi[i]!;
      const di = this.pairDi[i]!;
      if (this.usedTrack[ti] || this.usedDet[di]) continue;
      this.usedTrack[ti] = 1;
      this.usedDet[di] = 1;
      this.applyDetection(this.tracks[ti]!, this.detPool[di]!, dt, w, h);
    }

    const next = this.nextTracks;
    next.length = 0;
    for (let ti = 0; ti < nTrk; ti++) {
      const t = this.tracks[ti]!;
      if (this.usedTrack[ti]) {
        next.push(t);
        continue;
      }
      t.missed += 1;
      t.confidence -= decay;
      t.vx *= 0.72;
      t.vy *= 0.72;
      t.speed *= 0.72;
      t.x = Math.min(1, Math.max(0, t.x + t.vx * dt));
      t.y = Math.min(1, Math.max(0, t.y + t.vy * dt));
      if (t.confidence >= 0.08) next.push(t);
    }

    let spawned = 0;
    const minDist = Math.max(1.5, this.opts.minimumBlobDistance);
    const minDist2 = minDist * minDist;
    this.grid.setup(w, h, Math.max(8, this.opts.gridCellSize));
    for (let i = 0; i < next.length; i++) {
      const t = next[i]!;
      this.grid.insert(t.x * w, t.y * h, i);
    }

    for (let di = 0; di < nDet; di++) {
      if (this.usedDet[di]) continue;
      if (spawned >= spawnBudget || next.length >= maxBlobs) break;
      const det = this.detPool[di]!;
      let near = false;
      this.grid.query(det.cx, det.cy, (oi) => {
        if (near) return;
        const o = next[oi]!;
        const dx = o.x * w - det.cx;
        const dy = o.y * h - det.cy;
        if (dx * dx + dy * dy < minDist2) near = true;
      });
      if (near) continue;
      const t = this.makeTrackFromDet(det, w, h);
      this.grid.insert(det.cx, det.cy, next.length);
      next.push(t);
      spawned += 1;
    }

    if (next.length > maxBlobs) {
      next.sort((a, b) => b.confidence * b.featureStrength - a.confidence * a.featureStrength);
      next.length = maxBlobs;
    }
    const swap = this.tracks;
    this.tracks = next;
    this.nextTracks = swap;
    swap.length = 0;
  }

  private applyDetection(t: InternalTrack, det: Detection, dt: number, w: number, h: number): void {
    const nx = det.cx / w;
    const ny = det.cy / h;
    const follow = 0.42;
    const ox = t.x;
    const oy = t.y;
    t.x += (nx - t.x) * follow;
    t.y += (ny - t.y) * follow;
    const vx = (t.x - ox) / dt;
    const vy = (t.y - oy) / dt;
    t.vx = t.vx * 0.55 + vx * 0.45;
    t.vy = t.vy * 0.55 + vy * 0.45;
    t.speed = Math.hypot(t.vx, t.vy);
    const rMin = this.opts.minBlobRadius;
    const rMax = Math.max(rMin, this.opts.maxBlobRadius);
    const targetR = Math.min(rMax, Math.max(rMin, det.radius));
    t.radius += (targetR - t.radius) * 0.28;
    t.x0 = t.x - t.radius / w;
    t.y0 = t.y - t.radius / h;
    t.x1 = t.x + t.radius / w;
    t.y1 = t.y + t.radius / h;
    t.area = Math.PI * t.radius * t.radius;
    t.featureStrength += (det.featureStrength - t.featureStrength) * 0.35;
    t.confidence = Math.min(1, t.confidence + 0.18);
    t.age += 1;
    t.missed = 0;
    t.color[0] = t.color[0] * 0.7 + det.color[0] * 0.3;
    t.color[1] = t.color[1] * 0.7 + det.color[1] * 0.3;
    t.color[2] = t.color[2] * 0.7 + det.color[2] * 0.3;
  }

  private makeTrackFromDet(det: Detection, w: number, h: number): InternalTrack {
    const x = det.cx / w;
    const y = det.cy / h;
    const r = Math.min(this.opts.maxBlobRadius, Math.max(this.opts.minBlobRadius, det.radius));
    return {
      id: this.nextId++,
      x,
      y,
      x0: x - r / w,
      y0: y - r / h,
      x1: x + r / w,
      y1: y + r / h,
      area: Math.PI * r * r,
      speed: 0,
      vx: 0,
      vy: 0,
      age: 1,
      missed: 0,
      color: [det.color[0], det.color[1], det.color[2]],
      radius: r,
      confidence: Math.max(0.35, det.featureStrength),
      featureStrength: det.featureStrength,
      closeFrames: 0,
      alive: true,
    };
  }

  private mergeHighDensity(): void {
    const n = this.tracks.length;
    if (n < 2) return;
    const w = this.width;
    const h = this.height;
    const mergeDist = Math.max(0.5, this.opts.mergeDistance);
    const overlapThr = this.opts.mergeOverlapThreshold;
    this.grid.setup(w, h, Math.max(8, this.opts.gridCellSize));
    for (let i = 0; i < n; i++) {
      const t = this.tracks[i]!;
      t.alive = true;
      this.grid.insert(t.x * w, t.y * h, i);
    }

    for (let i = 0; i < n; i++) {
      const a = this.tracks[i]!;
      if (!a.alive) continue;
      this.grid.query(a.x * w, a.y * h, (j) => {
        if (j <= i) return;
        const b = this.tracks[j]!;
        if (!b.alive || !a.alive) return;
        const dx = (a.x - b.x) * w;
        const dy = (a.y - b.y) * h;
        const dist = Math.hypot(dx, dy);
        if (dist >= mergeDist) {
          return;
        }
        const overlap = 1 - dist / Math.max(1e-4, a.radius + b.radius);
        if (overlap < overlapThr) return;
        a.closeFrames += 1;
        b.closeFrames += 1;
        if (a.closeFrames < 6 && b.closeFrames < 6) return;
        const keepA =
          a.age > b.age ||
          (a.age === b.age && a.confidence >= b.confidence);
        const keep = keepA ? a : b;
        const drop = keepA ? b : a;
        keep.confidence = Math.max(keep.confidence, drop.confidence);
        keep.featureStrength = Math.max(keep.featureStrength, drop.featureStrength);
        drop.alive = false;
        drop.confidence = 0;
      });
    }

    let write = 0;
    for (let i = 0; i < n; i++) {
      const t = this.tracks[i]!;
      if (!t.alive) continue;
      t.closeFrames = Math.max(0, t.closeFrames - 1);
      this.tracks[write] = t;
      write += 1;
    }
    this.tracks.length = write;
  }

  private publish(): void {
    const mirror = this.opts.mirrorX;
    const hd = this.opts.highDensityTracking;
    const src = this.tracks;
    const out = this.published;
    let n = 0;
    for (let i = 0; i < src.length; i++) {
      const t = src[i]!;
      if (hd ? t.confidence < 0.1 : t.missed !== 0) continue;
      let b = out[n];
      if (!b) {
        b = {
          id: 0,
          x: 0,
          y: 0,
          x0: 0,
          y0: 0,
          x1: 0,
          y1: 0,
          area: 0,
          speed: 0,
          vx: 0,
          vy: 0,
          age: 0,
          color: [0, 0, 0],
          radius: 0,
          confidence: 0,
          featureStrength: 0,
        };
        out[n] = b;
      }
      const x = mirror ? 1 - t.x : t.x;
      b.id = t.id;
      b.x = x;
      b.y = t.y;
      b.x0 = mirror ? 1 - t.x1 : t.x0;
      b.y0 = t.y0;
      b.x1 = mirror ? 1 - t.x0 : t.x1;
      b.y1 = t.y1;
      b.area = t.area;
      b.speed = t.speed;
      b.vx = mirror ? -t.vx : t.vx;
      b.vy = t.vy;
      b.age = t.age;
      b.color[0] = t.color[0];
      b.color[1] = t.color[1];
      b.color[2] = t.color[2];
      b.radius = t.radius;
      b.confidence = t.confidence;
      b.featureStrength = t.featureStrength;
      n += 1;
    }
    out.length = n;
    this.blobs = out;
  }
}

/** Uniform grid spatial hash: query own cell + 8 neighbors. */
class SpatialHash {
  private cellSize = 24;
  private inv = 1 / 24;
  private cols = 1;
  private rows = 1;
  private readonly buckets: number[][] = [[]];

  setup(width: number, height: number, cellSize: number): void {
    this.cellSize = Math.max(8, cellSize);
    this.inv = 1 / this.cellSize;
    this.cols = Math.max(1, Math.ceil(width * this.inv));
    this.rows = Math.max(1, Math.ceil(height * this.inv));
    const n = this.cols * this.rows;
    while (this.buckets.length < n) this.buckets.push([]);
    for (let i = 0; i < n; i++) this.buckets[i]!.length = 0;
  }

  insert(x: number, y: number, id: number): void {
    this.buckets[this.index(x, y)]!.push(id);
  }

  query(x: number, y: number, visit: (id: number) => void): void {
    const cs = this.cellSize;
    let cx = (x / cs) | 0;
    let cy = (y / cs) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    const x0 = cx > 0 ? cx - 1 : 0;
    const x1 = cx + 1 < this.cols ? cx + 1 : this.cols - 1;
    const y0 = cy > 0 ? cy - 1 : 0;
    const y1 = cy + 1 < this.rows ? cy + 1 : this.rows - 1;
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * this.cols;
      for (let xx = x0; xx <= x1; xx++) {
        const bucket = this.buckets[row + xx]!;
        for (let i = 0; i < bucket.length; i++) visit(bucket[i]!);
      }
    }
  }

  private index(x: number, y: number): number {
    let cx = (x * this.inv) | 0;
    let cy = (y * this.inv) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }
}
