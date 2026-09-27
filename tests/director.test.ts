import { describe, it, expect } from 'vitest';
import { Rng } from '../src/core/rng';
import { Director, ENEMY_COST } from '../src/game/enemies/director';

const cost = (d: Director) => d.waves.flat().reduce((s, e) => s + ENEMY_COST[e.type] * e.count, 0);

describe('director budgets (difficulty curve)', () => {
  it('opening room of sector 1 is a gentle warm-up', () => {
    for (let seed = 1; seed <= 20; seed++) expect(cost(new Director(new Rng(seed), 0, 0, 'arena'))).toBeLessThanOrEqual(10);
  });

  it('budget still ramps with room depth and sector', () => {
    const b = (s: number, d: number) => cost(new Director(new Rng(7), s, d, 'arena'));
    expect(b(0, 4)).toBeGreaterThan(b(0, 0));
    expect(b(1, 0)).toBeGreaterThan(b(0, 0));
    expect(b(2, 4)).toBeGreaterThan(b(1, 4));
  });

  it('late sector-3 elite rooms stay well below the round-1 peak (61 pts)', () => {
    for (let seed = 1; seed <= 10; seed++) expect(cost(new Director(new Rng(seed), 2, 5, 'elite'))).toBeLessThanOrEqual(52);
  });
});
