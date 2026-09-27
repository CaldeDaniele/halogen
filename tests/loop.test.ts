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
