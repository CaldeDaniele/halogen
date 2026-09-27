import { Rng } from '../../core/rng';
import type { RoomType } from './generator';

export type Reward = 'card' | 'rare' | 'heal' | 'weapon' | 'lumen' | 'none';
export interface MapNode { id: number; layer: number; type: RoomType; reward: Reward; next: number[]; seed: number }
export interface SectorMap { sector: number; nodes: MapNode[]; start: number; layers: number[][] }

/**
 * Per-sector branching route (Slay-the-Spire style, simplified): 6 layers, the last is the boss.
 * Each room's exit doors map 1:1 to its outgoing edges, so the player picks a route by door.
 */
export function buildSectorMap(seed: number, sector: number): SectorMap {
  const rng = new Rng((seed ^ Rng.hash('map' + sector)) >>> 0);
  const layerSizes = [1, 2, rng.int(2, 3), 2, 2, 1];
  const nodes: MapNode[] = [];
  const layers: number[][] = [];
  const combat: RoomType[] = sector === 0 ? ['arena', 'arena', 'gauntlet', 'shaft'] : sector === 1 ? ['arena', 'gauntlet', 'shaft', 'dark'] : ['arena', 'shaft', 'dark', 'dark', 'gauntlet'];
  layerSizes.forEach((n, L) => {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      let type: RoomType;
      let reward: Reward;
      if (L === 5) { type = 'boss'; reward = 'rare'; }
      else if (L === 4) { type = i === 0 ? 'rest' : 'elite'; reward = i === 0 ? 'heal' : 'rare'; }
      else if (L === 0) { type = sector === 0 ? 'arena' : rng.pick(combat); reward = 'card'; }
      else { type = rng.pick(combat); reward = rng.weighted<Reward>(['card', 'card', 'card', 'heal', 'weapon', 'lumen'], r => (r === 'weapon' ? (L === 2 ? 1.5 : 0.6) : 1)); }
      const node: MapNode = { id: nodes.length, layer: L, type, reward, next: [], seed: rng.int(1, 2 ** 30) };
      nodes.push(node); ids.push(node.id);
    }
    layers.push(ids);
  });
  // edges: each node links to 1-2 nodes in the next layer; ensure every next-layer node has a parent
  for (let L = 0; L < layers.length - 1; L++) {
    const cur = layers[L], nxt = layers[L + 1];
    for (const a of cur) {
      const pool = rng.shuffle([...nxt]);
      const k = Math.min(nxt.length, rng.chance(0.6) ? 2 : 1);
      nodes[a].next = pool.slice(0, k).sort((x, y) => x - y);
    }
    for (const b of nxt) {
      if (!cur.some(a => nodes[a].next.includes(b))) {
        const a = cur.find(a => nodes[a].next.length < 2) ?? cur[0];
        if (nodes[a].next.length >= 2) nodes[a].next[1] = b; else nodes[a].next.push(b);
        nodes[a].next.sort((x, y) => x - y);
      }
    }
  }
  // re-check orphans created by the replacement above
  for (let L = 0; L < layers.length - 1; L++) for (const b of layers[L + 1]) {
    if (!layers[L].some(a => nodes[a].next.includes(b))) {
      const a = layers[L].find(a => nodes[a].next.length < 2);
      if (a !== undefined) nodes[a].next.push(b);
      else nodes[layers[L][0]].next = [b, ...nodes[layers[L][0]].next.filter(x => x !== b)].slice(0, 2);
    }
  }
  return { sector, nodes, start: layers[0][0], layers };
}
