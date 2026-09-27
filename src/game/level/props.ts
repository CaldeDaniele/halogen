import * as THREE from 'three';
import { RAPIER, G, groups, ALL } from '../../physics/world';
import type { Ctx, HitInfo, Owner } from '../types';
import type { PropSpec } from './generator';
import { worldBox } from '../../render/materials';
import { fractureBox } from '../../physics/fracture';
import { explode } from '../combat';
import { Budget } from '../../core/budget';
import type { Part, PartInstancer } from '../../render/instancer';

export interface Debris { mesh: THREE.Mesh; body: RAPIER.RigidBody; t: number; settledT: number; part?: Part; scale?: THREE.Vector3 }

/** Box chunks are drawn as a unit box scaled per instance: every size shares one batch (UVs are 0..1 per face either way). */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const _dm = new THREE.Matrix4(), _dp = new THREE.Vector3(), _dq = new THREE.Quaternion();

const barrelGeo = new THREE.CylinderGeometry(0.45, 0.45, 1.1, 16);
const bandGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.12, 16);

/** Keeps the debris budget and sim cheap: debris stops colliding with debris after 2 s. */
export class DebrisSystem {
  readonly budget: Budget<Debris>;
  constructor(private ctx: Ctx, cap = 200) {
    this.budget = new Budget<Debris>(cap, d => this.kill(d));
  }
  spawn(mesh: THREE.Mesh, pos: THREE.Vector3, q: THREE.Quaternion, half: [number, number, number], vel: THREE.Vector3, density = 900) {
    const w = this.ctx.phys.world;
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinvel(vel.x, vel.y, vel.z).setAngvel({ x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 8 }).setLinearDamping(0.05).setAngularDamping(0.3));
    const col = w.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(0.03, half[0]), Math.max(0.03, half[1]), Math.max(0.03, half[2])).setDensity(density).setFriction(0.9)
      .setCollisionGroups(groups(G.DEBRIS, ALL & ~G.PLAYER)), body);
    this.ctx.phys.tag(col, { kind: 'debris', surface: 'concrete' });
    const d: Debris = { mesh, body, t: 0, settledT: 0 };
    const inst: PartInstancer | undefined = this.ctx.game?.instancer;
    if (inst && !Array.isArray(mesh.material)) {
      const box = mesh.geometry.type === 'BoxGeometry' ? (mesh.geometry as THREE.BoxGeometry).parameters : null;
      const unit = !!box && box.widthSegments === 1 && box.heightSegments === 1 && box.depthSegments === 1;
      d.scale = unit ? new THREE.Vector3(box!.width, box!.height, box!.depth) : new THREE.Vector3(1, 1, 1);
      d.part = inst.add(unit ? UNIT_BOX : mesh.geometry, mesh.material, true);
      d.part.setMatrix(_dm.compose(pos, q, d.scale));
    } else {
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.ctx.scene.add(mesh);
    }
    this.budget.add(d);
    return d;
  }
  update(dt: number) {
    for (const d of this.budget.items) {
      d.t += dt;
      const t = d.body.translation(), r = d.body.rotation();
      if (d.part) d.part.setMatrix(_dm.compose(_dp.set(t.x, t.y, t.z), _dq.set(r.x, r.y, r.z, r.w), d.scale!));
      else { d.mesh.position.set(t.x, t.y, t.z); d.mesh.quaternion.set(r.x, r.y, r.z, r.w); }
      if (d.t > 2 && d.t - dt <= 2) d.body.collider(0).setCollisionGroups(groups(G.DEBRIS, ALL & ~G.PLAYER & ~G.DEBRIS));
      if (t.y < -20) this.remove(d);
    }
  }
  remove(d: Debris) { this.budget.remove(d); this.kill(d); }
  private kill(d: Debris) {
    this.ctx.game?.kinetic?.forgetBody(d.body);
    this.ctx.phys.removeBody(d.body);
    if (d.part) { this.ctx.game.instancer!.remove(d.part); return; } // chunk geometry was never uploaded; shared ones must survive
    d.mesh.removeFromParent();
    d.mesh.geometry.dispose();
  }
  clear() { for (const d of [...this.budget.items]) this.remove(d); }
}

/** Dynamic crates, explosive barrels, fixed destructible barriers and columns. */
export class Prop {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  hp: number;
  dead = false;
  light?: any;
  private half: [number, number, number];
  owner: Owner;

