import * as THREE from 'three';
import type { Ctx } from '../types';
import type { Room } from '../level/builder';
import type { EnemyType } from './defs';
import type { Android } from './android';

export interface Boss { dead: boolean; update(dt: number): void; sync(): void; dispose(): void }

/** M4 placeholder: every sector boss is a Foreman. Real bosses land in M5. */
export function createBoss(ctx: Ctx, _sector: number, room: Room, spawn: (t: EnemyType, p: THREE.Vector3) => Android): Boss {
  const a = spawn('foreman', room.worldSpawn(0));
  a.isBoss = true;
  return {
    get dead() { return !a.alive; },
    update() {},
    sync() {},
    dispose() {},
  };
}
