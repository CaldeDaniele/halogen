/** mulberry32 seeded PRNG with labeled forks so subsystems don't perturb each other. */
export class Rng {
  private s: number;
  readonly seed: number;
  constructor(seed: number) { this.seed = seed >>> 0; this.s = this.seed; }

  static hash(str: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return a + Math.floor(this.next() * (b - a + 1)); }
  chance(p: number) { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  weighted<T>(items: readonly T[], weight: (t: T) => number): T {
    const total = items.reduce((s, it) => s + weight(it), 0);
    let r = this.next() * total;
    for (const it of items) { r -= weight(it); if (r <= 0) return it; }
    return items[items.length - 1];
  }
  /** Independent stream derived from the seed + label (not from current state). */
  fork(label: string) { return new Rng((this.seed ^ Rng.hash(label)) >>> 0); }
}
