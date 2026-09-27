import { describe, it, expect } from 'vitest';
import { createLoop } from '../src/core/loop';

describe('fixed-step loop', () => {
  it('runs whole steps and carries the remainder as alpha', () => {
    const steps: number[] = [];
    let alpha = -1;
    const loop = createLoop({ step: 1 / 120, onStep: dt => steps.push(dt), onRender: a => { alpha = a; } });
    loop.advance(1 / 60 + 0.001);
    expect(steps.length).toBe(2);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(1);
  });
  it('clamps sub-steps on a huge frame (tab hidden) instead of spiraling', () => {
    let n = 0;
    const loop = createLoop({ step: 1 / 120, onStep: () => n++, onRender: () => {}, maxSubSteps: 8 });
    loop.advance(5);
    expect(n).toBe(8);
    n = 0;
    loop.advance(1 / 120);
    expect(n).toBe(1); // backlog dropped, not carried
  });
  it('uses the step multiplier from timescale for sim dt', () => {
    const dts: number[] = [];
    const loop = createLoop({ step: 1 / 120, onStep: dt => dts.push(dt), onRender: () => {} });
    loop.advance(1 / 120, 0.5);
    expect(dts[0]).toBeCloseTo(1 / 240);
  });
});

import { FrameLimiter } from '../src/core/loop';

describe('FrameLimiter', () => {
  const run = (cap: number, hz: number, seconds = 2) => {
    const f = new FrameLimiter(); f.cap = cap;
    let n = 0;
    for (let t = 0; t < seconds * 1000; t += 1000 / hz) if (f.shouldRender(t)) n++;
    return n / seconds;
  };
  it('uncapped renders every display refresh', () => { expect(run(0, 144)).toBeCloseTo(144, -1); });
  it('caps a 144 Hz display to ~60 fps on average', () => { expect(Math.abs(run(60, 144) - 60)).toBeLessThan(2); });
  it('caps a 240 Hz display to ~120 fps', () => { expect(Math.abs(run(120, 240) - 120)).toBeLessThan(2); });
  it('a cap above the refresh rate changes nothing', () => { expect(run(144, 60)).toBeCloseTo(60, -1); });
  it('recovers after a long stall without a burst of frames', () => {
    const f = new FrameLimiter(); f.cap = 60;
    f.shouldRender(0); f.shouldRender(5000); // tab was hidden for 5 s
    let n = 0; for (let t = 5000 + 1000 / 144; t < 5100; t += 1000 / 144) if (f.shouldRender(t)) n++;
    expect(n).toBeLessThanOrEqual(7);
  });
});
