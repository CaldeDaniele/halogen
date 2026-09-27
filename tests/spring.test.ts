import { describe, it, expect } from 'vitest';
import { Spring } from '../src/game/player/camera';

describe('Spring', () => {
  it('stays finite and settles even with huge frame dt (throttled tab)', () => {
    const s = new Spring(220, 22);
    s.kick(5);
    for (let i = 0; i < 20; i++) s.update(0.25);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThan(1e-3);
  });
});
