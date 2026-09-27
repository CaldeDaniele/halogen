import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DamageTally, hpBarAlpha, pickAssistTarget } from '../src/game/feedback';

describe('DamageTally (floating damage numbers)', () => {
  it('merges rapid hits on the same enemy into one growing number', () => {
    const t = new DamageTally(0.45, 0.9);
    const a = t.add(1, 24, 0);
    const b = t.add(1, 24, 0.2);
    expect(b).toBe(a);
    expect(a.total).toBe(48);
    expect(t.update(0.3)).toHaveLength(1);
  });

  it('starts a new number after the merge window or on a different enemy', () => {
    const t = new DamageTally(0.45, 0.9);
    const a = t.add(1, 10, 0);
    const b = t.add(1, 10, 0.6);
    const c = t.add(2, 10, 0.6);
    expect(b).not.toBe(a);
    expect(c).not.toBe(b);
    expect(t.update(0.6)).toHaveLength(3);
  });

  it('remembers headshots and kills on the entry', () => {
    const t = new DamageTally();
    const e = t.add(3, 60, 0, true);
    t.kill(3, 0.1);
    expect(e.head).toBe(true);
    expect(e.kill).toBe(true);
    // a kill closes the entry: later damage on the corpse key starts fresh
    expect(t.add(3, 5, 0.15)).not.toBe(e);
  });

  it('expires entries once their life has passed since the last hit', () => {
    const t = new DamageTally(0.45, 0.9);
    t.add(1, 10, 0);
    t.add(1, 10, 0.4);
    expect(t.update(1.2)).toHaveLength(1);
    expect(t.update(1.31)).toHaveLength(0);
  });
});

describe('hpBarAlpha', () => {
  it('is fully visible while recently hit, then fades to zero', () => {
    expect(hpBarAlpha(0)).toBe(1);
    expect(hpBarAlpha(1.9)).toBe(1);
    expect(hpBarAlpha(2.2)).toBeCloseTo(0.5, 5);
    expect(hpBarAlpha(2.4)).toBe(0);
    expect(hpBarAlpha(99)).toBe(0);
  });
});

describe('pickAssistTarget (kinetic throw aim assist)', () => {
  const eye = new THREE.Vector3(0, 1.6, 0);
  const fwd = new THREE.Vector3(0, 0, -1);
  const cone = THREE.MathUtils.degToRad(10);

  it('picks the candidate closest to the crosshair inside the cone', () => {
    const cands = [
      { pos: new THREE.Vector3(1.2, 1.6, -10) }, // ~6.8°
      { pos: new THREE.Vector3(0.4, 1.6, -10) }, // ~2.3°
      { pos: new THREE.Vector3(-0.8, 1.6, -10) }, // ~4.6°
    ];
    expect(pickAssistTarget(eye, fwd, cands, cone, 40)).toBe(1);
  });

  it('ignores candidates outside the cone, behind, or beyond range', () => {
    const cands = [
      { pos: new THREE.Vector3(5, 1.6, -10) },   // ~26°
      { pos: new THREE.Vector3(0, 1.6, 10) },    // behind
      { pos: new THREE.Vector3(0.2, 1.6, -60) }, // too far
    ];
    expect(pickAssistTarget(eye, fwd, cands, cone, 40)).toBe(-1);
  });
});
