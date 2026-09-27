// HALOGEN asset generator. Idempotent: skips outputs that already exist.
// Usage: node tools/gen-assets.mjs [music|images|cards|all] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'assets');
const RAW = path.join(ROOT, 'tools', 'raw');
const LOG = path.join(ROOT, 'tools', 'spend-log.json');
const BUDGET = 9.0;
const PRIOR_PROBES = 0.16; // spent on API shape probes before this script existed

const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const KEY = env.match(/OPENROUTER_API_KEY=(.*)/)[1].trim();
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'asset-manifest.json'), 'utf8'));
const which = process.argv[2] ?? 'all';
const dry = process.argv.includes('--dry');

const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
const spent = () => PRIOR_PROBES + log.reduce((s, e) => s + e.cost, 0);
const EST = { 'google/lyria-3-pro-preview': 0.08, 'google/lyria-3-clip-preview': 0.04,
  'google/gemini-3.1-flash-lite-image': 0.035, 'google/gemini-3-pro-image': 0.15 };

let reserved = 0;
function reserve(model) {
  const est = EST[model] ?? 0.2;
  if (spent() + reserved + est > BUDGET) throw new Error(`BudgetExceeded: spent ${spent().toFixed(3)} + ${est}`);
  reserved += est;
  return est;
}

function costOf(usage) {
  if (!usage) return 0;
  return usage.cost_details?.upstream_inference_cost ?? usage.cost ?? 0;
}

async function call(body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json',
        'X-Title': 'HALOGEN asset pipeline' },
      body: JSON.stringify(body),
    });
    if (r.ok) return r;
    const t = await r.text();
    console.warn(`  HTTP ${r.status} (${body.model}) attempt ${attempt + 1}: ${t.slice(0, 200)}`);
    await new Promise(res => setTimeout(res, 3000 * (attempt + 1)));
  }
  throw new Error('request failed after retries');
}

async function genAudio(item) {
  const r = await call({ model: item.model, messages: [{ role: 'user', content: item.prompt }],
    modalities: ['audio', 'text'], stream: true, audio: { format: 'mp3' } });
  const txt = await r.text();
  let b64 = '', usage;
  for (const l of txt.split('\n')) {
    if (!l.startsWith('data: ') || l.includes('[DONE]')) continue;
    try { const j = JSON.parse(l.slice(6)); const a = j.choices?.[0]?.delta?.audio; if (a?.data) b64 += a.data; if (j.usage) usage = j.usage; } catch {}
  }
  if (!b64) throw new Error('no audio in response');
  return { bytes: Buffer.from(b64, 'base64'), cost: costOf(usage) };
}

async function genImage(model, prompt, aspect) {
  const r = await call({ model, messages: [{ role: 'user', content: prompt }], modalities: ['image', 'text'],
    image_config: { aspect_ratio: aspect } });
  const j = await r.json();
  const url = j.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error('no image in response: ' + JSON.stringify(j).slice(0, 300));
  return { bytes: Buffer.from(url.split(',')[1], 'base64'), cost: costOf(j.usage) };
}

function record(id, model, cost) {
  log.push({ id, model, cost, at: new Date().toISOString() });
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
}

async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (q.length) {
      const it = q.shift();
      try { await fn(it); } catch (e) { console.error('  FAIL', it.id, e.message); if (String(e.message).startsWith('BudgetExceeded')) q.length = 0; }
    }
  }));
}

async function doMusic() {
  fs.mkdirSync(path.join(OUT, 'music'), { recursive: true });
  fs.mkdirSync(path.join(RAW, 'music'), { recursive: true });
  const todo = manifest.music.filter(m => !fs.existsSync(path.join(OUT, 'music', m.id + '.mp3')));
  console.log(`music: ${todo.length} to generate`);
  if (dry) return;
  await pool(todo, 3, async m => {
    const est = reserve(m.model);
    const { bytes, cost } = await genAudio(m);
    reserved -= est; record('music/' + m.id, m.model, cost);
    const raw = path.join(RAW, 'music', m.id + '.mp3');
    fs.writeFileSync(raw, bytes);
    // re-encode smaller for the web, cap length at 150s, gentle fade-out
    const isClip = m.model.includes('clip');
    const dur = isClip ? 12 : 150;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-t', String(dur), '-af', `afade=t=out:st=${dur - (isClip ? 2 : 4)}:d=${isClip ? 2 : 4}`,
      '-ac', '2', '-b:a', '112k', path.join(OUT, 'music', m.id + '.mp3')]);
    console.log(`  ok music/${m.id} $${cost.toFixed(3)} total $${spent().toFixed(3)}`);
  });
}

async function doImages(list) {
  console.log(`images: ${list.length} to generate`);
  if (dry) return;
  await pool(list, 3, async it => {
    const est = reserve(it.model);
    const { bytes, cost } = await genImage(it.model, it.fullPrompt, it.aspect);
    reserved -= est; record(it.id, it.model, cost);
    const rawPath = path.join(RAW, it.id + '.png');
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    await sharp(bytes).png().toFile(rawPath);
    const outPath = path.join(OUT, it.id + '.webp');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    let img = sharp(bytes);
    if (it.resize) img = img.resize(it.resize[0], it.resize[1], { fit: 'cover' });
    await img.webp({ quality: 88 }).toFile(outPath);
    console.log(`  ok ${it.id} $${cost.toFixed(3)} total $${spent().toFixed(3)}`);
  });
}

function imageJobs() {
  return manifest.images.map(i => ({ ...i, fullPrompt: manifest.styles[i.style] + i.prompt,
    aspect: i.aspect ?? '1:1',
    resize: i.style === 'art' ? [1920, 1080] : i.id.startsWith('art/boss') ? [768, 768] : [1024, 1024] }))
    .filter(i => !fs.existsSync(path.join(OUT, i.id + '.webp')));
}
function cardJobs() {
  return manifest.cards.map(([id, subject]) => ({ id: 'cards/' + id, model: 'google/gemini-3.1-flash-lite-image',
    fullPrompt: manifest.styles.card + subject, aspect: '1:1', resize: [512, 512] }))
    .filter(i => !fs.existsSync(path.join(OUT, i.id + '.webp')));
}

console.log(`spent so far: $${spent().toFixed(3)} / $${BUDGET}`);
if (which === 'music' || which === 'all') await doMusic();
if (which === 'images' || which === 'all') await doImages(imageJobs());
if (which === 'cards' || which === 'all') await doImages(cardJobs());
console.log(`DONE. total spent: $${spent().toFixed(3)}`);
