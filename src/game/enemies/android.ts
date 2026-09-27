import * as THREE from 'three';
import { ArticulatedBody, Seg } from '../../physics/ragdoll';
import { RAPIER, G, groups } from '../../physics/world';
import type { Ctx, HitInfo, Owner } from '../types';
import { ENEMIES, EnemyStats, EnemyType, SegDef } from './defs';
import type { DynLight } from '../../render/lights';

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry) { let g = geoCache.get(key); if (!g) { g = make(); geoCache.set(key, g); } return g; }

const matCache = new Map<string, THREE.MeshStandardMaterial>();

export type AState = 'alive' | 'stagger' | 'held' | 'dead';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

let nextId = 1;

/**
 * An android enemy: articulated physics body + procedural animation + damage model.
 * AI (ai.ts) sets `moveDir`, `aimPoint`, `wantFire` etc; this class turns intent into motion.
 */
export class Android {
  readonly id = nextId++;
  stats: EnemyStats;
  body: ArticulatedBody;
  state: AState = 'alive';
  hp: number;
  maxHp: number;
  mover?: RAPIER.Collider;
  kcc?: RAPIER.KinematicCharacterController;
  readonly vel = new THREE.Vector3();
  readonly moveDir = new THREE.Vector3();
  moveSpeed = 0;
  aimPoint: THREE.Vector3 | null = null;
  faceYaw: number | null = null;
  grounded = true;
  private phase = 0;
  private lean = 0;
  staggerAccum = 0;
  staggerT = 0;
  deadT = 0;
  heldT = 0;
  core: DynLight;
  coreMeshes: THREE.Mesh[] = [];
  private emissiveMat: THREE.MeshBasicMaterial;
  private coreColor: THREE.Color;
  flare = 0;           // telegraph 0..1
  flareColor = new THREE.Color();
  visibility = 1;      // shades
  burning = 0;
  plates = 0;
  hoverY = 3;
  lastHitBy: HitInfo['source'] = 'player';
  killedByKinetic = false;
  shield = 0;
  ai: any = null;
  gun?: THREE.Object3D;
  /** set true for bosses that manage limbs themselves */
  isBoss = false;
  /** boss hook: called on every hit while alive; may return a damage multiplier */
  onSegHit?: (seg: Seg, h: HitInfo, dmg: number) => number;
  private ownerCache = new Map<Seg, Owner>();
  private punch = new Map<Seg, number>();
  private shadeMats: THREE.Material[] = [];

  constructor(private ctx: Ctx, readonly type: EnemyType, pos: THREE.Vector3, yaw: number) {
    this.stats = ENEMIES[type];
    this.hp = this.maxHp = this.stats.hp;
    const s = this.stats.scale;
    this.coreColor = new THREE.Color(this.stats.color);
    this.emissiveMat = new THREE.MeshBasicMaterial({ color: this.coreColor.clone().multiplyScalar(5) });
    if (type === 'charger') this.plates = 3;
    const spawn = pos.clone();
    if (this.stats.flying) spawn.y += this.hoverY;
    this.body = new ArticulatedBody(ctx.phys, this.stats.body, s, spawn, yaw, (d, sc) => this.visual(d, sc), seg => this.ownerFor(seg));
    ctx.scene.add(this.body.object);
    if (this.stats.hurtbox) this.body.addHurtbox(this.stats.hurtbox);
    this.core = ctx.lights.add({ pos: spawn.clone().add(new THREE.Vector3(0, 1.3 * s, 0)), color: this.coreColor, intensity: 3.5, radius: 3.5 * s });
    if (!this.stats.flying) {
      const r = 0.35 * s, hh = Math.max(0.1, 0.9 * s - r);
      this.mover = ctx.phys.world.createCollider(RAPIER.ColliderDesc.capsule(hh, r).setTranslation(pos.x, pos.y + hh + r, pos.z).setCollisionGroups(groups(0, 0)));
      this.kcc = ctx.phys.world.createCharacterController(0.03);
      this.kcc.enableAutostep(0.4 * s, 0.2, false);
      this.kcc.enableSnapToGround(0.4);
      this.kcc.setMaxSlopeClimbAngle(0.9);
    }
  }

