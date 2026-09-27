import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAPIER, G, groups, ALL } from '../../physics/world';
import type { Ctx } from '../types';
import { CELL, Cell, RoomLayout, cellToWorld, DoorSpec } from './generator';
import { worldBox, tex } from '../../render/materials';
import { Fixture } from './fixtures';
import { Prop, DebrisSystem } from './props';
import { NavGrid } from './navgrid';
import { LightType } from '../../render/lights';

export interface Door { spec: DoorSpec; mesh: THREE.Mesh; frame: THREE.Group; collider: RAPIER.Collider; open: number; target: number; world: THREE.Vector3; label?: THREE.Sprite; reward?: string; neon: THREE.Mesh[] }

const SECTOR_MATS = [
  { wall: 'wall', floor: 'floor', accent: 'hazard', cover: 'panel', pillar: 'wall', ceiling: 'ceiling' },
  { wall: 'pipes', floor: 'diamond', accent: 'hazard', cover: 'metal', pillar: 'panel', ceiling: 'ceiling' },
  { wall: 'stained', floor: 'tiles', accent: 'panel', cover: 'wall', pillar: 'stained', ceiling: 'ceiling' },
];

const SIGNS = ['stack', 'obey', 'exit'];

/** Instantiates a RoomLayout: merged static geometry per material, greedy colliders, doors, fixtures, props. */
export class Room {
  readonly group = new THREE.Group();
  bodies: RAPIER.RigidBody[] = [];
  fixtures: Fixture[] = [];
  props: Prop[] = [];
  doors: Door[] = [];
  entryDoor!: Door;
  nav: NavGrid;
  keyLights: THREE.SpotLight[] = [];
  extraLights: any[] = [];
  cleared = false;

