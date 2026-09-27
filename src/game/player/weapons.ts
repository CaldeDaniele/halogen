import * as THREE from 'three';
import type { Ctx, HitInfo, Owner } from '../types';
import { Input } from '../../core/input';
import { SHOT_FILTER, dealHit, surfaceImpact, explode } from '../combat';
import { Spring } from './camera';
import { worldBox } from '../../render/materials';
import { RAPIER } from '../../physics/world';

export interface WeaponDef {
  id: string; name: string; color: number;
  dmg: number; pellets: number; spread: number; rate: number; mag: number; reload: number;
  impulse: number; kind: 'hitscan' | 'rail' | 'projectile';
  sfx: string; recoil: number; trauma: number;
}

export const WEAPONS: Record<string, WeaponDef> = {
  arc: { id: 'arc', name: 'ARC PISTOL', color: 0x19f0ff, dmg: 24, pellets: 1, spread: 0.006, rate: 0.14, mag: 14, reload: 0.95, impulse: 6, kind: 'hitscan', sfx: 'pistol', recoil: 0.035, trauma: 0.08 },
  scatter: { id: 'scatter', name: 'SCATTERGUN', color: 0xffa040, dmg: 12, pellets: 10, spread: 0.075, rate: 0.72, mag: 6, reload: 1.35, impulse: 9, kind: 'hitscan', sfx: 'shotgun', recoil: 0.11, trauma: 0.32 },
  rail: { id: 'rail', name: 'RAIL LANCE', color: 0xd0b8ff, dmg: 150, pellets: 1, spread: 0, rate: 0.35, mag: 4, reload: 1.6, impulse: 40, kind: 'rail', sfx: 'rail', recoil: 0.14, trauma: 0.45 },
  ion: { id: 'ion', name: 'ION LAUNCHER', color: 0xb46bff, dmg: 95, pellets: 1, spread: 0, rate: 0.8, mag: 3, reload: 1.8, impulse: 34, kind: 'projectile', sfx: 'ionFire', recoil: 0.1, trauma: 0.25 },
};

interface Tracer { mesh: THREE.Mesh; life: number; max: number; }
interface Projectile { pos: THREE.Vector3; vel: THREE.Vector3; mesh: THREE.Mesh; light: any; life: number; }

/** Procedural viewmodel: every gun is built from primitives + neon accents. */
function buildViewmodel(ctx: Ctx, id: string): { root: THREE.Group; muzzle: THREE.Object3D; glow: THREE.Mesh[] } {
  const g = new THREE.Group();
  const metal = ctx.mats.get('metal'), armor = ctx.mats.get('armor'), joint = ctx.mats.get('joint');
  const def = WEAPONS[id];
  const neon = ctx.mats.neon(def.color, 5);
  const glow: THREE.Mesh[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
    const b = new THREE.Mesh(worldBox(w, h, d, 0.3), m); b.position.set(x, y, z); g.add(b); return b;
  };
  const cyl = (r: number, l: number, x: number, y: number, z: number, m: THREE.Material, seg = 12) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, l, seg), m); c.rotation.x = Math.PI / 2; c.position.set(x, y, z); g.add(c); return c;
  };
  const muzzle = new THREE.Object3D();
  if (id === 'arc') {
    box(0.055, 0.075, 0.26, 0, 0, -0.05, armor);
    box(0.045, 0.12, 0.06, 0, -0.08, 0.04, joint).rotation.x = 0.25;
    cyl(0.016, 0.16, 0, 0.012, -0.23, metal);
    for (let i = 0; i < 3; i++) glow.push(cyl(0.022, 0.012, 0, 0.012, -0.14 - i * 0.035, neon));
    glow.push(box(0.058, 0.006, 0.16, 0, 0.04, -0.06, neon));
    muzzle.position.set(0, 0.012, -0.32);
  } else if (id === 'scatter') {
    box(0.09, 0.1, 0.42, 0, 0, -0.1, metal);
    box(0.06, 0.13, 0.08, 0, -0.1, 0.08, joint).rotation.x = 0.3;
    cyl(0.028, 0.34, -0.022, 0.02, -0.38, joint, 10);
    cyl(0.028, 0.34, 0.022, 0.02, -0.38, joint, 10);
    box(0.1, 0.05, 0.16, 0, -0.06, -0.3, armor);
    for (let i = 0; i < 4; i++) glow.push(box(0.012, 0.03, 0.02, 0.05, 0.0, -0.05 - i * 0.05, neon));
    muzzle.position.set(0, 0.02, -0.56);
  } else if (id === 'rail') {
    box(0.07, 0.09, 0.5, 0, 0, -0.12, armor);
    box(0.05, 0.12, 0.07, 0, -0.1, 0.08, joint).rotation.x = 0.25;
    box(0.012, 0.04, 0.5, -0.03, 0.05, -0.38, metal);
    box(0.012, 0.04, 0.5, 0.03, 0.05, -0.38, metal);
    glow.push(box(0.03, 0.01, 0.46, 0, 0.05, -0.38, neon));
    cyl(0.03, 0.08, 0, -0.02, 0.02, joint);
    muzzle.position.set(0, 0.05, -0.64);
  } else {
    box(0.1, 0.1, 0.34, 0, 0, -0.08, metal);
    box(0.06, 0.12, 0.07, 0, -0.1, 0.08, joint).rotation.x = 0.3;
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 14), armor);
    drum.rotation.z = Math.PI / 2; drum.position.set(0, -0.04, -0.06); g.add(drum);
    for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), neon); s.position.set(0.06, -0.04 + Math.cos(i * 2.1) * 0.045, -0.06 + Math.sin(i * 2.1) * 0.045); g.add(s); glow.push(s); }
    cyl(0.045, 0.2, 0, 0.02, -0.32, joint, 14);
    glow.push(cyl(0.05, 0.015, 0, 0.02, -0.41, neon, 14));
    muzzle.position.set(0, 0.02, -0.44);
  }
  g.add(muzzle);
  g.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; (o as THREE.Mesh).renderOrder = 10; } });
  return { root: g, muzzle, glow };
}

