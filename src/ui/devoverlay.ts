/** F1 developer overlay: frame timing graph and engine counters. */
export class DevOverlay {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private hist: number[] = [];
  private acc = 0; private frames = 0; fps = 0;
  visible = false;
  constructor(ui: HTMLElement, private game: any) {
    this.el = document.createElement('div');
    this.el.className = 'dev';
    this.canvas = document.createElement('canvas'); this.canvas.width = 240; this.canvas.height = 60;
    this.g = this.canvas.getContext('2d')!;
    this.el.appendChild(this.canvas);
    const info = document.createElement('pre'); this.el.appendChild(info);
    ui.appendChild(this.el);
    this.el.style.display = 'none';
    window.addEventListener('keydown', e => { if (e.code === 'F1') { e.preventDefault(); this.visible = !this.visible; this.el.style.display = this.visible ? '' : 'none'; } });
  }
  update(dt: number) {
    this.acc += dt; this.frames++;
    this.hist.push(dt * 1000); if (this.hist.length > 120) this.hist.shift();
    if (this.acc >= 0.5) { this.fps = Math.round(this.frames / this.acc); this.acc = 0; this.frames = 0; }
    if (!this.visible) return;
    const g = this.g, W = 240, H = 60;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,.2)'; g.beginPath(); g.moveTo(0, H - 16.7 * 2); g.lineTo(W, H - 16.7 * 2); g.stroke();
    this.hist.forEach((ms, i) => { g.fillStyle = ms > 20 ? '#ff3b3b' : ms > 17.5 ? '#ffb02e' : '#19f0ff'; g.fillRect(i * 2, H - Math.min(H, ms * 2), 2, Math.min(H, ms * 2)); });
    const gm = this.game;
    const r = gm.renderer.renderer.info;
    const pre = this.el.querySelector('pre')!;
    pre.textContent = `FPS ${this.fps}   frame ${gm.frameMs.toFixed(1)}ms  sim ${gm.simMs.toFixed(2)}ms
draw calls ${r.render.calls}  tris ${(r.render.triangles / 1000).toFixed(0)}k
lights ${gm.renderer.lights.stats.active}/${gm.renderer.lights.lights.length}  bodies ${gm.phys.world.bodies.len()}
enemies ${gm.enemies.length}  ragdolls ${gm.corpses.size}/40  debris ${gm.debris.budget.size}/200
particles ${gm.particles.count}  quality ${gm.renderer.quality}  timescale ${gm.time.scale.toFixed(2)}
seed ${gm.run?.seed}`;
  }
}
