import * as THREE from 'three';
import type { Ctx } from '../types';
import { Android } from './android';
import { G, groups } from '../../physics/world';

export interface Nav { next(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3; randomNear(p: THREE.Vector3, rMin: number, rMax: number): THREE.Vector3 | null; darkSpotNear?(p: THREE.Vector3): THREE.Vector3 | null }

const LOS_FILTER = groups(0xffff, G.STATIC);
const _v = new THREE.Vector3();

export interface Action { name: string; score: number }

/**
 * Utility AI: every 0.2 s each android scores a handful of actions against the situation
 * (distance, line of sight, hp, cooldowns, light) and commits to the best; a tiny per-type
 * state machine executes it. Every attack has a light-based telegraph (core flare).
 */
export class AndroidAI {
  think = Math.random() * 0.2;
  action = 'idle';
  scores: Action[] = [];
  cooldown = 1 + Math.random() * 1.5;
  windup = 0;
  burst = 0;
  burstT = 0;
  goal: THREE.Vector3 | null = null;
  strafeSign = Math.random() < 0.5 ? -1 : 1;
  rushing = false;
  rushT = 0;
  rushDir = new THREE.Vector3();
  leaping = false;
  lunging = false;
  target: Android | null = null;
  beamT = 0;
  los = false;
  dist = 99;
  alert = false;
  hitPlayerThisAttack = false;

  constructor(private ctx: Ctx, readonly a: Android, private nav: Nav, private allies: () => Android[]) { a.ai = this; }

  private hasLOS(from: THREE.Vector3, to: THREE.Vector3) {
    const d = _v.copy(to).sub(from);
    const len = d.length();
    if (len < 0.01) return true;
    d.divideScalar(len);
    return !this.ctx.phys.ray(from.x, from.y, from.z, d.x, d.y, d.z, len - 0.3, LOS_FILTER);
  }

  update(dt: number) {
    const a = this.a, ctx = this.ctx;
    if (a.state !== 'alive') { this.rushing = this.leaping = this.lunging = false; a.moveSpeed = 0; return; }
    const player = ctx.player;
    const ppos = player.eye;
    const me = a.center;
    this.dist = me.distanceTo(ppos);
    this.cooldown -= dt;
    this.think -= dt;
    if (this.think <= 0) {
      this.think = 0.2;
      this.los = this.hasLOS(a.stats.flying ? me : me.clone().setY(me.y + 0.5 * a.stats.scale), ppos);
      if (this.los || this.dist < 12) this.alert = true;
      this.decide();
    }
    this.execute(dt, ppos);
  }

  private decide() {
    const a = this.a, st = a.stats;
    const d = this.dist, hpK = a.hp / a.maxHp;
    const s: Action[] = [];
    switch (a.type) {
      case 'grunt': case 'foreman': {
        s.push({ name: 'shoot', score: this.los && this.cooldown <= 0 && d < st.range ? 0.9 : 0 });
        s.push({ name: 'advance', score: !this.los || d > 20 ? 0.6 : 0.1 });
        s.push({ name: 'retreat', score: d < 7 ? 0.7 : 0 });
        s.push({ name: 'strafe', score: this.los ? 0.45 : 0.1 });
        s.push({ name: 'cover', score: hpK < 0.4 && this.los ? 0.55 : 0 });
        break;
      }
      case 'charger': {
        s.push({ name: 'rush', score: this.los && this.cooldown <= 0 && d < 16 && d > 3 ? 0.95 : 0 });
        s.push({ name: 'smash', score: d < st.range + 0.5 && this.cooldown <= 0 ? 1 : 0 });
        s.push({ name: 'advance', score: 0.5 });
        break;
      }
      case 'skitter': {
        s.push({ name: 'leap', score: this.los && d < 7 && d > 2.5 && this.cooldown <= 0 ? 0.95 : 0 });
        s.push({ name: 'bite', score: d < st.range && this.cooldown <= 0 ? 1 : 0 });
        s.push({ name: 'swarm', score: 0.5 });
        break;
      }
      case 'shade': {
        s.push({ name: 'lunge', score: d < 4 && this.cooldown <= 0 ? 1 : 0 });
        s.push({ name: 'stalk', score: 0.5 + (a.visibility > 0.5 ? 0.2 : 0) });
        s.push({ name: 'hide', score: a.visibility > 0.6 && d > 6 ? 0.6 : 0 });
        break;
      }
      case 'lamplighter': {
        const broken = this.ctx.game.nearestBrokenFixture?.(a.center, 30);
        s.push({ name: 'repair', score: broken ? 0.8 : 0 });
        s.push({ name: 'shield', score: this.cooldown <= 0 ? 0.7 : 0 });
        s.push({ name: 'flee', score: this.dist < 8 ? 0.9 : 0 });
        s.push({ name: 'hover', score: 0.3 });
        break;
      }
    }
    // stickiness: prefer continuing current action slightly
    for (const x of s) if (x.name === this.action) x.score += 0.08;
    s.sort((p, q) => q.score - p.score);
    this.scores = s;
    const best = s[0]?.name ?? 'idle';
    if (!this.alert) { this.action = 'idle'; return; }
    if (this.windup > 0 || this.rushing || this.leaping || this.lunging || this.burst > 0) return; // committed
    if (best !== this.action) { this.action = best; this.goal = null; this.onEnter(best); }
  }