export class WeaponSystem {
  slots: string[];
  cur = 0;
  ammo: Record<string, number> = {};
  private cool = 0;
  private reloading = 0;
  private switching = 0;
  private charge = 0;
  private charging = false;
  private shotCount = 0;
  private vm: Record<string, ReturnType<typeof buildViewmodel>> = {};
  private vmRoot = new THREE.Group();
  private kick = new Spring(260, 20);
  private kickRot = new Spring(200, 16);
  private swayX = 0; private swayY = 0;
  private tracers: Tracer[] = [];
  private projectiles: Projectile[] = [];
  private chargeLight: any = null;
  private tracerMats = new Map<number, THREE.MeshBasicMaterial>();
  private tracerGeo = new THREE.BoxGeometry(1, 1, 1);
  enabled = true;

  constructor(private ctx: Ctx, slots: string[]) {
    this.slots = [...slots];
    ctx.camera.add(this.vmRoot);
    for (const id of Object.keys(WEAPONS)) {
      this.vm[id] = buildViewmodel(ctx, id);
      this.vm[id].root.visible = false;
      this.vmRoot.add(this.vm[id].root);
      this.ammo[id] = WEAPONS[id].mag;
    }
    this.show();
  }

  get id() { return this.slots[this.cur]; }
  get def() { return WEAPONS[this.id]; }
  magSize(id = this.id) { return Math.max(1, Math.round(WEAPONS[id].mag * this.ctx.run.mods.magMul)); }
  get reloadingFrac() { return this.reloading > 0 ? 1 - this.reloading / (this.def.reload * this.ctx.run.mods.reloadMul) : 0; }
  get chargeFrac() { return this.charge; }

  setSlots(slots: string[]) { this.slots = [...slots]; this.cur = Math.min(this.cur, this.slots.length - 1); for (const s of slots) this.ammo[s] = this.magSize(s); this.show(); }
  refill() { for (const s of this.slots) this.ammo[s] = this.magSize(s); }

  private show() { for (const id in this.vm) this.vm[id].root.visible = id === this.id; }

  switchTo(i: number) {
    if (i === this.cur || i < 0 || i >= this.slots.length) return;
    this.cur = i; this.switching = 0.22; this.reloading = 0; this.charge = 0; this.charging = false;
    this.show(); this.ctx.sfx.play('reload', { pitch: 0.5 });
  }

