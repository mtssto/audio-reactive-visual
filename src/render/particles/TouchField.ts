export type TouchMode = 'scatter' | 'wind' | 'gather';

export type TouchImpulse = {
  /** NDC xy in [-1, 1] */
  ndcX: number;
  ndcY: number;
  strength: number;
  age: number;
  /** Sticky id so hands can update the same slot */
  id: string;
  mode: TouchMode;
  /** Falloff radius in NDC space */
  radius: number;
};

export type TouchHoldOptions = {
  mode?: TouchMode;
  radius?: number;
};

const MAX_TOUCHES = 4;

const MODE_CODE: Record<TouchMode, number> = {
  scatter: 0,
  wind: 1,
  gather: 2,
};

/**
 * Queue of concurrent touch contacts (hands + pointer) for the particle shader.
 * Supports scatter (index), wind (palm), and gather (pinch) verbs.
 */
export class TouchField {
  private impulses: TouchImpulse[] = [];

  /** Press / hit — strong burst that decays. */
  pulse(
    ndcX: number,
    ndcY: number,
    strength = 1,
    id?: string,
    opts: TouchHoldOptions = {},
  ): void {
    const key = id ?? `pulse-${performance.now()}`;
    const mode = opts.mode ?? 'scatter';
    const radius = opts.radius ?? 0.2;
    const existing = this.impulses.find((i) => i.id === key);
    if (existing) {
      existing.ndcX = ndcX;
      existing.ndcY = ndcY;
      existing.strength = Math.max(existing.strength, strength);
      existing.age = 0;
      existing.mode = mode;
      existing.radius = radius;
      return;
    }
    this.impulses.push({
      ndcX,
      ndcY,
      strength,
      age: 0,
      id: key,
      mode,
      radius,
    });
    this.trim();
  }

  /** Continuous contact (fingertip / drag) — refreshes age while moving. */
  hold(
    ndcX: number,
    ndcY: number,
    strength = 0.7,
    id = 'hold',
    opts: TouchHoldOptions = {},
  ): void {
    const mode = opts.mode ?? 'scatter';
    const radius = opts.radius ?? (mode === 'wind' ? 0.42 : mode === 'gather' ? 0.28 : 0.18);
    const existing = this.impulses.find((i) => i.id === id);
    if (existing) {
      existing.ndcX = ndcX;
      existing.ndcY = ndcY;
      existing.strength = strength;
      existing.age = Math.min(existing.age, 0.08);
      existing.mode = mode;
      existing.radius = radius;
      return;
    }
    this.impulses.push({
      ndcX,
      ndcY,
      strength,
      age: 0,
      id,
      mode,
      radius,
    });
    this.trim();
  }

  release(id: string): void {
    const hit = this.impulses.find((i) => i.id === id);
    if (hit) hit.strength *= 0.35;
  }

  /** Soft-release every impulse whose id is not in the keep set. */
  releaseExcept(keep: Set<string>): void {
    for (const impulse of this.impulses) {
      if (!keep.has(impulse.id)) impulse.strength *= 0.35;
    }
  }

  update(dt: number): void {
    for (const impulse of this.impulses) {
      impulse.age += dt;
      const decay =
        impulse.mode === 'wind' ? 1.35 : impulse.mode === 'gather' ? 1.55 : 1.8;
      impulse.strength *= Math.exp(-dt * decay);
    }
    this.impulses = this.impulses.filter((i) => i.strength > 0.02 && i.age < 2.5);
  }

  /** Pack into fixed-length arrays for shader uniforms. */
  toUniforms(): {
    ndc: Float32Array;
    strength: Float32Array;
    age: Float32Array;
    radius: Float32Array;
    mode: Float32Array;
  } {
    const ndc = new Float32Array(MAX_TOUCHES * 2);
    const strength = new Float32Array(MAX_TOUCHES);
    const age = new Float32Array(MAX_TOUCHES);
    const radius = new Float32Array(MAX_TOUCHES);
    const mode = new Float32Array(MAX_TOUCHES);
    const sorted = [...this.impulses].sort((a, b) => b.strength - a.strength);
    for (let i = 0; i < MAX_TOUCHES; i++) {
      const impulse = sorted[i];
      if (!impulse) {
        radius[i] = 0.2;
        continue;
      }
      ndc[i * 2] = impulse.ndcX;
      ndc[i * 2 + 1] = impulse.ndcY;
      strength[i] = impulse.strength;
      age[i] = impulse.age;
      radius[i] = impulse.radius;
      mode[i] = MODE_CODE[impulse.mode];
    }
    return { ndc, strength, age, radius, mode };
  }

  get count(): number {
    return this.impulses.length;
  }

  /** Strongest active gather strength (for frequency pull). */
  gatherStrength(): number {
    let max = 0;
    for (const i of this.impulses) {
      if (i.mode === 'gather') max = Math.max(max, i.strength);
    }
    return max;
  }

  private trim(): void {
    if (this.impulses.length <= MAX_TOUCHES) return;
    this.impulses.sort((a, b) => b.strength - a.strength);
    this.impulses.length = MAX_TOUCHES;
  }
}
