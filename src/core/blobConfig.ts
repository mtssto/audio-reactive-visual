/**
 * Blob VJ look + detection config (persisted in localStorage).
 * Defaults are intentionally milder than the original neon-fire look.
 */

export const BLOB_CONFIG_STORAGE_KEY = 'data-visual:blob-config';

export type BlobConfig = {
  /** Luma delta threshold (higher = less sensitive). */
  threshold: number;
  /** Min blob area in analysis pixels. */
  minArea: number;
  /** Cap on simultaneous tracks. */
  maxBlobs: number;
  /** Morphological open passes (noise cleanup). */
  morphPasses: number;
  /** Display lerp rate toward tracker. */
  smoothRate: number;
  /** Drop blobs shorter than this fraction of frame height. */
  minHeight: number;

  /** Background dim amount (0 = bright, 1 = very dark). */
  bgDim: number;
  /** Background blur in CSS px. */
  bgBlur: number;
  /** Extra black veil opacity over background. */
  bgVeil: number;
  /** Video bloom / luminous glow strength (0–1). */
  bloomAmount: number;
  /** White rect outline stroke scale. */
  contourThickness: number;
  /** White rect outline glow / shadow scale. */
  contourGlow: number;
  /** Magnifier zoom inside primary blob (when Matrix off). */
  lensZoom: number;
  /** Expand lens clip / bbox (fraction of blob size). */
  lensPadding: number;
  showBoxes: boolean;
  /** White axis-aligned rectangle outlines. */
  showContours: boolean;
  showLens: boolean;

  /** Matrix-style glyph rain fill inside each blob rect. */
  matrixFill: boolean;
  /** Glyph column density (0 = sparse, 1 = dense). */
  matrixDensity: number;
  /** Fall speed of the rain. */
  matrixSpeed: number;
  /** Glyph brightness / opacity. */
  matrixBrightness: number;
  /** Hue in degrees (120 ≈ classic Matrix green). */
  matrixHue: number;

  /** Inflate / shrink drawn rect & lens vs detected bbox. */
  sizeScale: number;
  /** Vertical stretch of drawn rect / lens. */
  heightScale: number;
  /** Extra vertical padding on the lens dest (fraction of blob height). */
  lensPadY: number;
};

/** Milder out-of-box look (was ~1.85× zoom, heavy blur/bloom/contours). */
export const BLOB_CONFIG_DEFAULTS: BlobConfig = {
  threshold: 30,
  minArea: 50,
  maxBlobs: 8,
  morphPasses: 1,
  smoothRate: 9,
  minHeight: 0,

  bgDim: 0.42,
  bgBlur: 7,
  bgVeil: 0.12,
  bloomAmount: 0.32,
  contourThickness: 0.55,
  contourGlow: 0.42,
  lensZoom: 1.32,
  lensPadding: 0.04,
  showBoxes: true,
  showContours: true,
  showLens: true,

  matrixFill: false,
  matrixDensity: 0.55,
  matrixSpeed: 0.65,
  matrixBrightness: 0.85,
  matrixHue: 120,

  sizeScale: 1,
  heightScale: 1,
  lensPadY: 0.02,
};

export type BlobConfigSlider = {
  key: keyof BlobConfig;
  label: string;
  min: number;
  max: number;
  step: number;
};

export type BlobConfigToggle = {
  key: keyof BlobConfig;
  label: string;
};

export const BLOB_DETECTION_SLIDERS: BlobConfigSlider[] = [
  { key: 'threshold', label: 'Threshold', min: 8, max: 70, step: 1 },
  { key: 'minArea', label: 'Min area', min: 10, max: 400, step: 5 },
  { key: 'maxBlobs', label: 'Max blobs', min: 1, max: 16, step: 1 },
  { key: 'morphPasses', label: 'Morph / smooth', min: 0, max: 3, step: 1 },
  { key: 'smoothRate', label: 'Display smooth', min: 2, max: 20, step: 0.5 },
  { key: 'minHeight', label: 'Min height', min: 0, max: 0.45, step: 0.01 },
];

export const BLOB_LOOK_SLIDERS: BlobConfigSlider[] = [
  { key: 'bgDim', label: 'Background dim', min: 0.2, max: 1, step: 0.01 },
  { key: 'bgBlur', label: 'Background blur', min: 0, max: 28, step: 0.5 },
  { key: 'bgVeil', label: 'Dim veil', min: 0, max: 0.5, step: 0.01 },
  { key: 'bloomAmount', label: 'Bloom / glow', min: 0, max: 1, step: 0.01 },
  { key: 'contourThickness', label: 'Outline thickness', min: 0.15, max: 1.8, step: 0.01 },
  { key: 'contourGlow', label: 'Outline glow', min: 0, max: 1.5, step: 0.01 },
];

