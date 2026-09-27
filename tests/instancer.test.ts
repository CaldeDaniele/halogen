import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PartInstancer } from '../src/render/instancer';

const m4 = (x: number) => new THREE.Matrix4().makeTranslation(x, 0, 0);
const xOf = (im: THREE.InstancedMesh, i: number) => { const m = new THREE.Matrix4(); im.getMatrixAt(i, m); return new THREE.Vector3().setFromMatrixPosition(m).x; };

describe('PartInstancer', () => {
  it('batches parts sharing geometry + material + shadow flag into one InstancedMesh', () => {
    const scene = new THREE.Scene();
    const inst = new PartInstancer(scene);
    const geo = new THREE.BoxGeometry(), a = new THREE.MeshStandardMaterial(), b = new THREE.MeshStandardMaterial();
    for (let i = 0; i < 5; i++) inst.add(geo, a, true);
    inst.add(geo, b, true);
    inst.add(geo, a, false);
    inst.flush();
    const meshes = scene.children.filter(c => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
    expect(meshes).toHaveLength(3);
    expect(meshes.map(m => m.count).sort()).toEqual([1, 1, 5]);
  });

  it('removal keeps the remaining instances intact (swap-remove) and grows past capacity', () => {
    const scene = new THREE.Scene();
    const inst = new PartInstancer(scene, 2);
    const geo = new THREE.BoxGeometry(), mat = new THREE.MeshBasicMaterial();
    const parts = [0, 1, 2, 3, 4].map(() => inst.add(geo, mat, false));
    parts.forEach((p, i) => p.setMatrix(m4(i)));
    inst.remove(parts[1]);
    inst.flush();
    const im = scene.children.find(c => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    expect(im.count).toBe(4);
    const xs = Array.from({ length: im.count }, (_, i) => xOf(im, i)).sort();
    expect(xs).toEqual([0, 2, 3, 4]);
    // a moved handle still writes to its own slot
    parts[4].setMatrix(m4(40));
    inst.flush();
    expect(Array.from({ length: im.count }, (_, i) => xOf(im, i)).sort((p, q) => p - q)).toEqual([0, 2, 3, 40]);
  });

  it('per-instance color for emissive parts; hidden parts collapse to zero scale', () => {
    const scene = new THREE.Scene();
    const inst = new PartInstancer(scene);
    const geo = new THREE.BoxGeometry(), mat = new THREE.MeshBasicMaterial();
    const p = inst.add(geo, mat, false);
    p.setColor(new THREE.Color(2, 0.5, 0));
    p.setMatrix(m4(1));
    inst.flush();
    const im = scene.children[0] as THREE.InstancedMesh;
    const c = new THREE.Color(); im.getColorAt(0, c);
    expect([c.r, c.g, c.b]).toEqual([2, 0.5, 0]);
    p.visible = false; p.setMatrix(m4(1)); inst.flush();
    const m = new THREE.Matrix4(); im.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).length()).toBe(0);
  });

  it('removing the last part of a batch empties it without errors; double remove is a no-op', () => {
    const scene = new THREE.Scene();
    const inst = new PartInstancer(scene);
    const p = inst.add(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), false);
    inst.remove(p); inst.remove(p); inst.flush();
    expect((scene.children[0] as THREE.InstancedMesh).count).toBe(0);
  });
});
