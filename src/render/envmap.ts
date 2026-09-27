import * as THREE from 'three';

/**
 * Builds a tiny emissive "neon room" scene and prefilters it into a PMREM environment.
 * This stands in for bounce light and gives metals/wet surfaces something to reflect.
 */
export function buildNeonEnvironment(renderer: THREE.WebGLRenderer, palette: number[], base = 0x0b0d10) {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(20, 10, 20), new THREE.MeshBasicMaterial({ color: base, side: THREE.BackSide }));
  env.add(room);
  const strip = (color: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, k: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) }));
    m.position.set(x, y, z); env.add(m);
  };
  palette.forEach((c, i) => {
    const a = (i / palette.length) * Math.PI * 2;
    strip(c, Math.cos(a) * 9.8, 3 + (i % 2) * 2, Math.sin(a) * 9.8, 0.2 + Math.abs(Math.sin(a)) * 12, 0.25, 0.2 + Math.abs(Math.cos(a)) * 12, 3);
  });
  strip(0xdfe8ff, 0, 4.9, 0, 8, 0.1, 1.2, 2.2); // overhead panel
  strip(0x10151a, 0, -4.9, 0, 18, 0.1, 18, 1);  // dark floor
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(env, 0.02);
  pm.dispose();
  env.traverse(o => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
  return rt.texture;
}
