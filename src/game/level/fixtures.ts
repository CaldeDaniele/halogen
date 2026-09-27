import * as THREE from 'three';
import { RAPIER, G, groups, ALL } from '../../physics/world';
import type { Ctx, HitInfo, Owner } from '../types';
import type { FixtureSpec } from './generator';
import { LightType, DynLight } from '../../render/lights';

const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
const deadMat = new THREE.MeshStandardMaterial({ color: 0x151719, roughness: 0.3, metalness: 0.2 });
const housingGeo = new THREE.BoxGeometry(1, 1, 1);

/**
 * A breakable light. Shooting (or throwing something into) it triggers a flicker → pop →
 * spark shower → glass → darkness sequence, grants a Lumen burst, and leaves that zone dark.
 */
export class Fixture {
  light: DynLight;
  mesh: THREE.Mesh;
  housing: THREE.Mesh;
  collider: RAPIER.Collider;
  broken = false;
  breaking = 0;
  readonly pos: THREE.Vector3;
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  private litMat: THREE.Material;
  ambientFlicker: number;

  constructor(private ctx: Ctx, readonly spec: FixtureSpec, parent: THREE.Object3D, private onBreak: (f: Fixture, byPlayer: boolean) => void) {
    this.a = new THREE.Vector3(...spec.a); this.b = new THREE.Vector3(...spec.b);
    this.pos = this.a.clone().add(this.b).multiplyScalar(0.5);
    const len = Math.max(0.3, this.a.distanceTo(this.b));
    const r = spec.kind === 'panel' ? 0.09 : spec.kind === 'strip' ? 0.035 : 0.05;
    this.litMat = ctx.mats.neon(spec.color, spec.kind === 'panel' ? 5 : 7);
    this.mesh = new THREE.Mesh(tubeGeo, this.litMat);
    this.mesh.scale.set(r, len, r);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.b.clone().sub(this.a).normalize());
    parent.add(this.mesh);
    // dark metal housing behind the tube
    const n = new THREE.Vector3(...spec.normal);
    this.housing = new THREE.Mesh(housingGeo, ctx.mats.get('joint'));
    const dir = this.b.clone().sub(this.a).normalize();
    this.housing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.housing.scale.set(r * 3.2, len + 0.1, r * 3.2);
    this.housing.position.copy(this.pos).addScaledVector(n, -r * 1.6);
    this.housing.castShadow = false;
    parent.add(this.housing);
    this.light = ctx.lights.add({ type: len > 0.5 ? LightType.Tube : LightType.Point, pos: this.a, pos2: this.b, color: new THREE.Color(spec.color), intensity: spec.intensity, radius: spec.radius });
    const half = len / 2;
    const q = this.mesh.quaternion;
    this.collider = ctx.phys.world.createCollider(RAPIER.ColliderDesc.cuboid(r * 2.5, half, r * 2.5)
      .setTranslation(this.pos.x, this.pos.y, this.pos.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setCollisionGroups(groups(G.FIXTURE, ALL & ~G.PLAYER)).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS));
    const owner: Owner = { kind: 'fixture', surface: 'glass', fixture: this, hit: (h: HitInfo) => this.hit(h) };
    ctx.phys.tag(this.collider, owner);
    this.ambientFlicker = Math.random() < 0.12 ? 0.5 : 0;
    this.light.flicker = this.ambientFlicker;
  }

  hit(h: HitInfo) {
    if (this.broken || this.breaking > 0 || !this.spec.breakable) return;
    this.breaking = 0.22;
    this.light.flicker = 1;
    this.byPlayer = h.source !== 'enemy';
  }
  private byPlayer = true;

  update(dt: number) {
    if (this.breaking > 0) {
      this.breaking -= dt;
      this.mesh.visible = Math.random() < 0.5;
      if (this.breaking <= 0) this.pop();
    }
  }

  private pop() {
    const ctx = this.ctx;
    this.broken = true;
    this.light.enabled = false;
    this.light.flicker = this.ambientFlicker;
    this.mesh.visible = true;
    this.mesh.material = deadMat;
    const n = new THREE.Vector3(...this.spec.normal);
    const len = this.a.distanceTo(this.b);
    for (let i = 0; i < Math.max(2, Math.round(len * 1.5)); i++) {
      const p = this.a.clone().lerp(this.b, Math.random());
      ctx.particles.sparksAt(p, n.clone().add(new THREE.Vector3(0, -0.6, 0)), 14, 0xffe6b0, 7, 1, 0.9);
      ctx.particles.shardsAt(p, n, 6, this.spec.color, 3, 0.025, 1.4);
    }
    ctx.particles.glowAt(this.pos, this.spec.color, 2.2, 0.15);
    ctx.lights.flash(this.pos, this.spec.color, this.spec.intensity * 3, this.spec.radius, 0.3);
    ctx.particles.smokeAt(this.pos, 3, 0x333333, 0.4, 1.5, 0.2, 0.4);
    ctx.sfx.play('fixturePop', { pos: this.pos });
    this.onBreak(this, this.byPlayer);
  }

  repair() {
    if (!this.broken) return;
    this.broken = false;
    this.light.enabled = true;
    this.mesh.material = this.litMat;
    this.ctx.particles.glowAt(this.pos, this.spec.color, 1.5, 0.3);
    this.ctx.sfx.play('buzz', { pos: this.pos });
  }

  /** 0..1 how strongly this fixture lights point p. */
  influence(p: THREE.Vector3) {
    if (this.broken) return 0;
    const ab = this.b.clone().sub(this.a);
    const t = THREE.MathUtils.clamp(p.clone().sub(this.a).dot(ab) / Math.max(ab.lengthSq(), 1e-4), 0, 1);
    const d = this.a.clone().addScaledVector(ab, t).distanceTo(p);
    const x = Math.max(0, 1 - d / (this.spec.radius * 0.75));
    return x * x;
  }

  dispose() {
    this.ctx.lights.remove(this.light);
    this.ctx.phys.world.removeCollider(this.collider, false);
    this.mesh.removeFromParent(); this.housing.removeFromParent();
  }
}
