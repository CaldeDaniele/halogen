import * as THREE from 'three';
import { RAPIER, PhysicsWorld, G, groups } from '../../physics/world';
import { Input } from '../../core/input';

export const MOVE = {
  walk: 9.5,
  crouchWalk: 4.5,
  groundAccel: 11,
  friction: 7,
  stopSpeed: 3,
  airAccel: 10,
  airCap: 1.4,
  airControl: 2.5,
  jump: 8.5,
  airJump: 8.0,
  gravity: 24,
  fallGravity: 30,
  dashSpeed: 23,
  dashTime: 0.16,
  dashCharges: 2,
  dashRecharge: 1.1,
  dashKeep: 0.55,
  slideMinSpeed: 6.5,
  slideBoost: 1.25,
  slideMaxBoosted: 21,
  slideFriction: 1.1,
  slideCooldown: 0.6,
  coyote: 0.1,
  jumpBuffer: 0.12,
  wallKickOut: 9,
  wallKickUp: 8.2,
  eyeStand: 0.65,
  eyeSlide: -0.1,
};

export type PlayerEvent =
  | { type: 'jump' } | { type: 'airjump' } | { type: 'walljump' } | { type: 'dash' }
  | { type: 'slide' } | { type: 'land'; speed: number } | { type: 'step' };

/** Quake-lineage movement on a Rapier kinematic character controller. */
export class PlayerController {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  kcc: RAPIER.KinematicCharacterController;
  readonly vel = new THREE.Vector3();
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  sliding = false;
  crouching = false;
  dashLeft = 0;
  dashCharges = MOVE.dashCharges;
  dashRecharge = 0;
  maxDashCharges = MOVE.dashCharges;
  maxAirJumps = 1;
  airJumps = 1;
  private dashDir = new THREE.Vector3();
  private coyote = 0;
  private jumpBuf = 0;
  private slideCd = 0;
  private wallN = new THREE.Vector3();
  private wallTime = 0;
  eyeOffset = MOVE.eyeStand;
  stepDist = 0;
  /** speed multiplier from cards etc */
  speedMul = 1;
  events: PlayerEvent[] = [];
  groundNormal = new THREE.Vector3(0, 1, 0);
  frozen = false;

