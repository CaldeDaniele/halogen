/**
 * Procedural SFX: every sound is a small WebAudio graph built on demand from layered
 * recipes (transient + body + tail) with per-play randomization, so nothing repeats exactly.
 * Buses: sfx → (lowpass for bullet-time) → comp → master; reverb send; music bus separate.
 */
type V3 = { x: number; y: number; z: number };

export interface PlayOpts { pos?: V3; gain?: number; pitch?: number; }

export class Sfx {
  ctx: AudioContext;
  master: GainNode;
  sfxBus: GainNode;
  musicBus: GainNode;
  private btFilter: BiquadFilterNode;
  private reverb: ConvolverNode;
  private reverbSend: GainNode;
  private noiseBuf: AudioBuffer;
  private pinkBuf: AudioBuffer;
  private distCurve: Float32Array<ArrayBuffer>;
  private bulletTime = false;
  private lastPlay = new Map<string, number>();
  volumes = { master: 0.8, sfx: 0.9, music: 0.55 };

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const c = this.ctx;
    this.master = c.createGain();
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.18;
    this.master.connect(comp).connect(c.destination);
    this.btFilter = c.createBiquadFilter(); this.btFilter.type = 'lowpass'; this.btFilter.frequency.value = 20000; this.btFilter.Q.value = 0.8;
    this.sfxBus = c.createGain();
    this.sfxBus.connect(this.btFilter).connect(this.master);
    this.musicBus = c.createGain();
    this.musicBus.connect(this.master);
    this.reverb = c.createConvolver();
    this.reverb.buffer = this.makeIR(2.4, 2.6);
    this.reverbSend = c.createGain(); this.reverbSend.gain.value = 0.22;
    this.reverbSend.connect(this.reverb).connect(this.btFilter);
    this.noiseBuf = this.makeNoise(2, false);
    this.pinkBuf = this.makeNoise(2, true);
    this.distCurve = this.makeDist(28);
    this.applyVolumes();
  }

  applyVolumes() {
    this.master.gain.value = this.volumes.master;
    this.sfxBus.gain.value = this.volumes.sfx;
    this.musicBus.gain.value = this.volumes.music;
  }

  resume() { if (this.ctx.state !== 'running') this.ctx.resume(); }

  setRoomSize(size: number) { this.reverb.buffer = this.makeIR(1.2 + size * 0.06, 2.4); this.reverbSend.gain.value = 0.16 + Math.min(0.2, size * 0.005); }

  setListener(pos: V3, fwd: V3) {
    const l = this.ctx.listener as any;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t); l.positionY.setValueAtTime(pos.y, t); l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t); l.forwardY.setValueAtTime(fwd.y, t); l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t);
    } else { l.setPosition(pos.x, pos.y, pos.z); l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0); }
  }

  setBulletTime(on: boolean) {
    if (on === this.bulletTime) return;
    this.bulletTime = on;
    const t = this.ctx.currentTime;
    this.btFilter.frequency.cancelScheduledValues(t);
    this.btFilter.frequency.setTargetAtTime(on ? 1100 : 20000, t, on ? 0.05 : 0.2);
    this.musicBus.gain.setTargetAtTime(this.volumes.music * (on ? 0.45 : 1), t, 0.1);
    this.play(on ? 'btIn' : 'btOut');
  }

  // ---------- buffers ----------
  private makeNoise(sec: number, pink: boolean) {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * sec, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (pink) { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
      else d[i] = w;
    }
    return b;
  }
  private makeIR(sec: number, decay: number) {
    const rate = this.ctx.sampleRate, len = Math.floor(rate * sec);
    const b = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // early reflections cluster + diffuse tail
        const er = i < rate * 0.08 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 0.8 : 0;
        d[i] = ((Math.random() * 2 - 1) * Math.pow(1 - t, decay) + er) * (ch ? 0.95 : 1);
      }
    }
    return b;
  }
  private makeDist(k: number) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x)); }
    return c;
  }

  // ---------- graph helpers ----------
  private out(opts: PlayOpts | undefined, gain: number, reverb = 0.25): AudioNode {
    const c = this.ctx;
    const g = c.createGain(); g.gain.value = gain * (opts?.gain ?? 1);
    if (opts?.pos) {
      const p = c.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 3; p.maxDistance = 80; p.rolloffFactor = 1.1;
      const t = c.currentTime;
      p.positionX.setValueAtTime(opts.pos.x, t); p.positionY.setValueAtTime(opts.pos.y, t); p.positionZ.setValueAtTime(opts.pos.z, t);
      g.connect(p); p.connect(this.sfxBus);
      if (reverb > 0) { const s = c.createGain(); s.gain.value = reverb; p.connect(s).connect(this.reverbSend); }
    } else {
      g.connect(this.sfxBus);
      if (reverb > 0) { const s = c.createGain(); s.gain.value = reverb; g.connect(s).connect(this.reverbSend); }
    }
    return g;
  }
  private get pm() { return this.bulletTime ? 0.62 : 1; }

  /** Filtered noise burst with ADSR-ish envelope. */
  private noise(dest: AudioNode, t0: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, gain: number, attack = 0.002, pink = false) {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = pink ? this.pinkBuf : this.noiseBuf;
    src.playbackRate.value = this.pm;
    src.loopStart = Math.random(); src.loop = true;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0 * this.pm, t0); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * this.pm), t0 + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t0, Math.random() * 1.5); src.stop(t0 + dur + 0.05);
  }
  /** Oscillator with pitch sweep. */
  private tone(dest: AudioNode, t0: number, dur: number, type: OscillatorType, f0: number, f1: number, gain: number, attack = 0.002, dist = false) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0 * this.pm, t0); o.frequency.exponentialRampToValueAtTime(Math.max(10, f1 * this.pm), t0 + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (dist) { const ws = c.createWaveShaper(); ws.curve = this.distCurve; o.connect(ws).connect(g); } else o.connect(g);
    g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  /** Inharmonic metallic ring. */
  private ring(dest: AudioNode, t0: number, dur: number, base: number, gain: number, partials = [1, 2.76, 5.4, 8.93]) {
    for (const p of partials) this.tone(dest, t0, dur / (0.6 + p * 0.25), 'sine', base * p * (0.98 + Math.random() * 0.04), base * p * 0.97, gain / partials.length);
  }

  private r(a: number, b: number) { return a + Math.random() * (b - a); }

  /** Rate limit identical sounds (e.g. 9 shotgun pellet impacts in one frame). */
  private allow(name: string, minGap: number) {
    const t = this.ctx.currentTime, last = this.lastPlay.get(name) ?? -1;
    if (t - last < minGap) return false;
    this.lastPlay.set(name, t); return true;
  }

  play(name: string, opts?: PlayOpts) {
    if (this.ctx.state !== 'running') return;
    const c = this.ctx, t = c.currentTime + 0.001, r = this.r.bind(this);
    const p = opts?.pitch ?? 1;
    switch (name) {
      case 'pistol': {
        const o = this.out(opts, 0.55, 0.3);
        this.noise(o, t, 0.02, 'highpass', 4000, 3000, 0.7, 0.9);
        this.tone(o, t, 0.07, 'square', 1100 * p * r(0.95, 1.05), 140, 0.35, 0.001, true);
        this.tone(o, t, 0.12, 'sawtooth', 2600 * p, 500, 0.12);
        this.noise(o, t, 0.18, 'bandpass', 1800, 700, 1.2, 0.35);
        this.tone(o, t, 0.1, 'sine', 160, 50, 0.6);
        break;
      }
      case 'shotgun': {
        const o = this.out(opts, 0.8, 0.35);
        this.tone(o, t, 0.35, 'sine', 120, 38, 1.0, 0.002);
        this.noise(o, t, 0.45, 'lowpass', 5000, 300, 0.7, 1.0, 0.001);
        this.noise(o, t, 0.05, 'highpass', 3000, 2000, 0.8, 0.9);
        this.tone(o, t, 0.2, 'sawtooth', 400, 60, 0.3, 0.001, true);
        this.noise(o, t + 0.28, 0.12, 'bandpass', 2500, 2000, 4, 0.08); // pump rattle
        this.noise(o, t + 0.42, 0.08, 'bandpass', 1800, 1500, 5, 0.1);
        break;
      }
      case 'railCharge': {
        const o = this.out(opts, 0.25, 0.2);
        this.tone(o, t, 0.62, 'sawtooth', 180, 1400, 0.4, 0.3);
        this.tone(o, t, 0.62, 'sine', 90, 700, 0.5, 0.3);
        break;
      }
      case 'rail': {
        const o = this.out(opts, 0.9, 0.5);
        this.noise(o, t, 0.08, 'highpass', 6000, 3000, 0.7, 1.0);
        this.tone(o, t, 0.9, 'sine', 90, 28, 1.0);
        this.tone(o, t, 0.5, 'sawtooth', 3200, 200, 0.25, 0.001, true);
        this.ring(o, t, 1.4, 1700, 0.5);
        this.noise(o, t, 1.0, 'bandpass', 900, 200, 1, 0.3, 0.01, true);
        break;
      }
      case 'ionFire': {
        const o = this.out(opts, 0.6, 0.3);
        this.tone(o, t, 0.18, 'sine', 220, 70, 0.9);
        this.noise(o, t, 0.3, 'bandpass', 600, 2400, 1.5, 0.5, 0.02);
        this.tone(o, t, 0.25, 'triangle', 800, 1600, 0.2, 0.01);
        break;
      }
      case 'explosion': {
        const o = this.out(opts, 1.1, 0.6);
        this.tone(o, t, 1.2, 'sine', 80, 22, 1.0, 0.004);
        this.noise(o, t, 1.4, 'lowpass', 4000, 150, 0.8, 1.0, 0.002, true);
        this.noise(o, t, 0.12, 'highpass', 2000, 1000, 0.7, 0.8);
        this.tone(o, t, 0.5, 'sawtooth', 200, 30, 0.4, 0.002, true);
        for (let i = 0; i < 10; i++) this.noise(o, t + 0.1 + Math.random() * 0.7, 0.03, 'highpass', 3000, 3000, 1, 0.12 * Math.random());
        break;
      }
      case 'impactConcrete': {
        if (!this.allow(name, 0.02)) return;
        const o = this.out(opts, 0.35, 0.2);
        this.noise(o, t, r(0.06, 0.12), 'bandpass', r(1200, 2200), 400, 1.2, 0.8);
        this.noise(o, t, 0.25, 'lowpass', 900, 200, 0.7, 0.2, 0.01, true);
        break;
      }
      case 'impactMetal': {
        if (!this.allow(name, 0.02)) return;
        const o = this.out(opts, 0.3, 0.3);
        this.noise(o, t, 0.03, 'highpass', 5000, 4000, 0.8, 0.6);
        this.ring(o, t, r(0.3, 0.6), r(1400, 2600), 0.5);
        break;
      }
      case 'impactFlesh': // android armor hit: dull clank + servo tick
      case 'impactAndroid': {
        if (!this.allow(name, 0.02)) return;
        const o = this.out(opts, 0.45, 0.2);
        this.noise(o, t, 0.05, 'bandpass', 3000, 1200, 1.5, 0.7);
        this.ring(o, t, 0.25, r(600, 900), 0.45, [1, 2.3, 3.9]);
        this.tone(o, t, 0.08, 'square', 300, 120, 0.1);
        break;
      }
      case 'headshot': {
        const o = this.out(undefined, 0.5, 0.2);
        this.noise(o, t, 0.08, 'bandpass', 2600, 900, 1.2, 0.9);
        this.ring(o, t, 0.4, 1800, 0.6, [1, 2.01, 3.03]);
        break;
      }
      case 'hit': { // confirm: bright tick + crunchy click + a little body, heavier hits (gain) get more thump
        if (!this.allow(name, 0.03)) return;
        const k = Math.min(1.6, opts?.gain ?? 1);
        const o = this.out(undefined, 0.34, 0);
        this.tone(o, t, 0.045, 'sine', 3000, 2500, 0.6);
        this.noise(o, t, 0.035, 'bandpass', 4200, 2600, 2, 0.55);
        this.tone(o, t, 0.07, 'triangle', 240 * r(0.9, 1.1), 110, 0.35 * k, 0.001);
        break;
      }
      case 'kill': { // two-note confirm over a low crunch
        const o = this.out(undefined, 0.42, 0.25);
        this.noise(o, t, 0.09, 'lowpass', 1800, 300, 1, 0.8, 0.001);
        this.tone(o, t, 0.16, 'sine', 140, 45, 0.8, 0.002);
        this.tone(o, t, 0.08, 'sine', 1400, 1400, 0.45); this.tone(o, t + 0.07, 0.2, 'sine', 2100, 2100, 0.45);
        break;
      }
      case 'thud': {
        if (!this.allow(name, 0.03)) return;
        const o = this.out(opts, 0.6 * Math.min(1, opts?.gain ?? 1), 0.25);
        this.noise(o, t, 0.18, 'lowpass', 500, 100, 1, 0.9, 0.003, true);
        this.tone(o, t, 0.14, 'sine', r(90, 130), 40, 0.7);
        this.ring(o, t, 0.2, r(300, 500), 0.15, [1, 2.4]);
        break;
      }
      case 'snap': {
        const o = this.out(opts, 0.6, 0.25);
        this.noise(o, t, 0.04, 'highpass', 3500, 2000, 1, 1);
        this.tone(o, t, 0.5, 'sawtooth', 900, 120, 0.15, 0.005);
        for (let i = 0; i < 5; i++) this.noise(o, t + i * 0.03 + Math.random() * 0.02, 0.02, 'bandpass', 4000, 4000, 3, 0.3);
        break;
      }
      case 'glass': {
        const o = this.out(opts, 0.5, 0.35);
        this.noise(o, t, 0.25, 'highpass', 5000, 3000, 0.8, 0.6);
        for (let i = 0; i < 14; i++) this.tone(o, t + Math.random() * 0.25, r(0.05, 0.2), 'sine', r(3000, 9000), r(2500, 8000), 0.12);
        break;
      }
      case 'fixturePop': {
        const o = this.out(opts, 0.7, 0.4);
        this.noise(o, t, 0.06, 'highpass', 2000, 1000, 0.8, 1);
        this.tone(o, t, 0.4, 'sawtooth', 60, 55, 0.3, 0.001, true);
        for (let i = 0; i < 8; i++) this.noise(o, t + Math.random() * 0.35, 0.02, 'bandpass', r(2000, 6000), 3000, 2, 0.4);
        this.play('glass', opts);
        break;
      }
      case 'buzz': { // neon hum blip for flicker
        const o = this.out(opts, 0.08, 0.1);
        this.tone(o, t, 0.12, 'sawtooth', 120, 118, 0.4, 0.005);
        break;
      }
      case 'dash': {
        const o = this.out(undefined, 0.45, 0.15);
        this.noise(o, t, 0.28, 'bandpass', 500, 2600, 1.4, 0.8, 0.03);
        this.tone(o, t, 0.2, 'sine', 180, 90, 0.3, 0.01);
        break;
      }
      case 'jump': { const o = this.out(undefined, 0.18, 0.05); this.noise(o, t, 0.1, 'bandpass', 900, 1600, 1, 0.5, 0.01); break; }
      case 'land': {
        const o = this.out(undefined, 0.4 * Math.min(1.5, opts?.gain ?? 1), 0.1);
        this.noise(o, t, 0.16, 'lowpass', 700, 120, 1, 0.9, 0.002, true); this.tone(o, t, 0.12, 'sine', 90, 45, 0.6);
        break;
      }
      case 'step': {
        const o = this.out(undefined, 0.12, 0.05);
        this.noise(o, t, r(0.05, 0.08), 'bandpass', r(500, 900), 300, 1.5, 0.7, 0.002, true);
        this.noise(o, t, 0.02, 'highpass', 4000, 4000, 1, 0.1);
        break;
      }
      case 'slide': {
        const o = this.out(undefined, 0.3, 0.1);
        this.noise(o, t, 0.6, 'bandpass', 2400, 900, 2, 0.5, 0.02);
        break;
      }
      case 'grab': { // yank: low thump + rising zap
        const o = this.out(undefined, 0.55, 0.25);
        this.tone(o, t, 0.14, 'sine', 120, 50, 0.8, 0.002);
        this.noise(o, t, 0.06, 'highpass', 2500, 5000, 1, 0.5);
        this.tone(o, t, 0.25, 'sawtooth', 200, 700, 0.3, 0.01);
        this.noise(o, t, 0.2, 'bandpass', 1200, 3000, 3, 0.3, 0.02);
        break;
      }
      case 'throw': {
        const o = this.out(undefined, 0.6, 0.3);
        this.noise(o, t, 0.35, 'bandpass', 3000, 400, 1.2, 0.8, 0.005);
        this.tone(o, t, 0.3, 'sawtooth', 700, 80, 0.4, 0.002, true);
        this.tone(o, t, 0.15, 'sine', 160, 50, 0.6);
        break;
      }
      case 'kineticFail': { const o = this.out(undefined, 0.2, 0.1); this.tone(o, t, 0.15, 'square', 220, 160, 0.3); break; }
      case 'reload': {
        const o = this.out(undefined, 0.25, 0.1);
        this.noise(o, t, 0.05, 'bandpass', 2200, 1800, 4, 0.8);
        this.noise(o, t + 0.25 * p, 0.06, 'bandpass', 1600, 1400, 5, 0.8);
        this.tone(o, t + 0.1, 0.25 * p, 'sawtooth', 300, 900, 0.08, 0.02);
        break;
      }
      case 'empty': { const o = this.out(undefined, 0.2, 0); this.noise(o, t, 0.03, 'bandpass', 3000, 3000, 6, 0.8); break; }
      case 'enemyShot': {
        if (!this.allow(name, 0.03)) return;
        const o = this.out(opts, 0.4, 0.3);
        this.tone(o, t, 0.14, 'sawtooth', r(1500, 1900), 300, 0.4, 0.002, true);
        this.noise(o, t, 0.08, 'bandpass', 2000, 800, 1, 0.3);
        break;
      }
      case 'telegraph': {
        const o = this.out(opts, 0.25, 0.2);
        this.tone(o, t, 0.4, 'square', 300 * p, 900 * p, 0.2, 0.05);
        break;
      }
      case 'charger': {
        const o = this.out(opts, 0.6, 0.3);
        this.tone(o, t, 0.6, 'sawtooth', 60, 180, 0.5, 0.05, true);
        this.noise(o, t, 0.6, 'lowpass', 400, 1200, 1, 0.5, 0.05, true);
        break;
      }
      case 'skitter': {
        if (!this.allow(name, 0.05)) return;
        const o = this.out(opts, 0.25, 0.1);
        for (let i = 0; i < 4; i++) this.noise(o, t + i * 0.035, 0.025, 'bandpass', r(3000, 5000), 3000, 4, 0.5);
        break;
      }
      case 'servo': {
        if (!this.allow(name, 0.08)) return;
        const o = this.out(opts, 0.12, 0.1);
        this.tone(o, t, r(0.12, 0.25), 'sawtooth', r(300, 500), r(600, 900), 0.2, 0.02);
        break;
      }
      case 'hurt': {
        const o = this.out(undefined, 0.6, 0.1);
        this.tone(o, t, 0.25, 'sine', 140, 50, 0.8); this.noise(o, t, 0.2, 'lowpass', 1500, 200, 1, 0.6, 0.002);
        this.tone(o, t, 0.15, 'square', 90, 70, 0.1, 0.002, true);
        break;
      }
      case 'shieldBreak': { const o = this.out(opts, 0.5, 0.3); this.ring(o, t, 0.6, 900, 0.6); this.noise(o, t, 0.3, 'highpass', 3000, 6000, 1, 0.5); break; }
      case 'btIn': {
        const o = this.out(undefined, 0.7, 0.4);
        this.tone(o, t, 0.9, 'sine', 300, 40, 0.9, 0.01);
        this.noise(o, t, 0.8, 'lowpass', 3000, 100, 1, 0.5, 0.01);
        this.tone(o, t, 0.6, 'sawtooth', 900, 80, 0.12, 0.01);
        break;
      }
      case 'btOut': { const o = this.out(undefined, 0.5, 0.3); this.tone(o, t, 0.4, 'sine', 60, 400, 0.6, 0.02); this.noise(o, t, 0.35, 'bandpass', 300, 3000, 1, 0.3, 0.05); break; }
      case 'door': {
        const o = this.out(opts, 0.6, 0.4);
        this.tone(o, t, 0.8, 'sawtooth', 70, 110, 0.25, 0.1, true);
        this.noise(o, t, 0.9, 'lowpass', 300, 900, 1, 0.4, 0.2, true);
        this.noise(o, t + 0.85, 0.2, 'lowpass', 600, 100, 1, 1, 0.002, true);
        this.tone(o, t + 0.85, 0.2, 'sine', 70, 40, 0.8);
        break;
      }
      case 'clear': {
        const o = this.out(undefined, 0.35, 0.6);
        [0, 4, 7, 12].forEach((s, i) => this.tone(o, t + i * 0.07, 1.4, 'triangle', 293.66 * Math.pow(2, s / 12), 293.66 * Math.pow(2, s / 12), 0.25, 0.02));
        break;
      }
      case 'uiHover': { const o = this.out(undefined, 0.08, 0); this.tone(o, t, 0.04, 'sine', 1800, 1700, 0.5); break; }
      case 'uiSelect': {
        const o = this.out(undefined, 0.3, 0.4);
        [0, 7, 12, 19].forEach((s, i) => this.tone(o, t + i * 0.05, 0.5, 'triangle', 440 * Math.pow(2, s / 12), 440 * Math.pow(2, s / 12), 0.3, 0.005));
        break;
      }
      case 'cardReveal': { const o = this.out(undefined, 0.3, 0.4); this.noise(o, t, 0.5, 'bandpass', 400, 4000, 1.5, 0.5, 0.1); break; }
      case 'pickup': { const o = this.out(undefined, 0.3, 0.2); this.tone(o, t, 0.15, 'sine', 900, 1800, 0.5, 0.005); this.tone(o, t + 0.06, 0.2, 'sine', 1350, 2700, 0.4, 0.005); break; }
      case 'lumenBurst': { const o = this.out(undefined, 0.5, 0.5); this.tone(o, t, 0.6, 'sine', 400, 1600, 0.5, 0.01); this.noise(o, t, 0.5, 'highpass', 2000, 8000, 1, 0.4, 0.02); break; }
      case 'heartbeat': { const o = this.out(undefined, 0.5, 0); this.tone(o, t, 0.12, 'sine', 70, 40, 0.9); this.tone(o, t + 0.18, 0.12, 'sine', 60, 35, 0.6); break; }
      case 'bossRoar': {
        const o = this.out(opts, 1.0, 0.7);
        this.tone(o, t, 2.0, 'sawtooth', 55, 35, 0.6, 0.2, true);
        this.tone(o, t, 2.0, 'sawtooth', 82, 50, 0.4, 0.2, true);
        this.noise(o, t, 2.0, 'lowpass', 200, 2000, 2, 0.6, 0.3, true);
        break;
      }
    }
  }

  /** Continuous hum for the kinetic hand. Returns a controller. */
  hum() {
    const c = this.ctx;
    const o1 = c.createOscillator(), o2 = c.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'sawtooth'; o1.frequency.value = 80; o2.frequency.value = 80.7;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500; f.Q.value = 6;
    const g = c.createGain(); g.gain.value = 0;
    o1.connect(f); o2.connect(f); f.connect(g).connect(this.sfxBus);
    o1.start(); o2.start();
    const t = () => c.currentTime;
    return {
      set: (mass: number, strain: number) => {
        const fr = 60 + 200 / Math.sqrt(Math.max(1, mass)) + strain * 60;
        o1.frequency.setTargetAtTime(fr, t(), 0.05); o2.frequency.setTargetAtTime(fr * 1.009, t(), 0.05);
        f.frequency.setTargetAtTime(400 + strain * 2200, t(), 0.05);
        g.gain.setTargetAtTime(0.09, t(), 0.05);
      },
      stop: () => { g.gain.setTargetAtTime(0, t(), 0.04); setTimeout(() => { o1.stop(); o2.stop(); }, 300); },
    };
  }
}
