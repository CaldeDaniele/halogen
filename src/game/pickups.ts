import * as THREE from 'three';
import type { Ctx } from './types';

interface Pickup { mesh: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; kind: 'health' | 'lumen'; t: number; light: any }
const geo = new THREE.OctahedronGeometry(0.16, 0);

/** Health / lumen cells dropped by androids. Magnetize toward the player when close. */
export class Pickups {
  list: Pickup[] = [];
  constructor(private ctx: Ctx) {}
  spawn(pos: THREE.Vector3, kind: Pickup['kind']) {
    const color = kind === 'health' ? 0x50ff9a : 0x19f0ff;
    const mesh = new THREE.Mesh(geo, this.ctx.mats.neon(color, 6));
    this.ctx.scene.add(mesh);
    const light = this.ctx.lights.add({ pos, color: new THREE.Color(color), intensity: 3, radius: 3 });
    this.list.push({ mesh, pos: pos.clone(), vel: new THREE.Vector3((Math.random() - 0.5) * 3, 4, (Math.random() - 0.5) * 3), kind, t: 0, light });
  }
  update(dt: number) {
    const ctx = this.ctx;
    const pp = ctx.player.pos;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.t += dt;
      const d = pp.clone().sub(p.pos);
      const dist = d.length();
      if (dist < 4.5 && p.t > 0.4) p.vel.lerp(d.normalize().multiplyScalar(16), Math.min(1, dt * 8));
      else { p.vel.y -= 14 * dt; p.vel.x *= 0.98; p.vel.z *= 0.98; }
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.35) { p.pos.y = 0.35; p.vel.y = Math.abs(p.vel.y) * 0.3; }
      p.mesh.position.copy(p.pos); p.mesh.position.y += Math.sin(p.t * 4) * 0.06;
      p.mesh.rotation.y += dt * 3;
      p.light.pos.copy(p.pos);
      if (dist < 0.9 || p.t > 25) {
        if (dist < 0.9) {
          if (p.kind === 'health') { ctx.run.heal(12); ctx.hud.toast('+12 INTEGRITY', '#50ff9a'); }
          else ctx.run.addLumen(20);
          ctx.sfx.play('pickup');
        }
        p.mesh.removeFromParent(); ctx.lights.remove(p.light); this.list.splice(i, 1);
      }
    }
  }
  clear() { for (const p of this.list) { p.mesh.removeFromParent(); this.ctx.lights.remove(p.light); } this.list = []; }
}
