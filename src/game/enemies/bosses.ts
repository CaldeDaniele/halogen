import * as THREE from 'three';
import type { Ctx, HitInfo, Owner } from '../types';
import type { Room } from '../level/builder';
import type { EnemyType } from './defs';
import type { Android } from './android';
import { RAPIER, G, groups, ALL } from '../../physics/world';
import { LightType, DynLight } from '../../render/lights';
import { Fixture } from '../level/fixtures';
import { explode } from '../combat';
import type { Seg } from '../../physics/ragdoll';

export interface Boss {
  name: string; hp: number; maxHp: number; state: string; dead: boolean;
  update(dt: number): void; sync(): void; dispose(): void;
}

type Spawn = (t: EnemyType, p: THREE.Vector3) => Android;
const UP = new THREE.Vector3(0, 1, 0);

export function createBoss(ctx: Ctx, sector: number, room: Room, spawn: Spawn): Boss {
  if (sector === 1) return new Switchboard(ctx, room, spawn);
  if (sector === 2) return new Filament(ctx, room, spawn);
  return new Foreman(ctx, room, spawn);
}

function playerFeet(ctx: Ctx) { return ctx.player.pos.y - 0.9; }
function distToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6), 0, 1);
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}

/** Expanding ground shockwave: jump over it. */
class Shockwave {
  r = 1; mesh: THREE.Mesh; light: DynLight; hit = false; dead = false;
  constructor(private ctx: Ctx, readonly origin: THREE.Vector3, private maxR: number, private speed: number, private dmg: number, color: number) {
    this.mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 6, 64), ctx.mats.neon(color, 8));
    this.mesh.rotation.x = Math.PI / 2; this.mesh.position.copy(origin).setY(origin.y + 0.25);
    ctx.scene.add(this.mesh);
    this.light = ctx.lights.add({ pos: origin.clone().setY(origin.y + 0.5), color: new THREE.Color(color), intensity: 30, radius: 10, ttl: maxR / speed });
  }
  update(dt: number) {
    this.r += this.speed * dt;
    this.mesh.scale.set(this.r, this.r, 1 + this.r * 0.05);
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    const p = this.ctx.player.pos;
    const d = Math.hypot(p.x - this.origin.x, p.z - this.origin.z);
    if (!this.hit && Math.abs(d - this.r) < 0.9 && playerFeet(this.ctx) < this.origin.y + 0.8) {
      this.hit = true;
      this.ctx.game.damagePlayer(this.dmg, this.origin);
      this.ctx.game.knockPlayer(new THREE.Vector3(p.x - this.origin.x, 0, p.z - this.origin.z).normalize().multiplyScalar(10).setY(7));
    }
    if (Math.random() < 0.8) {
      const a = Math.random() * Math.PI * 2;
      this.ctx.particles.sparksAt(new THREE.Vector3(this.origin.x + Math.cos(a) * this.r, this.origin.y + 0.1, this.origin.z + Math.sin(a) * this.r), UP, 3, 0xffd28a, 5, 0.6, 0.4);
    }
    if (this.r >= this.maxR) { this.dead = true; this.mesh.removeFromParent(); this.mesh.geometry.dispose(); }
  }
  dispose() { this.mesh.removeFromParent(); this.ctx.lights.remove(this.light); }
}

/** Telegraphed line attack: warning line, then lightning along it. */
class LineStrike {
  t = 0; fired = false; dead = false; mesh: THREE.Mesh;
  constructor(private ctx: Ctx, private a: THREE.Vector3, private b: THREE.Vector3, private delay: number, private dmg: number, private color: number) {
    const len = a.distanceTo(b);
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, len), new THREE.MeshBasicMaterial({ color: new THREE.Color(ctx.game?.palette?.bossTell ?? 0xff3b3b).multiplyScalar(3), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.mesh.position.copy(a).add(b).multiplyScalar(0.5); this.mesh.lookAt(b);
    ctx.scene.add(this.mesh);
    ctx.sfx.play('telegraph', { pos: a, pitch: 1.4 });
  }
  update(dt: number) {
    this.t += dt;
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.5 * Math.abs(Math.sin(this.t * 30));
    if (!this.fired && this.t >= this.delay) {
      this.fired = true;
      this.ctx.game.lightning(this.a, this.b, this.color);
      this.ctx.game.lightning(this.a, this.b, 0xffffff);
      this.ctx.sfx.play('rail', { pos: this.a, gain: 0.7 });
      if (distToSegment(this.ctx.player.pos, this.a, this.b) < 1.4) this.ctx.game.damagePlayer(this.dmg, this.a);
      this.ctx.particles.sparksAt(this.b, UP, 30, this.color, 8, 1, 0.6);
      this.ctx.decals.add(new THREE.Vector3(this.b.x, 0.01, this.b.z), UP, 1.2, this.color, 1.5);
      this.mesh.removeFromParent();
      this.dead = true;
    }
  }
  dispose() { this.mesh.removeFromParent(); }
}

// ======================================================================================
/** Sector 1 — THE FOREMAN. A 5 m android; shooting its arms off moves it through phases. */
class Foreman implements Boss {
  name = 'THE FOREMAN';
  a: Android;
  dead = false;
  phase = 1;
  private limb = { L: 480, R: 480 };
  private attackT = 3;
  private windup = 0;
  private act = '';
  private burst = 0; private burstT = 0;
  private rings: Shockwave[] = [];
  private airborne = false;
  private rushT = 0; private rushDir = new THREE.Vector3();
  private deathT = -1;
  brain: any;

