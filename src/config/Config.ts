/**
 * Bioluminescent forest growth knobs — subtle cool luminescence.
 */

export const CONFIG_STORAGE_KEY = 'bioluminescent-forest:config';

export type ForestConfig = {
  /** How fast new segments elongate (0–1). */
  growthSpeed: number;
  /** Attraction-point cloud size (per colony). */
  attractionCount: number;
  /** Distance at which nodes sense attractions. */
  influenceRadius: number;
  /** Distance at which attractions are consumed. */
  killRadius: number;
  /** Length of each newly grown segment. */
  segmentLength: number;
  /** Emissive core intensity (0–1). */
  coreBrightness: number;
  /** UnrealBloomPass strength (keep restrained). */
  bloomStrength: number;
  /** Darken the forest photo (0–1). */
  backgroundDim: number;
  /** Desaturate background toward cool midtones (0–1). */
  backgroundDesat: number;
  /** Soft atmospheric haze between depth layers (0–1). */
  hazeStrength: number;
};

export const CONFIG_DEFAULTS: ForestConfig = {
  growthSpeed: 0.32,
  attractionCount: 280,
  influenceRadius: 0.58,
  killRadius: 0.1,
  segmentLength: 0.068,
  coreBrightness: 0.48,
  bloomStrength: 0.14,
  backgroundDim: 0.38,
  backgroundDesat: 0.28,
  hazeStrength: 0.22,
};

export type ForestConfigKey = keyof ForestConfig;

export type ForestConfigSlider = {
  key: ForestConfigKey;
  label: string;
  min: number;
  max: number;
  step: number;
};

export const LOOK_SLIDERS: ForestConfigSlider[] = [
  { key: 'growthSpeed', label: 'Growth speed', min: 0.05, max: 1, step: 0.01 },
  { key: 'bloomStrength', label: 'Bloom', min: 0, max: 0.4, step: 0.01 },
  { key: 'backgroundDim', label: 'Dim', min: 0, max: 0.7, step: 0.01 },
  { key: 'backgroundDesat', label: 'Desat', min: 0, max: 0.6, step: 0.01 },
  { key: 'coreBrightness', label: 'Core brightness', min: 0.15, max: 1, step: 0.01 },
  { key: 'hazeStrength', label: 'Haze', min: 0, max: 0.55, step: 0.01 },
];

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function normalizeConfig(
  raw: Partial<ForestConfig> | null | undefined,
): ForestConfig {
  const d = CONFIG_DEFAULTS;
  const r = raw ?? {};
  const num = (key: ForestConfigKey, min: number, max: number): number => {
    const v = r[key];
    return typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : d[key];
  };

  return {
    growthSpeed: num('growthSpeed', 0.05, 1),
    attractionCount: Math.round(num('attractionCount', 40, 800)),
    influenceRadius: num('influenceRadius', 0.15, 2),
    killRadius: num('killRadius', 0.03, 0.5),
    segmentLength: num('segmentLength', 0.02, 0.25),
    coreBrightness: num('coreBrightness', 0.1, 1),
    bloomStrength: num('bloomStrength', 0, 0.55),
    backgroundDim: num('backgroundDim', 0, 0.75),
    backgroundDesat: num('backgroundDesat', 0, 0.7),
    hazeStrength: num('hazeStrength', 0, 0.6),
  };
}

export function loadConfig(): ForestConfig {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return { ...CONFIG_DEFAULTS };
    return normalizeConfig(JSON.parse(raw) as Partial<ForestConfig>);
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}

export function saveConfig(cfg: ForestConfig): void {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* quota / private mode */
  }
}
