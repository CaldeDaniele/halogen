import * as THREE from 'three';

/**
 * F1 developer overlay — the "under the hood" view for the showreel:
 *  frame graph + counters, F2 physics wireframes (Rapier debug render), F3 floating AI utility
 *  scores, F4 clustered-light heatmap, [ / ] timescale.
 */
export class DevOverlay {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private pre: HTMLPreElement;
  private heat: HTMLCanvasElement;
  private hg: CanvasRenderingContext2D;
  private labels: HTMLElement;
  private hist: number[] = [];
  private acc = 0; private frames = 0; fps = 0;
  visible = false;
  physics = false; ai = false; clusters = false;
  timescale = 1;
  private lines: THREE.LineSegments;
  benchResult = '';

  constructor(ui: HTMLElement, private game: any) {
    this.el = document.createElement('div'); this.el.className = 'dev';
    this.canvas = document.createElement('canvas'); this.canvas.width = 240; this.canvas.height = 60;
    this.g = this.canvas.getContext('2d')!;
    this.el.appendChild(this.canvas);
    this.pre = document.createElement('pre'); this.el.appendChild(this.pre);
    ui.appendChild(this.el);
    this.el.style.display = 'none';
    this.heat = document.createElement('canvas'); this.heat.className = 'dev-heat'; this.heat.width = 16; this.heat.height = 9;
    this.hg = this.heat.getContext('2d')!;
    ui.appendChild(this.heat); this.heat.style.display = 'none';
    this.labels = document.createElement('div'); this.labels.className = 'dev-labels'; ui.appendChild(this.labels);
    const geo = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthTest: false }));
    this.lines.frustumCulled = false; this.lines.renderOrder = 999; this.lines.visible = false;
    game.renderer.scene.add(this.lines);
    window.addEventListener('keydown', e => {
      if (e.code === 'F1') { e.preventDefault(); this.visible = !this.visible; this.el.style.display = this.visible ? '' : 'none'; }
      if (!this.visible) return;
      if (e.code === 'F2') { e.preventDefault(); this.physics = !this.physics; this.lines.visible = this.physics; }
      if (e.code === 'F3') { e.preventDefault(); this.ai = !this.ai; this.labels.innerHTML = ''; }
      if (e.code === 'F4') { e.preventDefault(); this.clusters = !this.clusters; this.heat.style.display = this.clusters ? '' : 'none'; }
      if (e.code === 'BracketLeft') this.timescale = Math.max(0.1, +(this.timescale - 0.1).toFixed(2));
      if (e.code === 'BracketRight') this.timescale = Math.min(1, +(this.timescale + 0.1).toFixed(2));
    });
  }

  update(dt: number) {
    this.acc += dt; this.frames++;
    this.hist.push(dt * 1000); if (this.hist.length > 120) this.hist.shift();
    if (this.acc >= 0.5) { this.fps = Math.round(this.frames / this.acc); this.acc = 0; this.frames = 0; }
    if (!this.visible) return;
    const g = this.g, W = 240, H = 60;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.moveTo(0, H - 16.7 * 2); g.lineTo(W, H - 16.7 * 2); g.stroke();
    this.hist.forEach((ms, i) => { g.fillStyle = ms > 20 ? '#ff3b3b' : ms > 17.5 ? '#ffb02e' : '#19f0ff'; g.fillRect(i * 2, H - Math.min(H, ms * 2), 2, Math.min(H, ms * 2)); });
    const gm = this.game;
    const r = gm.renderer.renderer.info;
    const L = gm.renderer.lights;
    this.pre.textContent = `FPS ${this.fps}   frame ${gm.frameMs.toFixed(1)}ms  sim ${gm.simMs.toFixed(2)}ms/step
draw calls ${r.render.calls}  tris ${(r.render.triangles / 1000).toFixed(0)}k
lights ${L.stats.active}/${L.lights.length} clustered (16×9×24)  bodies ${gm.phys.world.bodies.len()}
enemies ${gm.enemies.length}  ragdolls ${gm.corpses.size}/40  debris ${gm.debris.budget.size}/200
particles ${gm.particles.count}  quality ${gm.renderer.quality}  timescale ${(gm.time.scale).toFixed(2)} (dev ×${this.timescale})
director stress ${(gm.director?.stress ?? 0).toFixed(2)} wave ${gm.director?.waveIndex ?? 0}/${gm.director?.waves.length ?? 0}
seed ${gm.run?.seed}
F2 physics ${this.physics ? 'ON' : 'off'} · F3 AI ${this.ai ? 'ON' : 'off'} · F4 clusters ${this.clusters ? 'ON' : 'off'} · [ ] timescale${this.benchResult ? '\n' + this.benchResult : ''}`;
    if (this.physics) this.drawPhysics();
    if (this.ai) this.drawAI();
    if (this.clusters) this.drawClusters();
  }

  private drawPhysics() {
    const { vertices, colors } = this.game.phys.world.debugRender();
    const geo = this.lines.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geo.computeBoundingSphere();
  }

  private drawAI() {
    const gm = this.game, cam = gm.renderer.camera as THREE.PerspectiveCamera;
    const w = window.innerWidth, h = window.innerHeight;
    let html = '';
    for (const e of gm.enemies) {
      if (!e.alive || !e.ai?.scores) continue;
      const p = e.head.clone().add(new THREE.Vector3(0, 0.5 * e.stats.scale, 0)).project(cam);
      if (p.z > 1) continue;
      const x = (p.x * 0.5 + 0.5) * w, y = (-p.y * 0.5 + 0.5) * h;
      const sc = e.ai.scores.slice(0, 3).map((s: any) => `${s.name} ${s.score.toFixed(2)}`).join('<br>');
      html += `<div class="dl" style="transform:translate(${x.toFixed(0)}px,${y.toFixed(0)}px)"><b>${e.type} · ${e.ai.action}</b><br>${sc}<br>hp ${Math.max(0, e.hp).toFixed(0)}${e.shield ? ' +' + e.shield.toFixed(0) : ''} · vis ${e.visibility.toFixed(2)}</div>`;
    }
    this.labels.innerHTML = html;
  }

  /** Max light count per screen tile across all depth slices. */
  private drawClusters() {
    const L = this.game.renderer.lights;
    const gdef = L.grid;
    const data = L.clusterTex.image.data as Float32Array;
    const stride = gdef.maxPerCluster + 1;
    const img = this.hg.createImageData(gdef.nx, gdef.ny);
    for (let y = 0; y < gdef.ny; y++) for (let x = 0; x < gdef.nx; x++) {
      let m = 0;
      for (let z = 0; z < gdef.nz; z++) m = Math.max(m, data[((z * gdef.ny + y) * gdef.nx + x) * stride]);
      const k = Math.min(1, m / 16);
      const i = ((gdef.ny - 1 - y) * gdef.nx + x) * 4;
      img.data[i] = 255 * Math.min(1, k * 2); img.data[i + 1] = 255 * Math.max(0, 1 - Math.abs(k - 0.5) * 2); img.data[i + 2] = 255 * Math.max(0, 1 - k * 2);
      img.data[i + 3] = m > 0 ? 110 : 0;
    }
    this.hg.putImageData(img, 0, 0);
  }
}
