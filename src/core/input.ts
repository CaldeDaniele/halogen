/** Keyboard + mouse + pointer lock. Edge-triggered "pressed" sets are consumed once per sim step. */
export class Input {
  readonly down = new Set<string>();
  private pressedQ = new Set<string>();
  private releasedQ = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  sensitivity = 0.0022;
  onLockChange?: (locked: boolean) => void;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', e => {
      if (e.repeat) return;
      const k = this.key(e);
      if (['Tab', 'Space', 'AltLeft', 'ControlLeft', 'F1', 'KeyF'].includes(k) && this.locked) e.preventDefault();
      if (k === 'F1') e.preventDefault();
      this.down.add(k); this.pressedQ.add(k);
    });
    window.addEventListener('keyup', e => { const k = this.key(e); this.down.delete(k); this.releasedQ.add(k); });
    window.addEventListener('mousedown', e => {
      if (!this.locked) return;
      const k = 'Mouse' + e.button; this.down.add(k); this.pressedQ.add(k);
    });
    window.addEventListener('mouseup', e => { const k = 'Mouse' + e.button; if (this.down.delete(k)) this.releasedQ.add(k); });
    window.addEventListener('contextmenu', e => { if (this.locked) e.preventDefault(); });
    window.addEventListener('mousemove', e => {
      if (!this.locked) return;
      // clamp absurd deltas some browsers emit on lock/unlock
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX; this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', e => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.reset();
      this.onLockChange?.(this.locked);
    });
    window.addEventListener('blur', () => this.reset());
  }

  private key(e: KeyboardEvent) { return e.code || e.key; }

  requestLock() {
    const p = (this.el as any).requestPointerLock?.({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') p.catch(() => (this.el as any).requestPointerLock?.());
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  /** Clear all held state — used on blur / lock loss so nothing sticks. */
  reset() {
    for (const k of this.down) this.releasedQ.add(k);
    this.down.clear(); this.pressedQ.clear();
    this.mouseDX = this.mouseDY = this.wheel = 0;
  }

  isDown(k: string) { return this.down.has(k); }
  /** Pressed since last `endStep`. */
  pressed(k: string) { return this.pressedQ.has(k); }
  released(k: string) { return this.releasedQ.has(k); }
  endStep() { this.pressedQ.clear(); this.releasedQ.clear(); }

  consumeMouse() {
    const dx = this.mouseDX * this.sensitivity, dy = this.mouseDY * this.sensitivity;
    this.mouseDX = this.mouseDY = 0;
    return { dx, dy };
  }
  consumeWheel() { const w = this.wheel; this.wheel = 0; return w; }
}