  private ownerFor(seg: Seg): Owner {
    const cached = this.ownerCache.get(seg);
    if (cached) return cached;
    const o: Owner = { kind: 'android', android: this, seg, surface: 'android', hit: (h: HitInfo) => this.hit(h, seg) };
    this.ownerCache.set(seg, o);
    return o;
  }

  private armorMat() {
    const key = this.type;
    let m = matCache.get(key);
    if (!m) {
      const base = this.ctx.mats.get('armor');
      m = base.clone();
      this.ctx.lights.patch(m);
      if (this.type === 'charger' || this.type === 'foreman') m.color.set(0xd9b25a);
      if (this.type === 'shade') { m.color.set(0x15151c); m.roughness = 0.2; m.metalness = 0.6; }
      if (this.type === 'skitter') m.color.set(0x8a6d88);
      if (this.type === 'lamplighter') m.color.set(0xb8c0c8);
      matCache.set(key, m);
    }
    if (this.type === 'shade') { const c = m.clone(); c.transparent = true; this.ctx.lights.patch(c); this.shadeMats.push(c); return c; }
    return m;
  }

  private visual(d: SegDef, sc: number) {
    const g = new THREE.Group();
    const s = d.size.map(v => v * sc);
    const joint = this.ctx.mats.get('joint');
    const armor = this.armorMat();
    const mesh = (gm: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const me = new THREE.Mesh(gm, m); me.position.set(x, y, z); me.castShadow = m !== this.emissiveMat && m !== joint; g.add(me); return me;
    };
    if (d.shape === 'capsule') {
      const k = `cap${s[0].toFixed(3)}_${s[1].toFixed(3)}`;
      mesh(geo(k + 'j', () => new THREE.CapsuleGeometry(s[1] * 0.75, s[0] * 2, 4, 8)), joint);
      if (d.look === 'armor') mesh(geo(k + 'a', () => new THREE.CapsuleGeometry(s[1] * 1.08, s[0] * 1.3, 4, 8)), armor, 0, s[0] * 0.15, 0);
      // joint ring glow
      if (d.look === 'joint') { const r = mesh(geo(k + 'r', () => new THREE.TorusGeometry(s[1] * 0.9, s[1] * 0.18, 6, 12)), this.emissiveMat, 0, s[0], 0); r.rotation.x = Math.PI / 2; this.coreMeshes.push(r); }
    } else if (d.shape === 'box') {
      const k = `box${s.map(v => v.toFixed(3)).join('_')}`;
      if (d.look === 'joint') mesh(geo(k, () => new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2)), joint);
      else mesh(geo(k, () => new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2)), armor);
      if (d.look === 'core') {
        const c = mesh(geo(k + 'c', () => new THREE.BoxGeometry(s[0] * 0.6, s[1] * 0.5, 0.02 * sc)), this.emissiveMat, 0, s[1] * 0.15, -s[2] - 0.005); this.coreMeshes.push(c);
        // shoulder plates / back vents
        mesh(geo(k + 'p', () => new THREE.BoxGeometry(s[0] * 2.2, s[1] * 0.35, s[2] * 2.1)), joint, 0, s[1] * 0.75, 0);
      }
      if (d.look === 'head' || d.look === 'visor') {
        const v = mesh(geo(k + 'v', () => new THREE.BoxGeometry(s[0] * 1.7, s[1] * 0.28, 0.02 * sc)), this.emissiveMat, 0, s[1] * 0.1, -s[2] - 0.005); this.coreMeshes.push(v);
      }
    } else {
      const k = `ball${s[0].toFixed(3)}`;
      mesh(geo(k, () => new THREE.IcosahedronGeometry(s[0], 1)), armor);
      const ring = mesh(geo(k + 'r', () => new THREE.TorusGeometry(s[0] * 1.05, s[0] * 0.08, 6, 20)), this.emissiveMat); ring.rotation.x = Math.PI / 2; this.coreMeshes.push(ring);
    }
    if (d.name === 'farmR' && (this.type === 'grunt' || this.type === 'foreman')) {
      // rifle along -Y of the forearm (forearm points at target when aiming)
      const gun = new THREE.Group();
      const b = new THREE.Mesh(geo('gunb' + sc, () => new THREE.BoxGeometry(0.06 * sc, 0.42 * sc, 0.09 * sc)), joint); b.position.y = -0.22 * sc; gun.add(b);
      const n = new THREE.Mesh(geo('gunn' + sc, () => new THREE.BoxGeometry(0.02 * sc, 0.3 * sc, 0.02 * sc)), this.emissiveMat); n.position.set(0, -0.25 * sc, -0.05 * sc); gun.add(n);
      this.coreMeshes.push(n);
      const muzzle = new THREE.Object3D(); muzzle.position.y = -0.46 * sc; gun.add(muzzle);
      g.add(gun); this.gun = muzzle;
    }
    if (d.name === 'torso' && this.plates > 0) {
      for (let i = 0; i < 3; i++) {
        const p = mesh(geo('plate' + i + sc, () => new THREE.BoxGeometry(s[0] * 1.2, s[1] * 0.55, 0.05 * sc)), armor, 0, s[1] * (0.55 - i * 0.55), -s[2] - 0.03 * sc);
        p.name = 'plate';
      }
    }
    return g;
  }

  get alive() { return this.state !== 'dead'; }
  get position() { return this.body.position; }
  /** Visual centre of mass: the root segment (pelvis / body / core), lifted to the chest on bipeds. */
  get center() {
    const c = this.body.comPosition;
    if (!this.stats.quad && !this.stats.flying && this.state === 'alive') c.y += 0.25 * this.stats.scale;
    return c;
  }
  get head() { const h = this.body.segs.find(s => s.def.head)!; const t = h.body.translation(); return new THREE.Vector3(t.x, t.y, t.z); }

  private hittable = true;
  /** Shades in darkness: bullets pass through them. */
  setHittable(v: boolean) {
    if (v === this.hittable || this.state !== 'alive') return;
    this.hittable = v;
    for (const sg of this.body.segs) sg.collider.setCollisionGroups(v ? groups(G.ENEMY, G.PLAYER | G.PROP | G.DEBRIS | G.RAGDOLL | G.HELD) : groups(G.TRIGGER, G.PROP | G.HELD));
  }

  // ---------- damage ----------
  hit(h: HitInfo, seg: Seg) {
    const ctx = this.ctx;
    if (this.state === 'dead') {
      // juggle corpses
      if (h.impulse > 0) seg.body.applyImpulseAtPoint(_v.copy(h.dir).multiplyScalar(h.impulse * 1.2), h.point, true);
      if (h.pin && h.weapon === 'rail') this.ctx.game.pinSegment(seg, h);
      return;
    }
    let dmg = h.damage;
    let headshot = false;
    const direct = h.source === 'player' && h.weapon !== 'explosion';
    if (seg.def.head && direct) { dmg *= 2.5; headshot = true; }
    // charger front plates
    if (this.plates > 0 && direct && seg.def.name === 'torso') {
      const fwd = _v.set(-Math.sin(this.body.yaw), 0, -Math.cos(this.body.yaw));
      if (h.dir.dot(fwd) < -0.3) {
        dmg *= 0.35;
        if (Math.random() < 0.18 + h.damage / 300) this.breakPlate(h);
      }
    }
    if (this.shield > 0) { const s = Math.min(this.shield, dmg); this.shield -= s; dmg -= s; if (this.shield <= 0) ctx.sfx.play('shieldBreak', { pos: h.point }); }
    if (this.onSegHit) dmg *= this.onSegHit(seg, h, dmg);
    if (h.tags?.has('thermite')) this.burning = Math.max(this.burning, 3);
    this.hp -= dmg;
    this.lastHitBy = h.source;
    h.headshot = headshot;
    h.dealt = dmg;
    // flinch: rotate the hit segment chain away from the shot
    const local = _v2.copy(h.dir).applyAxisAngle(UP, -this.body.yaw);
    const fk = Math.min(6, 1 + h.impulse * 0.25);
    const chain = [seg, seg.parent, seg.parent?.parent].filter(Boolean) as Seg[];
    chain.forEach((c, i) => { c.flinchV.x += -local.z * fk * (1 - i * 0.3) * 5; c.flinchV.z += local.x * fk * (1 - i * 0.3) * 5; });
    // visual punch on the struck part (render-only scale pulse, physics untouched)
    this.punch.set(seg, Math.min(1, (this.punch.get(seg) ?? 0) + 0.5 + dmg / 80));
    // knockback
    if (this.state === 'alive') this.vel.addScaledVector(h.dir, h.impulse / (3.5 * this.stats.scale ** 2));
    this.staggerAccum += dmg + h.impulse * 1.5;
    this.flare = Math.max(this.flare, 0.8); this.flareColor.set(0xffffff);
    ctx.events.emit('enemyHit', { hit: h, enemy: this });
    if (this.hp <= 0) { this.die(h, seg); return; }
    if (this.state === 'alive' && this.staggerAccum > this.stats.stagger && !this.isBoss) this.stagger(h, seg);
    else if (this.state !== 'alive' && h.impulse > 0) seg.body.applyImpulseAtPoint(_v.copy(h.dir).multiplyScalar(h.impulse), h.point, true);
  }

  private breakPlate(h: HitInfo) {
    const torso = this.body.seg('torso')!;
    const plate = torso.group.children.find(c => c.name === 'plate');
    if (!plate) { this.plates = 0; return; }
    plate.removeFromParent();
    this.plates--;
    const wp = plate.getWorldPosition(new THREE.Vector3());
    this.ctx.game.spawnDebrisPiece(wp, (plate as THREE.Mesh).geometry, (plate as THREE.Mesh).material, h.dir.clone().multiplyScalar(4).add(new THREE.Vector3(0, 3, 0)));
    this.ctx.particles.sparksAt(wp, h.normal, 25, 0xffd28a, 10, 1, 0.6);
    this.ctx.sfx.play('impactMetal', { pos: wp, gain: 1.6 });
  }

  stagger(h?: HitInfo, seg?: Seg, time = 1.1) {
    if (this.state !== 'alive') return;
    this.state = 'stagger';
    this.staggerT = time;
    this.staggerAccum = 0;
    const imp = h ? _v.copy(h.dir).multiplyScalar(h.impulse * 1.4).add(new THREE.Vector3(0, h.impulse * 0.3, 0)) : undefined;
    this.body.goRagdoll(imp, h?.point, seg);
    this.ctx.sfx.play('servo', { pos: this.center });
  }

  /** Kinetic hand grabbed us. */
  grab() {
    if (this.state === 'dead') return;
    if (this.state === 'alive') this.body.goRagdoll();
    this.state = 'held';
    this.heldT = 0;
  }
  release() { if (this.state === 'held') { this.state = 'stagger'; this.staggerT = 1.4; } }

  die(h: HitInfo, seg?: Seg) {
    if (this.state === 'dead') return;
    const ctx = this.ctx;
    const wasAlive = this.state === 'alive';
    this.state = 'dead';
    this.deadT = 0;
    this.killedByKinetic = h.source === 'kinetic';
    this.body.removeHurtbox();
    const imp = _v.copy(h.dir).multiplyScalar(h.impulse * 1.6 + 4).add(new THREE.Vector3(0, h.impulse * 0.4 + 1.5, 0));
    if (wasAlive || this.body.mode !== 'ragdoll') this.body.goRagdoll(imp, h.point, seg);
    else seg?.body.applyImpulseAtPoint(imp, h.point, true);
    // overkill / explosions sever limbs
    const overkill = -this.hp;
    const severables = this.body.segs.filter(s => s.def.severable && !s.detached);
    let cuts = 0;
    if (seg?.def.severable && (overkill > 35 || h.weapon === 'rail' || h.weapon === 'scatter' && overkill > 20)) { this.severSeg(seg); cuts++; }
    if (h.weapon === 'explosion' || h.tags?.has('volatile')) for (const s of severables) if (Math.random() < 0.3 && cuts < 3) { this.severSeg(s); cuts++; }
    if (h.pin && h.weapon === 'rail' && seg) ctx.game.pinSegment(seg, h);
    ctx.sfx.play('snap', { pos: this.center });
    ctx.events.emit('enemyKilled', { hit: h, enemy: this, headshot: !!h.headshot, kinetic: this.killedByKinetic, bulletTime: ctx.time.isBulletTime, pos: this.center });
    if (this.mover) { ctx.phys.world.removeCollider(this.mover, false); this.mover = undefined; }
    if (this.kcc) { ctx.phys.world.removeCharacterController(this.kcc); this.kcc = undefined; }
  }

  severSeg(s: Seg) {
    const cut = this.body.sever(s);
    if (!cut) return;
    const t = s.body.translation();
    const p = new THREE.Vector3(t.x, t.y, t.z);
    this.ctx.particles.sparksAt(p, new THREE.Vector3(0, 1, 0), 30, 0xffe0a0, 9, 1.2, 0.8);
    this.ctx.particles.smokeAt(p, 3, 0x1a1a1a, 0.3, 1);
    s.body.applyImpulse({ x: (Math.random() - 0.5) * 6, y: 4 + Math.random() * 3, z: (Math.random() - 0.5) * 6 }, true);
    for (const x of this.body.subtree(s)) { const o = this.ownerCache.get(x); if (o) { o.kind = 'android'; o.severed = true; } }
    this.ctx.events.emit('limbSevered', { pos: p });
  }

  // ---------- simulation ----------
  step(dt: number) {
    const ctx = this.ctx;
    const b = this.body;
    const s = this.stats.scale;
    this.flare = Math.max(0, this.flare - dt * 3);
    for (const [sg, p] of this.punch) { const n = p - dt * 7; if (n <= 0) { this.punch.delete(sg); sg.group.scale.setScalar(1); } else this.punch.set(sg, n); }
    if (this.burning > 0 && this.state !== 'dead') {
      this.burning -= dt;
      if (Math.random() < dt * 8) this.hit({ point: this.center, normal: UP, dir: UP.clone(), damage: 6, impulse: 0, source: 'player', weapon: 'thermite' }, b.root);
      if (Math.random() < 0.5) ctx.particles.sparksAt(this.center.add(new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.3) * 0.6, (Math.random() - 0.5) * 0.4)), UP, 1, 0xff9a40, 2, 0.8, 0.5);
    }
    if (this.state === 'stagger') {
      this.staggerT -= dt;
      if (this.staggerT <= 0 && b.settled || this.staggerT < -2.5) this.getUp();
    } else if (this.state === 'held') {
      this.heldT += dt;
    } else if (this.state === 'dead') {
      this.deadT += dt;
    } else {
      this.locomote(dt);
    }
    this.staggerAccum = Math.max(0, this.staggerAccum - dt * this.stats.stagger * 0.8);
    b.step(dt);
    // core light follows torso; fades on death
    const coreSeg = b.seg('torso') ?? b.root;
    const ct = coreSeg.body.translation();
    this.core.pos.set(ct.x, ct.y, ct.z);
    const deadK = this.state === 'dead' ? (ctx.run.mods.lanterns ? Math.max(0.75, 1 - this.deadT / 2.2) : Math.max(0, 1 - this.deadT / 2.2)) : 1;
    const flick = this.state === 'dead' && this.deadT < 1.5 ? (Math.random() < 0.15 ? 0.2 : 1) : this.state === 'stagger' ? (Math.random() < 0.3 ? 0.3 : 1) : 1;
    const k = deadK * flick;
    const col = _v.set(this.coreColor.r, this.coreColor.g, this.coreColor.b).lerp(_v2.set(this.flareColor.r, this.flareColor.g, this.flareColor.b), Math.min(1, this.flare));
    this.core.color.setRGB(col.x, col.y, col.z);
    this.core.intensity = (3.5 + this.flare * 12) * k * this.visibility;
    this.emissiveMat.color.setRGB(col.x, col.y, col.z).multiplyScalar((4 + this.flare * 10) * k + 0.05);
  }

  private getUp() {
    if (this.state === 'dead') return;
    this.body.recover();
    this.hittable = true;
    const r = this.body.root.body.translation();
    // stand up where the pelvis landed; face the player
    const ground = this.ctx.phys.ray(r.x, r.y + 0.5, r.z, 0, -1, 0, 5, groups(0xffff, G.STATIC));
    const gy = ground ? ground.y : r.y - 1;
    this.body.position.set(r.x, this.stats.flying ? gy + this.hoverY : gy, r.z);
    if (this.mover) {
      const hh = (this.mover.shape as RAPIER.Capsule).halfHeight, rr = (this.mover.shape as RAPIER.Capsule).radius;
      this.mover.setTranslation({ x: r.x, y: gy + hh + rr + 0.02, z: r.z });
    }
    this.vel.set(0, 0, 0);
    this.state = 'alive';
    this.flare = 1; this.flareColor.set(0xffffff);
    this.ctx.sfx.play('servo', { pos: this.center });
  }

  private locomote(dt: number) {
    const b = this.body, st = this.stats, s = st.scale;
    // desired horizontal velocity from AI intent
    const want = _v.copy(this.moveDir).setY(0);
    if (want.lengthSq() > 1e-4) want.normalize().multiplyScalar(this.moveSpeed);
    const accel = st.flying ? 6 : 10;
    this.vel.x += (want.x - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (want.z - this.vel.z) * Math.min(1, accel * dt);
    if (st.flying) {
      this.vel.y += ((this.moveDir.y || 0) * 3 - this.vel.y) * Math.min(1, 3 * dt);
      const p = b.position;
      const nx = p.x + this.vel.x * dt, ny = p.y + this.vel.y * dt, nz = p.z + this.vel.z * dt;
      const d = _v2.set(nx - p.x, ny - p.y, nz - p.z);
      const len = d.length();
      if (len > 1e-5) {
        const hit = this.ctx.phys.ray(p.x, p.y, p.z, d.x / len, d.y / len, d.z / len, len + 0.4, groups(0xffff, G.STATIC));
        if (!hit) p.set(nx, ny, nz); else this.vel.multiplyScalar(-0.3);
      }
    } else if (this.mover && this.kcc) {
      this.vel.y -= 24 * dt;
      if (this.grounded && this.vel.y < 0) this.vel.y = -1;
      this.kcc.computeColliderMovement(this.mover, { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(0xffff, G.STATIC | G.PROP));
      const mv = this.kcc.computedMovement();
      this.grounded = this.kcc.computedGrounded();
      const t = this.mover.translation();
      const np = { x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z };
      this.mover.setTranslation(np);
      const cap = this.mover.shape as RAPIER.Capsule;
      b.position.set(np.x, np.y - cap.halfHeight - cap.radius, np.z);
      if (dt > 0) { const hv = Math.hypot(mv.x, mv.z) / dt; const cur = Math.hypot(this.vel.x, this.vel.z); if (hv < cur * 0.5 && cur > 1) { this.vel.x *= 0.5; this.vel.z *= 0.5; } }
    }
    // facing
    const speed = Math.hypot(this.vel.x, this.vel.z);
    let targetYaw = b.yaw;
    if (this.faceYaw !== null) targetYaw = this.faceYaw;
    else if (this.aimPoint) targetYaw = Math.atan2(-(this.aimPoint.x - b.position.x), -(this.aimPoint.z - b.position.z));
    else if (speed > 0.5) targetYaw = Math.atan2(-this.vel.x, -this.vel.z);
    let dy = targetYaw - b.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    b.yaw += dy * Math.min(1, dt * (st.quad ? 10 : 7));

    if (st.flying) this.animDrone(dt, speed);
    else if (st.quad) this.animQuad(dt, speed);
    else this.animBiped(dt, speed);
  }

  private animBiped(dt: number, speed: number) {
    const b = this.body, s = this.stats.scale;
    const stride = Math.min(0.75, speed * 0.16) * s;
    const T = stride > 0.02 ? stride / (0.6 * Math.max(speed, 0.1)) : 1.2;
    this.phase = (this.phase + dt / T) % 1;
    // local velocity for foot placement direction
    const lv = _v.set(this.vel.x, 0, this.vel.z).applyAxisAngle(UP, -b.yaw);
    const ldir = lv.lengthSq() > 0.01 ? lv.clone().normalize() : new THREE.Vector3(0, 0, -1);
    const pelvisBob = stride > 0.02 ? Math.abs(Math.sin(this.phase * Math.PI * 2)) * 0.035 * s : Math.sin(performance.now() / 700 + this.id) * 0.008 * s;
    this.lean += ((-lv.z * 0.03) - this.lean) * Math.min(1, dt * 5);
    b.rootOffset.set(0, -pelvisBob - 0.03 * s, 0);
    b.rootRot.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -this.lean * 0.5);
    const a = 0.42 * s, bl = 0.43 * s;
    for (const [side, off] of [['L', 0], ['R', 0.5]] as const) {
      const thigh = b.seg('thigh' + side)!, shin = b.seg('shin' + side)!;
      if (thigh.detached) continue;
      const ψ = (this.phase + off) % 1;
      let f: number, lift = 0;
      if (ψ < 0.6) f = stride / 2 - (ψ / 0.6) * stride;
      else { const u = (ψ - 0.6) / 0.4; f = -stride / 2 + u * stride; lift = Math.sin(u * Math.PI) * Math.min(0.18 * s, stride * 0.35); }
      const H = thigh.anchor.clone().add(b.rootOffset);
      const F = new THREE.Vector3(thigh.anchor.x, 0.07 * s + lift, 0).addScaledVector(ldir, f);
      this.ik2(H, F, a, bl, new THREE.Vector3(0, 0, -1), thigh, shin, b.rootRot);
    }
    // arms
    const torso = b.seg('torso')!;
    let torsoYaw = 0, torsoPitch = this.lean;
    const aim = this.aimPoint;
    const armR = b.seg('uarmR')!, farmR = b.seg('farmR')!, armL = b.seg('uarmL')!, farmL = b.seg('farmL')!;
    const swing = Math.sin(this.phase * Math.PI * 2) * Math.min(0.6, speed * 0.1);
    if (aim && !armR.detached) {
      const sh = armR.anchor.clone().applyAxisAngle(UP, b.yaw).add(b.position);
      const dirW = aim.clone().sub(sh).normalize();
      const dirL = dirW.applyAxisAngle(UP, -b.yaw);
      torsoYaw = THREE.MathUtils.clamp(Math.atan2(-dirL.x, -dirL.z), -0.6, 0.6) * 0.5;
      // shoulder: point the arm at the target in torso space
      const torsoQ = _q.setFromEuler(new THREE.Euler(torsoPitch, torsoYaw, 0, 'YXZ')).premultiply(b.rootRot);
      const inTorso = dirL.clone().applyQuaternion(torsoQ.clone().invert());
      armR.local.setFromUnitVectors(DOWN, inTorso);
      farmR.local.identity();
      armL.local.setFromEuler(new THREE.Euler(0.9, 0, -0.5)); farmL.local.setFromEuler(new THREE.Euler(1.2, 0, 0));
    } else {
      armR.local.setFromEuler(new THREE.Euler(swing, 0, 0.12)); farmR.local.setFromEuler(new THREE.Euler(0.3 + Math.max(0, swing) * 0.5, 0, 0));
      armL.local.setFromEuler(new THREE.Euler(-swing, 0, -0.12)); farmL.local.setFromEuler(new THREE.Euler(0.3 + Math.max(0, -swing) * 0.5, 0, 0));
    }
    if (this.type === 'charger' && this.ai?.rushing) {
      armR.local.setFromEuler(new THREE.Euler(1.2, 0, 0.3)); armL.local.setFromEuler(new THREE.Euler(1.2, 0, -0.3));
      torsoPitch += 0.35;
    }
    if (this.type === 'shade' && this.ai?.lunging) { armR.local.setFromEuler(new THREE.Euler(2.4, 0, 0)); armL.local.setFromEuler(new THREE.Euler(2.4, 0, 0)); }
    torso.local.setFromEuler(new THREE.Euler(torsoPitch, torsoYaw, 0, 'YXZ'));
    const head = b.seg('head')!;
    if (aim) {
      const hp = head.anchor.clone().applyAxisAngle(UP, b.yaw).add(b.position);
      const d = aim.clone().sub(hp).applyAxisAngle(UP, -b.yaw).normalize();
      head.local.setFromEuler(new THREE.Euler(Math.asin(THREE.MathUtils.clamp(d.y, -0.7, 0.7)) - torsoPitch, THREE.MathUtils.clamp(Math.atan2(-d.x, -d.z) - torsoYaw, -0.8, 0.8), 0, 'YXZ'));
    } else head.local.setFromEuler(new THREE.Euler(-torsoPitch * 0.5, Math.sin(performance.now() / 1500 + this.id) * 0.3, 0, 'YXZ'));
  }

  /** Two-bone IK in body space: sets local rotations for upper/lower segments. */
  private ik2(H: THREE.Vector3, F: THREE.Vector3, a: number, bLen: number, bendDir: THREE.Vector3, upper: Seg, lower: Seg, parentQ: THREE.Quaternion) {
    const v = F.clone().sub(H);
    let L = v.length();
    L = THREE.MathUtils.clamp(L, 0.05, a + bLen - 0.001);
    const d = v.normalize();
    const cosB = THREE.MathUtils.clamp((a * a + L * L - bLen * bLen) / (2 * a * L), -1, 1);
    const beta = Math.acos(cosB);
    const perp = bendDir.clone().addScaledVector(d, -bendDir.dot(d)).normalize();
    const t = d.clone().multiplyScalar(Math.cos(beta)).addScaledVector(perp, Math.sin(beta));
    const K = H.clone().addScaledVector(t, a);
    const u = F.clone().sub(K).normalize();
    const qUpper = new THREE.Quaternion().setFromUnitVectors(DOWN, t);
    const qLower = new THREE.Quaternion().setFromUnitVectors(DOWN, u);
    upper.local.copy(parentQ.clone().invert().multiply(qUpper));
    lower.local.copy(qUpper.clone().invert().multiply(qLower));
  }

  private animQuad(dt: number, speed: number) {
    const b = this.body;
    const T = speed > 0.3 ? 0.9 / Math.max(speed, 0.5) + 0.12 : 1.4;
    this.phase = (this.phase + dt / T) % 1;
    const amp = Math.min(0.7, speed * 0.1) + 0.05;
    const leaping = this.ai?.leaping;
    b.rootOffset.set(0, Math.abs(Math.sin(this.phase * Math.PI * 4)) * 0.03, 0);
    b.rootRot.setFromAxisAngle(new THREE.Vector3(1, 0, 0), leaping ? -0.4 : 0);
    for (const k of ['FL', 'FR', 'BL', 'BR']) {
      const u = b.seg('u' + k)!, l = b.seg('l' + k)!;
      if (u.detached) continue;
      const sx = k.endsWith('L') ? -1 : 1;
      const off = k === 'FL' || k === 'BR' ? 0 : 0.5;
      const ψ = (this.phase + off) * Math.PI * 2;
      // upper legs splay out (rotate about Z), swing fore/aft (about Y)
      u.local.setFromEuler(new THREE.Euler(0, Math.sin(ψ) * amp, sx * (1.25 + Math.max(0, Math.cos(ψ)) * amp * 0.6) + (leaping ? sx * 0.4 : 0)));
      l.local.setFromEuler(new THREE.Euler(0, 0, -sx * (1.6 + (leaping ? 0.5 : 0))));
    }
    const head = b.seg('head')!;
    head.local.setFromEuler(new THREE.Euler(Math.sin(performance.now() / 300 + this.id) * 0.1, 0, 0));
  }

  private animDrone(dt: number, speed: number) {
    const b = this.body;
    const t = performance.now() / 1000 + this.id;
    b.rootOffset.set(0, Math.sin(t * 2.2) * 0.12, 0);
    b.rootRot.setFromEuler(new THREE.Euler(-this.vel.z * 0.05 * 0 + Math.min(0.3, speed * 0.04), 0, Math.sin(t * 1.3) * 0.1));
    const fl = b.seg('finL'), fr = b.seg('finR');
    if (fl && !fl.detached) fl.local.setFromEuler(new THREE.Euler(0, 0, Math.sin(t * 14) * 0.35));
    if (fr && !fr.detached) fr.local.setFromEuler(new THREE.Euler(0, 0, -Math.sin(t * 14) * 0.35));
  }

  /** Muzzle world position (grunt / foreman). */
  muzzle(out = new THREE.Vector3()) {
    if (this.gun) { this.gun.updateWorldMatrix(true, false); return this.gun.getWorldPosition(out); }
    return out.copy(this.center);
  }

  sync() {
    this.body.syncVisuals();
    for (const [sg, p] of this.punch) sg.group.scale.setScalar(1 + p * p * 0.22);
    if (this.shadeMats.length) {
      const op = this.state === 'dead' ? 1 : 0.04 + 0.96 * this.visibility;
      for (const m of this.shadeMats) (m as THREE.MeshStandardMaterial).opacity = op;
      for (const c of this.coreMeshes) c.visible = this.visibility > 0.25 || this.state === 'dead';
    }
  }

  dispose() {
    const ctx = this.ctx;
    for (const sg of this.body.segs) ctx.game?.kinetic?.forgetBody(sg.body);
    ctx.lights.remove(this.core);
    if (this.mover) ctx.phys.world.removeCollider(this.mover, false);
    if (this.kcc) ctx.phys.world.removeCharacterController(this.kcc);
    this.body.dispose();
    this.emissiveMat.dispose();
  }
}
