import { describe, it, expect } from 'vitest';
import { CVD_MODES, palette, simulateCvd, deltaE, lightness } from '../src/game/palette';
import { ENEMIES, EnemyType } from '../src/game/enemies/defs';

const types = Object.keys(ENEMIES) as EnemyType[];
const seen = (a: number, b: number, mode: (typeof CVD_MODES)[number]) => deltaE(simulateCvd(a, mode), simulateCvd(b, mode));

describe('color-vision simulation', () => {
  it('red and green collapse under deuteranopia and protanopia but not for normal vision', () => {
    expect(seen(0xd02020, 0x20a020, 'default')).toBeGreaterThan(60);
    expect(seen(0xd02020, 0x7a6a10, 'deuteranopia')).toBeLessThan(seen(0xd02020, 0x7a6a10, 'default'));
    expect(seen(0xff0000, 0x00ff00, 'deuteranopia')).toBeLessThan(seen(0xff0000, 0x00ff00, 'default') * 0.5);
    expect(seen(0xff0000, 0x00ff00, 'protanopia')).toBeLessThan(seen(0xff0000, 0x00ff00, 'default') * 0.5);
  });
  it('blue and green collapse under tritanopia', () => {
    expect(seen(0x0080ff, 0x00c080, 'tritanopia')).toBeLessThan(seen(0x0080ff, 0x00c080, 'default') * 0.6);
  });
});

describe('telegraph palettes', () => {
  it('default palette keeps the authored attack colors', () => {
    const p = palette('default');
    for (const t of types) expect(p.tell[t]).toBe(ENEMIES[t].attackColor);
  });

  for (const mode of CVD_MODES.filter(m => m !== 'default')) {
    describe(mode, () => {
      const p = palette(mode);
      it('every attack tell reads as a change from the enemy idle core color', () => {
        for (const t of types) {
          if (ENEMIES[t].dmg === 0) continue; // lamplighter has no attack
          expect(seen(p.tell[t], ENEMIES[t].color, mode), `${t}`).toBeGreaterThanOrEqual(35);
        }
      });
      it('attack tells are not confused with the white hit flash', () => {
        for (const t of types) if (ENEMIES[t].dmg > 0) expect(seen(p.tell[t], 0xffffff, mode), `${t}`).toBeGreaterThanOrEqual(20);
      });
      it('boss tells are distinct from each other and from the Foreman idle core', () => {
        expect(seen(p.bossTell, p.bossAlt, mode)).toBeGreaterThanOrEqual(35);
        expect(seen(p.bossTell, ENEMIES.foreman.color, mode)).toBeGreaterThanOrEqual(35);
      });
      it('kill and headshot markers are distinguishable; damage color is bright on dark', () => {
        expect(seen(p.kill, p.head, mode)).toBeGreaterThanOrEqual(30);
        expect(lightness(simulateCvd(p.hurt, mode))).toBeGreaterThanOrEqual(50);
      });
    });
  }
});
