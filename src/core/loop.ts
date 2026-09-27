/**
 * Frame cap on top of the browser's vsync'd rAF. Uses a time-budget accumulator so a 60 cap on a
 * 144 Hz display averages exactly 60 instead of snapping between 48 and 72.
 */
export class FrameLimiter {
  /** max frames per second; 0 = uncapped (native refresh rate / vsync) */
  cap = 0;
  private acc = 0;
  private prev = -1;

  shouldRender(now: number) {
    if (this.cap <= 0 || this.prev < 0) { this.prev = now; this.acc = 0; return true; }
    const interval = 1000 / this.cap;
    this.acc += now - this.prev;
    this.prev = now;
    if (this.acc > interval * 2) this.acc = interval; // after a stall: one frame now, no burst
    if (this.acc + 0.5 < interval) return false;       // 0.5 ms slack absorbs rAF timestamp jitter
    this.acc -= interval;
    return true;
  }
}

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
  const limiter = new FrameLimiter();

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
      if (!limiter.shouldRender(now)) return;
      const realDt = Math.min((now - last) / 1000, 0.25);
      last = now;
      onFrame?.(realDt);
      advance(realDt, getScale());
    };
    raf = requestAnimationFrame(tick);
  }

  function stop() { cancelAnimationFrame(raf); }

  return { advance, start, stop, limiter };
}