  constructor(private ctx: Ctx, readonly layout: RoomLayout, debris: DebrisSystem, onFixtureBreak: (f: Fixture, byPlayer: boolean) => void, onPropDestroy: (p: Prop) => void) {
    const r = layout;
    const mats = SECTOR_MATS[r.sector % SECTOR_MATS.length];
    const geos = new Map<string, THREE.BufferGeometry[]>();
    const push = (mat: string, g: THREE.BufferGeometry) => { let a = geos.get(mat); if (!a) geos.set(mat, (a = [])); a.push(g); };
    const box = (mat: string, w: number, h: number, d: number, x: number, y: number, z: number, tile = 3, collide = true, rotY = 0) => {
      const g = worldBox(w, h, d, tile);
      if (rotY) g.rotateY(rotY);
      g.translate(x, y, z);
      push(mat, g);
      if (collide) this.fixed(x, y, z, w / 2, h / 2, d / 2);
    };
    const W = r.w * CELL, H = r.h * CELL;
    const hgt = r.height;
    // floor + ceiling (floor in 2 halves so UVs stay small)
    box(mats.floor, W, 1, H, 0, -0.5, 0, 4);
    box(mats.ceiling, W, 1, H, 0, hgt + 0.5, 0, 4);
    // perimeter walls with door gaps: walk each wall row/column and emit runs
    const wallRun = (horizontal: boolean, fixedIdx: number) => {
      const n = horizontal ? r.w : r.h;
      let start = -1;
      for (let i = 0; i <= n; i++) {
        const c = i < n ? (horizontal ? r.grid[fixedIdx * r.w + i] : r.grid[i * r.w + fixedIdx]) : -1;
        const solid = c === Cell.WALL;
        if (solid && start < 0) start = i;
        if (!solid && start >= 0) {
          const len = (i - start) * CELL;
          const mid = (start + i) / 2;
          if (horizontal) box(mats.wall, len, hgt, CELL, (mid - r.w / 2) * CELL, hgt / 2, (fixedIdx - r.h / 2 + 0.5) * CELL, 3.5);
          else box(mats.wall, CELL, hgt, len, (fixedIdx - r.w / 2 + 0.5) * CELL, hgt / 2, (mid - r.h / 2) * CELL, 3.5);
          start = -1;
        }
      }
    };
    wallRun(true, 0); wallRun(true, r.h - 1);
    wallRun(false, 0); wallRun(false, r.w - 1);
    // skirting accent strip along walls
    box(mats.accent, W - 2 * CELL, 0.35, 0.1, 0, 0.175, -H / 2 + CELL + 0.05, 1, false);
    box(mats.accent, W - 2 * CELL, 0.35, 0.1, 0, 0.175, H / 2 - CELL - 0.05, 1, false);

    // interior cells
    for (let y = 1; y < r.h - 1; y++) {
      let x = 1;
      while (x < r.w - 1) {
        const c = r.grid[y * r.w + x];
        if (c === Cell.PILLAR || c === Cell.LOW || c === Cell.HIGH || c === Cell.PLAT) {
          // greedy run along x of the same type
          let x2 = x;
          while (x2 + 1 < r.w - 1 && r.grid[y * r.w + x2 + 1] === c) x2++;
          const n = x2 - x + 1;
          const [wx0] = cellToWorld(r, x, y);
          const [, wz] = cellToWorld(r, x, y);
          const cx = wx0 + (n - 1) * CELL / 2;
          if (c === Cell.PILLAR) for (let k = 0; k < n; k++) box(mats.pillar, 1.7, hgt, 1.7, wx0 + k * CELL, hgt / 2, wz, 2.5);
          else if (c === Cell.LOW) { box(mats.cover, n * CELL - 0.2, 1.15, CELL * 0.7, cx, 0.575, wz, 1.5); box(mats.accent, n * CELL - 0.2, 0.08, CELL * 0.72, cx, 1.19, wz, 1, false); }
          else if (c === Cell.HIGH) box(mats.cover, n * CELL - 0.2, 2.4, CELL * 0.75, cx, 1.2, wz, 1.8);
          else { box(mats.floor, n * CELL, 2.4, CELL, cx, 1.2, wz, 3); }
          x = x2 + 1;
        } else x++;
      }
    }
    // platform edge accents
    for (let y = 1; y < r.h - 1; y++) for (let x = 1; x < r.w - 1; x++) {
      if (r.grid[y * r.w + x] !== Cell.PLAT) continue;
      const [wx, wz] = cellToWorld(r, x, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = r.grid[(y + dy) * r.w + x + dx];
        if (n === Cell.PLAT || n === Cell.RAMP) continue;
        const g = new THREE.BoxGeometry(dx ? 0.06 : CELL, 0.06, dx ? CELL : 0.06);
        g.translate(wx + dx * (CELL / 2), 2.42, wz + dy * (CELL / 2));
        push('__neon', g);
      }
    }
    // ramps: group consecutive cells by direction
    const seen = new Set<number>();
    for (let y = 1; y < r.h - 1; y++) for (let x = 1; x < r.w - 1; x++) {
      const i = y * r.w + x;
      if (r.grid[i] !== Cell.RAMP || seen.has(i)) continue;
      const dir = r.rampDir[i];
      const [ddx, ddy] = dir === 1 ? [1, 0] : dir === 2 ? [-1, 0] : dir === 3 ? [0, 1] : [0, -1];
      // walk to the low end
      let lx = x, ly = y;
      while (r.grid[(ly - ddy) * r.w + lx - ddx] === Cell.RAMP) { lx -= ddx; ly -= ddy; }
      const cells: number[] = [];
      let cx = lx, cy = ly;
      while (r.grid[cy * r.w + cx] === Cell.RAMP) { cells.push(cy * r.w + cx); seen.add(cy * r.w + cx); cx += ddx; cy += ddy; }
      const len = cells.length * CELL;
      const [sx, sz] = cellToWorld(r, lx, ly);
      const startX = sx - ddx * CELL / 2, startZ = sz - ddy * CELL / 2;
      const endX = startX + ddx * len, endZ = startZ + ddy * len;
      const rise = 2.4;
      const slopeLen = Math.hypot(len, rise);
      const ang = Math.atan2(rise, len);
      const th = 0.4;
      const g = worldBox(ddx ? slopeLen : CELL, th, ddx ? CELL : slopeLen, 2);
      // tilt: rotate about the axis perpendicular to ascent so the high end is at the platform
      const m = new THREE.Matrix4();
      if (ddx) m.makeRotationZ(ang * ddx); else m.makeRotationX(-ang * ddy);
      g.applyMatrix4(m);
      const cxw = (startX + endX) / 2, czw = (startZ + endZ) / 2;
      const nrm = new THREE.Vector3(0, 1, 0).applyMatrix4(new THREE.Matrix4().extractRotation(m));
      g.translate(cxw - nrm.x * th / 2, rise / 2 - nrm.y * th / 2, czw - nrm.z * th / 2);
      push(mats.accent === 'hazard' ? 'diamond' : mats.cover, g);
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      const body = ctx.phys.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cxw - nrm.x * th / 2, rise / 2 - nrm.y * th / 2, czw - nrm.z * th / 2).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
      ctx.phys.world.createCollider(RAPIER.ColliderDesc.cuboid(ddx ? slopeLen / 2 : CELL / 2, th / 2, ddx ? CELL / 2 : slopeLen / 2).setCollisionGroups(groups(G.STATIC, ALL)), body);
      this.bodies.push(body);
    }

