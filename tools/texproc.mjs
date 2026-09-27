// Makes generated albedos seamless and derives normal + roughness maps.
// Usage: node tools/texproc.mjs
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '..', 'public', 'assets', 'tex');
const N = 1024;
sharp.cache(false);

for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.webp') || /_n\.webp$|_r\.webp$|\.tmp/.test(f)) continue;
  const base = f.replace('.webp', '');
  if (process.argv[2] && !process.argv.slice(2).includes(base)) continue;
  const { data } = await sharp(fs.readFileSync(path.join(DIR, f))).resize(N, N, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // 1) seamless: blend with a half-offset copy, weighted toward the copy near the edges
  const out = Buffer.alloc(N * N * 3);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const ox = (x + N / 2) % N, oy = (y + N / 2) % N;
    const ex = Math.abs(x / (N - 1) - 0.5) * 2, ey = Math.abs(y / (N - 1) - 0.5) * 2;
    const e = Math.max(ex, ey);
    const w = Math.min(1, Math.max(0, (e - 0.55) / 0.4)); // 0 in center, 1 at edges
    const ws = w * w * (3 - 2 * w);
    for (let c = 0; c < 3; c++) out[(y * N + x) * 3 + c] = data[(y * N + x) * 3 + c] * (1 - ws) + data[(oy * N + ox) * 3 + c] * ws;
  }
  // 2) height from luminance (blurred), normal via wrapped sobel, roughness from luminance
  const lum = new Float32Array(N * N);
  let mn = 1e9, mx = -1e9;
  for (let i = 0; i < N * N; i++) { const l = (out[i * 3] * 0.299 + out[i * 3 + 1] * 0.587 + out[i * 3 + 2] * 0.114) / 255; lum[i] = l; mn = Math.min(mn, l); mx = Math.max(mx, l); }
  const blur = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += lum[((y + dy + N) % N) * N + ((x + dx + N) % N)];
    blur[y * N + x] = s / 9;
  }
  const nrm = Buffer.alloc(N * N * 3), rough = Buffer.alloc(N * N);
  const strength = 6;
  const h = (x, y) => blur[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (h(x + 1, y - 1) + 2 * h(x + 1, y) + h(x + 1, y + 1)) - (h(x - 1, y - 1) + 2 * h(x - 1, y) + h(x - 1, y + 1));
    const dy = (h(x - 1, y + 1) + 2 * h(x, y + 1) + h(x + 1, y + 1)) - (h(x - 1, y - 1) + 2 * h(x, y - 1) + h(x + 1, y - 1));
    let nx = -dx * strength, ny = dy * strength, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = y * N + x;
    nrm[i * 3] = (nx * 0.5 + 0.5) * 255; nrm[i * 3 + 1] = (ny * 0.5 + 0.5) * 255; nrm[i * 3 + 2] = (nz * 0.5 + 0.5) * 255;
    const ln = (lum[i] - mn) / Math.max(1e-3, mx - mn);
    rough[i] = Math.min(255, Math.max(0, (0.42 + 0.5 * ln) * 255));
  }
  await sharp(out, { raw: { width: N, height: N, channels: 3 } }).webp({ quality: 88 }).toFile(path.join(DIR, base + '.tmp.webp'));
  fs.renameSync(path.join(DIR, base + '.tmp.webp'), path.join(DIR, f));
  await sharp(nrm, { raw: { width: N, height: N, channels: 3 } }).webp({ quality: 90 }).toFile(path.join(DIR, base + '_n.webp'));
  await sharp(rough, { raw: { width: N, height: N, channels: 1 } }).webp({ quality: 85 }).toFile(path.join(DIR, base + '_r.webp'));
  console.log('processed', base);
}
