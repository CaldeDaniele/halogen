import * as THREE from 'three';
import { RAPIER, G, groups } from '../../physics/world';
import type { Ctx, Owner } from '../types';
import { Input } from '../../core/input';
import type { Android } from '../enemies/android';
import { pickAssistTarget } from '../feedback';

const GRAB_FILTER = groups(0xffff, G.PROP | G.RAGDOLL | G.DEBRIS | G.ENEMY);
const COST_GRAB = 8, COST_ALIVE = 18, DRAIN = 6;
const ASSIST_CONE = THREE.MathUtils.degToRad(10), ASSIST_RANGE = 40;

interface Held { body: RAPIER.RigidBody; android?: Android; mass: number; prevGroups: number[]; offset: number }

/**
 * Off-hand force manipulator. Hold RMB to yank the object under the crosshair to a point in
 * front of you (spring-damper, mass-aware so heavy things lag and swing), release to launch.
 */
export class KineticHand {
  held: Held[] = [];
  /** body handle → time thrown (for impact damage) */
  readonly thrown = new Map<number, { t: number; android?: Android; mass: number }>();
  /**
   * Velocity of each thrown body before this step's solve. Contact events arrive after the solver
   * has already stopped the body against a (kinematic) android, so impact speed is read from here.
   */
  readonly preVel = new Map<number, THREE.Vector3>();
  private hum: ReturnType<Ctx['sfx']['hum']> | null = null;
  private beam: THREE.Mesh;
  private handLight: any = null;
  strain = 0;
  private cool = 0;

