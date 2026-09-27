import { Rng } from '../../core/rng';

/** Pure, seeded room layout generation. Output is plain data consumed by builder.ts. */
export const CELL = 2;

export const enum Cell { FLOOR = 0, WALL = 1, PILLAR = 2, LOW = 3, HIGH = 4, PLAT = 5, RAMP = 6, DOOR = 7, VOID = 8 }

export type RoomType = 'arena' | 'gauntlet' | 'shaft' | 'dark' | 'boss' | 'rest' | 'elite';

export interface FixtureSpec {
  kind: 'tube' | 'panel' | 'strip' | 'pillar';
  a: [number, number, number];
  b: [number, number, number];
  color: number;
  intensity: number;
  radius: number;
  breakable: boolean;
  normal: [number, number, number];
}
export interface PropSpec { kind: 'crate' | 'barrel' | 'barrier' | 'column'; x: number; y: number; z: number; size: number; rotY: number }
export interface DoorSpec { x: number; y: number; inX: number; inY: number; dir: [number, number] }

export interface RoomLayout {
  seed: number; type: RoomType; sector: number;
  w: number; h: number; height: number;
  grid: Uint8Array; heights: Float32Array;
  /** ramp direction per cell: 0 none, 1 +x, 2 -x, 3 +y, 4 -y (direction of ascent) */
  rampDir: Uint8Array;
  entry: DoorSpec; exits: DoorSpec[];
  spawns: { x: number; y: number }[];
  fixtures: FixtureSpec[];
  props: PropSpec[];
  palette: number[];
}

export const PALETTES: number[][] = [
  [0x19f0ff, 0x19f0ff, 0xdff6ff, 0xff2bd6],      // S1 Foundry: cold cyan
  [0xffa030, 0xffb02e, 0xfff1b0, 0x19f0ff],      // S2 Grid: sodium orange
  [0xff2bd6, 0xd070ff, 0xffffff, 0x19f0ff],      // S3 Filament: magenta
];

export function cellToWorld(r: RoomLayout, x: number, y: number): [number, number] {
  return [(x - r.w / 2 + 0.5) * CELL, (y - r.h / 2 + 0.5) * CELL];
}
export function worldToCell(r: RoomLayout, wx: number, wz: number): [number, number] {
  return [Math.floor(wx / CELL + r.w / 2), Math.floor(wz / CELL + r.h / 2)];
}

export function isWalkable(c: number) { return c === Cell.FLOOR || c === Cell.PLAT || c === Cell.RAMP || c === Cell.DOOR; }

/** BFS over walkable cells; steps allowed when the elevation change is small (ramps). */
export function walkableFrom(r: RoomLayout, sx: number, sy: number): Set<number> {
  const seen = new Set<number>();
  const q = [sy * r.w + sx];
  seen.add(q[0]);
  while (q.length) {
    const i = q.pop()!;
    const x = i % r.w, y = (i / r.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= r.w || ny >= r.h) continue;
      const j = ny * r.w + nx;
      if (seen.has(j) || !isWalkable(r.grid[j])) continue;
      if (Math.abs(r.heights[j] - r.heights[i]) > 0.9) continue;
      seen.add(j); q.push(j);
    }
  }
  return seen;
}

function makeRoom(seed: number, type: RoomType, sector: number, w: number, h: number, height: number): RoomLayout {
  const grid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) grid[y * w + x] = Cell.WALL;
  return {
    seed, type, sector, w, h, height, grid, heights: new Float32Array(w * h), rampDir: new Uint8Array(w * h),
    entry: { x: 0, y: 0, inX: 0, inY: 0, dir: [0, -1] }, exits: [], spawns: [], fixtures: [], props: [],
    palette: PALETTES[sector % PALETTES.length],
  };
}

const at = (r: RoomLayout, x: number, y: number) => r.grid[y * r.w + x];
const set = (r: RoomLayout, x: number, y: number, c: number) => { if (x > 0 && y > 0 && x < r.w - 1 && y < r.h - 1) r.grid[y * r.w + x] = c; };

