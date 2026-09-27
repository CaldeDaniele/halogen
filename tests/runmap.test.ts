import { describe, it, expect } from 'vitest';
import { buildSectorMap } from '../src/game/level/runmap';

describe('run map', () => {
  for (let seed = 1; seed < 60; seed++) {
    it(`seed ${seed}: every node reachable, boss is the only sink, out-degree ≤ 2`, () => {
      const m = buildSectorMap(seed, seed % 3);
      const reach = new Set<number>([m.start]);
      const q = [m.start];
      while (q.length) { const n = q.pop()!; for (const e of m.nodes[n].next) if (!reach.has(e)) { reach.add(e); q.push(e); } }
      expect(reach.size).toBe(m.nodes.length);
      const sinks = m.nodes.filter(n => n.next.length === 0);
      expect(sinks.length).toBe(1);
      expect(sinks[0].type).toBe('boss');
      for (const n of m.nodes) expect(n.next.length).toBeLessThanOrEqual(2);
    });
  }
  it('deterministic', () => { expect(buildSectorMap(5, 1)).toEqual(buildSectorMap(5, 1)); });
});