  constructor(private ctx: Ctx, readonly spec: PropSpec, parent: THREE.Object3D, private debris: DebrisSystem, private onDestroy: (p: Prop) => void) {
    const w = ctx.phys.world, m = ctx.mats;
    const s = spec.size;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.rotY);
    let desc: RAPIER.RigidBodyDesc, cd: RAPIER.ColliderDesc;
    this.owner = { kind: 'prop', prop: this, surface: 'metal', hit: (h: HitInfo) => this.hit(h) };
    if (spec.kind === 'crate') {
      this.half = [s / 2, s / 2, s / 2];
      this.mesh = new THREE.Mesh(worldBox(s, s, s, 1.2), Math.random() < 0.5 ? m.get('panel') : m.get('metal'));
      desc = RAPIER.RigidBodyDesc.dynamic(); cd = RAPIER.ColliderDesc.cuboid(s / 2, s / 2, s / 2).setDensity(55);
      this.hp = 70;
    } else if (spec.kind === 'barrel') {
      this.half = [0.45, 0.55, 0.45];
      const g = new THREE.Group();
      const body = new THREE.Mesh(barrelGeo, m.get('panel')); g.add(body);
      const band = new THREE.Mesh(bandGeo, m.neon(0xff3b1a, 6)); band.position.y = 0.18; g.add(band);
      const band2 = new THREE.Mesh(bandGeo, m.neon(0xff3b1a, 6)); band2.position.y = -0.18; g.add(band2);
      this.mesh = g;
      desc = RAPIER.RigidBodyDesc.dynamic(); cd = RAPIER.ColliderDesc.cylinder(0.55, 0.45).setDensity(90);
      this.hp = 18;
      this.owner.surface = 'metal';
      this.light = ctx.lights.add({ pos: new THREE.Vector3(spec.x, spec.y, spec.z), color: new THREE.Color(0xff3b1a), intensity: 3, radius: 3.5, flicker: 0.2 });
    } else if (spec.kind === 'barrier') {
      this.half = [s / 2, 0.6, 0.3];
      this.mesh = new THREE.Mesh(worldBox(s, 1.2, 0.6, 1.6), m.get('wall'));
      desc = RAPIER.RigidBodyDesc.fixed(); cd = RAPIER.ColliderDesc.cuboid(s / 2, 0.6, 0.3);
      this.hp = 140; this.owner.surface = 'concrete';
    } else {
      this.half = [s / 2, 1.6, s / 2];
      this.mesh = new THREE.Mesh(worldBox(s, 3.2, s, 1.6), m.get('wall'));
      desc = RAPIER.RigidBodyDesc.fixed(); cd = RAPIER.ColliderDesc.cuboid(s / 2, 1.6, s / 2);
      this.hp = 180; this.owner.surface = 'concrete';
    }
    this.mesh.traverse(o => { o.castShadow = true; o.receiveShadow = true; });
    this.body = w.createRigidBody(desc.setTranslation(spec.x, spec.y, spec.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
    const col = w.createCollider(cd.setFriction(0.7).setCollisionGroups(groups(G.PROP, ALL)).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(60), this.body);
    ctx.phys.tag(col, this.owner);
    parent.add(this.mesh);
    this.sync();
  }

  get isDynamic() { return this.body.isDynamic(); }
  get position() { const t = this.body.translation(); return new THREE.Vector3(t.x, t.y, t.z); }

  hit(h: HitInfo) {
    if (this.dead) return;
    if (this.body.isDynamic() && h.impulse > 0) this.body.applyImpulseAtPoint({ x: h.dir.x * h.impulse * 2, y: h.dir.y * h.impulse * 2 + h.impulse * 0.3, z: h.dir.z * h.impulse * 2 }, h.point, true);
    this.hp -= h.damage;
    if (this.hp <= 0) this.destroy(h);
  }

  destroy(h?: HitInfo) {
    if (this.dead) return;
    this.dead = true;
    const ctx = this.ctx;
    const pos = this.position;
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const lv = this.body.linvel();
    if (this.spec.kind === 'barrel') {
      ctx.game?.kinetic?.forgetBody(this.body); ctx.phys.removeBody(this.body);
      this.mesh.removeFromParent();
      if (this.light) ctx.lights.remove(this.light);
      // slight delay makes chain reactions read as a cascade
      ctx.game.later(0.07, () => explode(ctx, pos, 5.5, 110, 30, 'explosion', 0xff5a1a));
    } else {
      const n = this.spec.kind === 'crate' ? 6 : this.spec.kind === 'barrier' ? 10 : 14;
      const chunks = fractureBox(this.half, n, (Math.random() * 1e9) | 0);
      const mat = this.spec.kind === 'crate' ? (this.mesh as THREE.Mesh).material as THREE.Material : ctx.mats.get('chunk');
      const dir = h?.dir ?? new THREE.Vector3(0, 1, 0);
      const force = Math.min(12, (h?.impulse ?? 8) * 0.4 + 3);
      ctx.game?.kinetic?.forgetBody(this.body); ctx.phys.removeBody(this.body);
      this.mesh.removeFromParent();
      for (const c of chunks) {
        const lp = new THREE.Vector3(...c.center).applyQuaternion(q).add(pos);
        const out = lp.clone().sub(pos).normalize();
        const v = new THREE.Vector3(lv.x, lv.y, lv.z).addScaledVector(dir, force * (0.5 + Math.random())).addScaledVector(out, 2 + Math.random() * 2);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(c.half[0] * 2, c.half[1] * 2, c.half[2] * 2), mat);
        this.debris.spawn(mesh, lp, q, c.half, v, this.spec.kind === 'crate' ? 200 : 900);
      }
      ctx.particles.smokeAt(pos, 12, 0x77736d, 1.1, 2.2, 0.8, 2.5);
      ctx.particles.shardsAt(pos, dir, 20, 0x55524e, 5, 0.04, 1.8);
      ctx.sfx.play(this.spec.kind === 'crate' ? 'impactMetal' : 'explosion', { pos, gain: 0.6 });
      ctx.rig.addTrauma(0.15);
    }
    this.onDestroy(this);
  }

  sync() {
    if (this.dead) return;
    const t = this.body.translation(), r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z); this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    if (this.light) this.light.pos.set(t.x, t.y + 0.2, t.z);
    if (t.y < -20 && !this.dead) { this.dead = true; this.ctx.game?.kinetic?.forgetBody(this.body); this.ctx.phys.removeBody(this.body); this.mesh.removeFromParent(); if (this.light) this.ctx.lights.remove(this.light); }
  }

  dispose() {
    if (!this.dead) { this.ctx.game?.kinetic?.forgetBody(this.body); this.ctx.phys.removeBody(this.body); this.mesh.removeFromParent(); }
    if (this.light) this.ctx.lights.remove(this.light);
  }
}