function clearZone(r: RoomLayout, cx: number, cy: number, rad: number) {
  for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) {
    if (x <= 0 || y <= 0 || x >= r.w - 1 || y >= r.h - 1) continue;
    const i = y * r.w + x;
    if (r.grid[i] !== Cell.DOOR) { r.grid[i] = Cell.FLOOR; r.heights[i] = 0; r.rampDir[i] = 0; }
  }
}

function placeDoors(r: RoomLayout, rng: Rng, exits: number) {
  const ex = rng.int(3, r.w - 4);
  r.entry = { x: ex, y: r.h - 1, inX: ex, inY: r.h - 2, dir: [0, -1] };
  r.grid[(r.h - 1) * r.w + ex] = Cell.DOOR;
  const used: number[] = [];
  for (let i = 0; i < exits; i++) {
    let x = 0;
    for (let k = 0; k < 20; k++) {
      x = exits === 1 ? rng.int(3, r.w - 4) : Math.round(((i + 1) / (exits + 1)) * (r.w - 1)) + rng.int(-1, 1);
      if (used.every(u => Math.abs(u - x) > 3)) break;
    }
    used.push(x);
    r.exits.push({ x, y: 0, inX: x, inY: 1, dir: [0, -1] });
    r.grid[x] = Cell.DOOR;
  }
}

function addPlatform(r: RoomLayout, rng: Rng, px: number, py: number, pw: number, ph: number) {
  for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) { set(r, x, y, Cell.PLAT); if (at(r, x, y) === Cell.PLAT) r.heights[y * r.w + x] = 2.4; }
  // ramp of 3 cells descending from one side
  const sides = rng.shuffle([0, 1, 2, 3]);
  for (const s of sides) {
    let cells: [number, number][] = [];
    let dir = 0;
    if (s === 0) { const y = py + rng.int(0, ph - 1); cells = [[px - 1, y], [px - 2, y], [px - 3, y]]; dir = 1; }
    if (s === 1) { const y = py + rng.int(0, ph - 1); cells = [[px + pw, y], [px + pw + 1, y], [px + pw + 2, y]]; dir = 2; }
    if (s === 2) { const x = px + rng.int(0, pw - 1); cells = [[x, py - 1], [x, py - 2], [x, py - 3]]; dir = 3; }
    if (s === 3) { const x = px + rng.int(0, pw - 1); cells = [[x, py + ph], [x, py + ph + 1], [x, py + ph + 2]]; dir = 4; }
    if (cells.every(([x, y]) => x > 1 && y > 1 && x < r.w - 2 && y < r.h - 2 && at(r, x, y) === Cell.FLOOR)) {
      cells.forEach(([x, y], k) => { set(r, x, y, Cell.RAMP); r.heights[y * r.w + x] = 1.8 - k * 0.6; r.rampDir[y * r.w + x] = dir; });
      // landing cell beyond the ramp must be floor
      return true;
    }
  }
  // no ramp possible → revert platform
  for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) if (at(r, x, y) === Cell.PLAT) { set(r, x, y, Cell.FLOOR); r.heights[y * r.w + x] = 0; }
  return false;
}

function scatterCover(r: RoomLayout, rng: Rng, n: number) {
  for (let i = 0; i < n; i++) {
    const x = rng.int(2, r.w - 3), y = rng.int(2, r.h - 3);
    const horiz = rng.chance(0.5), len = rng.int(1, 3), kind = rng.chance(0.65) ? Cell.LOW : Cell.HIGH;
    for (let k = 0; k < len; k++) {
      const cx = x + (horiz ? k : 0), cy = y + (horiz ? 0 : k);
      if (at(r, cx, cy) === Cell.FLOOR) set(r, cx, cy, kind);
    }
  }
}

