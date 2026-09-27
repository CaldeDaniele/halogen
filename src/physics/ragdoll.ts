import * as THREE from 'three';
import { RAPIER, PhysicsWorld, G, groups } from './world';
import type { SegDef } from '../game/enemies/defs';

export interface Seg {
  def: SegDef;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  group: THREE.Group;
  rest: THREE.Vector3;          // rest center (body space, scaled)
  anchor: THREE.Vector3;        // joint anchor (body space, scaled)
  parent?: Seg;
  children: Seg[];
  joint?: RAPIER.ImpulseJoint;
  local: THREE.Quaternion;      // animated local rotation about anchor
  flinch: THREE.Vector3;        // additive euler springs (hit reactions)
  flinchV: THREE.Vector3;
  D: THREE.Matrix4;             // deformation (rest → posed, body space)
  detached: boolean;
  blendFromP: THREE.Vector3;
  blendFromQ: THREE.Quaternion;
}

export type BodyMode = 'anim' | 'ragdoll' | 'blend';

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _t = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _e = new THREE.Euler();

const LIVE_GROUPS = groups(G.ENEMY, G.PLAYER | G.PROP | G.DEBRIS | G.RAGDOLL | G.HELD);
const RAG_GROUPS = groups(G.RAGDOLL, G.STATIC | G.PROP | G.RAGDOLL | G.DEBRIS | G.ENEMY | G.HELD | G.FIXTURE);

/**
 * Articulated rigid-body skeleton. While alive every segment is kinematic and driven by
 * forward kinematics from animated joint rotations; on death/stagger the bodies switch to
 * dynamic and the pre-built impulse joints take over. Recovery blends ragdoll → pose.
 */
export class ArticulatedBody {
  segs: Seg[] = [];
  byName = new Map<string, Seg>();
  root!: Seg;
  mode: BodyMode = 'anim';
  /** world placement of the body origin (feet) */
  readonly position = new THREE.Vector3();
  yaw = 0;
  /** root tilt (lean) + bob */
  readonly rootOffset = new THREE.Vector3();
  readonly rootRot = new THREE.Quaternion();
  blendT = 0;
  blendDur = 0.45;
  readonly object = new THREE.Group();
  private hurtbox?: RAPIER.Collider;

  constructor(private phys: PhysicsWorld, defs: SegDef[], readonly scale: number, pos: THREE.Vector3, yaw: number,
    makeVisual: (d: SegDef, scale: number) => THREE.Group, private owner: (seg: Seg) => any) {
    this.position.copy(pos); this.yaw = yaw;
    const w = phys.world;
    const bodyQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    for (const d of defs) {
      const rest = new THREE.Vector3(...d.pos).multiplyScalar(scale);
      const anchor = d.joint ? new THREE.Vector3(...d.joint.anchor).multiplyScalar(scale) : rest.clone();
      const wp = rest.clone().applyQuaternion(bodyQ).add(pos);
      const body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(wp.x, wp.y, wp.z)
        .setRotation({ x: bodyQ.x, y: bodyQ.y, z: bodyQ.z, w: bodyQ.w }).setCcdEnabled(false).setLinearDamping(0.1).setAngularDamping(0.6));
      let cd: RAPIER.ColliderDesc;
      const s = d.size.map(v => v * scale);
      // hitboxes are a little more generous than the visuals: thin limbs should still be hittable
      if (d.shape === 'capsule') cd = RAPIER.ColliderDesc.capsule(s[0], s[1] * 1.35);
      else if (d.shape === 'ball') cd = RAPIER.ColliderDesc.ball(s[0] * 1.05);
      else cd = RAPIER.ColliderDesc.cuboid(s[0] * 1.1, s[1] * 1.1, s[2] * 1.1);
      const vol = d.shape === 'box' ? 8 * s[0] * s[1] * s[2] : d.shape === 'ball' ? 4.19 * s[0] ** 3 : Math.PI * s[1] ** 2 * (2 * s[0] + 1.33 * s[1]);
      cd.setDensity((d.mass * scale ** 3) / Math.max(vol, 1e-4)).setFriction(0.9).setRestitution(0.05).setCollisionGroups(LIVE_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(40 * scale);
      const collider = w.createCollider(cd, body);
      const group = makeVisual(d, scale);
      this.object.add(group);
      const seg: Seg = { def: d, body, collider, group, rest, anchor, children: [], local: new THREE.Quaternion(), flinch: new THREE.Vector3(), flinchV: new THREE.Vector3(),
        D: new THREE.Matrix4(), detached: false, blendFromP: new THREE.Vector3(), blendFromQ: new THREE.Quaternion() };
      phys.tag(collider, owner(seg));
      if (d.parent) {
        const p = this.byName.get(d.parent)!;
        seg.parent = p; p.children.push(seg);
        const a1 = anchor.clone().sub(p.rest), a2 = anchor.clone().sub(rest);
        let jd: RAPIER.JointData;
        if (d.joint!.type === 'hinge') {
          const ax = d.joint!.axis ?? [1, 0, 0];
          jd = RAPIER.JointData.revolute({ x: a1.x, y: a1.y, z: a1.z }, { x: a2.x, y: a2.y, z: a2.z }, { x: ax[0], y: ax[1], z: ax[2] });
        } else jd = RAPIER.JointData.spherical({ x: a1.x, y: a1.y, z: a1.z }, { x: a2.x, y: a2.y, z: a2.z });
        const j = w.createImpulseJoint(jd, p.body, body, true);
        j.setContactsEnabled(false);
        if (d.joint!.type === 'hinge' && d.joint!.limits) (j as RAPIER.RevoluteImpulseJoint).setLimits(d.joint!.limits[0], d.joint!.limits[1]);
        seg.joint = j;
      } else this.root = seg;
      this.segs.push(seg);
      this.byName.set(d.name, seg);
    }
    this.syncVisuals();
  }