    // merge & add static meshes
    for (const [mat, list] of geos) {
      const merged = mergeGeometries(list, false);
      list.forEach(g => g.dispose());
      const mesh = new THREE.Mesh(merged, mat === '__neon' ? ctx.mats.neon(r.palette[0], 4) : ctx.mats.get(mat));
      mesh.receiveShadow = true; mesh.castShadow = mat !== '__neon';
      this.group.add(mesh);
    }
    ctx.scene.add(this.group);

    // doors
    this.entryDoor = this.makeDoor(r.entry, true);
    for (const e of r.exits) this.doors.push(this.makeDoor(e, false));

    // fixtures
    for (const f of r.fixtures) this.fixtures.push(new Fixture(ctx, f, this.group, onFixtureBreak));
    // props
    for (const p of r.props) this.props.push(new Prop(ctx, p, this.group, debris, onPropDestroy));

    // key shadowed spots (1-2)
    const nKeys = r.type === 'dark' ? 1 : 2;
    for (let i = 0; i < nKeys; i++) {
      const sp = new THREE.SpotLight(0xd8ecff, r.type === 'dark' ? 40 : 70, hgt * 3, 0.55, 0.7, 1.3);
      const [kx, kz] = [(i === 0 ? -1 : 1) * W * 0.18, (i === 0 ? -1 : 1) * H * 0.12];
      sp.position.set(kx, hgt - 0.4, kz); sp.target.position.set(kx * 0.5, 0, kz * 0.5);
      sp.castShadow = ctx.renderer.cfg.shadows; sp.shadow.mapSize.set(1024, 1024); sp.shadow.bias = -0.0004; sp.shadow.normalBias = 0.03; sp.shadow.camera.near = 0.5;
      this.group.add(sp, sp.target);
      this.keyLights.push(sp);
      // matching volumetric cone + visible fixture
      this.extraLights.push(ctx.lights.add({ type: LightType.Spot, pos: sp.position.clone(), pos2: sp.target.position.clone().sub(sp.position).normalize(), spotCos: Math.cos(0.5), color: new THREE.Color(0xd8ecff), intensity: r.type === 'dark' ? 16 : 26, radius: hgt * 2 }));
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 0.25, 16), ctx.mats.neon(0xeaf6ff, 6));
      lamp.position.copy(sp.position).add(new THREE.Vector3(0, 0.15, 0)); this.group.add(lamp);
    }
    // neon signs
    const rng = (n: number) => Math.abs(Math.sin(r.seed * 12.9898 + n * 78.233)) % 1;
    const signs = [`sector${(r.sector % 3) + 1}`, SIGNS[Math.floor(rng(1) * SIGNS.length)]];
    signs.forEach((s, i) => {
      const t = tex(`assets/signs/${s}.webp`);
      const mat = new THREE.MeshBasicMaterial({ map: t, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(2.2, 2.2, 2.2) });
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), mat);
      if (i === 0) { pl.position.set(0, hgt - 2.3, -H / 2 + CELL + 0.05); }
      else { pl.position.set(-W / 2 + CELL + 0.05, 3.2, (rng(2) - 0.5) * H * 0.5); pl.rotation.y = Math.PI / 2; }
      this.group.add(pl);
      const c = i === 0 ? r.palette[0] : 0xff2bd6;
      this.extraLights.push(ctx.lights.add({ pos: pl.position.clone().add(new THREE.Vector3(i === 0 ? 0 : 0.8, 0, i === 0 ? 0.8 : 0)), color: new THREE.Color(c), intensity: 5, radius: 6 }));
    });

    this.nav = new NavGrid(r);
    ctx.particles.floorY = 0;
    ctx.sfx.setRoomSize(Math.max(W, H));
  }

  private fixed(x: number, y: number, z: number, hx: number, hy: number, hz: number) {
    const { body } = this.ctx.phys.fixedBox(x, y, z, hx, hy, hz, { kind: 'static', surface: 'concrete' });
    this.bodies.push(body);
  }

  private makeDoor(d: DoorSpec, entry: boolean): Door {
    const ctx = this.ctx, r = this.layout;
    const [wx, wz] = cellToWorld(r, d.x, d.y);
    const frame = new THREE.Group();
    const color = entry ? 0x5a6a78 : r.palette[0];
    const neon = ctx.mats.neon(color, entry ? 1.5 : 6);
    const neonMeshes: THREE.Mesh[] = [];
    for (const [w, h, x, y] of [[0.08, 3.6, -1.05, 1.8], [0.08, 3.6, 1.05, 1.8], [2.18, 0.08, 0, 3.6]] as const) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), neon);
      m.position.set(x, y, 0); frame.add(m); neonMeshes.push(m);
    }
    frame.position.set(wx, 0, wz + (d.y === 0 ? CELL / 2 - 0.05 : -CELL / 2 + 0.05));
    this.group.add(frame);
    const slab = new THREE.Mesh(worldBox(2, 3.6, 0.3, 1.2), ctx.mats.get('metal'));
    slab.position.set(wx, 1.8, wz);
    slab.castShadow = true;
    this.group.add(slab);
    // door-gap collider fills the whole wall cell (closed) — disabled when open
    const col = ctx.phys.world.createCollider(RAPIER.ColliderDesc.cuboid(CELL / 2, r.height / 2, CELL / 2).setTranslation(wx, r.height / 2, wz).setCollisionGroups(groups(G.STATIC, ALL)));
    ctx.phys.tag(col, { kind: 'static', surface: 'metal' });
    // lintel above door
    const lintel = new THREE.Mesh(worldBox(CELL, r.height - 3.6, CELL, 3.5), ctx.mats.get(SECTOR_MATS[r.sector % 3].wall));
    lintel.position.set(wx, 3.6 + (r.height - 3.6) / 2, wz);
    this.group.add(lintel);
    return { spec: d, mesh: slab, frame, collider: col, open: 0, target: 0, world: new THREE.Vector3(wx, 0, wz), neon: neonMeshes };
  }

  setDoorsOpen(open: boolean) {
    for (const d of this.doors) {
      d.target = open ? 1 : 0;
      d.collider.setEnabled(!open);
      if (open) this.ctx.sfx.play('door', { pos: d.world });
    }
  }

  update(dt: number) {
    for (const d of [...this.doors, this.entryDoor]) {
      d.open += (d.target - d.open) * Math.min(1, dt * 2.5);
      d.mesh.position.y = 1.8 + d.open * 3.4;
    }
    for (const f of this.fixtures) f.update(dt);
    for (const p of this.props) p.sync();
    this.nav.tick(dt);
  }

  /** Light level at a point from room fixtures (0..~2). */
  lightAt(p: THREE.Vector3) {
    let s = 0;
    for (const f of this.fixtures) s += f.influence(p);
    return s;
  }

  worldSpawn(i: number) {
    const s = this.layout.spawns[i % this.layout.spawns.length];
    const [x, z] = cellToWorld(this.layout, s.x, s.y);
    return new THREE.Vector3(x, this.layout.heights[s.y * this.layout.w + s.x], z);
  }
  get entryPoint() {
    const e = this.layout.entry;
    const [x, z] = cellToWorld(this.layout, e.inX, e.inY);
    return new THREE.Vector3(x, 0, z);
  }

  dispose() {
    for (const f of this.fixtures) f.dispose();
    for (const p of this.props) p.dispose();
    for (const b of this.bodies) this.ctx.phys.removeBody(b);
    for (const d of [...this.doors, this.entryDoor]) this.ctx.phys.world.removeCollider(d.collider, false);
    for (const l of this.extraLights) this.ctx.lights.remove(l);
    this.group.removeFromParent();
    this.group.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
  }
}
