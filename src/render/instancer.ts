import * as THREE from 'three';

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** One instanced part. Holds its slot in a batch; the slot moves when other parts are removed. */
export class Part {
  visible = true;
  alive = true;
  constructor(readonly batch: Batch, public index: number) {}
  setMatrix(m: THREE.Matrix4) { this.batch.writeMatrix(this.index, this.visible ? m : HIDDEN); }
  setColor(c: THREE.Color) { this.batch.writeColor(this.index, c); }
}

class Batch {
  mesh: THREE.InstancedMesh;
  parts: Part[] = [];
  private dirty = false;

  constructor(private scene: THREE.Scene, readonly geo: THREE.BufferGeometry, readonly mat: THREE.Material, readonly shadow: boolean, private cap: number) {
    this.mesh = this.make(cap);
    scene.add(this.mesh);
  }

  private make(cap: number) {
    const m = new THREE.InstancedMesh(this.geo, this.mat, cap);
    m.count = this.parts.length;
    m.castShadow = m.receiveShadow = this.shadow;
    m.frustumCulled = false; // instances are spread over the room; per-instance bounds would cost more than they save
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return m;
  }

  add() {
    if (this.parts.length === this.cap) this.grow();
    const p = new Part(this, this.parts.length);
    this.parts.push(p);
    this.mesh.count = this.parts.length;
    this.writeMatrix(p.index, HIDDEN);
    if (this.mesh.instanceColor) this.writeColor(p.index, new THREE.Color(1, 1, 1));
    return p;
  }

  remove(p: Part) {
    const last = this.parts.pop()!;
    if (last !== p) {
      // swap-remove: move the last instance into the freed slot
      const a = this.mesh.instanceMatrix.array as Float32Array;
      a.copyWithin(p.index * 16, last.index * 16, last.index * 16 + 16);
      const c = this.mesh.instanceColor?.array as Float32Array | undefined;
      c?.copyWithin(p.index * 3, last.index * 3, last.index * 3 + 3);
      last.index = p.index;
      this.parts[p.index] = last;
    }
    this.mesh.count = this.parts.length;
    this.dirty = true;
  }

  private grow() {
    const old = this.mesh;
    this.cap *= 2;
    this.mesh = this.make(this.cap);
    (this.mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    if (old.instanceColor) {
      this.mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // allocates the attribute
      (this.mesh.instanceColor!.array as Float32Array).set(old.instanceColor.array as Float32Array);
    }
    this.scene.remove(old); old.dispose();
    this.scene.add(this.mesh);
    this.dirty = true;
  }

  writeMatrix(i: number, m: THREE.Matrix4) { this.mesh.setMatrixAt(i, m); this.dirty = true; }
  writeColor(i: number, c: THREE.Color) {
    const first = !this.mesh.instanceColor;
    this.mesh.setColorAt(i, c);
    if (first) {
      (this.mesh.instanceColor!.array as Float32Array).fill(1).set([c.r, c.g, c.b], i * 3);
      this.mat.needsUpdate = true; // program needs USE_INSTANCING_COLOR
    }
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() { this.scene.remove(this.mesh); this.mesh.dispose(); }
}

/**
 * Batches many small moving parts (android armor plates, joints, glow rings) into one
 * InstancedMesh per (geometry, material, shadow) so 40 ragdolls cost a few dozen draw calls
 * instead of ~1,300. Callers write world matrices every frame, then `flush()` once.
 */
export class PartInstancer {
  private batches = new Map<string, Batch>();
  private ids = new WeakMap<object, number>();
  private nextId = 1;

  constructor(private scene: THREE.Scene, private initialCap = 64) {}

  private id(o: object) { let k = this.ids.get(o); if (!k) { k = this.nextId++; this.ids.set(o, k); } return k; }

  add(geo: THREE.BufferGeometry, mat: THREE.Material, castShadow: boolean) {
    const key = `${this.id(geo)}|${this.id(mat)}|${castShadow ? 1 : 0}`;
    let b = this.batches.get(key);
    if (!b) { b = new Batch(this.scene, geo, mat, castShadow, this.initialCap); this.batches.set(key, b); }
    return b.add();
  }

  remove(p: Part) {
    if (!p.alive) return;
    p.alive = false;
    p.batch.remove(p);
  }

  flush() { for (const b of this.batches.values()) b.flush(); }

  /** Draw calls this instancer currently issues (non-empty batches). */
  get drawCalls() { let n = 0; for (const b of this.batches.values()) if (b.parts.length) n++; return n; }

  dispose() { for (const b of this.batches.values()) b.dispose(); this.batches.clear(); }
}
