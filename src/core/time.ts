/** Global simulation timescale: bullet-time (slowmo) and hit-stop. Real time drives the timers. */
export class Time {
  scale = 1;
  /** total scaled sim time */
  simTime = 0;
  realTime = 0;
  private slowScale = 1;
  private slowLeft = 0;
  private slowEase = 0.25;
  private easeT = 0;
  private stopLeft = 0;

  get isBulletTime() { return this.slowLeft > 0; }
  get bulletTimeLeft() { return this.slowLeft; }

  reset() { this.scale = 1; this.slowScale = 1; this.slowLeft = 0; this.easeT = 0; this.stopLeft = 0; }

  slowmo(scale: number, duration: number) {
    this.slowScale = scale;
    this.slowLeft = Math.max(this.slowLeft, duration);
    this.easeT = 0;
  }
  extendSlowmo(seconds: number) { if (this.slowLeft > 0) this.slowLeft += seconds; }
  hitstop(ms: number) { this.stopLeft = Math.max(this.stopLeft, ms / 1000); }

  update(realDt: number) {
    this.realTime += realDt;
    let s = 1;
    if (this.slowLeft > 0) {
      this.slowLeft = Math.max(0, this.slowLeft - realDt);
      s = this.slowScale;
      if (this.slowLeft === 0) this.easeT = this.slowEase;
    } else if (this.easeT > 0) {
      this.easeT = Math.max(0, this.easeT - realDt);
      const k = 1 - this.easeT / this.slowEase;
      s = this.slowScale + (1 - this.slowScale) * k * k;
    }
    if (this.stopLeft > 0) {
      if (this.stopLeft > realDt) s = 0;
      this.stopLeft = Math.max(0, this.stopLeft - realDt);
    }
    this.scale = s;
  }
  advanceSim(dt: number) { this.simTime += dt; }
}
