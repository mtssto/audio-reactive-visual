export type TouchImpulse = {
  /** NDC xy in [-1, 1] */
  ndcX: number;
  ndcY: number;
  strength: number;
  age: number;
  /** Sticky id so hands can update the same slot */
  id: string;
};

const MAX_TOUCHES = 4;

/**
 * Queue of concurrent touch contacts (hands + pointer) for the particle shader.
 */
export class TouchField {
  private impulses: TouchImpulse[] = [];

  /** Press / hit — strong burst that decays. */
  pulse(ndcX: number, ndcY: number, strength = 1, id?: string): void {
    const key = id ?? `pulse-${performance.now()}`;
    const existing = this.impulses.find((i) => i.id === key);
    if (existing) {
      existing.ndcX = ndcX;
      existing.ndcY = ndcY;
      existing.strength = Math.max(existing.strength, strength);
      existing.age = 0;
      return;
    }
    this.impulses.push({ ndcX, ndcY, strength, age: 0, id: key });
    this.trim();
  }

  /** Continuous contact (fingertip / drag) — refreshes age while moving. */
  hold(ndcX: number, ndcY: number, strength = 0.7, id = 'hold'): void {
    const existing = this.impulses.find((i) => i.id === id);
    if (existing) {
      existing.ndcX = ndcX;
      existing.ndcY = ndcY;
      existing.strength = strength;
      existing.age = Math.min(existing.age, 0.08);
      return;
    }
    this.impulses.push({ ndcX, ndcY, strength, age: 0, id });
    this.trim();
  }

  release(id: string): void {
    const hit = this.impulses.find((i) => i.id === id);
    if (hit) hit.strength *= 0.35;
  }

  update(dt: number): void {
    for (const impulse of this.impulses) {
      impulse.age += dt;
      impulse.strength *= Math.exp(-dt * 1.8);
    }
    this.impulses = this.impulses.filter((i) => i.strength > 0.02 && i.age < 2.5);
  }

  /** Pack into fixed-length arrays for shader uniforms. */
  toUniforms(): {
    ndc: Float32Array;
    strength: Float32Array;
    age: Float32Array;
  } {
    const ndc = new Float32Array(MAX_TOUCHES * 2);
    const strength = new Float32Array(MAX_TOUCHES);
    const age = new Float32Array(MAX_TOUCHES);
    const sorted = [...this.impulses].sort((a, b) => b.strength - a.strength);
    for (let i = 0; i < MAX_TOUCHES; i++) {
      const impulse = sorted[i];
      if (!impulse) continue;
      ndc[i * 2] = impulse.ndcX;
      ndc[i * 2 + 1] = impulse.ndcY;
      strength[i] = impulse.strength;
      age[i] = impulse.age;
    }
    return { ndc, strength, age };
  }

  get count(): number {
    return this.impulses.length;
  }

  private trim(): void {
    if (this.impulses.length <= MAX_TOUCHES) return;
    this.impulses.sort((a, b) => b.strength - a.strength);
    this.impulses.length = MAX_TOUCHES;
  }
}
