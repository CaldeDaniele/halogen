import { describe, it, expect } from 'vitest';
import { fractureBox } from '../src/physics/fracture';

describe('fracture', () => {
  it('is deterministic for a seed', () => {
    expect(fractureBox([1, 2, 0.5], 12, 7)).toEqual(fractureBox([1, 2, 0.5], 12, 7));
  });
  it('conserves volume and produces the requested chunk count', () => {
    const ch = fractureBox([1, 2, 0.5], 12, 3);
    expect(ch.length).toBe(12);
    const vol = ch.reduce((s, c) => s + 8 * c.half[0] * c.half[1] * c.half[2], 0);
    expect(vol).toBeCloseTo(8 * 1 * 2 * 0.5, 5);
  });
  it('chunks stay inside the original bounds', () => {
    for (const c of fractureBox([0.6, 0.6, 0.6], 20, 11)) for (let a = 0; a < 3; a++) {
      expect(Math.abs(c.center[a]) + c.half[a]).toBeLessThanOrEqual([0.6, 0.6, 0.6][a] + 1e-9);
    }
  });
});