  constructor(private ctx: Ctx) {
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.03, 1, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0x19f0ff).multiplyScalar(3), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.beam.visible = false;
    ctx.scene.add(this.beam);
  }

  get holding() { return this.held.length > 0; }

  /** Drop references to bodies removed elsewhere (fractured props, evicted debris, disposed limbs). */
  private prune() {
    const before = this.held.length;
    this.held = this.held.filter(h => this.ctx.phys.bodyAlive(h.body));
    if (before && !this.held.length) this.endHold();
  }

  /** Called by any system about to remove a body the hand might be holding. */
  forgetBody(body: RAPIER.RigidBody) {
    const h = this.held.find(x => x.body === body);
    if (!h) return;
    this.held.splice(this.held.indexOf(h), 1);
    this.thrown.delete(body.handle);
    if (!this.held.length) this.endHold();
  }

  update(dt: number, input: Input) {
    const ctx = this.ctx, run = ctx.run;
    this.cool = Math.max(0, this.cool - dt);
    for (const [h, v] of this.thrown) if (ctx.time.simTime - v.t > 2.5) this.thrown.delete(h);
    this.preVel.clear();
    for (const h of this.thrown.keys()) {
      const b = ctx.phys.world.getRigidBody(h);
      if (!b || !ctx.phys.bodyAlive(b)) continue;
      const v = b.linvel();
      this.preVel.set(h, new THREE.Vector3(v.x, v.y, v.z));
    }
    this.prune();

    if (input.pressed('Mouse2') && !this.holding && this.cool <= 0) this.tryGrab();
    if (this.holding) {
      run.lumen -= DRAIN * dt * this.held.length;
      if (run.lumen <= 0 || input.pressed('KeyF')) { run.lumen = Math.max(0, run.lumen); this.drop(); }
      else if (input.released('Mouse2') || !input.isDown('Mouse2')) this.throw();
      else this.hold(dt);
    }
  }

  private tryGrab() {
    const ctx = this.ctx, run = ctx.run;
    const cam = ctx.camera;
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const cands: { body: RAPIER.RigidBody; owner?: Owner; d: number }[] = [];
    // primary: shape cast along the aim for forgiveness
    const shape = new RAPIER.Ball(0.45);
    const hit = ctx.phys.world.castShape(eye, { x: 0, y: 0, z: 0, w: 1 }, fwd, shape, 0, 28, true, undefined, GRAB_FILTER, ctx.player.collider);
    const seen = new Set<number>();
    const consider = (col: RAPIER.Collider, d: number) => {
      const owner = ctx.phys.ownerOf(col.handle) as Owner | undefined;
      // severed limbs are free pieces; grabbing one never grabs the rest of the android
      const android: Android | undefined = owner?.severed ? undefined : owner?.android;
      if (android?.isBoss) return;
      const body = android ? (android.body.seg('torso') ?? android.body.root).body : col.parent();
      if (!body || seen.has(body.handle)) return;
      if (!android && !body.isDynamic()) return;
      seen.add(body.handle);
      cands.push({ body, owner, d });
    };
    if (hit) consider(hit.collider, hit.time_of_impact);
    if (run.mods.multiGrab > 1 && cands.length) {
      const c = cands[0];
      const p = c.body.translation();
      ctx.phys.world.intersectionsWithShape(p, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(4), col => { consider(col, 99); return cands.length < run.mods.multiGrab; }, undefined, GRAB_FILTER);
    }
    if (!cands.length) { ctx.sfx.play('kineticFail'); return; }
    const pick = cands.slice(0, run.mods.multiGrab);
    let cost = 0;
    for (const c of pick) cost += !c.owner?.severed && c.owner?.android?.state === 'alive' ? COST_ALIVE : COST_GRAB;
    if (run.lumen < cost) { ctx.sfx.play('kineticFail'); ctx.hud.toast('NOT ENOUGH LUMEN', '#ffb02e'); return; }
    run.lumen -= cost;
    pick.forEach((c, i) => {
      const android: Android | undefined = c.owner?.severed ? undefined : c.owner?.android;
      if (android) android.grab();
      const bodies = android ? android.body.segs.filter(s => !s.detached).map(s => s.body) : [c.body];
      let mass = 0;
      for (const b of bodies) mass += b.mass();
      const prev: number[] = [];
      for (const b of bodies) for (let k = 0; k < b.numColliders(); k++) { const col = b.collider(k); prev.push(col.collisionGroups()); }
      c.body.setGravityScale(0.15, true);
      c.body.setAngularDamping(4);
      c.body.wakeUp();
      this.held.push({ body: c.body, android, mass: Math.max(1, mass), prevGroups: prev, offset: i });
    });
    // the yank: snap everything toward the hand so a grab reads as a violent pull, not a float
    this.held.forEach((h, i) => {
      const t = h.body.translation(), hp = this.holdPoint(i);
      const v = new THREE.Vector3(hp.x - t.x, hp.y - t.y, hp.z - t.z);
      v.setLength(Math.min(14, v.length() * 6) / Math.sqrt(Math.max(1, h.mass / 20)));
      const bodies = h.android ? h.android.body.segs.filter(s => !s.detached).map(s => s.body) : [h.body];
      for (const b of bodies) b.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
      const p = new THREE.Vector3(t.x, t.y, t.z);
      ctx.particles.sparksAt(p, v.clone().normalize(), 24, 0x19f0ff, 8, 0.9, 0.5);
      ctx.particles.glowAt(p, 0x19f0ff, 1.1, 0.12);
    });
    ctx.time.hitstop(35);
    ctx.sfx.play('grab');
    this.hum = ctx.sfx.hum();
    ctx.rig.addTrauma(0.12);
    ctx.rig.fovKick += 3;
  }

  private holdPoint(i: number) {
    const cam = this.ctx.camera;
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const h = this.held[i];
    const dist = 2.4 + Math.min(1.5, h.mass / 60);
    return eye.addScaledVector(fwd, dist).addScaledVector(right, (i - (this.held.length - 1) / 2) * 1.2).add(new THREE.Vector3(0, -0.2, 0));
  }

  private hold(dt: number) {
    const ctx = this.ctx;
    let strain = 0;
    this.held.forEach((h, i) => {
      const target = this.holdPoint(i);
      const t = h.body.translation(), v = h.body.linvel();
      const m = h.body.mass();
      const k = 140, c = 2 * Math.sqrt(k) * 0.9;
      const ex = target.x - t.x, ey = target.y - t.y, ez = target.z - t.z;
      const err = Math.hypot(ex, ey, ez);
      strain = Math.max(strain, Math.min(1, err / 2));
      // acceleration-based spring; heavy objects are force-limited so they lag
      let ax = k * ex - c * v.x, ay = k * ey - c * v.y, az = k * ez - c * v.z;
      const maxA = 900 / Math.sqrt(Math.max(1, h.mass / 8));
      const al = Math.hypot(ax, ay, az);
      if (al > maxA) { ax *= maxA / al; ay *= maxA / al; az *= maxA / al; }
      h.body.applyImpulse({ x: ax * m * dt, y: ay * m * dt, z: az * m * dt }, true);
      if (err > 9) this.dropOne(h);
    });
    this.strain = strain;
    this.hum?.set(this.held[0]?.mass ?? 10, strain);
    // beam from hand to first held object
    const h0 = this.held[0];
    if (h0) {
      const cam = ctx.camera;
      const hand = new THREE.Vector3(-0.25, -0.25, -0.5).applyMatrix4(cam.matrixWorld);
      const p = h0.body.translation();
      const tp = new THREE.Vector3(p.x, p.y, p.z);
      const len = hand.distanceTo(tp);
      this.beam.visible = true;
      this.beam.position.copy(hand).add(tp).multiplyScalar(0.5);
      const w = 1.8 + strain * 2.5 + Math.random() * 0.5; // crackle
      this.beam.scale.set(w, len, w);
      this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tp.clone().sub(hand).normalize());
      if (!this.handLight) this.handLight = ctx.lights.add({ pos: tp, color: new THREE.Color(0x19f0ff), intensity: 7, radius: 5 });
      this.handLight.pos.copy(tp);
      if (Math.random() < 0.4) ctx.particles.sparksAt(tp, new THREE.Vector3(0, 1, 0), 1, 0x19f0ff, 2, 1, 0.3);
    }
  }

  private restore(h: Held) {
    if (!this.ctx.phys.bodyAlive(h.body)) return;
    h.body.setGravityScale(1, true);
    h.body.setAngularDamping(h.android ? 0.6 : 0.2);
  }

  private dropOne(h: Held) {
    this.restore(h);
    h.android?.release();
    this.held.splice(this.held.indexOf(h), 1);
    if (!this.held.length) this.endHold();
  }

  drop() { this.prune(); for (const h of [...this.held]) this.dropOne(h); }

  private throw() {
    this.prune();
    const ctx = this.ctx;
    const cam = ctx.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    // aim assist: an android within a small cone of the crosshair wins (led by its velocity);
    // otherwise throw toward whatever is under the crosshair
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const heldAndroids = new Set(this.held.map(h => h.android));
    const los = (e: Android) => { const c = e.center, d = c.clone().sub(eye), L = d.length(); d.divideScalar(L); return !ctx.phys.ray(eye.x, eye.y, eye.z, d.x, d.y, d.z, L - 0.3, groups(0xffff, G.STATIC)); };
    const cands: Android[] = (ctx.game?.enemies ?? []).filter((e: Android) => e.alive && !heldAndroids.has(e) && (e.visibility ?? 1) > 0.5 && los(e));
    const ti = pickAssistTarget(eye, fwd, cands.map(e => ({ pos: e.center })), ASSIST_CONE, ASSIST_RANGE);
    const assist = ti >= 0 ? cands[ti] : undefined;
    let totalMass = 0;
    for (const h of this.held) {
      const t = h.body.translation();
      const speed = THREE.MathUtils.clamp(40 / Math.sqrt(h.mass / 12), 20, 44) * ctx.run.mods.throwMul;
      let dir: THREE.Vector3;
      if (assist) {
        const aim = assist.center;
        const flight = aim.distanceTo(new THREE.Vector3(t.x, t.y, t.z)) / speed;
        if (assist.state === 'alive') aim.addScaledVector(assist.vel, flight); // vel is stale while ragdolled
        dir = new THREE.Vector3(aim.x - t.x, aim.y - t.y, aim.z - t.z).normalize();
      } else {
        const aimHit = ctx.phys.ray(eye.x, eye.y, eye.z, fwd.x, fwd.y, fwd.z, 80, groups(0xffff, G.STATIC | G.ENEMY), h.body, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
        dir = aimHit ? new THREE.Vector3(aimHit.x - t.x, aimHit.y - t.y, aimHit.z - t.z).normalize() : fwd.clone();
      }
      const v = dir.multiplyScalar(speed);
      if (h.android) { for (const s of h.android.body.segs) if (!s.detached) s.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true); }
      else h.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
      h.body.setAngvel({ x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 10, z: (Math.random() - 0.5) * 10 }, true);
      this.restore(h);
      const rec = { t: ctx.time.simTime, android: h.android, mass: h.mass };
      if (h.android) for (const s of h.android.body.segs) this.thrown.set(s.body.handle, rec);
      else this.thrown.set(h.body.handle, rec);
      h.android?.release();
      totalMass += h.mass;
    }
    ctx.sfx.play('throw');
    const hand = new THREE.Vector3(-0.25, -0.25, -0.8).applyMatrix4(cam.matrixWorld);
    ctx.particles.sparksAt(hand, fwd, 30, 0x19f0ff, 14, 0.6, 0.35);
    ctx.particles.glowAt(hand, 0x19f0ff, 0.9, 0.1);
    ctx.lights.flash(hand, 0x19f0ff, 18, 5, 0.12);
    ctx.time.hitstop(40);
    ctx.rig.addTrauma(0.3); ctx.rig.fovKick += 7;
    ctx.rig.recoilPitch.kick(0.7);
    ctx.events.emit('kineticThrow', { mass: totalMass });
    this.held = [];
    this.endHold();
    this.cool = 0.25;
  }

  private endHold() {
    this.hum?.stop(); this.hum = null;
    this.beam.visible = false;
    if (this.handLight) { this.ctx.lights.remove(this.handLight); this.handLight = null; }
    this.strain = 0;
  }

  /** Called when an android dies/despawns so we don't keep a dangling reference. */
  forget(android: Android) {
    for (const h of [...this.held]) if (h.android === android) this.dropOne(h);
  }
}
