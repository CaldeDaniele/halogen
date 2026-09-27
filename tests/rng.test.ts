import { describe, it, expect } from 'vitest';
import { Rng } from '../src/core/rng';

describe('Rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it('different seeds diverge', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });
  it('fork is independent of parent consumption order', () => {
    const a = new Rng(7); const fa = a.fork('rooms');
    const b = new Rng(7); b.next(); b.next(); const fb = b.fork('rooms');
    expect(fa.next()).toBe(fb.next());
  });
  it('int range inclusive and pick/shuffle stable', () => {
    const r = new Rng(3);
    for (let i = 0; i < 500; i++) { const v = r.int(2, 5); expect(v).toBeGreaterThanOrEqual(2); expect(v).toBeLessThanOrEqual(5); }
    expect(new Rng(9).shuffle([1, 2, 3, 4, 5])).toEqual(new Rng(9).shuffle([1, 2, 3, 4, 5]));
  });
  it('seeds from strings', () => {
    expect(Rng.hash('abc')).toBe(Rng.hash('abc'));
    expect(Rng.hash('abc')).not.toBe(Rng.hash('abd'));
  });
});