function pillars(r: RoomLayout, rng: Rng, spacing: number, jitter: boolean) {
  const off = rng.int(2, 3);
  for (let y = off; y < r.h - 2; y += spacing) for (let x = off; x < r.w - 2; x += spacing) {
    const jx = jitter ? rng.int(-1, 1) : 0, jy = jitter ? rng.int(-1, 1) : 0;
    if (rng.chance(0.85)) set(r, x + jx, y + jy, Cell.PILLAR);
  }
}

function placeFixtures(r: RoomLayout, rng: Rng, density: number) {
  const pal = r.palette;
  const hw = (r.w * CELL) / 2, hh = (r.h * CELL) / 2;
  const tubeY = Math.min(r.height - 1.2, 5.5);
  // perimeter wall tubes (horizontal), mounted slightly off the wall
  const along = (len: number, place: (t: number, l: number) => void) => {
    let t = rng.range(2, 5);
    while (t < len - 3) { const l = rng.range(2.5, 5); if (rng.chance(density)) place(t, l); t += l + rng.range(3, 7); }
  };
  const inset = CELL - 0.12;
  along(r.w * CELL, (t, l) => {
    const c = rng.pick(pal), x0 = -hw + t;
    r.fixtures.push({ kind: 'tube', a: [x0, tubeY, -hh + inset], b: [x0 + l, tubeY, -hh + inset], color: c, intensity: 16, radius: 12, breakable: true, normal: [0, 0, 1] });
  });
  along(r.w * CELL, (t, l) => {
    const c = rng.pick(pal), x0 = -hw + t;
    r.fixtures.push({ kind: 'tube', a: [x0, tubeY, hh - inset], b: [x0 + l, tubeY, hh - inset], color: c, intensity: 16, radius: 12, breakable: true, normal: [0, 0, -1] });
  });
  along(r.h * CELL, (t, l) => {
    const c = rng.pick(pal), z0 = -hh + t;
    r.fixtures.push({ kind: 'tube', a: [-hw + inset, tubeY, z0], b: [-hw + inset, tubeY, z0 + l], color: c, intensity: 16, radius: 12, breakable: true, normal: [1, 0, 0] });
  });
  along(r.h * CELL, (t, l) => {
    const c = rng.pick(pal), z0 = -hh + t;
    r.fixtures.push({ kind: 'tube', a: [hw - inset, tubeY, z0], b: [hw - inset, tubeY, z0 + l], color: c, intensity: 16, radius: 12, breakable: true, normal: [-1, 0, 0] });
  });
  // floor-level strips along walls (low accent light, great on wet floors)
  if (rng.chance(0.7)) {
    const c = pal[3] ?? pal[0];
    r.fixtures.push({ kind: 'strip', a: [-hw + inset, 0.15, -hh + 3], b: [-hw + inset, 0.15, hh - 3], color: c, intensity: 7, radius: 6, breakable: true, normal: [1, 0, 0] });
    r.fixtures.push({ kind: 'strip', a: [hw - inset, 0.15, -hh + 3], b: [hw - inset, 0.15, hh - 3], color: c, intensity: 7, radius: 6, breakable: true, normal: [-1, 0, 0] });
  }
  // overhead panels
  const nPanels = Math.round((r.w * r.h) / 70 * density);
  for (let i = 0; i < nPanels; i++) {
    const x = rng.range(-hw + 4, hw - 4), z = rng.range(-hh + 4, hh - 4);
    const along = rng.chance(0.5);
    const l = rng.range(2, 4);
    r.fixtures.push({ kind: 'panel', a: [x - (along ? l / 2 : 0), r.height - 0.3, z - (along ? 0 : l / 2)], b: [x + (along ? l / 2 : 0), r.height - 0.3, z + (along ? 0 : l / 2)],
      color: rng.chance(0.7) ? 0xe6f2ff : rng.pick(pal), intensity: 14, radius: 11, breakable: true, normal: [0, -1, 0] });
  }
  // vertical tubes on some pillars
  for (let y = 1; y < r.h - 1; y++) for (let x = 1; x < r.w - 1; x++) {
    if (at(r, x, y) !== Cell.PILLAR || !rng.chance(0.45 * density)) continue;
    const [wx, wz] = cellToWorld(r, x, y);
    const side = rng.int(0, 3);
    const n: [number, number, number] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]][side] as any;
    const ox = wx + n[0] * 0.86, oz = wz + n[2] * 0.86;
    r.fixtures.push({ kind: 'pillar', a: [ox, 0.8, oz], b: [ox, Math.min(r.height - 1, 4.2), oz], color: rng.pick(pal), intensity: 12, radius: 8, breakable: true, normal: n });
  }
}