export const BLOB_LENS_SLIDERS: BlobConfigSlider[] = [
  { key: 'lensZoom', label: 'Lens zoom', min: 1, max: 2.4, step: 0.01 },
  { key: 'lensPadding', label: 'Lens padding', min: 0, max: 0.35, step: 0.01 },
  { key: 'lensPadY', label: 'Lens pad Y', min: 0, max: 0.35, step: 0.01 },
  { key: 'sizeScale', label: 'Size scale', min: 0.5, max: 1.8, step: 0.01 },
  { key: 'heightScale', label: 'Height scale', min: 0.5, max: 1.8, step: 0.01 },
];

export const BLOB_MATRIX_SLIDERS: BlobConfigSlider[] = [
  { key: 'matrixDensity', label: 'Matrix density', min: 0.1, max: 1, step: 0.01 },
  { key: 'matrixSpeed', label: 'Matrix speed', min: 0.05, max: 1.5, step: 0.01 },
  { key: 'matrixBrightness', label: 'Matrix brightness', min: 0.15, max: 1, step: 0.01 },
  { key: 'matrixHue', label: 'Matrix hue', min: 0, max: 360, step: 1 },
];

export const BLOB_LOOK_TOGGLES: BlobConfigToggle[] = [
  { key: 'showBoxes', label: 'Green ID boxes' },
  { key: 'showContours', label: 'White rect outlines' },
  { key: 'showLens', label: 'Lens fill' },
  { key: 'matrixFill', label: 'Matrix fill' },
];

function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** Merge stored JSON with defaults; clamp known numeric ranges. */
export function normalizeBlobConfig(raw: Partial<BlobConfig> | null | undefined): BlobConfig {
  const d = BLOB_CONFIG_DEFAULTS;
  const r = raw ?? {};
  const num = (key: keyof BlobConfig, min: number, max: number): number => {
    const v = r[key];
    return typeof v === 'number' && Number.isFinite(v)
      ? clampNum(v, min, max)
      : (d[key] as number);
  };
  const bool = (key: keyof BlobConfig): boolean => {
    const v = r[key];
    return isBool(v) ? v : (d[key] as boolean);
  };

  return {
    threshold: num('threshold', 8, 70),
    minArea: num('minArea', 10, 400),
    maxBlobs: Math.round(num('maxBlobs', 1, 16)),
    morphPasses: Math.round(num('morphPasses', 0, 3)),
    smoothRate: num('smoothRate', 2, 20),
    minHeight: num('minHeight', 0, 0.45),

    bgDim: num('bgDim', 0.2, 1),
    bgBlur: num('bgBlur', 0, 28),
    bgVeil: num('bgVeil', 0, 0.5),
    bloomAmount: num('bloomAmount', 0, 1),
    contourThickness: num('contourThickness', 0.15, 1.8),
    contourGlow: num('contourGlow', 0, 1.5),
    lensZoom: num('lensZoom', 1, 2.4),
    lensPadding: num('lensPadding', 0, 0.35),
    showBoxes: bool('showBoxes'),
    showContours: bool('showContours'),
    showLens: bool('showLens'),

    matrixFill: bool('matrixFill'),
    matrixDensity: num('matrixDensity', 0.1, 1),
    matrixSpeed: num('matrixSpeed', 0.05, 1.5),
    matrixBrightness: num('matrixBrightness', 0.15, 1),
    matrixHue: num('matrixHue', 0, 360),

    sizeScale: num('sizeScale', 0.5, 1.8),
    heightScale: num('heightScale', 0.5, 1.8),
    lensPadY: num('lensPadY', 0, 0.35),
  };
}

export function loadBlobConfig(): BlobConfig {
  try {
    const raw = localStorage.getItem(BLOB_CONFIG_STORAGE_KEY);
    if (!raw) return { ...BLOB_CONFIG_DEFAULTS };
    return normalizeBlobConfig(JSON.parse(raw) as Partial<BlobConfig>);
  } catch {
    return { ...BLOB_CONFIG_DEFAULTS };
  }
}

export function saveBlobConfig(cfg: BlobConfig): void {
  try {
    localStorage.setItem(BLOB_CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* quota / private mode */
  }
}

/** Secondary lens zoom stays a bit milder than primary. */
export function secondaryLensZoom(primary: number): number {
  return 1 + (primary - 1) * 0.55;
}
