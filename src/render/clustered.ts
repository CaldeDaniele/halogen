/**
 * Clustered forward lighting — CPU side.
 * The view frustum is cut into nx × ny screen tiles × nz exponential depth slices.
 * Each frame every light's view-space bounding sphere is binned into the clusters it touches.
 * Output layout (one row per cluster, row width = maxPerCluster + 1):
 *   [count, lightIndex0, lightIndex1, ...]
 * The shader fetches its cluster row with texelFetch and loops only those lights.
 */
export interface ClusterGrid { nx: number; ny: number; nz: number; maxPerCluster: number }
export interface ClusterCamera { fovY: number; aspect: number; near: number; far: number }
export interface LightSphere { x: number; y: number; z: number; r: number }

export const DEFAULT_GRID: ClusterGrid = { nx: 16, ny: 9, nz: 24, maxPerCluster: 32 };

export function clusterIndex(x: number, y: number, z: number, g: ClusterGrid) {
  return (z * g.ny + y) * g.nx + x;
}

export function sliceForDepth(depth: number, cam: ClusterCamera, g: ClusterGrid) {
  const d = Math.min(Math.max(depth, cam.near), cam.far);
  const s = Math.floor((Math.log(d / cam.near) / Math.log(cam.far / cam.near)) * g.nz);
  return Math.min(g.nz - 1, Math.max(0, s));
}

let scratch: Float32Array | null = null;

export function binLights(lights: readonly LightSphere[], cam: ClusterCamera, g: ClusterGrid, out?: Float32Array) {
  const stride = g.maxPerCluster + 1;
  const total = g.nx * g.ny * g.nz;
  let buf = out;
  if (!buf) {
    if (!scratch || scratch.length !== total * stride) scratch = new Float32Array(total * stride);
    buf = scratch;
  }
  // clear only the count column
  for (let c = 0; c < total; c++) buf[c * stride] = 0;

  const tanY = Math.tan(cam.fovY / 2);
  const tanX = tanY * cam.aspect;

  for (let i = 0; i < lights.length; i++) {
    const L = lights[i];
    const depth = -L.z;
    let zmin = depth - L.r;
    const zmax = depth + L.r;
    if (zmax < cam.near || zmin > cam.far) continue;

    let x0 = 0, x1 = g.nx - 1, y0 = 0, y1 = g.ny - 1;
    if (zmin > cam.near) {
      let nxMin = Infinity, nxMax = -Infinity, nyMin = Infinity, nyMax = -Infinity;
      for (const d of [zmin, zmax]) {
        for (const px of [L.x - L.r, L.x + L.r]) {
          const n = px / (d * tanX); if (n < nxMin) nxMin = n; if (n > nxMax) nxMax = n;
        }
        for (const py of [L.y - L.r, L.y + L.r]) {
          const n = py / (d * tanY); if (n < nyMin) nyMin = n; if (n > nyMax) nyMax = n;
        }
      }
      if (nxMax < -1 || nxMin > 1 || nyMax < -1 || nyMin > 1) continue; // off-screen
      x0 = Math.max(0, Math.floor(((nxMin + 1) / 2) * g.nx));
      x1 = Math.min(g.nx - 1, Math.floor(((nxMax + 1) / 2) * g.nx));
      y0 = Math.max(0, Math.floor(((nyMin + 1) / 2) * g.ny));
      y1 = Math.min(g.ny - 1, Math.floor(((nyMax + 1) / 2) * g.ny));
    } else {
      zmin = cam.near;
    }
    const z0 = sliceForDepth(zmin, cam, g);
    const z1 = sliceForDepth(zmax, cam, g);

    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const base = clusterIndex(x, y, z, g) * stride;
          const n = buf[base];
          if (n < g.maxPerCluster) { buf[base + 1 + n] = i; buf[base] = n + 1; }
        }
  }
  return buf;
}