function placeProps(r: RoomLayout, rng: Rng, n: number) {
  const reserved = new Set<number>();
  for (let i = 0; i < n; i++) {
    const x = rng.int(2, r.w - 3), y = rng.int(2, r.h - 4);
    const idx = y * r.w + x;
    if (at(r, x, y) !== Cell.FLOOR || reserved.has(idx)) continue;
    if (Math.abs(x - r.entry.x) + Math.abs(y - r.entry.y) < 4) continue;
    reserved.add(idx);
    const [wx, wz] = cellToWorld(r, x, y);
    const roll = rng.next();
    if (roll < 0.45) {
      const cnt = rng.int(1, 3);
      for (let k = 0; k < cnt; k++) {
        const s = rng.range(0.7, 1.1);
        r.props.push({ kind: 'crate', x: wx + rng.range(-0.5, 0.5), y: s / 2 + k * s, z: wz + rng.range(-0.5, 0.5), size: s, rotY: rng.range(0, Math.PI) });
      }
    } else if (roll < 0.72) r.props.push({ kind: 'barrel', x: wx + rng.range(-0.4, 0.4), y: 0.55, z: wz + rng.range(-0.4, 0.4), size: 0.45, rotY: 0 });
    else if (roll < 0.9) r.props.push({ kind: 'barrier', x: wx, y: 0.6, z: wz, size: 1.8, rotY: rng.chance(0.5) ? 0 : Math.PI / 2 });
    else r.props.push({ kind: 'column', x: wx, y: 1.6, z: wz, size: 0.6, rotY: 0 });
  }
}

function pickSpawns(r: RoomLayout, rng: Rng, reach: Set<number>, want: number) {
  const cands: { x: number; y: number }[] = [];
  for (const i of reach) {
    const x = i % r.w, y = (i / r.w) | 0;
    const c = r.grid[i];
    if (c !== Cell.FLOOR && c !== Cell.PLAT) continue;
    const d = Math.abs(x - r.entry.x) + Math.abs(y - r.entry.y);
    if (d < Math.min(9, r.h * 0.45)) continue;
    cands.push({ x, y });
  }
  rng.shuffle(cands);
  // spread out: greedy farthest-first
  const out: { x: number; y: number }[] = [];
  for (const c of cands) {
    if (out.every(o => Math.abs(o.x - c.x) + Math.abs(o.y - c.y) >= 3)) out.push(c);
    if (out.length >= want) break;
  }
  for (const c of cands) { if (out.length >= want) break; if (!out.includes(c)) out.push(c); }
  return out;
}