  seg(name: string) { return this.byName.get(name); }

  /**
   * Massless sensor ball on the root that routes hits to it: small, fast bodies (Skitters) get a
   * forgiving target without changing their physical collision shape. Players/KCCs ignore sensors.
   */
  addHurtbox(radius: number) {
    if (this.hurtbox) return;
    const r = this.root;
    this.hurtbox = this.phys.world.createCollider(RAPIER.ColliderDesc.ball(radius * this.scale).setSensor(true).setDensity(0)
      .setCollisionGroups(LIVE_GROUPS), r.body);
    this.phys.tag(this.hurtbox, this.owner(r));
  }

  removeHurtbox() {
    const h = this.hurtbox;
    if (!h) return;
    this.hurtbox = undefined;
    this.phys.userData.delete(h.handle);
    if (this.phys.colliderAlive(h)) this.phys.world.removeCollider(h, false);
  }

  /** Dead bodies keep the (disabled) hurtbox until the body is removed: no collider removal mid-blast. */
  setHurtboxEnabled(on: boolean) { if (this.phys.colliderAlive(this.hurtbox)) this.hurtbox!.setEnabled(on); }

  /** Compute FK deformation for every segment from local rotations + flinch springs. */
  private fk() {
    for (const s of this.segs) {
      _e.set(s.flinch.x, s.flinch.y, s.flinch.z);
      _q.setFromEuler(_e).premultiply(s.local);
      // T(anchor) * R * T(-anchor)
      _t.makeTranslation(s.anchor.x, s.anchor.y, s.anchor.z);
      _m.makeRotationFromQuaternion(_q);
      _m2.makeTranslation(-s.anchor.x, -s.anchor.y, -s.anchor.z);
      const local = _t.multiply(_m).multiply(_m2);
      if (s.parent) s.D.multiplyMatrices(s.parent.D, local);
      else {
        // root: offset + tilt around its own center
        const c = s.rest;
        const a = new THREE.Matrix4().makeTranslation(c.x + this.rootOffset.x, c.y + this.rootOffset.y, c.z + this.rootOffset.z);
        const r = new THREE.Matrix4().makeRotationFromQuaternion(this.rootRot);
        const b = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
        s.D.copy(a.multiply(r).multiply(b)).multiply(local);
      }
    }
  }

  /** World target transform of a segment in the animated pose. */
  private target(s: Seg, outP: THREE.Vector3, outQ: THREE.Quaternion) {
    const M = _m.compose(this.position, _q.setFromAxisAngle(_p.set(0, 1, 0), this.yaw), _s.set(1, 1, 1));
    const W = _m2.multiplyMatrices(M, s.D);
    outP.copy(s.rest).applyMatrix4(W);
    W.decompose(_p, outQ, _s);
  }

