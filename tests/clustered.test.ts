import { describe, it, expect } from 'vitest';
import { ClusterGrid, binLights, clusterIndex, sliceForDepth } from '../src/render/clustered';

const grid: ClusterGrid = { nx: 16, ny: 9, nz: 24, maxPerCluster: 32 };
const cam = { fovY: 90 * Math.PI / 180, aspect: 16 / 9, near: 0.1, far: 200 };

function countAt(buf: Float32Array, c: number) { return buf[c * (grid.maxPerCluster + 1)]; }
function lightsAt(buf: Float32Array, c: number) {
  const n = countAt(buf, c); const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(buf[c * (grid.maxPerCluster + 1) + 1 + i]);
  return out;
}

describe('clustered light binning', () => {
  it('depth slices are exponential and monotonic', () => {
    expect(sliceForDepth(0.1, cam, grid)).toBe(0);
    expect(sliceForDepth(199, cam, grid)).toBe(23);
    expect(sliceForDepth(5, cam, grid)).toBeLessThan(sliceForDepth(50, cam, grid));
  });
  it('a light straight ahead lands in the center tiles at its depth only', () => {
    const buf = binLights([{ x: 0, y: 0, z: -10, r: 0.5 }], cam, grid);
    const z = sliceForDepth(10, cam, grid);
    const center = clusterIndex(8, 4, z, grid);
    expect(lightsAt(buf, center)).toContain(0);
    expect(countAt(buf, clusterIndex(0, 0, z, grid))).toBe(0);    // far corner tile
    expect(countAt(buf, clusterIndex(8, 4, 0, grid))).toBe(0);    // near slice
    expect(countAt(buf, clusterIndex(8, 4, 23, grid))).toBe(0);   // far slice
  });
  it('lights behind the camera are culled', () => {
    const buf = binLights([{ x: 0, y: 0, z: 5, r: 1 }], cam, grid);
    let total = 0; for (let c = 0; c < 16 * 9 * 24; c++) total += countAt(buf, c);
    expect(total).toBe(0);
  });
  it('a light enclosing the camera touches every tile of the near slices', () => {
    const buf = binLights([{ x: 0, y: 0, z: 0, r: 3 }], cam, grid);
    expect(countAt(buf, clusterIndex(0, 0, 0, grid))).toBe(1);
    expect(countAt(buf, clusterIndex(15, 8, 0, grid))).toBe(1);
  });
  it('caps per-cluster count at maxPerCluster', () => {
    const many = Array.from({ length: 50 }, () => ({ x: 0, y: 0, z: -10, r: 2 }));
    const buf = binLights(many, cam, grid);
    const z = sliceForDepth(10, cam, grid);
    expect(countAt(buf, clusterIndex(8, 4, z, grid))).toBe(32);
  });
});
