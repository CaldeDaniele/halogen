import * as THREE from 'three';
import { RoomLayout, isWalkable, cellToWorld, worldToCell } from './generator';
import type { Nav } from '../enemies/ai';

/** A* over the room grid with path caching per (from,to) cell pair and line-of-walk smoothing. */
export class NavGrid implements Nav {
  private cache = new Map<string, { path: number[]; t: number }>();
  private t = 0;
  lightAt: (p: THREE.Vector3) => number = () => 1;

  constructor(private r: RoomLayout) {}

  tick(dt: number) { this.t += dt; }

  private ok(i: number) { return isWalkable(this.r.grid[i]); }

  path(sx: number, sy: number, tx: number, ty: number): number[] | null {
    const r = this.r, W = r.w;
    const start = sy * W + sx, goal = ty * W + tx;
    if (!this.ok(goal)) return null;
    const g = new Map<number, number>([[start, 0]]);
    const came = new Map<number, number>();
    const open: [number, number][] = [[start, 0]];
    const h = (i: number) => Math.abs((i % W) - tx) + Math.abs(((i / W) | 0) - ty);
    let iter = 0;
    while (open.length && iter++ < 2500) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (open[k][1] < open[bi][1]) bi = k;
      const [cur] = open.splice(bi, 1)[0];
      if (cur === goal) {
        const p = [cur]; let c = cur;
        while (came.has(c)) { c = came.get(c)!; p.push(c); }
        return p.reverse();
      }
      const cx = cur % W, cy = (cur / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= r.h) continue;
        const ni = ny * W + nx;
        if (!this.ok(ni) || Math.abs(r.heights[ni] - r.heights[cur]) > 0.9) continue;
        if (dx && dy && (!this.ok(cy * W + nx) || !this.ok(ny * W + cx))) continue; // no corner cutting
        const ng = g.get(cur)! + (dx && dy ? 1.414 : 1);
        if (ng < (g.get(ni) ?? Infinity)) { g.set(ni, ng); came.set(ni, cur); open.push([ni, ng + h(ni)]); }
      }
    }
    return null;
  }

  next(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
    const r = this.r;
    const [sx, sy] = worldToCell(r, from.x, from.z);
    let [tx, ty] = worldToCell(r, to.x, to.z);
    tx = Math.max(1, Math.min(r.w - 2, tx)); ty = Math.max(1, Math.min(r.h - 2, ty));
    if (sx === tx && sy === ty) return to.clone();
    const key = `${sx},${sy}>${tx},${ty}`;
    let entry = this.cache.get(key);
    if (!entry || this.t - entry.t > 1.5) {
      const p = this.path(sx, sy, tx, ty) ?? this.path(sx, sy, ...this.nearestOpen(tx, ty));
      entry = { path: p ?? [], t: this.t };
      this.cache.set(key, entry);
      if (this.cache.size > 400) this.cache.clear();
    }
    const p = entry.path;
    if (p.length < 2) return to.clone();
    const i = p[Math.min(2, p.length - 1)];
    const [wx, wz] = cellToWorld(r, i % r.w, (i / r.w) | 0);
    return new THREE.Vector3(wx, from.y, wz);
  }

  private nearestOpen(x: number, y: number): [number, number] {
    for (let rad = 1; rad < 5; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx > 0 && ny > 0 && nx < this.r.w - 1 && ny < this.r.h - 1 && this.ok(ny * this.r.w + nx)) return [nx, ny];
    }
    return [x, y];
  }

  randomNear(p: THREE.Vector3, rMin: number, rMax: number) {
    const r = this.r;
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * Math.PI * 2, d = rMin + Math.random() * (rMax - rMin);
      const wx = p.x + Math.cos(a) * d, wz = p.z + Math.sin(a) * d;
      const [cx, cy] = worldToCell(r, wx, wz);
      if (cx > 0 && cy > 0 && cx < r.w - 1 && cy < r.h - 1 && r.grid[cy * r.w + cx] === 0) {
        const [x, z] = cellToWorld(r, cx, cy);
        return new THREE.Vector3(x, r.heights[cy * r.w + cx], z);
      }
    }
    return null;
  }

  darkSpotNear(p: THREE.Vector3) {
    let best: THREE.Vector3 | null = null, bl = Infinity;
    for (let k = 0; k < 10; k++) {
      const c = this.randomNear(p, 3, 12);
      if (!c) continue;
      const l = this.lightAt(c.clone().setY(1));
      if (l < bl) { bl = l; best = c; }
    }
    return best;
  }
}