  update(dt: number, input: Input, realDt: number) {
    const ctx = this.ctx;
    const mods = ctx.run.mods;
    this.cool = Math.max(0, this.cool - dt);
    this.switching = Math.max(0, this.switching - dt);
    if (input.pressed('Digit1')) this.switchTo(0);
    if (input.pressed('Digit2')) this.switchTo(1);
    const wheel = input.consumeWheel();
    if (wheel !== 0 && this.slots.length > 1) this.switchTo((this.cur + (wheel > 0 ? 1 : this.slots.length - 1)) % this.slots.length);

    const def = this.def;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) { this.ammo[def.id] = this.magSize(); }
    }
    if (input.pressed('KeyR') && this.reloading <= 0 && this.ammo[def.id] < this.magSize()) this.startReload();

    if (this.enabled && this.switching <= 0 && this.reloading <= 0) {
      if (def.kind === 'rail') {
        if (input.isDown('Mouse0') && this.cool <= 0 && this.ammo[def.id] > 0) {
          if (!this.charging) { this.charging = true; ctx.sfx.play('railCharge'); }
          this.charge = Math.min(1, this.charge + dt / 0.55);
        } else if (this.charging) {
          if (this.charge >= 0.99) this.fire();
          this.charging = false; this.charge = 0;
        }
      } else if (input.isDown('Mouse0') && this.cool <= 0) {
        if (this.ammo[def.id] > 0) this.fire();
        else if (input.pressed('Mouse0')) { ctx.sfx.play('empty'); this.startReload(); }
      }
    }
    // rail charge light
    if (this.charge > 0) {
      const mp = this.vm[def.id].muzzle.getWorldPosition(new THREE.Vector3());
      if (!this.chargeLight) this.chargeLight = ctx.lights.add({ pos: mp, color: new THREE.Color(def.color), intensity: 0, radius: 4 });
      this.chargeLight.pos.copy(mp); this.chargeLight.intensity = this.charge * 6;
    } else if (this.chargeLight) { ctx.lights.remove(this.chargeLight); this.chargeLight = null; }

    this.updateProjectiles(dt);
    this.animate(realDt, input);
  }

  private startReload() {
    const def = this.def;
    if (this.reloading > 0) return;
    this.reloading = def.reload * this.ctx.run.mods.reloadMul;
    this.charge = 0; this.charging = false;
    this.ctx.sfx.play('reload', { pitch: this.reloading });
  }

  private aimDir(spread: number) {
    const cam = this.ctx.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    if (spread > 0) {
      const r = Math.sqrt(Math.random()) * spread, a = Math.random() * Math.PI * 2;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    }
    return dir;
  }

  private fire() {
    const ctx = this.ctx, def = this.def, mods = ctx.run.mods;
    this.cool = def.rate / mods.rateMul;
    this.ammo[def.id]--;
    this.shotCount++;
    const over = mods.overcharge && this.shotCount % 6 === 0 ? 3 : 1;
    const vm = this.vm[def.id];
    const muzzle = vm.muzzle.getWorldPosition(new THREE.Vector3());
    const eye = ctx.camera.getWorldPosition(new THREE.Vector3());
    ctx.sfx.play(def.sfx, { pitch: over > 1 ? 0.8 : 1 });
    ctx.lights.flash(muzzle, def.color, def.id === 'scatter' ? 30 : 16, def.id === 'scatter' ? 9 : 6, 0.07);
    ctx.particles.glowAt(muzzle, def.color, def.id === 'scatter' ? 0.55 : 0.3, 0.05);
    ctx.particles.sparksAt(muzzle, this.aimDir(0), def.id === 'scatter' ? 10 : 3, def.color, 10, 0.3, 0.12);
    this.kick.kick(def.recoil * 30); this.kickRot.kick(def.recoil * 40);
    ctx.rig.recoilPitch.kick(def.recoil * 5); ctx.rig.recoilYaw.kick((Math.random() - 0.5) * def.recoil * 2);
    ctx.rig.addTrauma(def.trauma * 0.5);
    ctx.rig.fovKick += def.id === 'rail' ? 6 : def.id === 'scatter' ? 3 : 0.6;
    ctx.events.emit('shot', { weapon: def.id });

    if (def.kind === 'projectile') {
      const dir = this.aimDir(0);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), ctx.mats.neon(def.color, 8));
      mesh.position.copy(muzzle);
      ctx.scene.add(mesh);
      const light = ctx.lights.add({ pos: muzzle, color: new THREE.Color(def.color), intensity: 10, radius: 7 });
      this.projectiles.push({ pos: muzzle.clone(), vel: dir.multiplyScalar(34).add(ctx.player.vel.clone().multiplyScalar(0.3)), mesh, light, life: 4 });
      return;
    }
    const pierceAll = def.kind === 'rail';
    const tags = new Set<string>();
    if (mods.thermite) tags.add('thermite');
    for (let p = 0; p < def.pellets; p++) {
      const dir = this.aimDir(def.spread * (ctx.player.grounded ? 1 : 1.3) + (def.pellets === 1 ? Math.min(0.02, ctx.player.horizSpeed * 0.0006) : 0));
      this.trace(eye, dir, muzzle, def, def.dmg * mods.dmgMul * over, pierceAll ? 99 : mods.pierce, mods.ricochet, tags);
    }
    if (mods.flare && this.shotCount % 5 === 0) {
      const hit = ctx.phys.ray(eye.x, eye.y, eye.z, ...this.aimDir(0).toArray() as [number, number, number], 80, SHOT_FILTER, ctx.player.collider);
      if (hit) ctx.game.spawnFlare(new THREE.Vector3(hit.x + hit.nx * 0.2, hit.y + hit.ny * 0.2, hit.z + hit.nz * 0.2));
    }
  }

  /** Hitscan with pierce and ricochet. Draws the tracer from the muzzle to the final impact. */
  private trace(origin: THREE.Vector3, dir: THREE.Vector3, muzzle: THREE.Vector3, def: WeaponDef, dmg: number, pierce: number, ricochet: number, tags: Set<string>) {
    const ctx = this.ctx;
    let o = origin.clone(), d = dir.clone();
    let from = muzzle.clone();
    const hitSet = new Set<number>();
    let bounces = ricochet;
    let remaining = 120;
    for (let iter = 0; iter < 12 && remaining > 0; iter++) {
      const hit = ctx.phys.world.castRayAndGetNormal(new RAPIER.Ray(o, d), remaining, true, undefined, SHOT_FILTER, undefined, undefined,
        (c: any) => c.handle !== ctx.player.collider.handle && !hitSet.has(c.handle));
      if (!hit) { this.tracer(from, o.clone().addScaledVector(d, remaining), def, def.kind === 'rail'); return; }
      const p = o.clone().addScaledVector(d, hit.timeOfImpact);
      const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      const owner = ctx.phys.ownerOf(hit.collider.handle) as Owner | undefined;
      const h: HitInfo = { point: p, normal: n, dir: d.clone(), damage: dmg, impulse: def.impulse, source: 'player', weapon: def.id, pin: def.kind === 'rail', bulletTime: ctx.time.isBulletTime, tags };
      dealHit(ctx, hit.collider, h);
      const surface = owner?.surface ?? (owner?.kind === 'android' ? 'android' : 'concrete');
      if (!owner || owner.kind === 'static' || owner.kind === 'prop' || owner.kind === 'debris') surfaceImpact(ctx, p, n, surface, def.color, def.kind === 'rail');
      else if (owner.kind === 'android' || owner.kind === 'boss') surfaceImpact(ctx, p, n, 'android', def.color, def.kind === 'rail', false);
      hitSet.add(hit.collider.handle);
      const isStatic = !owner || owner.kind === 'static';
      remaining -= hit.timeOfImpact;
      if (isStatic) {
        this.tracer(from, p, def, def.kind === 'rail');
        if (bounces > 0) {
          bounces--; from = p.clone();
          d = d.clone().reflect(n).normalize(); o = p.clone().addScaledVector(n, 0.02); dmg *= 0.7;
          hitSet.clear();
          continue;
        }
        return;
      }
      if (pierce <= 0) { this.tracer(from, p, def, def.kind === 'rail'); return; }
      pierce--;
      o = p.clone().addScaledVector(d, 0.05);
    }
  }

  tracer(a: THREE.Vector3, b: THREE.Vector3, def: WeaponDef, thick = false, life?: number) {
    let mat = this.tracerMats.get(def.color);
    if (!mat) { mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(def.color).multiplyScalar(4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }); this.tracerMats.set(def.color, mat); }
    const mesh = new THREE.Mesh(this.tracerGeo, mat.clone());
    const len = a.distanceTo(b);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.lookAt(b);
    const w = thick ? 0.05 : def.id === 'scatter' ? 0.008 : 0.012;
    mesh.scale.set(w, w, len);
    this.ctx.scene.add(mesh);
    const l = life ?? (thick ? 0.5 : 0.06);
    this.tracers.push({ mesh, life: l, max: l });
    if (thick) {
      // rail: bright core + light along the beam
      const mid = a.clone().add(b).multiplyScalar(0.5);
      this.ctx.lights.add({ type: 1, pos: a, pos2: b, color: new THREE.Color(def.color), intensity: 20, radius: 5, ttl: 0.5 } as any);
      this.ctx.particles.smokeAt(mid, 6, 0x6a5a8a, 0.3, 1.2, 0.2, 0.5);
    }
  }

  private updateProjectiles(dt: number) {
    const ctx = this.ctx;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      pr.vel.y -= 11 * dt;
      const step = pr.vel.clone().multiplyScalar(dt);
      const len = step.length();
      const dir = step.clone().divideScalar(len || 1);
      const hit = ctx.phys.ray(pr.pos.x, pr.pos.y, pr.pos.z, dir.x, dir.y, dir.z, len + 0.12, SHOT_FILTER, ctx.player.collider);
      if (hit || pr.life <= 0) {
        const at = hit ? new THREE.Vector3(hit.x + hit.nx * 0.1, hit.y + hit.ny * 0.1, hit.z + hit.nz * 0.1) : pr.pos;
        explode(ctx, at, 5, WEAPONS.ion.dmg * ctx.run.mods.dmgMul, WEAPONS.ion.impulse, 'player', WEAPONS.ion.color);
        ctx.scene.remove(pr.mesh); pr.mesh.geometry.dispose();
        ctx.lights.remove(pr.light);
        this.projectiles.splice(i, 1);
        continue;
      }
      pr.pos.add(step);
      pr.mesh.position.copy(pr.pos);
      pr.light.pos.copy(pr.pos);
      if (Math.random() < 0.6) ctx.particles.smokeAt(pr.pos, 1, 0x4a2a6a, 0.2, 0.5, 0.1, 0.2);
      ctx.particles.sparksAt(pr.pos, dir.clone().negate(), 1, WEAPONS.ion.color, 3, 0.5, 0.2);
    }
  }

  private animate(dt: number, input: Input) {
    const ctx = this.ctx;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      const k = Math.max(0, t.life / t.max);
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = k;
      t.mesh.scale.x = t.mesh.scale.y = t.mesh.scale.x * (0.9 + 0.1 * k);
      if (t.life <= 0) { ctx.scene.remove(t.mesh); (t.mesh.material as THREE.Material).dispose(); this.tracers.splice(i, 1); }
    }
    const k = this.kick.update(dt), kr = this.kickRot.update(dt);
    // sway follows mouse movement with lag
    const mdx = input.mouseDX, mdy = input.mouseDY;
    this.swayX += (-mdx * 0.00025 - this.swayX) * Math.min(1, dt * 10);
    this.swayY += (mdy * 0.00025 - this.swayY) * Math.min(1, dt * 10);
    this.swayX = THREE.MathUtils.clamp(this.swayX, -0.04, 0.04); this.swayY = THREE.MathUtils.clamp(this.swayY, -0.04, 0.04);
    const p = ctx.player;
    const bob = ctx.rig.bobAmt;
    const t = performance.now() / 1000;
    const bobX = Math.sin(t * 9) * 0.008 * bob, bobY = Math.abs(Math.cos(t * 9)) * 0.01 * bob;
    const lower = this.switching > 0 ? this.switching / 0.22 : 0;
    const rl = this.reloading > 0 ? Math.sin(Math.min(1, this.reloadingFrac) * Math.PI) : 0;
    const vx = 0.2 + this.swayX + bobX, vy = -0.2 + this.swayY - bobY - lower * 0.25 - rl * 0.08 + (p.sliding ? -0.03 : 0);
    const vz = -0.38 + k * 0.03;
    this.vmRoot.position.set(vx, vy, vz);
    this.vmRoot.rotation.set(kr * 0.05 + rl * 0.5 + (p.sliding ? 0.05 : 0), this.swayX * 2, rl * 0.4 + (p.sliding ? 0.3 : 0));
    // neon accents pulse with charge/cooldown
    const vm = this.vm[this.id];
    const charge = this.charge;
    for (const gm of vm.glow) gm.scale.setScalar(1 + charge * 0.4 + (this.cool > 0 ? 0.1 : 0));
  }

  clear() {
    for (const pr of this.projectiles) { this.ctx.scene.remove(pr.mesh); this.ctx.lights.remove(pr.light); }
    this.projectiles.length = 0;
  }
}