  constructor(private phys: PhysicsWorld, spawn: THREE.Vector3) {
    const w = phys.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + 0.9, spawn.z));
    this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.4).setCollisionGroups(groups(G.PLAYER, G.STATIC | G.PROP | G.ENEMY | G.FIXTURE)), this.body);
    phys.tag(this.collider, { kind: 'player' });
    this.kcc = w.createCharacterController(0.02);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(50));
    this.kcc.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(35));
    this.kcc.enableAutostep(0.45, 0.25, true);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(90);
    this.kcc.setSlideEnabled(true);
    this.pos.set(spawn.x, spawn.y + 0.9, spawn.z);
    this.prevPos.copy(this.pos);
  }

  teleport(p: THREE.Vector3, yaw?: number) {
    this.pos.set(p.x, p.y + 0.9, p.z);
    this.prevPos.copy(this.pos);
    this.body.setTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z }, true);
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
    this.vel.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = yaw;
  }

  get horizSpeed() { return Math.hypot(this.vel.x, this.vel.z); }
  get eye() { return new THREE.Vector3(this.pos.x, this.pos.y + this.eyeOffset, this.pos.z); }
  forward(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  private accelerate(wish: THREE.Vector3, wishSpeed: number, accel: number, dt: number, cap = wishSpeed) {
    const cur = this.vel.x * wish.x + this.vel.z * wish.z;
    const add = cap - cur;
    if (add <= 0) return;
    const acc = Math.min(accel * wishSpeed * dt, add);
    this.vel.x += wish.x * acc; this.vel.z += wish.z * acc;
  }

  update(dt: number, input: Input) {
    this.events.length = 0;
    this.prevPos.copy(this.pos);
    if (dt <= 0) return;
    if (this.frozen) { this.vel.set(0, 0, 0); return; }

    const f = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const s = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const wish = new THREE.Vector3(-sy * f + cy * s, 0, -cy * f - sy * s);
    const hasWish = wish.lengthSq() > 0;
    if (hasWish) wish.normalize();

    if (input.pressed('Space')) this.jumpBuf = MOVE.jumpBuffer;
    this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    this.coyote = Math.max(0, this.coyote - dt);
    this.slideCd = Math.max(0, this.slideCd - dt);
    this.wallTime = Math.max(0, this.wallTime - dt);
    if (this.grounded) { this.coyote = MOVE.coyote; this.airJumps = this.maxAirJumps; }

    // dash charges
    if (this.dashCharges < this.maxDashCharges) {
      this.dashRecharge += dt;
      if (this.dashRecharge >= MOVE.dashRecharge) { this.dashRecharge = 0; this.dashCharges++; }
    }
    if ((input.pressed('ShiftLeft') || input.pressed('ShiftRight')) && this.dashCharges > 0 && this.dashLeft <= 0) {
      this.dashCharges--;
      this.dashLeft = MOVE.dashTime;
      if (hasWish) this.dashDir.copy(wish); else this.dashDir.set(-sy, 0, -cy);
      this.sliding = false;
      this.events.push({ type: 'dash' });
    }

    const crouchHeld = input.isDown('ControlLeft') || input.isDown('KeyC');
    const hs = this.horizSpeed;
    if (crouchHeld && this.grounded && !this.sliding && hs > MOVE.slideMinSpeed && this.slideCd <= 0) {
      this.sliding = true;
      const boost = Math.min(MOVE.slideBoost, MOVE.slideMaxBoosted / Math.max(hs, 0.001));
      if (boost > 1) { this.vel.x *= boost; this.vel.z *= boost; }
      this.slideCd = MOVE.slideCooldown;
      this.events.push({ type: 'slide' });
    }
    if (this.sliding && (!crouchHeld || (this.grounded && hs < 3))) this.sliding = false;
    this.crouching = crouchHeld && !this.sliding && this.grounded;

    if (this.dashLeft > 0) {
      this.dashLeft -= dt;
      this.vel.set(this.dashDir.x * MOVE.dashSpeed, 0, this.dashDir.z * MOVE.dashSpeed);
      if (this.dashLeft <= 0) {
        this.vel.x = this.dashDir.x * MOVE.dashSpeed * MOVE.dashKeep;
        this.vel.z = this.dashDir.z * MOVE.dashSpeed * MOVE.dashKeep;
      }
    } else if (this.grounded) {
      // friction
      const fr = this.sliding ? MOVE.slideFriction : MOVE.friction;
      const sp = this.horizSpeed;
      if (sp > 0) {
        const drop = Math.max(sp, this.sliding ? 0 : MOVE.stopSpeed) * fr * dt;
        const k = Math.max(0, sp - drop) / sp;
        this.vel.x *= k; this.vel.z *= k;
      }
      if (this.sliding) {
        // gravity pulls along slopes
        const n = this.groundNormal;
        const gx = n.x * n.y * MOVE.gravity, gz = n.z * n.y * MOVE.gravity;
        this.vel.x += gx * dt; this.vel.z += gz * dt;
        if (hasWish) this.accelerate(wish, 2, 4, dt);
      } else if (hasWish) {
        const ws = (this.crouching ? MOVE.crouchWalk : MOVE.walk) * this.speedMul;
        this.accelerate(wish, ws, MOVE.groundAccel, dt);
      }
      if (this.vel.y < 0) this.vel.y = -2;
    } else {
      if (hasWish) {
        this.accelerate(wish, MOVE.walk * this.speedMul, MOVE.airAccel, dt, MOVE.airCap);
        if (this.horizSpeed < MOVE.walk * this.speedMul) this.accelerate(wish, MOVE.walk * this.speedMul, MOVE.airControl, dt);
      }
      this.vel.y -= (this.vel.y < 0 ? MOVE.fallGravity : MOVE.gravity) * dt;
      this.vel.y = Math.max(this.vel.y, -45);
    }

    // jumps
    if (this.jumpBuf > 0) {
      if (this.grounded || this.coyote > 0) {
        this.vel.y = MOVE.jump;
        this.jumpBuf = 0; this.coyote = 0; this.grounded = false;
        this.sliding = false;
        this.events.push({ type: 'jump' });
      } else if (this.wallTime > 0) {
        this.vel.x = this.vel.x * 0.8 + this.wallN.x * MOVE.wallKickOut;
        this.vel.z = this.vel.z * 0.8 + this.wallN.z * MOVE.wallKickOut;
        this.vel.y = MOVE.wallKickUp;
        this.jumpBuf = 0; this.wallTime = 0;
        this.events.push({ type: 'walljump' });
      } else if (this.airJumps > 0) {
        this.vel.y = MOVE.airJump;
        if (hasWish) { // redirect some momentum toward input — feels responsive
          const sp = Math.max(this.horizSpeed, MOVE.walk * 0.8);
          this.vel.x = this.vel.x * 0.4 + wish.x * sp * 0.6;
          this.vel.z = this.vel.z * 0.4 + wish.z * sp * 0.6;
        }
        this.airJumps--; this.jumpBuf = 0;
        this.events.push({ type: 'airjump' });
      }
    }

    // move through the KCC
    const desired = { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt };
    this.kcc.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(G.PLAYER, G.STATIC | G.PROP | G.ENEMY | G.FIXTURE));
    const mv = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    const prevVy = this.vel.y;
    this.grounded = this.kcc.computedGrounded();
    for (let i = 0; i < this.kcc.numComputedCollisions(); i++) {
      const c = this.kcc.computedCollision(i);
      if (!c) continue;
      const n = c.normal1;
      if (n.y < -0.5 && this.vel.y > 0) this.vel.y = 0;
      if (Math.abs(n.y) < 0.35) {
        this.wallN.set(n.x, 0, n.z).normalize();
        this.wallTime = 0.2;
        const into = this.vel.x * this.wallN.x + this.vel.z * this.wallN.z;
        if (into < 0) { this.vel.x -= this.wallN.x * into; this.vel.z -= this.wallN.z * into; }
      }
      if (n.y > 0.6) this.groundNormal.set(n.x, n.y, n.z);
    }
    if (this.grounded && !wasGrounded && prevVy < -3) this.events.push({ type: 'land', speed: -prevVy });
    if (this.grounded && !wasGrounded) this.groundNormal.set(0, 1, 0);

    this.pos.set(this.pos.x + mv.x, this.pos.y + mv.y, this.pos.z + mv.z);
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });

    if (this.grounded && !this.sliding) {
      this.stepDist += Math.hypot(mv.x, mv.z);
      if (this.stepDist > 2.3) { this.stepDist = 0; this.events.push({ type: 'step' }); }
    }
    const targetEye = this.sliding ? MOVE.eyeSlide : this.crouching ? 0.1 : MOVE.eyeStand;
    this.eyeOffset += (targetEye - this.eyeOffset) * Math.min(1, dt * 14);
  }
}
