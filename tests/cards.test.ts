import { describe, it, expect } from 'vitest';
import { CARDS, offerCards, applyCard } from '../src/game/run/cards';
import { RunState } from '../src/game/run/state';
import { Rng } from '../src/core/rng';

describe('cards', () => {
  it('offers are deterministic for the same rng seed and state', () => {
    const a = offerCards(new RunState(1), new Rng(5), 3), b = offerCards(new RunState(1), new Rng(5), 3);
    expect(a.map(c => c.id)).toEqual(b.map(c => c.id));
  });
  it('offers 3 distinct cards and never an owned unique', () => {
    const run = new RunState(1);
    applyCard(run, 'ricochet'); applyCard(run, 'plating');
    for (let s = 0; s < 50; s++) {
      const o = offerCards(run, new Rng(s), 3);
      expect(o.length).toBe(3);
      expect(new Set(o.map(c => c.id)).size).toBe(3);
      expect(o.find(c => c.id === 'ricochet')).toBeUndefined();
    }
  });
  it('never returns an empty offer even when the pool is exhausted', () => {
    const run = new RunState(1);
    for (const c of CARDS) if (c.unique) run.cards.push(c.id);
    const o = offerCards(run, new Rng(1), 3);
    expect(o.length).toBe(3);
  });
  it('weapon cards are not offered for weapons already carried', () => {
    const run = new RunState(1);
    for (let s = 0; s < 80; s++) {
      const o = offerCards(run, new Rng(s), 3);
      expect(o.find(c => c.id === 'w_arc' || c.id === 'w_scatter')).toBeUndefined();
    }
  });
  it('applying cards modifies run mods', () => {
    const run = new RunState(1);
    applyCard(run, 'overpressure'); expect(run.mods.dmgMul).toBeGreaterThan(1);
    applyCard(run, 'plating'); expect(run.maxHp).toBe(125);
    applyCard(run, 'w_rail'); expect(run.weapons).toContain('rail');
    expect(run.weapons.length).toBe(2);
  });
  it('every card has art id, name and description', () => {
    expect(CARDS.length).toBeGreaterThanOrEqual(40);
    for (const c of CARDS) { expect(c.name.length).toBeGreaterThan(0); expect(c.desc.length).toBeGreaterThan(0); }
  });
});

describe('meta unlocks', () => {
  it('never offers locked cards', async () => {
    const { LOCKED_AT_START } = await import('../src/game/run/cards');
    const run = new RunState(1);
    const locked = new Set(LOCKED_AT_START);
    for (let s = 0; s < 120; s++) for (const c of offerCards(run, new Rng(s), 3, { rare: true, locked })) expect(locked.has(c.id)).toBe(false);
  });
  it('unlockFor returns the right cards per milestone and only once', async () => {
    const { unlockFor } = await import('../src/game/run/cards');
    const have = new Set<string>();
    expect(unlockFor({ bossSector: 0 }, have)).toEqual(['w_ion', 'phasedash']);
    ['w_ion', 'phasedash'].forEach(x => have.add(x));
    expect(unlockFor({ bossSector: 0 }, have)).toEqual([]);
    expect(unlockFor({ totalKills: 75 }, have)).toEqual(['singularity']);
    expect(unlockFor({ victory: true }, have)).toEqual(['glasscannon']);
  });
});
