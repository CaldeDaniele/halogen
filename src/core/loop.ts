export interface LoopOptions {
  step: number;
  onStep: (dt: number) => void;
  onRender: (alpha: number, frameDt: number) => void;
  maxSubSteps?: number;
}

/** Fixed-step accumulator. `advance` is pure w.r.t. wall clock so it can be unit tested. */
export function createLoop(opts: LoopOptions) {
  const maxSub = opts.maxSubSteps ?? 8;
  let acc = 0;
  let raf = 0;
  let last = 0;

  function advance(frameDt: number, timescale = 1) {
    acc += frameDt;
    let n = 0;
    while (acc >= opts.step && n < maxSub) {
      opts.onStep(opts.step * timescale);
      acc -= opts.step;
      n++;
    }
    if (n === maxSub && acc >= opts.step) acc = 0; // drop backlog: no spiral of death
    opts.onRender(acc / opts.step, frameDt);
  }

  function start(getScale: () => number, onFrame?: (realDt: number) => void) {
    last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const realDt = Math.min((now - last) / 1000, 0.25);
      last = now;
      onFrame?.(realDt);
      advance(realDt, getScale());
    };
    raf = requestAnimationFrame(tick);
  }

  function stop() { cancelAnimationFrame(raf); }

  return { advance, start, stop };
}
