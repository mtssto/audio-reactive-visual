export type VisualPresetId =
  | 'neon'
  | 'ember'
  | 'ice'
  | 'mono'
  | 'pulse'
  | 'image';

export type MeshPreference = 'cylinder' | 'box' | 'mixed' | 'image';

export type VisualBlending = 'additive' | 'normal';

export type VisualPreset = {
  id: VisualPresetId;
  name: string;
  /** Hot / near particles */
  startColor: number;
  /** Cool / far particles */
  endColor: number;
  clearColor: number;
  blending: VisualBlending;
  /** Multiplier on computed amplitude */
  amplitudeScale: number;
  idleAmp: number;
  presentAmp: number;
  /** Multiplier on base particle size */
  sizeScale: number;
  /** 0–1 chance to prefer auto remix when signals fire */
  remixChance: number;
  meshPreference: MeshPreference;
  /** Higher → denser segment counts on remesh */
  density: number;
  offsetSizeMin: number;
  offsetSizeMax: number;
};

export const VISUAL_PRESETS: readonly VisualPreset[] = [
  {
    id: 'neon',
    name: 'Neon',
    startColor: 0xff00ff,
    endColor: 0x00ffff,
    clearColor: 0x000000,
    blending: 'additive',
    amplitudeScale: 1,
    idleAmp: 0.38,
    presentAmp: 1.05,
    sizeScale: 1,
    remixChance: 0.28,
    meshPreference: 'mixed',
    density: 1,
    offsetSizeMin: 30,
    offsetSizeMax: 60,
  },
  {
    id: 'ember',
    name: 'Ember',
    startColor: 0xff4a1a,
    endColor: 0xffb347,
    clearColor: 0x050201,
    blending: 'additive',
    amplitudeScale: 0.88,
    idleAmp: 0.32,
    presentAmp: 0.92,
    sizeScale: 1.08,
    remixChance: 0.22,
    meshPreference: 'cylinder',
    density: 0.9,
    offsetSizeMin: 28,
    offsetSizeMax: 52,
  },
  {
    id: 'ice',
    name: 'Ice',
    startColor: 0xa8e6ff,
    endColor: 0x2b6cff,
    clearColor: 0x01040a,
    blending: 'additive',
    amplitudeScale: 1.05,
    idleAmp: 0.4,
    presentAmp: 1.12,
    sizeScale: 0.95,
    remixChance: 0.3,
    meshPreference: 'mixed',
    density: 1.05,
    offsetSizeMin: 32,
    offsetSizeMax: 64,
  },
  {
    id: 'mono',
    name: 'Mono',
    startColor: 0xe8e8e8,
    endColor: 0x6a6a6a,
    clearColor: 0x0a0a0c,
    blending: 'normal',
    amplitudeScale: 0.82,
    idleAmp: 0.3,
    presentAmp: 0.88,
    sizeScale: 1.15,
    remixChance: 0.16,
    meshPreference: 'cylinder',
    density: 0.85,
    offsetSizeMin: 24,
    offsetSizeMax: 48,
  },
  {
    id: 'pulse',
    name: 'Pulse',
    startColor: 0xff2d6a,
    endColor: 0x7c3aed,
    clearColor: 0x020008,
    blending: 'additive',
    amplitudeScale: 1.18,
    idleAmp: 0.45,
    presentAmp: 1.22,
    sizeScale: 0.9,
    remixChance: 0.38,
    meshPreference: 'box',
    density: 1.45,
    offsetSizeMin: 40,
    offsetSizeMax: 72,
  },
  {
    id: 'image',
    name: 'Image',
    startColor: 0xf0e6d8,
    endColor: 0x6a7a88,
    clearColor: 0x050505,
    blending: 'normal',
    amplitudeScale: 1,
    idleAmp: 0.1,
    presentAmp: 1.15,
    sizeScale: 0.92,
    remixChance: 0,
    meshPreference: 'image',
    density: 1.6,
    offsetSizeMin: 4,
    offsetSizeMax: 10,
  },
] as const;

export const DEFAULT_PRESET_ID: VisualPresetId = 'neon';

export const PRESET_STORAGE_KEY = 'data-visual:preset';

export function isVisualPresetId(value: string): value is VisualPresetId {
  return VISUAL_PRESETS.some((p) => p.id === value);
}

export function getPreset(id: VisualPresetId): VisualPreset {
  const found = VISUAL_PRESETS.find((p) => p.id === id);
  return found ?? VISUAL_PRESETS[0]!;
}

export function loadStoredPresetId(): VisualPresetId {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    if (raw && isVisualPresetId(raw)) return raw;
  } catch {
    /* private mode / blocked */
  }
  return DEFAULT_PRESET_ID;
}

export function storePresetId(id: VisualPresetId): void {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function presetIdFromKey(key: string): VisualPresetId | null {
  const map: Record<string, VisualPresetId> = {
    '1': 'neon',
    '2': 'ember',
    '3': 'ice',
    '4': 'mono',
    '5': 'pulse',
    '6': 'image',
  };
  return map[key] ?? null;
}
