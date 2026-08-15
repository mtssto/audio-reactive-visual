/**
 * Classic CV blob tracking for the browser (MIT-friendly clean room).
 *
 * Conceptual lineage: background-subtraction + connected-component blobs
 * with persistent IDs (as in classic OpenCV blob trackers). No GPL/BSD
 * source was copied — reimplemented from first principles on canvas ImageData.
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
  /** Frames this track has been alive. */
  age: number;
  /** Mean RGB of the blob region (0–1), useful for tinting. */
  color: [number, number, number];
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
  /** Max tracks kept (largest by area). */
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
  age: number;
  missed: number;
  color: [number, number, number];
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
} as const;

/**
 * Downsampled adaptive background subtraction → connected components →
 * nearest-centroid ID association.
 */
export class BlobTracker {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private bg: Float32Array | null = null;
  private mask: Uint8Array | null = null;
  private labels: Int32Array | null = null;
  private trainCount = 0;
  private lastUpdateAt = 0;
  private nextId = 1;
  private tracks: InternalTrack[] = [];
  private blobs: TrackedBlob[] = [];
  private opts: Required<BlobTrackerOptions>;

  constructor(options: BlobTrackerOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('BlobTracker: 2d context unavailable');
    this.ctx = ctx;
  }

  get isReady(): boolean {
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
    this.trainCount = 0;
    this.tracks = [];
    this.blobs = [];
    this.lastUpdateAt = 0;
    this.nextId = 1;
  }

  /** Selfie camera needs mirror; uploaded video usually does not. */
  setMirrorX(mirror: boolean): void {
    this.opts.mirrorX = mirror;
  }

  /** Live-update detection knobs (VJ panel). Does not reset the background. */
  setOptions(partial: Partial<BlobTrackerOptions>): void {
    const prevW = this.opts.targetWidth;
    this.opts = { ...this.opts, ...partial };
    if (partial.targetWidth != null && partial.targetWidth !== prevW) {
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
    if (now - this.lastUpdateAt < this.opts.minIntervalMs) return this.blobs;
    const dt = this.lastUpdateAt > 0 ? (now - this.lastUpdateAt) / 1000 : 1 / 15;
    this.lastUpdateAt = now;

    this.ensureSize(video.videoWidth, video.videoHeight);
    const { width: w, height: h } = this;
    const n = w * h;

    this.ctx.drawImage(video, 0, 0, w, h);
    const { data } = this.ctx.getImageData(0, 0, w, h);

    const luma = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      luma[i] =
        data[p]! * 0.299 + data[p + 1]! * 0.587 + data[p + 2]! * 0.114;
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

  private ensureSize(vw: number, vh: number): void {
    const tw = this.opts.targetWidth;
    const th = Math.max(24, Math.round((tw * vh) / Math.max(1, vw)));
    if (this.width === tw && this.height === th) return;
    this.width = tw;
    this.height = th;
    this.canvas.width = tw;
    this.canvas.height = th;
    this.bg = null;
    this.mask = null;
    this.labels = null;
    this.trainCount = 0;
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
        age: prev.age + 1,
        missed: 0,
        color: det.color,
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
        age: 1,
        missed: 0,
        color: det.color,
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

  private publish(): void {
    const mirror = this.opts.mirrorX;
    this.blobs = this.tracks
      .filter((t) => t.missed === 0)
      .map((t) => {
        const x = mirror ? 1 - t.x : t.x;
        const x0 = mirror ? 1 - t.x1 : t.x0;
        const x1 = mirror ? 1 - t.x0 : t.x1;
        return {
          id: t.id,
          x,
          y: t.y,
          x0,
          y0: t.y0,
          x1,
          y1: t.y1,
          area: t.area,
          speed: t.speed,
          age: t.age,
          color: t.color,
        };
      });
  }
}
