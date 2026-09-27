import * as THREE from 'three';
import { RAPIER, G, groups } from '../physics/world';
import type { Ctx, HitInfo, Owner } from './types';

export const SHOT_FILTER = groups(0xffff, G.STATIC | G.ENEMY | G.RAGDOLL | G.PROP | G.DEBRIS | G.FIXTURE);
export const ENEMY_SHOT_FILTER = groups(0xffff, G.STATIC | G.PLAYER | G.PROP | G.FIXTURE);

const SURF_SFX: Record<string, string> = { concrete: 'impactConcrete', metal: 'impactMetal', glass: 'glass', android: 'impactAndroid' };

export function surfaceImpact(ctx: Ctx, p: THREE.Vector3, n: THREE.Vector3, surface: string, color: THREE.ColorRepresentation, heavy = false, decal = true) {
  const sp = ctx.particles;
  if (surface === 'android') {
    sp.sparksAt(p, n, heavy ? 22 : 10, 0xffd28a, 9, 0.9, 0.4);
    sp.smokeAt(p, 1, 0x223038, 0.25, 0.6);
  } else if (surface === 'metal') {
    sp.sparksAt(p, n, heavy ? 26 : 12, 0xffb25a, 10, 0.7, 0.5);
  } else {
    sp.sparksAt(p, n, heavy ? 10 : 4, 0xffa050, 6, 0.8, 0.3);
    sp.smokeAt(p, heavy ? 5 : 2, 0x6c6a66, heavy ? 0.7 : 0.35, 0.9, 0.3, 0.8);
    sp.shardsAt(p, n, heavy ? 8 : 3, 0x3a3a38, 3, 0.02, 1.2);
  }
  sp.glowAt(p.clone().addScaledVector(n, 0.05), color, heavy ? 0.9 : 0.35, 0.08);
  if (decal && surface !== 'android') ctx.decals.add(p, n, heavy ? 0.5 : 0.12 + Math.random() * 0.05, 0xff7a20, heavy ? 1 : 0.8);
  ctx.sfx.play(SURF_SFX[surface] ?? 'impactConcrete', { pos: p, gain: heavy ? 1.3 : 1 });
}

/** Route a hit to whatever owns the collider. Returns the owner. */
export function dealHit(ctx: Ctx, collider: RAPIER.Collider, h: HitInfo): Owner | undefined {
  const owner = ctx.phys.ownerOf(collider.handle) as Owner | undefined;
  h.collider = collider;
  if (owner?.hit) owner.hit(h);
  else {
    const body = collider.parent();
    if (body && body.isDynamic() && h.impulse > 0) {
      body.applyImpulseAtPoint({ x: h.dir.x * h.impulse, y: h.dir.y * h.impulse, z: h.dir.z * h.impulse }, h.point, true);
    }
  }
  return owner;
}

const _v = new THREE.Vector3();

export function explode(ctx: Ctx, pos: THREE.Vector3, radius: number, damage: number, impulse: number, source: HitInfo['source'], color: THREE.ColorRepresentation = 0xb46bff, tags?: Set<string>) {
  const hitBodies = new Set<number>();
  const hitOwners = new Set<Owner>();
  // collect first, act after: Rapier forbids body mutation inside the query callback
  for (const col of ctx.phys.overlapBall(pos, radius)) {
    if (!ctx.phys.colliderAlive(col)) continue; // removed by an earlier hit this blast (slot may be reused)
    const t = col.translation();
    _v.set(t.x - pos.x, t.y - pos.y, t.z - pos.z);
    const d = Math.max(0.3, _v.length());
    const fall = Math.max(0, 1 - d / radius);
    const dir = _v.clone().normalize().add(new THREE.Vector3(0, 0.45, 0)).normalize();
    const owner = ctx.phys.ownerOf(col.handle) as Owner | undefined;
    if (owner?.kind === 'player') {
      if (source !== 'player') ctx.game.damagePlayer(damage * fall * 0.6, pos);
      else ctx.game.selfBlast(dir, impulse * fall * 0.5);
      continue;
    }
    // one hit per entity (an android has many segment colliders)
    const key = owner?.android ?? owner;
    if (owner?.hit && key && !hitOwners.has(key)) {
      hitOwners.add(key);
      owner.hit({ point: new THREE.Vector3(t.x, t.y, t.z), normal: dir.clone().negate(), dir, damage: damage * (0.35 + 0.65 * fall), impulse: impulse * fall, source, weapon: 'explosion', collider: col, tags });
    }
    const body = ctx.phys.colliderAlive(col) ? col.parent() : null;
    if (body && ctx.phys.bodyAlive(body) && body.isDynamic() && !hitBodies.has(body.handle)) {
      hitBodies.add(body.handle);
      // mass-proportional up to 60 kg: similar Δv for limbs, crates and barrels — explosions should launch things
      const k = impulse * fall * Math.min(body.mass(), 60) * 0.22;
      body.applyImpulseAtPoint({ x: dir.x * k, y: dir.y * k, z: dir.z * k }, { x: t.x, y: t.y, z: t.z }, true);
    }
  }
  const sp = ctx.particles;
  sp.sparksAt(pos, new THREE.Vector3(0, 1, 0), 60, 0xffc080, 16, 1.4, 0.8);
  sp.sparksAt(pos, new THREE.Vector3(0, 1, 0), 30, color, 12, 1.4, 0.6);
  sp.smokeAt(pos, 16, 0x2a2628, 1.4, 2.2, 1.5, 3);
  sp.glowAt(pos, color, radius * 1.6, 0.25);
  sp.glowAt(pos, 0xffe0b0, radius * 0.8, 0.12);
  ctx.lights.flash(pos, color, 40, radius * 2.2, 0.35);
  ctx.decals.add(new THREE.Vector3(pos.x, ctx.particles.floorY + 0.005, pos.z), new THREE.Vector3(0, 1, 0), radius * 0.9, color, 1.5);
  ctx.sfx.play('explosion', { pos });
  const dist = ctx.camera.position.distanceTo(pos);
  ctx.rig.addTrauma(Math.max(0, 0.9 - dist / 30));
  ctx.renderer.caPulse = Math.min(1, ctx.renderer.caPulse + 0.5);
  ctx.time.hitstop(dist < 12 ? 45 : 20);
  ctx.events.emit('explosion', { pos, radius });
}
