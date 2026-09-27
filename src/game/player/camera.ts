import * as THREE from 'three';
import { PlayerController } from './controller';

/** Critically-damped-ish spring for juice offsets. */
export class Spring {
  x = 0; v = 0;
  constructor(public k = 180, public c = 18) {}
  kick(v: number) { this.v += v; }
  update(dt: number) { const a = -this.k * this.x - this.c * this.v; this.v += a * dt; this.x += this.v * dt; return this.x; }
}

function noise1(t: number) { return Math.sin(t * 1.0) * 0.5 + Math.sin(t * 2.3 + 1.3) * 0.3 + Math.sin(t * 5.1 + 2.1) * 0.2; }

/** Camera juice: trauma shake, FOV kick, strafe tilt, landing dip, bob, recoil springs. */
export class CameraRig {
  trauma = 0;
  private t = 0;
  fovKick = 0;
  private fovCur = 0;
  private tilt = 0;
  readonly dip = new Spring(160, 16);
  readonly recoilPitch = new Spring(220, 22);
  readonly recoilYaw = new Spring(220, 22);
  private bobPhase = 0;
  bobAmt = 0;
  baseHFov = 103;

  addTrauma(a: number) { this.trauma = Math.min(1, this.trauma + a); }

  apply(cam: THREE.PerspectiveCamera, eye: THREE.Vector3, p: PlayerController, dt: number, setHFov: (h: number) => void) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const sh = this.trauma * this.trauma;
    const sx = noise1(this.t * 23) * sh * 0.05, sy = noise1(this.t * 21 + 40) * sh * 0.05, sr = noise1(this.t * 19 + 80) * sh * 0.07;

    // speed / dash FOV
    const speed = p.horizSpeed;
    const target = Math.max(0, Math.min(10, (speed - 9.5) * 0.7)) + this.fovKick + (p.sliding ? 4 : 0);
    this.fovKick = Math.max(0, this.fovKick - dt * 40);
    this.fovCur += (target - this.fovCur) * Math.min(1, dt * 8);
    setHFov(this.baseHFov + this.fovCur);

    // strafe tilt
    const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    const side = p.vel.x * rx + p.vel.z * rz;
    const tiltT = -side * 0.0022 + (p.sliding ? 0.05 : 0);
    this.tilt += (tiltT - this.tilt) * Math.min(1, dt * 10);

    // bob
    const moving = p.grounded && !p.sliding && speed > 1;
    this.bobAmt += ((moving ? Math.min(1, speed / 9.5) : 0) - this.bobAmt) * Math.min(1, dt * 8);
    this.bobPhase += dt * speed * 1.25;
    const bobY = Math.sin(this.bobPhase * 2) * 0.035 * this.bobAmt;
    const bobX = Math.cos(this.bobPhase) * 0.02 * this.bobAmt;

    const dip = this.dip.update(dt);
    const rp = this.recoilPitch.update(dt);
    const ry = this.recoilYaw.update(dt);

    cam.position.set(eye.x + bobX * Math.cos(p.yaw), eye.y + bobY + dip, eye.z - bobX * Math.sin(p.yaw));
    cam.rotation.set(p.pitch + sx + rp, p.yaw + sy + ry, this.tilt + sr, 'YXZ');
  }
}
