import { Rng } from '../../core/rng';
import type { EnemyType } from './defs';
import type { RoomType } from '../level/generator';

export interface WaveEnemy { type: EnemyType; count: number }

export const ENEMY_COST: Record<EnemyType, number> = { grunt: 2, skitter: 1, charger: 4, shade: 3, lamplighter: 3, foreman: 99 };

/**
 * Left-4-Dead-style pacing: a room has a point budget split into waves; the next wave is
 * released when the field thins out, and held back while the player's stress is high.
 */
export class Director {
  waves: WaveEnemy[][] = [];
  waveIndex = 0;
  stress = 0;
  private sinceLastHit = 99;
  private hold = 0;
  started = false;

  constructor(private rng: Rng, readonly sector: number, readonly roomDepth: number, readonly type: RoomType) {
    if (type === 'rest' || type === 'boss') return;
    const budget = Math.round((10 + roomDepth * 2 + sector * 7) * (type === 'elite' ? 1.5 : type === 'gauntlet' ? 0.9 : 1));
    const nWaves = type === 'gauntlet' ? 2 : budget > 20 ? 4 : 3;
    const allowed: EnemyType[] = ['grunt', 'skitter'];
    if (sector > 0 || roomDepth >= 2) allowed.push('charger');
    if (sector > 0 || roomDepth >= 3) allowed.push('lamplighter');
    if (sector > 0 || type === 'dark') allowed.push('shade');
    let left = budget;
    for (let w = 0; w < nWaves; w++) {
      const share = w === nWaves - 1 ? left : Math.round(budget / nWaves * (0.8 + rng.next() * 0.4));
      let pts = Math.min(left, share);
      left -= pts;
      const wave = new Map<EnemyType, number>();
      let guard = 0;
      while (pts > 0 && guard++ < 50) {
        let t = rng.weighted(allowed, e => e === 'grunt' ? 3 : e === 'skitter' ? 2 : e === 'shade' ? (type === 'dark' ? 3 : 1) : 1);
        if (ENEMY_COST[t] > pts) t = pts >= 2 ? 'grunt' : 'skitter';
        if (t === 'lamplighter' && (wave.get('lamplighter') ?? 0) >= 1) t = 'grunt';
        const n = t === 'skitter' ? Math.min(pts, 3) : 1;
        wave.set(t, (wave.get(t) ?? 0) + n);
        pts -= ENEMY_COST[t] * n;
      }
      this.waves.push([...wave].map(([type, count]) => ({ type, count })));
    }
  }

  get done() { return this.waveIndex >= this.waves.length; }
  get total() { return this.waves.reduce((s, w) => s + w.reduce((a, e) => a + e.count, 0), 0); }

  onPlayerHit(dmg: number) { this.stress = Math.min(1, this.stress + dmg / 60); this.sinceLastHit = 0; }
  onKill() { this.stress = Math.max(0, this.stress - 0.04); }

  /** Returns the next wave to spawn, or null. */
  update(dt: number, alive: number, hpFrac: number): WaveEnemy[] | null {
    if (this.done) return null;
    this.sinceLastHit += dt;
    this.stress = Math.max(0, this.stress - dt * (this.sinceLastHit > 3 ? 0.12 : 0.03));
    const target = Math.max(0, this.stress * 0.6 + (1 - hpFrac) * 0.4);
    this.hold -= dt;
    if (!this.started) { this.started = true; this.hold = 0.9; }
    if (this.hold > 0) return null;
    const threshold = this.waveIndex === 0 ? 99 : target > 0.6 ? 0 : target > 0.35 ? 1 : 2 + Math.min(2, this.roomDepth / 2);
    if (alive <= threshold) {
      this.hold = 3 + target * 4; // breathing room between waves, longer when the player is struggling
      return this.waves[this.waveIndex++];
    }
    return null;
  }
}