  constructor(private ctx: Ctx, private room: Room, private spawn: Spawn) {
    const p = room.worldSpawn(0);
    const c = new THREE.Vector3(0, 0, -room.layout.h * 0.5);
    this.a = spawn('foreman', c.lengthSq() > 0 ? c.setY(0) : p);
    this.a.isBoss = true;
    this.a.hp = this.a.maxHp = 2600;
    this.brain = { update: (dt: number) => this.think(dt), rushing: false, alert: true, action: 'boss' };
    this.a.ai = this.brain;
    this.a.onSegHit = (seg, h, dmg) => this.onSegHit(seg, h, dmg);
    ctx.sfx.play('bossRoar', { pos: this.a.center });
    ctx.rig.addTrauma(0.4);
  }
  get hp() { return Math.max(0, this.a.hp); }
  get maxHp() { return this.a.maxHp; }
  get state() { return this.phase === 1 ? '' : this.phase === 2 ? 'ENRAGED' : 'BERSERK'; }

  private onSegHit(seg: Seg, _h: HitInfo, dmg: number) {
    const side = seg.def.name === 'uarmL' || seg.def.name === 'farmL' ? 'L' : seg.def.name === 'uarmR' || seg.def.name === 'farmR' ? 'R' : null;
    if (side && this.limb[side] > 0) {
      this.limb[side] -= dmg;
      if (this.limb[side] <= 0) {
        this.a.severSeg(this.a.body.seg('uarm' + side)!);
        this.phase++;
        this.ctx.sfx.play('bossRoar', { pos: this.a.center });
        this.ctx.hud.toast(side === 'R' ? 'WEAPON ARM DESTROYED' : 'ARM SEVERED', '#ffb02e');
        this.ctx.events.emit('bossPhase', { phase: this.phase });
        this.ctx.time.hitstop(120);
        this.ctx.rig.addTrauma(0.5);
        for (let i = 0; i < 3; i++) this.ctx.game.later(i * 0.15, () => explode(this.ctx, this.a.center.add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2)), 2.5, 0, 12, 'player', 0xffb02e));
        this.attackT = 2;
      }
      return 0.55;
    }
    return 1;
  }

  private think(dt: number) {
    const a = this.a, ctx = this.ctx;
    if (!a.alive) return;
    const pp = ctx.player.eye;
    const toP = pp.clone().sub(a.position).setY(0);
    const dist = toP.length();
    toP.normalize();
    a.aimPoint = this.limb.R > 0 ? pp.clone() : null;
    a.faceYaw = null;
    a.moveDir.copy(toP);
    a.moveSpeed = dist > 8 ? 3.2 + this.phase * 0.6 : 0.8;
    if (this.airborne) {
      a.moveSpeed = 4;
      if (a.grounded && a.vel.y <= 0) {
        this.airborne = false;
        const o = a.position.clone();
        this.rings.push(new Shockwave(ctx, o, 26, 13, 24, 0x19f0ff));
        if (this.phase >= 2) ctx.game.later(0.45, () => this.rings.push(new Shockwave(ctx, o, 26, 13, 20, 0xff2bd6)));
        ctx.rig.addTrauma(Math.max(0.2, 0.8 - dist / 40));
        ctx.sfx.play('explosion', { pos: o });
        ctx.particles.smokeAt(o, 20, 0x3a3634, 1.6, 2, 0.5, 5);
        ctx.lights.flash(o.clone().setY(1), 0x19f0ff, 60, 16, 0.4);
      }
      return;
    }
    if (this.rushT > 0) {
      this.rushT -= dt;
      a.moveDir.copy(this.rushDir); a.moveSpeed = 13; a.faceYaw = Math.atan2(-this.rushDir.x, -this.rushDir.z);
      if (dist < 3.2) { ctx.game.damagePlayer(30, a.center); ctx.game.knockPlayer(this.rushDir.clone().multiplyScalar(18).setY(8)); this.rushT = 0; }
      const hit = ctx.phys.ray(a.position.x, a.position.y + 2, a.position.z, this.rushDir.x, 0, this.rushDir.z, 3.2, groups(0xffff, G.STATIC));
      if (hit) { this.rushT = 0; ctx.rig.addTrauma(0.5); ctx.sfx.play('explosion', { pos: a.center, gain: 0.6 }); this.stun(); }
      return;
    }
    if (this.burst > 0) {
      a.moveSpeed = 0.5;
      this.burstT -= dt;
      if (this.burstT <= 0 && this.limb.R > 0) {
        this.burstT = 0.085; this.burst--;
        const m = a.muzzle();
        const tgt = pp.clone().add(ctx.player.vel.clone().multiplyScalar(0.12)).add(new THREE.Vector3((Math.random() - 0.5) * 1.5, (Math.random() - 0.5), (Math.random() - 0.5) * 1.5));
        ctx.game.enemyFire(m, tgt.sub(m).normalize(), 9, ctx.game.palette.bossTell, 36);
      }
      return;
    }
    if (this.windup > 0) {
      this.windup -= dt;
      a.flare = 1; a.flareColor.set(this.act === 'slam' ? ctx.game.palette.bossAlt : ctx.game.palette.bossTell);
      a.moveSpeed = 0.3;
      if (this.windup <= 0) this.release(toP);
      return;
    }
    this.attackT -= dt;
    if (this.attackT <= 0) {
      const opts: string[] = ['slam'];
      if (this.limb.R > 0) opts.push('burst', 'burst');
      if (this.phase >= 2) opts.push('summon');
      if (this.phase >= 3 || this.limb.R <= 0) opts.push('rush', 'rush');
      this.act = opts[Math.floor(Math.random() * opts.length)];
      if (this.act === 'summon' && ctx.game.enemies.filter((e: Android) => e.alive && e !== a).length >= 4) this.act = 'slam';
      this.windup = this.act === 'slam' ? 0.9 : this.act === 'rush' ? 0.8 : 0.6;
      ctx.sfx.play(this.act === 'rush' ? 'charger' : 'telegraph', { pos: a.center, pitch: 0.5 });
      this.attackT = (this.phase === 1 ? 3.6 : this.phase === 2 ? 2.8 : 2.2) + Math.random();
    }
  }

  private release(toP: THREE.Vector3) {
    const a = this.a, ctx = this.ctx;
    if (this.act === 'burst') { this.burst = 8 + this.phase * 3; this.burstT = 0; }
    if (this.act === 'slam') { a.vel.y = 10; a.grounded = false; this.airborne = true; }
    if (this.act === 'rush') { this.rushT = 1.6; this.rushDir.copy(toP); }
    if (this.act === 'summon') {
      for (let i = 0; i < 2; i++) this.spawn(i === 0 ? 'grunt' : 'skitter', this.room.worldSpawn(3 + Math.floor(Math.random() * 6)));
      ctx.hud.toast('REINFORCEMENTS', '#ff3b3b');
    }
  }

  private stun() {
    this.a.flare = 1; this.a.flareColor.set(0xffffff);
    this.attackT = 3.5;
    this.ctx.hud.toast('STUNNED — HIT THE CORE', '#ffffff');
  }

  update(dt: number) {
    for (const r of this.rings) r.update(dt);
    this.rings = this.rings.filter(r => { if (r.dead) r.dispose(); return !r.dead; });
    if (!this.a.alive && this.deathT < 0) {
      this.deathT = 0;
      const ctx = this.ctx;
      ctx.time.slowmo(0.2, 1.8);
      ctx.sfx.play('bossRoar', { pos: this.a.center });
      for (let i = 0; i < 6; i++) ctx.game.later(0.15 + i * 0.22, () => ctx.phys.bodyAlive(this.a.body.root.body) && explode(ctx, this.a.body.comPosition.add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3)), 3, 0, 20, 'player', i % 2 ? 0x19f0ff : 0xffb02e));
      ctx.game.later(1.6, () => { this.dead = true; });
    }
  }
  sync() {}
  dispose() { for (const r of this.rings) r.dispose(); }
}