  /** Drive kinematic bodies (anim) or blend them (recovering). */
  step(dt: number) {
    for (const s of this.segs) {
      // flinch springs
      const k = 90, c = 11;
      s.flinchV.x += (-k * s.flinch.x - c * s.flinchV.x) * dt; s.flinchV.y += (-k * s.flinch.y - c * s.flinchV.y) * dt; s.flinchV.z += (-k * s.flinch.z - c * s.flinchV.z) * dt;
      s.flinch.addScaledVector(s.flinchV, dt);
    }
    if (this.mode === 'ragdoll') return;
    this.fk();
    const tp = new THREE.Vector3(), tq = new THREE.Quaternion();
    let k = 1;
    if (this.mode === 'blend') {
      this.blendT += dt;
      k = Math.min(1, this.blendT / this.blendDur);
      k = k * k * (3 - 2 * k);
      if (this.blendT >= this.blendDur) this.mode = 'anim';
    }
    for (const s of this.segs) {
      if (s.detached) continue;
      this.target(s, tp, tq);
      if (k < 1) { tp.lerpVectors(s.blendFromP, tp, k); tq.slerpQuaternions(s.blendFromQ, tq, k); }
      s.body.setNextKinematicTranslation(tp);
      s.body.setNextKinematicRotation(tq);
    }
  }

  /** Switch to full physics. Velocities carry over from the kinematic motion + impulse at point. */
  goRagdoll(impulse?: THREE.Vector3, point?: THREE.Vector3, hitSeg?: Seg) {
    if (this.mode === 'ragdoll') return;
    this.mode = 'ragdoll';
    for (const s of this.segs) {
      if (s.detached) continue;
      const lv = s.body.linvel(), av = s.body.angvel();
      s.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      s.body.setLinvel(lv, true); s.body.setAngvel(av, true);
      s.collider.setCollisionGroups(RAG_GROUPS);
    }
    if (impulse && point) {
      const target = hitSeg ?? this.root;
      target.body.applyImpulseAtPoint(impulse, point, true);
      // share a bit with the root so the whole body reacts
      if (target !== this.root) this.root.body.applyImpulse({ x: impulse.x * 0.35, y: impulse.y * 0.35, z: impulse.z * 0.35 }, true);
    }
  }

  /** Begin blending back to the animated pose from wherever the ragdoll lies. */
  recover() {
    if (this.mode !== 'ragdoll') return;
    // place the body origin under the root segment
    const rt = this.root.body.translation();
    this.position.set(rt.x, this.position.y, rt.z);
    for (const s of this.segs) {
      if (s.detached) continue;
      const t = s.body.translation(), r = s.body.rotation();
      s.blendFromP.set(t.x, t.y, t.z); s.blendFromQ.set(r.x, r.y, r.z, r.w);
      s.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      s.collider.setCollisionGroups(LIVE_GROUPS);
    }
    this.mode = 'blend'; this.blendT = 0;
  }

  /** Cut a segment (and its subtree) off: joint removed, becomes an independent ragdoll piece. */
  sever(s: Seg) {
    if (s.detached || !s.joint) return null;
    this.phys.world.removeImpulseJoint(s.joint, true);
    s.joint = undefined;
    const mark = (x: Seg) => { x.detached = true; for (const c of x.children) mark(c); };
    mark(s);
    for (const x of this.subtree(s)) {
      if (!x.body.isDynamic()) { const lv = x.body.linvel(); x.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true); x.body.setLinvel(lv, true); }
      x.collider.setCollisionGroups(RAG_GROUPS);
    }
    return s;
  }
  subtree(s: Seg): Seg[] { return [s, ...s.children.flatMap(c => this.subtree(c))]; }

  get comPosition() { const t = this.root.body.translation(); return new THREE.Vector3(t.x, t.y, t.z); }

  syncVisuals() {
    for (const s of this.segs) {
      const t = s.body.translation(), r = s.body.rotation();
      s.group.position.set(t.x, t.y, t.z); s.group.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Is the ragdoll basically at rest? */
  get settled() {
    let e = 0;
    for (const s of this.segs) { const v = s.body.linvel(); e += v.x * v.x + v.y * v.y + v.z * v.z; }
    return e / this.segs.length < 0.05;
  }

  freeze() {
    for (const s of this.segs) { if (s.body.isDynamic()) s.body.setBodyType(RAPIER.RigidBodyType.Fixed, true); s.collider.setCollisionGroups(groups(G.RAGDOLL, G.STATIC)); }
  }

  dispose() {
    for (const s of this.segs) { if (s.joint) { try { this.phys.world.removeImpulseJoint(s.joint, false); } catch {} } }
    for (const s of this.segs) this.phys.removeBody(s.body);
    this.object.removeFromParent();

  }
}
