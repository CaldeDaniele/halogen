import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/world';
import { PartInstancer } from '../src/render/instancer';
import { DebrisSystem } from '../src/game/level/props';

let phys: PhysicsWorld;
beforeAll(async () => { phys = await PhysicsWorld.create(); });

describe('DebrisSystem with instancing', () => {
  it('box chunks of any size share one instanced batch per material and leave no meshes in the scene', () => {
    const scene = new THREE.Scene();
    const instancer = new PartInstancer(scene);
    const ctx: any = { phys, scene, game: { instancer } };
    const debris = new DebrisSystem(ctx, 200);
    const mat = new THREE.MeshStandardMaterial();
    for (let i = 0; i < 30; i++) {
      const s = 0.1 + i * 0.01;
      debris.spawn(new THREE.Mesh(new THREE.BoxGeometry(s, s * 2, s), mat), new THREE.Vector3(i, 2, 0), new THREE.Quaternion(), [s / 2, s, s / 2], new THREE.Vector3());
    }
    debris.update(1 / 120);
    instancer.flush();
    const inst = scene.children.filter(c => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
    expect(inst).toHaveLength(1);
    expect(inst[0].count).toBe(30);
    expect(scene.children.filter(c => (c as THREE.Mesh).isMesh && !(c as THREE.InstancedMesh).isInstancedMesh)).toHaveLength(0);
    // the instance carries the chunk's size and follows its body
    const m = new THREE.Matrix4(); inst[0].getMatrixAt(29, m);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(); m.decompose(p, q, sc);
    expect(sc.x).toBeCloseTo(0.39, 5); expect(sc.y).toBeCloseTo(0.78, 5);
    expect(p.x).toBeCloseTo(29, 1);
    debris.clear();
    instancer.flush();
    expect(inst[0].count).toBe(0);
  });
});
