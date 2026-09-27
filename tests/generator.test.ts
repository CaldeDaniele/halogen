import { describe, it, expect } from 'vitest';
import { generateRoom, Cell, walkableFrom, RoomType } from '../src/game/level/generator';

const types: RoomType[] = ['arena', 'gauntlet', 'shaft', 'dark', 'boss', 'rest'];

describe('room generator', () => {
  it('is deterministic per seed', () => {
    const a = generateRoom(1234, 'arena', 0), b = generateRoom(1234, 'arena', 0);
    expect(Array.from(a.grid)).toEqual(Array.from(b.grid));
    expect(a.spawns).toEqual(b.spawns);
    expect(a.fixtures.length).toBe(b.fixtures.length);
  });
  it('different seeds give different layouts', () => {
    const a = generateRoom(1, 'arena', 0), b = generateRoom(2, 'arena', 0);
    expect(Array.from(a.grid)).not.toEqual(Array.from(b.grid));
  });
  for (const t of types) {
    it(`${t}: entry reaches every spawn and exit across 40 seeds`, () => {
      for (let s = 0; s < 40; s++) {
        const r = generateRoom(s * 7919 + 13, t, s % 3);
        const reach = walkableFrom(r, r.entry.x, r.entry.y);
        for (const sp of r.spawns) expect(reach.has(sp.y * r.w + sp.x), `seed ${s} spawn ${sp.x},${sp.y}`).toBe(true);
        for (const e of r.exits) expect(reach.has(e.inY * r.w + e.inX), `seed ${s} exit`).toBe(true);
        if (t !== 'rest') expect(r.spawns.length).toBeGreaterThanOrEqual(6);
        expect(r.exits.length).toBeGreaterThanOrEqual(1);
        expect(r.grid[r.entry.y * r.w + r.entry.x]).toBe(Cell.DOOR);
      }
    });
  }
  it('rooms have breakable fixtures and props', () => {
    const r = generateRoom(99, 'arena', 0);
    expect(r.fixtures.filter(f => f.breakable).length).toBeGreaterThanOrEqual(6);
    expect(r.props.length).toBeGreaterThan(0);
  });
});
