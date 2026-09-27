import * as THREE from 'three';

interface Pool {
  mesh: THREE.InstancedMesh;
  cap: number;
  n: number;
  pos: Float32Array; vel: Float32Array; life: Float32Array; max: Float32Array;
  col: Float32Array; size: Float32Array; grav: Float32Array; drag: Float32Array;
  rot: Float32Array; spin: Float32Array;
}

function makePool(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number): Pool {
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color());
  mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return {
    mesh, cap, n: 0,
    pos: new Float32Array(cap * 3), vel: new Float32Array(cap * 3), life: new Float32Array(cap), max: new Float32Array(cap),
    col: new Float32Array(cap * 3), size: new Float32Array(cap), grav: new Float32Array(cap), drag: new Float32Array(cap),
    rot: new Float32Array(cap * 3), spin: new Float32Array(cap * 3),
  };
}

function softDisc() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/**
 * CPU-simulated, GPU-instanced particles. Sparks are velocity-stretched additive streaks
 * that bounce off the floor; smoke/dust are camera-facing soft sprites; shards tumble.
 */
export class Particles {
  private sparks: Pool;
  private smoke: Pool;
  private shards: Pool;
  private glow: Pool;
  floorY = 0;
  scale = 1;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 0, 1);
  private c = new THREE.Color();
  private e = new THREE.Euler();

  constructor(scene: THREE.Scene) {
    const sparkGeo = new THREE.BoxGeometry(1, 1, 1);
    const add = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
    this.sparks = makePool(sparkGeo, add, 3000);
    const smokeMat = new THREE.MeshBasicMaterial({ map: softDisc(), transparent: true, depthWrite: false, opacity: 1 });
    this.smoke = makePool(new THREE.PlaneGeometry(1, 1), smokeMat, 700);
    const glowMat = new THREE.MeshBasicMaterial({ map: softDisc(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.glow = makePool(new THREE.PlaneGeometry(1, 1), glowMat, 400);
    const shardGeo = new THREE.TetrahedronGeometry(1, 0);
    const shardMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.shards = makePool(shardGeo, shardMat, 900);
    scene.add(this.sparks.mesh, this.smoke.mesh, this.glow.mesh, this.shards.mesh);
  }

  private spawn(p: Pool, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: THREE.Color, size: number, grav: number, drag: number) {
    if (p.n >= p.cap) { // overwrite a random older particle
      const i = Math.floor(Math.random() * p.cap); this.write(p, i, x, y, z, vx, vy, vz, life, color, size, grav, drag); return;
    }
    this.write(p, p.n++, x, y, z, vx, vy, vz, life, color, size, grav, drag);
  }
  private write(p: Pool, i: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: THREE.Color, size: number, grav: number, drag: number) {
    p.pos[i * 3] = x; p.pos[i * 3 + 1] = y; p.pos[i * 3 + 2] = z;
    p.vel[i * 3] = vx; p.vel[i * 3 + 1] = vy; p.vel[i * 3 + 2] = vz;
    p.life[i] = life; p.max[i] = life; p.size[i] = size; p.grav[i] = grav; p.drag[i] = drag;
    p.col[i * 3] = color.r; p.col[i * 3 + 1] = color.g; p.col[i * 3 + 2] = color.b;
    p.rot[i * 3] = Math.random() * 6; p.rot[i * 3 + 1] = Math.random() * 6; p.rot[i * 3 + 2] = Math.random() * 6;
    p.spin[i * 3] = (Math.random() - 0.5) * 20; p.spin[i * 3 + 1] = (Math.random() - 0.5) * 20; p.spin[i * 3 + 2] = (Math.random() - 0.5) * 20;
  }

  private rdir(nx: number, ny: number, nz: number, spread: number) {
    let x = nx + (Math.random() * 2 - 1) * spread, y = ny + (Math.random() * 2 - 1) * spread, z = nz + (Math.random() * 2 - 1) * spread;
    const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    return [x, y, z];
  }

  sparksAt(pos: THREE.Vector3, n: THREE.Vector3, count: number, color: THREE.ColorRepresentation, speed = 8, spread = 0.8, life = 0.5) {
    const c = this.c.set(color);
    count = Math.ceil(count * this.scale);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = this.rdir(n.x, n.y, n.z, spread);
      const sp = speed * (0.3 + Math.random());
      this.spawn(this.sparks, pos.x, pos.y, pos.z, x * sp, y * sp, z * sp, life * (0.4 + Math.random() * 0.8), c, 0.018 + Math.random() * 0.012, 16, 0.6);
    }
  }
  smokeAt(pos: THREE.Vector3, count: number, color: THREE.ColorRepresentation, size = 0.6, life = 1.2, rise = 0.6, speed = 1) {
    const c = this.c.set(color);
    count = Math.ceil(count * this.scale);
    for (let i = 0; i < count; i++) {
      this.spawn(this.smoke, pos.x + (Math.random() - 0.5) * 0.3, pos.y + (Math.random() - 0.5) * 0.3, pos.z + (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * speed, Math.random() * rise, (Math.random() - 0.5) * speed, life * (0.6 + Math.random() * 0.8), c, size * (0.6 + Math.random() * 0.8), -0.3, 1.5);
    }
  }
  glowAt(pos: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life: number) {
    this.spawn(this.glow, pos.x, pos.y, pos.z, 0, 0, 0, life, this.c.set(color), size, 0, 0);
  }
  shardsAt(pos: THREE.Vector3, dir: THREE.Vector3, count: number, color: THREE.ColorRepresentation, speed = 5, size = 0.03, life = 1.6) {
    const c = this.c.set(color);
    count = Math.ceil(count * this.scale);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = this.rdir(dir.x, dir.y, dir.z, 1.2);
      const sp = speed * (0.3 + Math.random());
      this.spawn(this.shards, pos.x, pos.y, pos.z, x * sp, y * sp + 1, z * sp, life * (0.5 + Math.random()), c, size * (0.5 + Math.random()), 18, 0.3);
    }
  }

  update(dt: number, camera: THREE.Camera) {
    this.step(this.sparks, dt, 'spark', camera);
    this.step(this.smoke, dt, 'smoke', camera);
    this.step(this.glow, dt, 'glow', camera);
    this.step(this.shards, dt, 'shard', camera);
  }

  private step(p: Pool, dt: number, kind: 'spark' | 'smoke' | 'glow' | 'shard', camera: THREE.Camera) {
    let i = 0;
    while (i < p.n) {
      p.life[i] -= dt;
      if (p.life[i] <= 0) { this.kill(p, i); continue; }
      const i3 = i * 3;
      const dr = Math.max(0, 1 - p.drag[i] * dt);
      p.vel[i3] *= dr; p.vel[i3 + 1] = p.vel[i3 + 1] * dr - p.grav[i] * dt; p.vel[i3 + 2] *= dr;
      p.pos[i3] += p.vel[i3] * dt; p.pos[i3 + 1] += p.vel[i3 + 1] * dt; p.pos[i3 + 2] += p.vel[i3 + 2] * dt;
      if ((kind === 'spark' || kind === 'shard') && p.pos[i3 + 1] < this.floorY + 0.01 && p.vel[i3 + 1] < 0) {
        p.pos[i3 + 1] = this.floorY + 0.01; p.vel[i3 + 1] *= -0.35; p.vel[i3] *= 0.6; p.vel[i3 + 2] *= 0.6;
      }
      const k = p.life[i] / p.max[i];
      this.v.set(p.pos[i3], p.pos[i3 + 1], p.pos[i3 + 2]);
      if (kind === 'spark') {
        const vx = p.vel[i3], vy = p.vel[i3 + 1], vz = p.vel[i3 + 2];
        const sp = Math.hypot(vx, vy, vz);
        this.q.setFromUnitVectors(this.up, this.s.set(vx, vy, vz).divideScalar(sp || 1));
        this.s.set(p.size[i], p.size[i], p.size[i] + sp * 0.022);
        const b = 2 + 6 * k;
        this.c.setRGB(p.col[i3] * b, p.col[i3 + 1] * b, p.col[i3 + 2] * b);
      } else if (kind === 'smoke' || kind === 'glow') {
        this.q.copy(camera.quaternion);
        const grow = kind === 'smoke' ? 1 + (1 - k) * 2 : 1;
        this.s.setScalar(p.size[i] * grow);
        const a = kind === 'smoke' ? Math.sin(k * Math.PI) * 0.5 : k * k;
        this.c.setRGB(p.col[i3] * a, p.col[i3 + 1] * a, p.col[i3 + 2] * a);
      } else {
        p.rot[i3] += p.spin[i3] * dt; p.rot[i3 + 1] += p.spin[i3 + 1] * dt; p.rot[i3 + 2] += p.spin[i3 + 2] * dt;
        this.q.setFromEuler(this.e.set(p.rot[i3], p.rot[i3 + 1], p.rot[i3 + 2]));
        this.s.setScalar(p.size[i]);
        const b = 0.3 + 2.5 * k * k;
        this.c.setRGB(p.col[i3] * b, p.col[i3 + 1] * b, p.col[i3 + 2] * b);
      }
      this.m.compose(this.v, this.q, this.s);
      p.mesh.setMatrixAt(i, this.m);
      p.mesh.setColorAt(i, this.c);
      i++;
    }
    p.mesh.count = p.n;
    p.mesh.instanceMatrix.needsUpdate = true;
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
  }

  private kill(p: Pool, i: number) {
    const last = --p.n;
    if (i === last) return;
    const cp = (a: Float32Array, w: number) => { for (let k = 0; k < w; k++) a[i * w + k] = a[last * w + k]; };
    cp(p.pos, 3); cp(p.vel, 3); cp(p.col, 3); cp(p.rot, 3); cp(p.spin, 3);
    cp(p.life, 1); cp(p.max, 1); cp(p.size, 1); cp(p.grav, 1); cp(p.drag, 1);
  }

  clear() { this.sparks.n = this.smoke.n = this.glow.n = this.shards.n = 0; }
  get count() { return this.sparks.n + this.smoke.n + this.glow.n + this.shards.n; }
}