// ======================================================================================
/** Sector 2 — THE SWITCHBOARD. Shielded while any grid pylon is lit: black out the room to hurt it. */
class Switchboard implements Boss {
  name = 'THE SWITCHBOARD';
  hp = 1900; maxHp = 1900;
  dead = false;
  private group = new THREE.Group();
  private body: RAPIER.RigidBody;
  private shieldMesh: THREE.Mesh;
  private bulbs: THREE.Mesh[] = [];
  private bulbMat: THREE.MeshBasicMaterial;
  private pylons: Fixture[] = [];
  private pylonBodies: RAPIER.RigidBody[] = [];
  private pylonMeshes: THREE.Mesh[] = [];
  private core: DynLight;
  private pos = new THREE.Vector3(0, 7, 0);
  private t = 0;
  private overload = 0;
  private attackT = 2.5;
  private novaT = 5;
  private strikes: LineStrike[] = [];
  private deathT = -1;
  private summonT = 6;
  owner: Owner;

  constructor(private ctx: Ctx, private room: Room, private spawn: Spawn) {
    const W = room.layout.w, H = room.layout.h;
    // body: switchboard panels around a core
    const panelMat = ctx.mats.get('panel');
    const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 1), ctx.mats.get('metal'));
    this.group.add(coreMesh);
    this.bulbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa030).multiplyScalar(6) });
    for (let i = 0; i < 26; i++) {
      const dir = new THREE.Vector3().randomDirection();
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.9 + Math.random() * 0.6, 0.7 + Math.random() * 0.5, 0.2), panelMat);
      p.position.copy(dir.clone().multiplyScalar(1.75)); p.lookAt(dir.clone().multiplyScalar(5));
      this.group.add(p);
      if (i % 2 === 0) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), this.bulbMat);
        b.position.copy(dir.clone().multiplyScalar(1.98)); this.group.add(b); this.bulbs.push(b);
      }
    }
    this.shieldMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(2.8, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb02e).multiplyScalar(0.6), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true }));
    this.group.add(this.shieldMesh);
    ctx.scene.add(this.group);
    this.body = ctx.phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 7, 0));
    const col = ctx.phys.world.createCollider(RAPIER.ColliderDesc.ball(2.2).setCollisionGroups(groups(G.ENEMY, ALL)).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS), this.body);
    this.owner = { kind: 'boss', surface: 'metal', boss: this, hit: (h: HitInfo) => this.hit(h) };
    ctx.phys.tag(col, this.owner);
    this.core = ctx.lights.add({ pos: this.pos, color: new THREE.Color(0xffa030), intensity: 20, radius: 16 });
    // four grid pylons
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [sx, sz] of corners) {
      const x = sx * W * 0.62, z = sz * H * 0.62;
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.4, room.layout.height, 1.4), ctx.mats.get('stained'));
      m.position.set(x, room.layout.height / 2, z); m.castShadow = true; ctx.scene.add(m); this.pylonMeshes.push(m);
      const b = ctx.phys.fixedBox(x, room.layout.height / 2, z, 0.7, room.layout.height / 2, 0.7, { kind: 'static', surface: 'concrete' }).body;
      this.pylonBodies.push(b);
      const n = new THREE.Vector3(-sx, 0, -sz).normalize();
      const fx = x + n.x * 0.78, fz = z + n.z * 0.78;
      const f = new Fixture(ctx, { kind: 'pillar', a: [fx, 1.2, fz], b: [fx, 6.5, fz], color: 0xffb02e, intensity: 9, radius: 13, breakable: true, normal: [n.x, 0, n.z] }, ctx.scene,
        (fx2, by) => { ctx.game.onFixtureBrokenPublic(fx2, by); this.checkPylons(); });
      this.pylons.push(f);
      room.fixtures.push(f);
    }
    ctx.sfx.play('bossRoar', { pos: this.pos });
    ctx.hud.toast('BREAK THE GRID PYLONS TO DROP ITS SHIELD', '#ffb02e', 3);
  }
  get shielded() { return this.overload <= 0 && this.pylons.some(p => !p.broken); }
  get state() { return this.shielded ? 'SHIELDED' : this.overload > 0 ? 'OVERLOAD' : ''; }

  private checkPylons() {
    if (this.pylons.every(p => p.broken) && this.overload <= 0) {
      this.overload = 9;
      this.ctx.hud.toast('GRID DOWN — OVERLOAD', '#ffffff', 2);
      this.ctx.sfx.play('shieldBreak', { pos: this.pos });
      this.ctx.time.hitstop(90);
      for (const f of this.room.fixtures) if (!this.pylons.includes(f)) f.light.mul = 0.3;
    }
  }

  hit(h: HitInfo) {
    if (this.dead || this.deathT >= 0) return;
    if (this.shielded) {
      this.ctx.particles.sparksAt(h.point, h.normal, 6, 0xffb02e, 5, 0.8, 0.3);
      if (h.source === 'player' && Math.random() < 0.2) this.ctx.hud.toast('SHIELDED', '#ffb02e', 0.5);
      return;
    }
    const dmg = h.damage * (h.source === 'kinetic' ? 1.5 : 1);
    this.hp -= dmg;
    h.dealt = dmg;
    this.ctx.hud.hitmarker(h.damage > 60 ? 'head' : 'hit');
    this.ctx.sfx.play('impactMetal', { pos: h.point });
    this.ctx.events.emit('enemyHit', { hit: h, enemy: this });
    if (this.hp <= 0) this.die();
  }

  private die() {
    const ctx = this.ctx;
    this.deathT = 0;
    ctx.time.slowmo(0.2, 1.8);
    ctx.sfx.play('bossRoar', { pos: this.pos });
    for (let i = 0; i < 7; i++) ctx.game.later(i * 0.2, () => explode(ctx, this.pos.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(2)), 3.5, 0, 25, 'player', 0xffa030));
    ctx.game.later(1.4, () => {
      for (const c of [...this.group.children]) {
        if (!(c as THREE.Mesh).isMesh || c === this.shieldMesh) continue;
        const m = c as THREE.Mesh;
        const wp = m.getWorldPosition(new THREE.Vector3());
        m.geometry.computeBoundingBox();
        const s = new THREE.Vector3(); m.geometry.boundingBox!.getSize(s);
        const q = m.getWorldQuaternion(new THREE.Quaternion());
        ctx.game.debris.spawn(new THREE.Mesh(m.geometry, m.material), wp, q, [Math.max(0.05, s.x / 2), Math.max(0.05, s.y / 2), Math.max(0.05, s.z / 2)], wp.clone().sub(this.pos).normalize().multiplyScalar(9).setY(4), 500);
      }
      this.group.removeFromParent();
      ctx.lights.flash(this.pos, 0xffffff, 200, 40, 0.6);
      ctx.phys.removeBody(this.body);
      for (const f of this.room.fixtures) f.light.mul = 1;
      this.dead = true;
      ctx.events.emit('enemyKilled', { hit: { point: this.pos, normal: UP, dir: UP, damage: 0, impulse: 0, source: 'player' }, enemy: { stats: { score: 4000 }, isBoss: true }, headshot: false, kinetic: false, bulletTime: false, pos: this.pos.clone() });
    });
  }

  update(dt: number) {
    if (this.dead) return;
    const ctx = this.ctx;
    this.t += dt;
    for (const s of this.strikes) s.update(dt);
    this.strikes = this.strikes.filter(s => !s.dead);
    if (this.deathT >= 0) { this.group.rotation.y += dt * 4; this.group.position.y -= dt * 2; this.pos.copy(this.group.position); return; }
    const phase2 = this.hp < this.maxHp * 0.5;
    // movement
    const targetY = this.overload > 0 ? 3.2 : 7 + Math.sin(this.t * 0.8) * 0.6;
    const orbit = phase2 ? 7 : 0;
    const tx = Math.cos(this.t * 0.35) * orbit, tz = Math.sin(this.t * 0.35) * orbit;
    this.pos.x += (tx - this.pos.x) * Math.min(1, dt); this.pos.z += (tz - this.pos.z) * Math.min(1, dt);
    this.pos.y += (targetY - this.pos.y) * Math.min(1, dt * 1.5);
    this.body.setNextKinematicTranslation(this.pos);
    this.core.pos.copy(this.pos);
    // overload window
    if (this.overload > 0) {
      this.overload -= dt;
      this.core.intensity = Math.random() < 0.2 ? 4 : 14;
      if (this.overload <= 0) {
        for (const p of this.pylons) p.repair();
        for (const f of this.room.fixtures) f.light.mul = 1;
        ctx.hud.toast('GRID REBOOTED', '#ffb02e');
        ctx.sfx.play('lumenBurst');
      }
      return; // no attacks while overloaded — punish window
    }
    this.core.intensity = 20;
    // attacks
    this.attackT -= dt;
    if (this.attackT <= 0) {
      this.attackT = phase2 ? 1.9 : 2.8;
      const target = ctx.player.pos.clone().setY(0.2).add(ctx.player.vel.clone().setY(0).multiplyScalar(0.4));
      const n = phase2 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const off = new THREE.Vector3((Math.random() - 0.5) * 4 * i, 0, (Math.random() - 0.5) * 4 * i);
        this.strikes.push(new LineStrike(ctx, this.pos.clone(), target.clone().add(off), 0.8, 22, 0xffb02e));
      }
    }
    this.novaT -= dt;
    if (this.novaT <= 0) {
      this.novaT = phase2 ? 4.5 : 6.5;
      const base = this.pos.clone().setY(1.3);
      const waves = phase2 ? 3 : 2;
      for (let w = 0; w < waves; w++) ctx.game.later(w * 0.35, () => {
        const off = w * 0.2 + this.t;
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2 + off;
          ctx.game.enemyFire(base.clone(), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 12, 0xffa030, 14);
        }
      });
      ctx.lights.flash(base, 0xffa030, 40, 12, 0.3);
    }
    this.summonT -= dt;
    if (this.summonT <= 0) {
      this.summonT = 10;
      const lamp = ctx.game.enemies.filter((e: Android) => e.alive && e.type === 'lamplighter').length;
      if (this.pylons.filter(p => p.broken).length >= 2 && lamp < 2) { this.spawn('lamplighter', this.room.worldSpawn(Math.floor(Math.random() * 8))); ctx.hud.toast('REPAIR DRONE INBOUND', '#fff1b0'); }
      else if (phase2) this.spawn('shade', this.room.worldSpawn(Math.floor(Math.random() * 8)));
    }
  }

  sync() {
    if (this.deathT < 0) this.group.position.copy(this.pos);
    this.group.rotation.y += 0.004;
    this.shieldMesh.visible = this.shielded;
    this.shieldMesh.rotation.x += 0.01;
    const k = this.overload > 0 ? (Math.random() < 0.3 ? 0.5 : 8) : 6;
    this.bulbMat.color.set(0xffa030).multiplyScalar(k);
  }
  dispose() {
    this.group.removeFromParent();
    if (!this.dead) this.ctx.phys.removeBody(this.body);
    for (const b of this.pylonBodies) this.ctx.phys.removeBody(b);
    for (const m of this.pylonMeshes) m.removeFromParent();
    this.ctx.lights.remove(this.core);
    for (const s of this.strikes) s.dispose();
  }
}