  private onEnter(name: string) {
    const a = this.a, ctx = this.ctx;
    const tellColor = a.stats.attackColor;
    if (name === 'shoot') { this.windup = 0.6; a.flare = 1; a.flareColor.set(tellColor); ctx.sfx.play('telegraph', { pos: a.center, pitch: 1 }); }
    if (name === 'rush') { this.windup = 0.65; a.flare = 1; a.flareColor.set(tellColor); ctx.sfx.play('charger', { pos: a.center }); }
    if (name === 'smash') { this.windup = 0.4; a.flare = 1; a.flareColor.set(tellColor); }
    if (name === 'leap') { this.windup = 0.45; a.flare = 1; a.flareColor.set(tellColor); ctx.sfx.play('skitter', { pos: a.center }); }
    if (name === 'bite') { this.windup = 0.35; a.flare = 1; a.flareColor.set(tellColor); }
    if (name === 'lunge') { this.windup = 0.38; a.flare = 1; a.flareColor.set(tellColor); ctx.sfx.play('telegraph', { pos: a.center, pitch: 0.6 }); }
    if (name === 'strafe') this.strafeSign *= -1;
  }

  private execute(dt: number, ppos: THREE.Vector3) {
    const a = this.a, ctx = this.ctx, st = a.stats;
    const me = a.position;
    a.aimPoint = null; a.faceYaw = null;
    a.moveDir.set(0, 0, 0);
    a.moveSpeed = st.speed;
    const toP = _v.copy(ppos).sub(me).setY(0);
    const dist = toP.length();
    const toPn = toP.clone().divideScalar(dist || 1);
    const sep = this.separation();

    if (this.windup > 0) {
      this.windup -= dt;
      a.flare = 1;
      a.moveSpeed = st.speed * 0.2;
      if (a.type !== 'lamplighter') a.aimPoint = ppos.clone();
      if (this.windup <= 0) this.release(ppos, toPn);
      return;
    }
    if (this.burst > 0) {
      a.aimPoint = ppos.clone().add(ctx.player.vel.clone().multiplyScalar(0.15));
      a.moveSpeed = 0.5;
      this.burstT -= dt;
      if (this.burstT <= 0) {
        this.burstT = a.type === 'foreman' ? 0.09 : 0.14;
        this.burst--;
        const m = a.muzzle();
        const aimAt = a.aimPoint.clone().add(new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5) * 0.6, (Math.random() - 0.5)).multiplyScalar(1.1 + this.dist * 0.04));
        ctx.game.enemyFire(m, aimAt.sub(m).normalize(), st.dmg, st.attackColor, a.type === 'foreman' ? 32 : 26);
        if (this.burst <= 0) this.cooldown = st.fireRate * (0.7 + Math.random() * 0.6);
      }
      return;
    }
    if (this.rushing) {
      this.rushT -= dt;
      a.moveDir.copy(this.rushDir); a.moveSpeed = 14;
      a.faceYaw = Math.atan2(-this.rushDir.x, -this.rushDir.z);
      if (Math.random() < 0.5) ctx.particles.sparksAt(me.clone().setY(me.y + 0.05), new THREE.Vector3(0, 1, 0), 1, 0xffb02e, 4, 1, 0.3);
      if (dist < 1.6 * st.scale && !this.hitPlayerThisAttack) {
        this.hitPlayerThisAttack = true;
        ctx.game.damagePlayer(st.dmg, a.center);
        ctx.game.knockPlayer(this.rushDir.clone().add(new THREE.Vector3(0, 0.5, 0)).multiplyScalar(16));
      }
      // hit a wall at speed → stunned
      const blocked = ctx.phys.ray(me.x, me.y + 1, me.z, this.rushDir.x, 0, this.rushDir.z, 1.3 * st.scale, LOS_FILTER);
      if (blocked || this.rushT <= 0) {
        this.rushing = false; this.cooldown = 2.5;
        if (blocked) { a.stagger(undefined, undefined, 1.6); ctx.rig.addTrauma(0.3 * Math.max(0, 1 - this.dist / 20)); ctx.sfx.play('impactMetal', { pos: me, gain: 2 }); ctx.particles.sparksAt(me.clone().setY(me.y + 1.3), this.rushDir.clone().negate(), 30, 0xffb02e, 8, 1, 0.6); }
      }
      return;
    }
    if (this.leaping) {
      a.moveDir.copy(this.rushDir); a.moveSpeed = 11;
      if (dist < 1.5 && !this.hitPlayerThisAttack) { this.hitPlayerThisAttack = true; ctx.game.damagePlayer(st.dmg, a.center); }
      if (a.grounded && a.vel.y <= 0) { this.leaping = false; this.cooldown = 1.2 + Math.random(); }
      return;
    }
    if (this.lunging) {
      this.rushT -= dt;
      a.moveDir.copy(this.rushDir); a.moveSpeed = 16;
      if (dist < 1.8 && !this.hitPlayerThisAttack) { this.hitPlayerThisAttack = true; ctx.game.damagePlayer(st.dmg, a.center); }
      if (this.rushT <= 0) { this.lunging = false; this.cooldown = 1.4; }
      return;
    }

