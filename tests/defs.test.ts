import { describe, it, expect } from 'vitest';
import { BIPED, QUAD, DRONE, ENEMIES } from '../src/game/enemies/defs';

describe('android body defs', () => {
  for (const [name, segs] of Object.entries({ BIPED, QUAD, DRONE })) {
    it(`${name}: exactly one root, parents exist and precede children, joints present`, () => {
      const names = new Set<string>();
      let roots = 0;
      for (const s of segs) {
        if (!s.parent) roots++;
        else {
          expect(names.has(s.parent), `${s.name} parent ${s.parent}`).toBe(true);
          expect(s.joint, `${s.name} joint`).toBeDefined();
        }
        expect(s.mass).toBeGreaterThan(0);
        expect(names.has(s.name)).toBe(false);
        names.add(s.name);
      }
      expect(roots).toBe(1);
      expect(segs.filter(s => s.head).length).toBe(1);
    });
  }
  it('every enemy type has positive hp and a body', () => {
    for (const e of Object.values(ENEMIES)) { expect(e.hp).toBeGreaterThan(0); expect(e.body.length).toBeGreaterThan(0); }
  });
});
