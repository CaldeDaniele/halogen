import type { Sfx } from './synth';

interface Track { src: AudioBufferSourceNode; gain: GainNode }

/**
 * Music director: each sector has an ambient bed and a combat stem playing in sync;
 * `intensity` crossfades them. Boss and title tracks replace the pair. Generated tracks
 * load lazily; if one fails, a procedural drone keeps the mood.
 */
export class Music {
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private ambient: Track | null = null;
  private combat: Track | null = null;
  private solo: Track | null = null;
  private drone: { stop(): void; gain: GainNode } | null = null;
  intensity = 0;
  private cur = 0;
  private key = '';

  constructor(private sfx: Sfx) {}

  private load(id: string) {
    let p = this.buffers.get(id);
    if (!p) {
      p = fetch(`assets/music/${id}.mp3`).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
        .then(b => this.sfx.ctx.decodeAudioData(b)).catch(e => { console.warn('[music] failed', id, e); return null; });
      this.buffers.set(id, p);
    }
    return p;
  }
  preload(ids: string[]) { for (const id of ids) this.load(id); }

  private start(buf: AudioBuffer, gain: number, when: number): Track {
    const c = this.sfx.ctx;
    const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = c.createGain(); g.gain.value = 0;
    g.gain.setTargetAtTime(gain, c.currentTime, 0.8);
    src.connect(g).connect(this.sfx.musicBus);
    src.start(when);
    return { src, gain: g };
  }
  private stop(t: Track | null, fade = 1.2) {
    if (!t) return;
    const c = this.sfx.ctx;
    t.gain.gain.cancelScheduledValues(c.currentTime);
    t.gain.gain.setTargetAtTime(0, c.currentTime, fade / 3);
    setTimeout(() => { try { t.src.stop(); } catch {} }, fade * 1000 + 200);
  }

  async sector(i: number) {
    const key = 's' + i;
    if (this.key === key) return;
    this.key = key;
    this.stopAll();
    const [a, b] = await Promise.all([this.load(`s${i + 1}_ambient`), this.load(`s${i + 1}_combat`)]);
    if (this.key !== key) return;
    if (!a && !b) { this.startDrone(i); return; }
    const when = this.sfx.ctx.currentTime + 0.05;
    if (a) this.ambient = this.start(a, 0.8, when);
    if (b) this.combat = this.start(b, 0, when);
    this.cur = -1;
  }

  async single(id: string, gain = 0.9) {
    if (this.key === id) return;
    this.key = id;
    this.stopAll();
    const buf = await this.load(id);
    if (this.key !== id) return;
    if (!buf) { this.startDrone(0); return; }
    this.solo = this.start(buf, gain, this.sfx.ctx.currentTime + 0.05);
  }

  async sting(id: string) {
    const buf = await this.load(id);
    if (!buf) return;
    const c = this.sfx.ctx;
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); g.gain.value = 0.9;
    src.connect(g).connect(this.sfx.musicBus); src.start();
  }

  stopAll() {
    this.stop(this.ambient); this.stop(this.combat); this.stop(this.solo);
    this.ambient = this.combat = this.solo = null;
    if (this.drone) { this.drone.stop(); this.drone = null; }
  }

  private startDrone(i: number) {
    const c = this.sfx.ctx;
    const base = [73.4, 87.3, 61.7][i % 3];
    const g = c.createGain(); g.gain.value = 0; g.gain.setTargetAtTime(0.25, c.currentTime, 1);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
    const oscs = [1, 1.5, 2, 2.997].map(m => { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = base * m; o.detune.value = (Math.random() - 0.5) * 12; o.connect(f); o.start(); return o; });
    f.connect(g).connect(this.sfx.musicBus);
    this.drone = { gain: g, stop: () => { g.gain.setTargetAtTime(0, c.currentTime, 0.4); setTimeout(() => oscs.forEach(o => o.stop()), 1500); } };
  }

  update(dt: number) {
    if (!this.ambient && !this.combat) return;
    const target = Math.min(1, this.intensity);
    const k = Math.min(1, dt * (target > this.cur ? 2.5 : 0.35));
    this.cur = this.cur < 0 ? target : this.cur + (target - this.cur) * k;
    const t = this.sfx.ctx.currentTime;
    this.ambient?.gain.gain.setTargetAtTime(0.85 * (1 - this.cur * 0.85), t, 0.1);
    this.combat?.gain.gain.setTargetAtTime(0.95 * this.cur, t, 0.1);
  }
}
