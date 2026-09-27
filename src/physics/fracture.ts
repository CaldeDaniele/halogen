import { Rng } from '../core/rng';

export interface Chunk { center: [number, number, number]; half: [number, number, number] }

/**
 * Seeded recursive fracture of a box (half extents) into `count` chunks.
 * Always splits the largest chunk along its longest axis at a random ratio, which gives
 * convincing slab/shard proportions for concrete and keeps volume exactly conserved.
 */
export function fractureBox(half: [number, number, number], count: number, seed: number): Chunk[] {
  const rng = new Rng(seed);
  const chunks: Chunk[] = [{ center: [0, 0, 0], half: [...half] as [number, number, number] }];
  while (chunks.length < count) {
    let bi = 0, bv = -1;
    chunks.forEach((c, i) => { const v = c.half[0] * c.half[1] * c.half[2] * (0.7 + rng.next() * 0.6); if (v > bv) { bv = v; bi = i; } });
    const c = chunks.splice(bi, 1)[0];
    const axis = c.half.indexOf(Math.max(...c.half)) as 0 | 1 | 2;
    const ax = rng.chance(0.25) ? rng.int(0, 2) as 0 | 1 | 2 : axis;
    const t = rng.range(0.3, 0.7);
    const full = c.half[ax] * 2;
    const lo = c.center[ax] - c.half[ax];
    const a = { center: [...c.center] as [number, number, number], half: [...c.half] as [number, number, number] };
    const b = { center: [...c.center] as [number, number, number], half: [...c.half] as [number, number, number] };
    a.half[ax] = (full * t) / 2; a.center[ax] = lo + a.half[ax];
    b.half[ax] = (full * (1 - t)) / 2; b.center[ax] = lo + full * t + b.half[ax];
    chunks.push(a, b);
  }
  return chunks;
}
