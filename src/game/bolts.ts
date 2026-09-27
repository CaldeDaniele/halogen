import * as THREE from 'three';
import type { Ctx, Owner } from './types';
import { G, groups } from '../physics/world';
import type { Android } from './enemies/android';

interface Bolt { pos: THREE.Vector3; vel: THREE.Vector3; dmg: number; color: number; mesh: THREE.Mesh; light: any; life: number; friendly: boolean }

const geo = new THREE.BoxGeometry(1, 1, 1);
const STATIC_FILTER = groups(0xffff, G.STATIC | G.PROP | G.FIXTURE);

/** Visible, dodgeable enemy projectiles (and friendly ones fired by puppeteered androids). */
export class Bolts {
  list: Bolt[] = [];
  private mats = new Map<number, THREE.MeshBasicMaterial>();
  constructor(private ctx: Ctx, private enemies: () => Android[]) {}

  fire(origin: THREE.Vector3, dir: THREE.Vector3, dmg: number, color: number, speed: number, friendly = false) {
    let m = this.mats.get(color);
    if (!m) { m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }); this.mats.set(color, m); }
    const mesh = new THREE.Mesh(geo, m);
    mesh.scale.set(0.07, 0.07, 1.1);
    this.ctx.scene.add(mesh);
    const light = this.list.length < 24 ? this.ctx.lights.add({ pos: origin, color: new THREE.Color(color), intensity: 5, radius: 3.5 }) : null;
    this.list.push({ pos: origin.clone(), vel: dir.clone().multiplyScalar(speed), dmg, color, mesh, light, life: 3, friendly });
    this.ctx.lights.flash(origin, color, 8, 4, 0.06);
    this.ctx.sfx.play('enemyShot', { pos: origin });
  }

  update(dt: number) {
    const ctx = this.ctx;
    const pp = ctx.player.pos;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      b.life -= dt;
      const step = b.vel.clone().multiplyScalar(dt);
      const len = step.length();
      const dir = step.clone().divideScalar(len || 1);
      let dead = b.life <= 0;
      // player capsule test (segment vs vertical segment, approximate)
      if (!b.friendly && !dead) {
        const closest = this.closestOnSeg(b.pos, b.pos.clone().add(step), pp);
        const dy = Math.max(0, Math.abs(closest.y - pp.y) - 0.5);
        if (Math.hypot(closest.x - pp.x, dy, closest.z - pp.z) < 0.5) { ctx.game.damagePlayer(b.dmg, b.pos); dead = true; }
      }
      if (b.friendly && !dead) {
        for (const e of this.enemies()) {
          if (!e.alive) continue;
          if (e.center.distanceTo(b.pos) < 0.9 * e.stats.scale) {
            e.hit({ point: b.pos.clone(), normal: dir.clone().negate(), dir, damage: b.dmg * 2, impulse: 6, source: 'player', weapon: 'puppet' }, e.body.root);
            dead = true; break;
          }
        }
      }
      if (!dead) {
        const hit = ctx.phys.ray(b.pos.x, b.pos.y, b.pos.z, dir.x, dir.y, dir.z, len, STATIC_FILTER);
        if (hit) {
          const owner = ctx.phys.ownerOf(hit.collider.handle) as Owner | undefined;
          owner?.hit?.({ point: new THREE.Vector3(hit.x, hit.y, hit.z), normal: new THREE.Vector3(hit.nx, hit.ny, hit.nz), dir, damage: b.dmg, impulse: 2, source: 'enemy' });
          ctx.particles.sparksAt(new THREE.Vector3(hit.x, hit.y, hit.z), new THREE.Vector3(hit.nx, hit.ny, hit.nz), 8, b.color, 6, 0.8, 0.3);
          ctx.decals.add(new THREE.Vector3(hit.x, hit.y, hit.z), new THREE.Vector3(hit.nx, hit.ny, hit.nz), 0.18, b.color, 1);
          dead = true;
        }
      }
      if (dead) { this.kill(i); continue; }
      b.pos.add(step);
      b.mesh.position.copy(b.pos);
      b.mesh.lookAt(b.pos.clone().add(dir));
      if (b.light) b.light.pos.copy(b.pos);
    }
  }

  private closestOnSeg(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3) {
    const ab = b.clone().sub(a);
    const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6)));
    return a.clone().addScaledVector(ab, t);
  }

  private kill(i: number) {
    const b = this.list[i];
    b.mesh.removeFromParent();
    if (b.light) this.ctx.lights.remove(b.light);
    this.list.splice(i, 1);
  }
  clear() { for (let i = this.list.length - 1; i >= 0; i--) this.kill(i); }
}