    switch (this.action) {
      case 'idle': a.moveSpeed = 0; break;
      case 'shoot': case 'strafe': {
        a.aimPoint = ppos.clone();
        const side = new THREE.Vector3(-toPn.z, 0, toPn.x).multiplyScalar(this.strafeSign);
        a.moveDir.copy(side).addScaledVector(sep, 1.5);
        a.moveSpeed = st.speed * 0.6;
        if (Math.random() < dt * 0.4) this.strafeSign *= -1;
        break;
      }
      case 'advance': case 'swarm': case 'stalk': {
        const wp = this.nav.next(me, ppos.clone().setY(me.y));
        a.moveDir.copy(wp.sub(me).setY(0).normalize()).addScaledVector(sep, 1.2);
        if (a.type === 'skitter') { const z = Math.sin(performance.now() / 180 + a.id) * 0.6; a.moveDir.addScaledVector(new THREE.Vector3(-toPn.z, 0, toPn.x), z); }
        if (a.type === 'shade') a.moveSpeed = st.speed * (a.visibility > 0.5 ? 1.2 : 0.8);
        if (this.los) a.aimPoint = ppos.clone();
        break;
      }
      case 'retreat': {
        a.aimPoint = ppos.clone();
        a.moveDir.copy(toPn).negate().addScaledVector(sep, 1);
        a.moveSpeed = st.speed * 0.8;
        break;
      }
      case 'cover': {
        if (!this.goal) this.goal = this.findCover(ppos);
        if (this.goal) { a.moveDir.copy(this.nav.next(me, this.goal).sub(me).setY(0).normalize()); if (me.distanceTo(this.goal) < 1) { this.goal = null; this.action = 'strafe'; } }
        break;
      }
      case 'hide': {
        if (!this.goal) this.goal = this.nav.darkSpotNear?.(me) ?? this.nav.randomNear(me, 4, 10);
        if (this.goal) a.moveDir.copy(this.nav.next(me, this.goal).sub(me).setY(0).normalize());
        a.moveSpeed = st.speed * 1.2;
        break;
      }
      case 'repair': {
        const f = ctx.game.nearestBrokenFixture(a.center, 30);
        if (!f) break;
        const hover = f.pos.clone().add(new THREE.Vector3(0, -1.2, 0));
        const d = hover.clone().sub(a.center);
        a.moveDir.copy(d.normalize()); a.moveDir.y = THREE.MathUtils.clamp(d.y, -1, 1);
        a.faceYaw = Math.atan2(-(f.pos.x - me.x), -(f.pos.z - me.z));
        if (a.center.distanceTo(f.pos) < 3.2) {
          a.moveSpeed = 0.5;
          this.beamT += dt;
          ctx.game.drawBeam(a.center, f.pos, 0xfff1b0);
          if (this.beamT > 2.2) { ctx.game.repairFixture(f); this.beamT = 0; }
        } else this.beamT = 0;
        break;
      }
      case 'shield': {
        const ally = this.allies().filter(x => x !== a && x.alive && x.type !== 'lamplighter').sort((p, q) => p.center.distanceTo(a.center) - q.center.distanceTo(a.center))[0];
        if (ally) {
          const d = ally.center.clone().add(new THREE.Vector3(0, 2, 0)).sub(a.center);
          a.moveDir.copy(d.normalize());
          if (a.center.distanceTo(ally.center) < 9) {
            ally.shield = Math.min(ally.maxHp * 0.5, ally.shield + 30);
            ctx.game.drawBeam(a.center, ally.center, 0xfff1b0, 0.4);
            this.cooldown = 3.5; this.action = 'hover';
          }
        } else this.action = 'hover';
        break;
      }
      case 'flee': {
        const away = a.center.clone().sub(ppos).setY(0).normalize();
        a.moveDir.copy(away).addScaledVector(sep, 1); a.moveDir.y = 0.3;
        a.moveSpeed = st.speed * 1.3;
        break;
      }
      case 'hover': {
        a.aimPoint = ppos.clone();
        a.moveDir.copy(sep); a.moveDir.y = Math.sin(performance.now() / 900 + a.id) * 0.4;
        a.moveSpeed = 1.5;
        break;
      }
      default: break;
    }
  }

  private release(ppos: THREE.Vector3, toPn: THREE.Vector3) {
    const a = this.a, ctx = this.ctx;
    this.hitPlayerThisAttack = false;
    switch (this.action) {
      case 'shoot': this.burst = a.type === 'foreman' ? 7 : 3; this.burstT = 0; break;
      case 'rush': this.rushing = true; this.rushT = 1.4; this.rushDir.copy(toPn); break;
      case 'smash': case 'bite': {
        if (this.dist < a.stats.range + 0.8) { ctx.game.damagePlayer(a.stats.dmg, a.center); ctx.game.knockPlayer(toPn.clone().setY(0.4).multiplyScalar(a.type === 'charger' ? 14 : 5)); }
        this.cooldown = a.stats.fireRate;
        break;
      }
      case 'leap': {
        this.leaping = true;
        const d = ppos.clone().sub(a.position);
        this.rushDir.copy(d.setY(0).normalize());
        a.vel.y = 7; a.grounded = false;
        break;
      }
      case 'lunge': this.lunging = true; this.rushT = 0.35; this.rushDir.copy(toPn); break;
    }
    this.action = 'strafe';
  }

  private separation() {
    const out = new THREE.Vector3();
    const me = this.a.position;
    for (const o of this.allies()) {
      if (o === this.a || !o.alive) continue;
      const d = me.clone().sub(o.position).setY(0);
      const l = d.length();
      const r = 1.3 * Math.max(this.a.stats.scale, o.stats.scale);
      if (l < r && l > 1e-3) out.addScaledVector(d.divideScalar(l), (r - l) / r);
    }
    return out;
  }

  private findCover(ppos: THREE.Vector3) {
    for (let i = 0; i < 8; i++) {
      const p = this.nav.randomNear(this.a.position, 3, 10);
      if (p && !this.hasLOS(p.clone().setY(p.y + 1.2), ppos)) return p;
    }
    return null;
  }
}
