import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../src/physics/world';

let phys: PhysicsWorld;
beforeAll(async () => { phys = await PhysicsWorld.create(); });

function dynBox(x: number) {
  const b = phys.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 1, 0));
  phys.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), b);
  return b;
}

describe('physics queries', () => {
  it('documents the Rapier constraint: mutating a body inside intersectionsWithShape does not take effect', () => {
    const b = dynBox(0);
    phys.world.step();
    phys.world.intersectionsWithShape({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(3), col => {
      try { col.parent()!.applyImpulse({ x: 0, y: 50, z: 0 }, true); } catch { /* swallowed by rapier */ }
      return true;
    });
    // if this ever starts passing, Rapier lifted the restriction; overlapBall is still the safe path
    expect(b.linvel().y).toBeLessThan(1);
    phys.removeBody(b);
  });

  it('overlapBall collects colliders so callers can mutate bodies afterwards', () => {
    const b = dynBox(0);
    phys.world.step();
    const hits = phys.overlapBall({ x: 0, y: 1, z: 0 }, 3);
    expect(hits.length).toBeGreaterThan(0);
    for (const c of hits) c.parent()!.applyImpulse({ x: 0, y: 50, z: 0 }, true);
    expect(b.linvel().y).toBeGreaterThan(1);
    phys.removeBody(b);
  });

  it('bodyAlive reports removed bodies so stale references can be pruned', () => {
    const b = dynBox(5);
    expect(phys.bodyAlive(b)).toBe(true);
    phys.removeBody(b);
    expect(phys.bodyAlive(b)).toBe(false);
  });
});

describe('kinetic hand vs removed bodies', () => {
  it('prunes held bodies that were removed elsewhere instead of touching them', async () => {
    const THREE = await import('three');
    const { KineticHand } = await import('../src/game/player/kinetic');
    const ctx: any = {
      scene: { add() {} }, phys, lights: { add: () => ({ pos: new THREE.Vector3() }), remove() {} },
      sfx: { play() {}, hum: () => ({ set() {}, stop() {} }) }, run: { lumen: 100, mods: { multiGrab: 1, throwMul: 1 } },
      camera: new THREE.PerspectiveCamera(), time: { simTime: 0 }, particles: { sparksAt() {} }, rig: { fovKick: 0, addTrauma() {}, recoilPitch: { kick() {} } },
      events: { emit() {} }, hud: { toast() {} }, player: { collider: undefined },
    };
    const hand = new KineticHand(ctx);
    const b = dynBox(9);
    hand.held.push({ body: b, mass: 10, prevGroups: [], offset: 0 } as any);
    phys.removeBody(b); // e.g. a held crate got shot and fractured, or debris was evicted
    const input: any = { pressed: () => false, released: () => false, isDown: (k: string) => k === 'Mouse2' };
    expect(() => hand.update(1 / 120, input)).not.toThrow();
    expect(hand.held.length).toBe(0);
    expect(() => phys.world.step()).not.toThrow();
  });
});
