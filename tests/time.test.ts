import { describe, it, expect } from 'vitest';
import { Time } from '../src/core/time';

describe('Time', () => {
  it('slowmo holds scale then eases back to 1', () => {
    const t = new Time();
    t.slowmo(0.2, 1.0);
    t.update(0.1);
    expect(t.scale).toBeCloseTo(0.2, 1);
    for (let i = 0; i < 20; i++) t.update(0.1);
    expect(t.scale).toBe(1);
  });
  it('hitstop zeroes scale for its duration in real time', () => {
    const t = new Time();
    t.hitstop(50);
    t.update(0.01);
    expect(t.scale).toBe(0);
    t.update(0.06);
    expect(t.scale).toBe(1);
  });
  it('hitstop during slowmo returns to slowmo scale', () => {
    const t = new Time();
    t.slowmo(0.2, 2);
    t.hitstop(30);
    t.update(0.01); expect(t.scale).toBe(0);
    t.update(0.05); expect(t.scale).toBeCloseTo(0.2, 1);
  });
  it('isBulletTime reflects active slowmo', () => {
    const t = new Time();
    expect(t.isBulletTime).toBe(false);
    t.slowmo(0.2, 1); t.update(0.01);
    expect(t.isBulletTime).toBe(true);
  });
});
