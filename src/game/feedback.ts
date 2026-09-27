import * as THREE from 'three';

/** Pure combat-feedback logic (damage numbers, HP bar fade, throw aim assist). No DOM, no physics. */

export interface TallyEntry { key: number; total: number; head: boolean; kill: boolean; born: number; last: number }

/**
 * Rapid hits on one enemy merge into a single growing number (a scattergun blast reads as "120",
 * not ten "12"s). An entry closes on kill or once the merge window passes without a new hit.
 */
export class DamageTally {
  private entries: TallyEntry[] = [];
  constructor(readonly mergeWindow = 0.45, readonly life = 0.9) {}

  add(key: number, dmg: number, now: number, head = false): TallyEntry {
    let e = this.open(key, now);
    if (!e) { e = { key, total: 0, head: false, kill: false, born: now, last: now }; this.entries.push(e); }
    e.total += dmg; e.last = now; e.head ||= head;
    return e;
  }

  kill(key: number, now: number) {
    const e = this.open(key, now);
    if (e) { e.kill = true; e.last = now; }
  }

  update(now: number): TallyEntry[] {
    this.entries = this.entries.filter(e => now - e.last <= this.life);
    return this.entries;
  }

  private open(key: number, now: number) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.key === key) return !e.kill && now - e.last < this.mergeWindow ? e : undefined;
    }
    return undefined;
  }
}

/** Enemy HP bar opacity: solid for `hold` seconds after the last hit, then a linear fade. */
export function hpBarAlpha(sinceHit: number, hold = 2, fade = 0.4) {
  if (sinceHit <= hold) return 1;
  const k = 1 - (sinceHit - hold) / fade;
  return k > 1e-6 ? k : 0;
}

const _d = new THREE.Vector3();

/** Index of the candidate nearest the crosshair within `cone` radians and `maxDist`, or -1. */
export function pickAssistTarget(eye: THREE.Vector3, fwd: THREE.Vector3, cands: { pos: THREE.Vector3 }[], cone: number, maxDist: number) {
  let best = -1, bestA = cone;
  cands.forEach((c, i) => {
    _d.copy(c.pos).sub(eye);
    const dist = _d.length();
    if (dist < 1e-3 || dist > maxDist) return;
    const a = Math.acos(THREE.MathUtils.clamp(_d.dot(fwd) / dist, -1, 1));
    if (a <= bestA) { bestA = a; best = i; }
  });
  return best;
}