function layout(seed: number, type: RoomType, sector: number, attempt: number): RoomLayout {
  const rng = new Rng((seed ^ Rng.hash(type + attempt)) >>> 0);
  let r: RoomLayout;
  switch (type) {
    case 'gauntlet': {
      r = makeRoom(seed, type, sector, rng.int(9, 11), rng.int(24, 30), 8);
      placeDoors(r, rng, rng.chance(0.4) ? 2 : 1);
      for (let y = 4; y < r.h - 4; y += rng.int(3, 4)) {
        const x = rng.int(2, r.w - 4), len = rng.int(2, 4);
        for (let k = 0; k < len; k++) set(r, x + k, y, rng.chance(0.7) ? Cell.LOW : Cell.HIGH);
      }
      for (let y = 3; y < r.h - 3; y += 6) { set(r, 2, y, Cell.PILLAR); set(r, r.w - 3, y, Cell.PILLAR); }
      break;
    }
    case 'shaft': {
      r = makeRoom(seed, type, sector, rng.int(15, 18), rng.int(15, 18), 13);
      placeDoors(r, rng, rng.chance(0.5) ? 2 : 1);
      const n = rng.int(2, 3);
      for (let i = 0; i < n; i++) addPlatform(r, rng, rng.int(4, r.w - 9), rng.int(3, r.h - 9), rng.int(3, 5), rng.int(3, 5));
      pillars(r, rng, 6, true);
      scatterCover(r, rng, 6);
      break;
    }
    case 'boss': {
      r = makeRoom(seed, type, sector, 24, 24, 14);
      placeDoors(r, rng, 1);
      for (const [x, y] of [[6, 6], [17, 6], [6, 17], [17, 17]]) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) set(r, x + dx, y + dy, Cell.PILLAR);
      scatterCover(r, rng, 6);
      break;
    }
    case 'rest': {
      r = makeRoom(seed, type, sector, 11, 13, 8);
      placeDoors(r, rng, 1);
      set(r, 3, 4, Cell.PILLAR); set(r, 7, 4, Cell.PILLAR);
      break;
    }
    default: { // arena, dark, elite
      const big = type === 'elite' ? 2 : 0;
      r = makeRoom(seed, type, sector, rng.int(16, 21) + big, rng.int(16, 21) + big, rng.int(9, 11));
      placeDoors(r, rng, rng.chance(0.55) ? 2 : 1);
      const style = rng.int(0, 2);
      if (style === 0) pillars(r, rng, rng.int(4, 5), false);
      else if (style === 1) pillars(r, rng, 5, true);
      else { const cx = (r.w / 2) | 0, cy = (r.h / 2) | 0; for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) set(r, cx + dx, cy + dy, Cell.PILLAR); pillars(r, rng, 7, true); }
      const plats = rng.int(0, 2);
      for (let i = 0; i < plats; i++) addPlatform(r, rng, rng.int(4, r.w - 9), rng.int(3, r.h - 10), rng.int(3, 5), rng.int(3, 4));
      scatterCover(r, rng, rng.int(7, 12));
      break;
    }
  }
  clearZone(r, r.entry.inX, r.entry.inY - 1, 2);
  for (const e of r.exits) clearZone(r, e.inX, e.inY + 1, 1);
  return r;
}

export function generateRoom(seed: number, type: RoomType, sector: number): RoomLayout {
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = layout(seed, type, sector, attempt);
    const reach = walkableFrom(r, r.entry.x, r.entry.y);
    if (!r.exits.every(e => reach.has(e.inY * r.w + e.inX))) continue;
    const rng = new Rng((seed ^ Rng.hash('fill' + attempt)) >>> 0);
    const want = type === 'rest' ? 0 : type === 'boss' ? 10 : type === 'gauntlet' ? 10 : 14;
    r.spawns = pickSpawns(r, rng, reach, want);
    if (type !== 'rest' && r.spawns.length < 6) continue;
    placeFixtures(r, rng, type === 'dark' ? 0.4 : type === 'boss' ? 1 : 0.85);
    if (type !== 'rest') placeProps(r, rng, type === 'boss' ? 6 : type === 'gauntlet' ? 10 : 16);
    return r;
  }
  // fallback: open box that is always valid
  const r = makeRoom(seed, 'arena', sector, 16, 16, 9);
  const rng = new Rng(seed);
  placeDoors(r, rng, 1);
  r.spawns = pickSpawns(r, rng, walkableFrom(r, r.entry.x, r.entry.y), 12);
  placeFixtures(r, rng, 1);
  return r;
}