// ======================================================================================
interface Tendril { segs: RAPIER.RigidBody[]; meshes: THREE.Mesh[]; rootJoint: RAPIER.ImpulseJoint | null; anchor: RAPIER.RigidBody; light: DynLight; hp: number; attached: boolean; phase: number; lash: number; tear: number; }

/** Sector 3 — THE FILAMENT. A core of light held up by physical tendrils. Sever them — shoot or rip — to reach it. */
class Filament implements Boss {
  name = 'THE FILAMENT';
  hp = 2600; maxHp = 2600;
  dead = false;
  private group = new THREE.Group();
  private body: RAPIER.RigidBody;
  private core: DynLight;
  private halo: THREE.Mesh;
  private tendrils: Tendril[] = [];
  private pos = new THREE.Vector3(0, 7.5, 0);
  private t = 0;
  private beamT = 5; private beam: { t: number; dir: THREE.Vector3; mesh: THREE.Mesh; light: DynLight; telegraph: number } | null = null;
  private lashT = 3;
  private spiralT = 7;
  private phase2 = false;
  private deathT = -1;
  private segGeo = new THREE.CapsuleGeometry(0.13, 0.7, 4, 8);
  private segMat: THREE.MeshBasicMaterial;
  owner: Owner;

  constructor(private ctx: Ctx, private room: Room, private spawn: Spawn) {
    const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.3, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.75, 1).multiplyScalar(9) }));
    this.group.add(coreMesh);
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.05, 6, 64), ctx.mats.neon(0xff2bd6, 8));
    this.group.add(this.halo);
    ctx.scene.add(this.group);
    this.body = ctx.phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pos.x, this.pos.y, this.pos.z));
    const col = ctx.phys.world.createCollider(RAPIER.ColliderDesc.ball(1.4).setCollisionGroups(groups(G.ENEMY, ALL)).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS), this.body);
    this.owner = { kind: 'boss', surface: 'glass', boss: this, hit: (h: HitInfo) => this.hit(h) };
    ctx.phys.tag(col, this.owner);
    this.core = ctx.lights.add({ pos: this.pos, color: new THREE.Color(0xffc0ff), intensity: 16, radius: 16 });
    this.segMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2bd6).multiplyScalar(4) });
    for (let i = 0; i < 6; i++) this.tendrils.push(this.makeTendril(i));
    ctx.sfx.play('bossRoar', { pos: this.pos });
    ctx.hud.toast('SEVER THE TENDRILS — SHOOT THEM OR TEAR THEM OFF', '#ff2bd6', 3.2);
  }

  private makeTendril(i: number): Tendril {
    const w = this.ctx.phys.world;
    const a = (i / 6) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(a), -0.35, Math.sin(a)).normalize();
    const root = this.pos.clone().addScaledVector(dir, 1.4);
    const anchor = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(root.x, root.y, root.z));
    const segs: RAPIER.RigidBody[] = [], meshes: THREE.Mesh[] = [];
    const L = 0.95, N = 9;
    let prev = anchor;
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().negate());
    const t: Tendril = { segs, meshes, rootJoint: null, anchor, light: null as any, hp: 240, attached: true, phase: Math.random() * 6, lash: 0, tear: 0 };
    for (let k = 0; k < N; k++) {
      const c = root.clone().addScaledVector(dir, L * (k + 0.5));
      const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(c.x, c.y, c.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setGravityScale(0).setLinearDamping(1.6).setAngularDamping(2));
      const col = w.createCollider(RAPIER.ColliderDesc.capsule(L * 0.4, k === N - 1 ? 0.28 : 0.14).setDensity(40).setCollisionGroups(groups(G.RAGDOLL, G.STATIC | G.PROP | G.DEBRIS | G.HELD)), b);
      this.ctx.phys.tag(col, { kind: 'boss', surface: 'glass', hit: (h: HitInfo) => this.hitTendril(t, h) });
      const jd = RAPIER.JointData.spherical(k === 0 ? { x: 0, y: 0, z: 0 } : { x: 0, y: -L / 2, z: 0 }, { x: 0, y: L / 2, z: 0 });
      const j = w.createImpulseJoint(jd, prev, b, true);
      j.setContactsEnabled(false);
      if (k === 0) t.rootJoint = j;
      const m = new THREE.Mesh(k === N - 1 ? new THREE.SphereGeometry(0.32, 12, 10) : this.segGeo, k === N - 1 ? new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.9, 1).multiplyScalar(8) }) : this.segMat);
      this.ctx.scene.add(m);
      segs.push(b); meshes.push(m);
      prev = b;
    }
    t.light = this.ctx.lights.add({ type: LightType.Tube, pos: root, pos2: root.clone().addScaledVector(dir, L * N), color: new THREE.Color(0xff2bd6), intensity: 8, radius: 6 });
    return t;
  }

  get attachedCount() { return this.tendrils.filter(t => t.attached).length; }
  get state() { const n = this.attachedCount; return n > 0 ? `${n} TENDRILS` : 'EXPOSED'; }

  private hitTendril(t: Tendril, h: HitInfo) {
    if (!t.attached) { const b = h.collider?.parent(); if (b && b.isDynamic()) b.applyImpulse({ x: h.dir.x * h.impulse, y: h.dir.y * h.impulse, z: h.dir.z * h.impulse }, true); return; }
    t.hp -= h.damage;
    this.ctx.hud.hitmarker('hit');
    const b = h.collider?.parent();
    if (b) b.applyImpulse({ x: h.dir.x * h.impulse * 0.5, y: h.dir.y * h.impulse * 0.5, z: h.dir.z * h.impulse * 0.5 }, true);
    this.ctx.particles.sparksAt(h.point, h.normal, 8, 0xff9aff, 6, 0.8, 0.3);
    if (t.hp <= 0) this.sever(t);
  }

  private sever(t: Tendril) {
    if (!t.attached) return;
    t.attached = false;
    const ctx = this.ctx;
    if (t.rootJoint) ctx.phys.world.removeImpulseJoint(t.rootJoint, true);
    t.rootJoint = null;
    for (const s of t.segs) { s.setGravityScale(1, true); s.setLinearDamping(0.1); s.setAngularDamping(0.4); for (let i = 0; i < s.numColliders(); i++) s.collider(i).setCollisionGroups(groups(G.RAGDOLL, G.STATIC | G.PROP | G.RAGDOLL | G.DEBRIS | G.HELD)); }
    t.light.enabled = false;
    const tp = t.segs[0].translation();
    ctx.particles.sparksAt(new THREE.Vector3(tp.x, tp.y, tp.z), UP, 60, 0xffc0ff, 10, 1.5, 0.9);
    ctx.lights.flash(new THREE.Vector3(tp.x, tp.y, tp.z), 0xff2bd6, 60, 12, 0.4);
    ctx.sfx.play('snap', { pos: new THREE.Vector3(tp.x, tp.y, tp.z) });
    ctx.sfx.play('fixturePop', { pos: new THREE.Vector3(tp.x, tp.y, tp.z) });
    ctx.hud.feedMsg('TENDRIL SEVERED', 250, '#ff2bd6');
    ctx.run.score += 250;
    ctx.run.addFocus(0.35);
    ctx.time.hitstop(80);
    const dead = new THREE.MeshBasicMaterial({ color: 0x3a1030 });
    for (const m of t.meshes) if (m.material === this.segMat) m.material = dead;
    if (this.attachedCount === 0) ctx.hud.toast('CORE EXPOSED', '#ffffff', 2);
  }

  hit(h: HitInfo) {
    if (this.dead || this.deathT >= 0) return;
    const n = this.attachedCount;
    const k = n >= 3 ? 0.15 : n > 0 ? 0.45 : 1;
    h.dealt = h.damage * k * (h.source === 'kinetic' ? 1.6 : 1);
    this.hp -= h.dealt;
    this.ctx.hud.hitmarker(k < 0.3 ? 'hit' : 'head');
    this.ctx.particles.sparksAt(h.point, h.normal, 10, 0xffffff, 7, 1, 0.3);
    this.ctx.events.emit('enemyHit', { hit: h, enemy: this });
    if (!this.phase2 && this.hp < this.maxHp * 0.5) {
      this.phase2 = true;
      this.ctx.hud.toast('THE LIGHTS DIM', '#ff2bd6');
      for (const f of this.room.fixtures) f.light.mul = 0.35;
      for (let i = 0; i < 3; i++) this.spawn('shade', this.room.worldSpawn(i * 3 + 1));
    }
    if (this.hp <= 0) this.die();
  }

  private die() {
    const ctx = this.ctx;
    this.deathT = 0;
    for (const t of this.tendrils) this.sever(t);
    ctx.time.slowmo(0.15, 2.4);
    ctx.sfx.play('bossRoar', { pos: this.pos });
    ctx.sfx.play('btIn');
    // cascade: every light in the arcology goes out
    const fx = [...this.room.fixtures].sort((a, b) => a.pos.distanceTo(this.pos) - b.pos.distanceTo(this.pos));
    fx.forEach((f, i) => ctx.game.later(0.4 + i * 0.07, () => f.hit({ point: f.pos, normal: UP, dir: UP, damage: 99, impulse: 0, source: 'player' })));
    ctx.game.later(1.2, () => {
      ctx.lights.flash(this.pos, 0xffffff, 400, 60, 1.2);
      ctx.renderer.caPulse = 1;
      explode(ctx, this.pos, 6, 0, 40, 'player', 0xffc0ff);
      this.group.removeFromParent();
      ctx.lights.remove(this.core);
      ctx.phys.removeBody(this.body);
      this.dead = true;
      ctx.events.emit('enemyKilled', { hit: { point: this.pos, normal: UP, dir: UP, damage: 0, impulse: 0, source: 'player' }, enemy: { stats: { score: 6000 }, isBoss: true }, headshot: false, kinetic: false, bulletTime: false, pos: this.pos.clone() });
    });
  }

  update(dt: number) {
    if (this.dead) return;
    const ctx = this.ctx;
    this.t += dt;
    if (this.deathT >= 0) { this.pos.y += dt * 0.5; this.halo.scale.multiplyScalar(1 + dt * 2); return; }
    this.pos.y = 7.5 + Math.sin(this.t * 0.9) * 0.4 - (this.attachedCount === 0 ? 3.5 : 0) * Math.min(1, this.t * 0.02 + 0.5);
    this.body.setNextKinematicTranslation(this.pos);
    this.core.pos.copy(this.pos);
    const pp = ctx.player.pos;
    // tendrils: anchors orbit the core; tips sweep the floor or lash at the player
    this.tendrils.forEach((t, i) => {
      const a = (i / 6) * Math.PI * 2 + this.t * 0.25;
      const dir = new THREE.Vector3(Math.cos(a), -0.35, Math.sin(a)).normalize();
      const root = this.pos.clone().addScaledVector(dir, 1.4);
      t.anchor.setNextKinematicTranslation(root);
      if (!t.attached) return;
      const tip = t.segs[t.segs.length - 1];
      const tp = tip.translation();
      let target: THREE.Vector3;
      if (t.lash > 0) { t.lash -= dt; target = pp.clone(); }
      else {
        const sweep = a + Math.sin(this.t * 0.7 + t.phase) * 0.8;
        const r = 9 + Math.sin(this.t * 0.5 + t.phase) * 3;
        target = new THREE.Vector3(Math.cos(sweep) * r, 1 + Math.sin(this.t * 1.3 + t.phase) * 0.8, Math.sin(sweep) * r);
      }
      const f = target.sub(new THREE.Vector3(tp.x, tp.y, tp.z)).multiplyScalar(t.lash > 0 ? 7 : 2.2);
      tip.applyImpulse({ x: f.x * tip.mass() * dt, y: f.y * tip.mass() * dt, z: f.z * tip.mass() * dt }, true);
      // contact damage anywhere along the tendril
      for (let k = 2; k < t.segs.length; k++) {
        const s = t.segs[k].translation();
        if (Math.hypot(s.x - pp.x, s.y - pp.y, s.z - pp.z) < 1.0) { ctx.game.damagePlayer(t.lash > 0 ? 18 : 10, new THREE.Vector3(s.x, s.y, s.z)); t.lash = 0; break; }
      }
      // tearing with the kinetic hand
      const held = ctx.game.kinetic.held.some((h: any) => t.segs.includes(h.body));
      if (held) {
        t.tear += dt * (0.5 + ctx.game.kinetic.strain);
        if (Math.random() < 0.5) ctx.particles.sparksAt(new THREE.Vector3(tp.x, tp.y, tp.z), UP, 2, 0xffc0ff, 5, 1, 0.3);
        if (t.tear > 1.3) { ctx.game.kinetic.drop(); this.sever(t); ctx.hud.feedMsg('TORN OUT', 300, '#19f0ff'); }
      } else t.tear = Math.max(0, t.tear - dt);
    });
    // lash attack
    this.lashT -= dt;
    if (this.lashT <= 0) {
      this.lashT = this.phase2 ? 2.2 : 3.4;
      const cands = this.tendrils.filter(t => t.attached);
      const t = cands[Math.floor(Math.random() * cands.length)];
      if (t) { ctx.game.later(0.5, () => { t.lash = 0.9; }); t.meshes.forEach(m => m.scale.setScalar(1.4)); ctx.game.later(0.5, () => t.meshes.forEach(m => m.scale.setScalar(1))); ctx.sfx.play('telegraph', { pos: this.pos, pitch: 0.7 }); }
    }
    // tracking beam
    this.beamT -= dt;
    if (!this.beam && this.beamT <= 0) {
      this.beamT = this.phase2 ? 5 : 7;
      const dir = pp.clone().sub(this.pos).normalize();
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 1, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(ctx.game.palette.beam).multiplyScalar(8), transparent: true, opacity: 0.2 }));
      ctx.scene.add(mesh);
      this.beam = { t: 0, dir, mesh, light: ctx.lights.add({ type: LightType.Tube, pos: this.pos, pos2: this.pos, color: new THREE.Color(ctx.game.palette.beam), intensity: 0, radius: 6 }), telegraph: 1 };
      ctx.sfx.play('railCharge', { pos: this.pos });
    }
    if (this.beam) {
      const bm = this.beam;
      bm.t += dt;
      const want = pp.clone().setY(pp.y - 0.3).sub(this.pos).normalize();
      bm.dir.lerp(want, Math.min(1, dt * (bm.t < bm.telegraph ? 3 : 0.9))).normalize();
      const hit = ctx.phys.ray(this.pos.x, this.pos.y, this.pos.z, bm.dir.x, bm.dir.y, bm.dir.z, 80, groups(0xffff, G.STATIC));
      const end = hit ? new THREE.Vector3(hit.x, hit.y, hit.z) : this.pos.clone().addScaledVector(bm.dir, 80);
      const len = end.distanceTo(this.pos);
      const firing = bm.t >= bm.telegraph;
      bm.mesh.position.copy(this.pos).add(end).multiplyScalar(0.5);
      bm.mesh.quaternion.setFromUnitVectors(UP, bm.dir);
      bm.mesh.scale.set(firing ? 2.2 : 0.3, len, firing ? 2.2 : 0.3);
      (bm.mesh.material as THREE.MeshBasicMaterial).opacity = firing ? 0.95 : 0.25 + 0.2 * Math.sin(bm.t * 40);
      bm.light.pos.copy(this.pos); bm.light.pos2.copy(end); bm.light.intensity = firing ? 30 : 3;
      if (firing) {
        if (distToSegment(ctx.player.eye, this.pos, end) < 0.9) ctx.game.damagePlayer(40 * dt, this.pos);
        ctx.particles.sparksAt(end, hit ? new THREE.Vector3(hit.nx, hit.ny, hit.nz) : UP, 4, 0xffc0ff, 8, 1, 0.4);
        if (Math.random() < 0.3) ctx.decals.add(end, hit ? new THREE.Vector3(hit.nx, hit.ny, hit.nz) : UP, 0.6, 0xff2bd6, 1.2);
        ctx.rig.addTrauma(0.01);
      }
      if (bm.t > bm.telegraph + 1.8) { bm.mesh.removeFromParent(); ctx.lights.remove(bm.light); this.beam = null; }
    }
    // spiral bolts
    this.spiralT -= dt;
    if (this.spiralT <= 0) {
      this.spiralT = this.phase2 ? 5 : 8;
      for (let i = 0; i < 24; i++) ctx.game.later(i * 0.05, () => {
        const a = i * 0.55 + this.t;
        ctx.game.enemyFire(this.pos.clone(), new THREE.Vector3(Math.cos(a), -0.28, Math.sin(a)).normalize(), 10, 0xff2bd6, 16);
      });
    }
  }

  sync() {
    if (this.dead) return;
    this.group.position.copy(this.pos);
    this.halo.rotation.x = Math.PI / 2 + Math.sin(this.t * 0.7) * 0.3;
    this.halo.rotation.z += 0.01;
    for (const t of this.tendrils) {
      t.segs.forEach((s, k) => { const p = s.translation(), r = s.rotation(); t.meshes[k].position.set(p.x, p.y, p.z); t.meshes[k].quaternion.set(r.x, r.y, r.z, r.w); });
      if (t.attached) {
        const a = t.segs[0].translation(), b = t.segs[t.segs.length - 1].translation();
        t.light.pos.set(a.x, a.y, a.z); t.light.pos2.set(b.x, b.y, b.z);
      }
    }
  }

  dispose() {
    this.group.removeFromParent();
    if (this.beam) { this.beam.mesh.removeFromParent(); this.ctx.lights.remove(this.beam.light); }
    for (const t of this.tendrils) {
      for (const s of t.segs) { this.ctx.game.kinetic.forgetBody(s); this.ctx.phys.removeBody(s); }
      this.ctx.phys.removeBody(t.anchor);
      for (const m of t.meshes) m.removeFromParent();
      this.ctx.lights.remove(t.light);
    }
    if (!this.dead) { this.ctx.phys.removeBody(this.body); this.ctx.lights.remove(this.core); }
  }
}
