import * as THREE from 'three';

function holeTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.25, 'rgba(10,10,10,0.95)'); gr.addColorStop(0.5, 'rgba(20,20,20,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2; g.beginPath(); g.moveTo(32, 32);
    let x = 32, y = 32;
    for (let k = 0; k < 4; k++) { x += Math.cos(a + (Math.random() - 0.5)) * 4; y += Math.sin(a + (Math.random() - 0.5)) * 4; g.lineTo(x, y); }
    g.stroke();
  }
  return new THREE.CanvasTexture(c);
}
function ringTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 4, 32, 32, 20);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.35, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Pooled bullet holes / scorch marks with a hot glowing rim that cools over ~1.5 s. */
export class Decals {
  private dark: THREE.InstancedMesh;
  private hot: THREE.InstancedMesh;
  private cap = 320;
  private i = 0;
  private heat: Float32Array;
  private heatColor: THREE.Color[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private z = new THREE.Vector3(0, 0, 1);
  private c = new THREE.Color();
  private scales: Float32Array;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const darkMat = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: holeTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.dark = new THREE.InstancedMesh(geo, darkMat, this.cap);
    const hotMat = new THREE.MeshBasicMaterial({ map: ringTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -5 });
    this.hot = new THREE.InstancedMesh(geo, hotMat, this.cap);
    this.hot.setColorAt(0, new THREE.Color());
    this.dark.count = 0; this.hot.count = 0;
    this.dark.frustumCulled = this.hot.frustumCulled = false;
    this.heat = new Float32Array(this.cap);
    this.scales = new Float32Array(this.cap);
    for (let k = 0; k < this.cap; k++) this.heatColor.push(new THREE.Color());
    scene.add(this.dark, this.hot);
  }

  add(pos: THREE.Vector3, normal: THREE.Vector3, size: number, hotColor: THREE.ColorRepresentation = 0xff7a20, heat = 1) {
    const i = this.i; this.i = (this.i + 1) % this.cap;
    this.q.setFromUnitVectors(this.z, normal);
    const spin = new THREE.Quaternion().setFromAxisAngle(this.z, Math.random() * Math.PI * 2);
    this.q.multiply(spin);
    const p = pos.clone().addScaledVector(normal, 0.004);
    this.m.compose(p, this.q, new THREE.Vector3(size, size, size));
    this.dark.setMatrixAt(i, this.m);
    this.hot.setMatrixAt(i, this.m);
    this.heat[i] = heat; this.scales[i] = size;
    this.heatColor[i].set(hotColor);
    this.dark.count = Math.max(this.dark.count, i + 1);
    this.hot.count = this.dark.count;
    this.dark.instanceMatrix.needsUpdate = true;
    this.hot.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    for (let i = 0; i < this.hot.count; i++) {
      if (this.heat[i] > 0) this.heat[i] = Math.max(0, this.heat[i] - dt * 0.7);
      const h = this.heat[i] * this.heat[i] * 4;
      this.c.copy(this.heatColor[i]).multiplyScalar(h);
      this.hot.setColorAt(i, this.c);
    }
    if (this.hot.instanceColor) this.hot.instanceColor.needsUpdate = true;
  }

  clear() { this.dark.count = this.hot.count = 0; this.i = 0; }
}
