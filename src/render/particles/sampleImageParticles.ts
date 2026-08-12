/** Sample an image into a capped particle cloud (home positions + RGB). */

export type ImageParticleSample = {
  positions: Float32Array;
  colors: Float32Array;
  seeds: Float32Array;
  count: number;
  aspect: number;
  /** World-space half extents of the fitted image plane. */
  halfWidth: number;
  halfHeight: number;
};

export type SampleImageOptions = {
  /** Max long-side resolution for the sample grid (before stride). */
  maxSide?: number;
  /** Skip every Nth pixel on each axis after downscale (1 = all). */
  stride?: number;
  /** Hard cap on particle count. */
  maxParticles?: number;
  /** Max world-space half-width of the image plane. */
  planeHalfWidth?: number;
  /** Max world-space half-height (aspect fit inside this box). */
  planeMaxHalfHeight?: number;
  /** Skip pixels with alpha below this (0–255). */
  minAlpha?: number;
  /** Skip near-white pixels when luminance exceeds this (0–1). Use ≥1 to disable. */
  skipWhiteAbove?: number;
};

const DEFAULTS: Required<SampleImageOptions> = {
  maxSide: 256,
  stride: 1,
  maxParticles: 36000,
  planeHalfWidth: 5.2,
  planeMaxHalfHeight: 3.85,
  minAlpha: 10,
  skipWhiteAbove: 1,
};

function fitSampleSize(
  srcW: number,
  srcH: number,
  maxSide: number,
): { w: number; h: number } {
  const long = Math.max(srcW, srcH);
  if (long <= maxSide) return { w: srcW, h: srcH };
  const scale = maxSide / long;
  return {
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale)),
  };
}

/** Fit image aspect inside a max width × height box (letterbox-style). */
function fitPlaneExtents(
  aspect: number,
  maxHalfW: number,
  maxHalfH: number,
): { halfW: number; halfH: number } {
  const boxAspect = maxHalfW / Math.max(1e-6, maxHalfH);
  if (aspect >= boxAspect) {
    const halfW = maxHalfW;
    return { halfW, halfH: halfW / aspect };
  }
  const halfH = maxHalfH;
  return { halfW: halfH * aspect, halfH };
}

/**
 * Rasterize `source` to a downscaled canvas and emit particle attributes.
 * Positions sit on a centered XY plane (Z ≈ 0) preserving aspect.
 */
export function sampleImageToParticles(
  source: CanvasImageSource,
  opts: SampleImageOptions = {},
): ImageParticleSample {
  const {
    maxSide,
    stride,
    maxParticles,
    planeHalfWidth,
    planeMaxHalfHeight,
    minAlpha,
    skipWhiteAbove,
  } = { ...DEFAULTS, ...opts };

  const srcW =
    'naturalWidth' in source && typeof source.naturalWidth === 'number'
      ? source.naturalWidth || (source as HTMLImageElement).width
      : 'videoWidth' in source && typeof source.videoWidth === 'number'
        ? source.videoWidth
        : (source as HTMLCanvasElement).width;
  const srcH =
    'naturalHeight' in source && typeof source.naturalHeight === 'number'
      ? source.naturalHeight || (source as HTMLImageElement).height
      : 'videoHeight' in source && typeof source.videoHeight === 'number'
        ? source.videoHeight
        : (source as HTMLCanvasElement).height;

  if (!srcW || !srcH) {
    return {
      positions: new Float32Array(0),
      colors: new Float32Array(0),
      seeds: new Float32Array(0),
      count: 0,
      aspect: 1,
      halfWidth: 0,
      halfHeight: 0,
    };
  }

  let { w, h } = fitSampleSize(srcW, srcH, maxSide);
  let step = Math.max(1, stride);

  // Prefer denser grids: raise stride only after exhausting side shrink gently.
  while (Math.ceil(w / step) * Math.ceil(h / step) > maxParticles && step < 4) {
    step += 1;
  }
  while (
    Math.ceil(w / step) * Math.ceil(h / step) > maxParticles &&
    Math.max(w, h) > 64
  ) {
    w = Math.max(48, Math.floor(w * 0.9));
    h = Math.max(48, Math.floor(h * 0.9));
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('sampleImageToParticles: 2d context unavailable');
  }
  // High-quality downscale keeps photo detail in particle colors
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const aspect = w / h;
  const { halfW, halfH } = fitPlaneExtents(
    aspect,
    planeHalfWidth,
    planeMaxHalfHeight,
  );

  const est = Math.ceil(w / step) * Math.ceil(h / step);
  const positions = new Float32Array(est * 3);
  const colors = new Float32Array(est * 3);
  const seeds = new Float32Array(est);
  let count = 0;

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (count >= maxParticles) break;
      const i = (y * w + x) * 4;
      const a = data[i + 3]!;
      if (a < minAlpha) continue;

      const r = data[i]! / 255;
      const g = data[i + 1]! / 255;
      const b = data[i + 2]! / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (skipWhiteAbove < 1 && lum > skipWhiteAbove && a > 240) continue;

      const u = (x + 0.5) / w;
      const v = (y + 0.5) / h;
      const px = (u - 0.5) * 2 * halfW;
      const py = (0.5 - v) * 2 * halfH;
      // Flat photo plane — tiny z only to reduce z-fighting when depth-tested
      const pz = (Math.random() - 0.5) * 0.008;

      const o = count * 3;
      positions[o] = px;
      positions[o + 1] = py;
      positions[o + 2] = pz;
      colors[o] = r;
      colors[o + 1] = g;
      colors[o + 2] = b;
      seeds[count] = Math.random();
      count += 1;
    }
    if (count >= maxParticles) break;
  }

  return {
    positions: positions.subarray(0, count * 3),
    colors: colors.subarray(0, count * 3),
    seeds: seeds.subarray(0, count),
    count,
    aspect,
    halfWidth: halfW,
    halfHeight: halfH,
  };
}

export function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Not an image file'));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image'));
    };
    img.src = url;
  });
}
