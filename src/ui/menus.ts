import type { Quality } from '../render/renderer';

interface Settings { quality: Quality; sens: number; fov: number; master: number; music: number; sfx: number; fpsCap: number }
const DEFAULTS: Settings = { quality: 'high', sens: 1, fov: 103, master: 0.8, music: 0.55, sfx: 0.9, fpsCap: 0 };
const FPS_CAPS = [0, 30, 60, 90, 120, 144];
const KEY = 'halogen.settings.v1';
const META = 'halogen.meta.v1';

function load<T>(k: string, d: T): T { try { const s = localStorage.getItem(k); return s ? { ...d, ...JSON.parse(s) } : d; } catch { return d; } }
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

export interface Meta { runs: number; wins: number; bestScore: number; bestSector: number; totalKills: number; unlocked: string[] }

/** Title / pause / settings / end-of-run screens. */
export class Menus {
  private el: HTMLElement;
  private fadeEl: HTMLElement;
  settings: Settings;
  meta: Meta;

  constructor(private ui: HTMLElement, private game: any) {
    this.el = document.createElement('div'); this.el.className = 'menu'; ui.appendChild(this.el);
    this.fadeEl = document.createElement('div'); this.fadeEl.className = 'fader'; ui.appendChild(this.fadeEl);
    this.settings = load(KEY, DEFAULTS);
    this.meta = load<Meta>(META, { runs: 0, wins: 0, bestScore: 0, bestSector: 0, totalKills: 0, unlocked: [] });
    this.apply();
  }

  private apply() {
    const g = this.game, s = this.settings;
    if (g.renderer.quality !== s.quality) g.renderer.setQuality(s.quality);
    g.input.sensitivity = 0.0022 * s.sens;
    g.rig.baseHFov = s.fov;
    g.sfx.volumes = { master: s.master, music: s.music, sfx: s.sfx };
    g.sfx.applyVolumes();
    g.setFpsCap(s.fpsCap);
  }

  hide() { this.el.innerHTML = ''; this.el.className = 'menu'; }

  fade(on: boolean) { this.fadeEl.classList.toggle('on', on); }

  private btn(label: string, fn: () => void, cls = '') {
    const b = document.createElement('button'); b.className = 'mbtn ' + cls; b.textContent = label;
    b.addEventListener('mouseenter', () => this.game.sfx.play('uiHover'));
    b.addEventListener('click', () => { this.game.sfx.resume(); this.game.sfx.play('uiSelect'); fn(); });
    return b;
  }

  saveMeta() { save(META, this.meta); }

  showTitle() {
    this.el.className = 'menu title interactive';
    const seed = new URLSearchParams(location.search).get('seed');
    this.el.innerHTML = `
      <div class="t-art" style="background-image:url(assets/art/title.webp)"></div>
      <div class="t-left">
        <div class="t-logo">HALOGEN</div>
        <div class="t-sub">A PHYSICS-DRIVEN ROGUELIKE SHOOTER · BUILT FOR THE BROWSER</div>
        <div class="t-btns"></div>
        <div class="t-seed"><label>SEED</label><input id="seed" placeholder="random" value="${seed ?? ''}" spellcheck="false"/></div>
        <div class="t-meta">RUNS ${this.meta.runs} · CLEARS ${this.meta.wins} · BEST ${this.meta.bestScore} · UNLOCKS ${this.meta.unlocked.length}/6</div>
      </div>
      <div class="t-right">
        <div class="t-how">
          <h3>HOW IT PLAYS</h3>
          <p><b>Momentum is armor.</b> Dash, slide, double jump and wall-kick through brutalist arenas.</p>
          <p><b>Physics is a weapon.</b> Hold <kbd>RMB</kbd> to rip androids, crates or severed limbs toward you — release to launch them.</p>
          <p><b>Light is contested.</b> Standing in light charges Lumen. Shooting a light gives a burst — but that corner goes dark, and Shades hunt in the dark.</p>
          <p><b>Style fills Focus.</b> Headshots, kinetic kills and multikills trigger bullet-time.</p>
        </div>
      </div>
      <div class="t-foot">WASD · SPACE · SHIFT dash · CTRL slide · LMB fire · RMB kinetic · R reload · 1/2 weapons · ESC pause · F1 dev overlay</div>`;
    const btns = this.el.querySelector('.t-btns')!;
    btns.append(
      this.btn('START RUN', () => {
        const v = (this.el.querySelector('#seed') as HTMLInputElement).value.trim();
        const s = v ? (/^\d+$/.test(v) ? parseInt(v, 10) : Math.abs(hash(v))) : undefined;
        this.meta.runs++; save(META, this.meta);
        this.hide(); this.game.newRun(s);
      }, 'primary'),
      this.btn('SETTINGS', () => this.showSettings(() => this.showTitle())),
    );
  }

  sectorSplash(i: number, name: string, tag: string) {
    const d = document.createElement('div');
    d.className = 'splash';
    d.innerHTML = `<div class="sp-art" style="background-image:url(assets/art/sector${i + 1}.webp)"></div><div class="sp-txt"><div class="sp-n">SECTOR 0${i + 1}</div><div class="sp-name">${name}</div><div class="sp-tag">${tag}</div></div>`;
    this.ui.appendChild(d);
    setTimeout(() => d.classList.add('out'), 2600);
    setTimeout(() => d.remove(), 3400);
  }

  private mapSvg() {
    const g = this.game;
    const map = g.maps?.[g.run.sector];
    if (!map || !g.node) return '';
    const W = 520, H = 120, L = map.layers.length;
    const pos = new Map<number, [number, number]>();
    map.layers.forEach((ids: number[], li: number) => ids.forEach((id, k) => pos.set(id, [30 + (li / (L - 1)) * (W - 60), H / 2 + (k - (ids.length - 1) / 2) * 38])));
    const icon: Record<string, string> = { arena: '◆', gauntlet: '▮', shaft: '▲', dark: '●', boss: '✖', rest: '✚', elite: '★' };
    let svg = `<svg class="rmap" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
    for (const n of map.nodes) for (const e of n.next) { const a = pos.get(n.id)!, b = pos.get(e)!; svg += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="${n.id === g.node.id ? 'hot' : ''}"/>`; }
    for (const n of map.nodes) { const [x, y] = pos.get(n.id)!; const cur = n.id === g.node.id; const done = n.layer < g.node.layer; svg += `<g class="nd ${cur ? 'cur' : done ? 'done' : ''}"><circle cx="${x}" cy="${y}" r="13"/><text x="${x}" y="${y + 5}">${icon[n.type] ?? '?'}</text></g>`; }
    return svg + '</svg>';
  }

  showPause() {
    this.el.className = 'menu pause interactive';
    this.el.innerHTML = `<div class="p-box"><div class="p-title">PAUSED</div>${this.mapSvg()}<div class="p-btns"></div><div class="p-stats">${this.runLine()}</div></div>`;
    this.el.querySelector('.p-btns')!.append(
      this.btn('RESUME', () => this.game.pause(false), 'primary'),
      this.btn('SETTINGS', () => this.showSettings(() => this.showPause())),
      this.btn('ABANDON RUN', () => this.game.toTitle()),
    );
  }

  private runLine() {
    const r = this.game.run;
    return `SEED ${r.seed} · KILLS ${r.kills} · SCORE ${r.score} · CARDS ${r.cards.length}`;
  }

  showSettings(back: () => void) {
    const s = this.settings;
    this.el.className = 'menu pause interactive';
    this.el.innerHTML = `<div class="p-box wide"><div class="p-title">SETTINGS</div>
      <div class="set">
        <label>QUALITY</label><div class="seg">${(['low', 'medium', 'high', 'ultra'] as Quality[]).map(q => `<button data-q="${q}" class="${q === s.quality ? 'on' : ''}">${q.toUpperCase()}</button>`).join('')}</div>
        <label>FRAME RATE CAP</label><div class="seg fps">${FPS_CAPS.map(c => `<button data-fps="${c}" class="${c === s.fpsCap ? 'on' : ''}">${c === 0 ? 'VSYNC' : c}</button>`).join('')}</div>
        ${this.slider('sens', 'MOUSE SENSITIVITY', 0.2, 3, 0.05, s.sens)}
        ${this.slider('fov', 'FIELD OF VIEW', 80, 120, 1, s.fov)}
        ${this.slider('master', 'MASTER VOLUME', 0, 1, 0.01, s.master)}
        ${this.slider('music', 'MUSIC', 0, 1, 0.01, s.music)}
        ${this.slider('sfx', 'EFFECTS', 0, 1, 0.01, s.sfx)}
      </div><div class="p-btns"></div></div>`;
    this.el.querySelectorAll<HTMLButtonElement>('.seg button[data-q]').forEach(b => b.addEventListener('click', () => {
      s.quality = b.dataset.q as Quality; save(KEY, s); this.apply(); this.showSettings(back);
    }));
    this.el.querySelectorAll<HTMLButtonElement>('.seg button[data-fps]').forEach(b => b.addEventListener('click', () => {
      s.fpsCap = parseInt(b.dataset.fps!, 10); save(KEY, s); this.apply(); this.showSettings(back);
    }));
    this.el.querySelectorAll<HTMLInputElement>('input[type=range]').forEach(inp => inp.addEventListener('input', () => {
      (s as any)[inp.name] = parseFloat(inp.value);
      (inp.nextElementSibling as HTMLElement).textContent = inp.value;
      save(KEY, s); this.apply();
    }));
    this.el.querySelector('.p-btns')!.append(this.btn('BACK', back, 'primary'));
  }

  private slider(name: string, label: string, min: number, max: number, step: number, v: number) {
    return `<label>${label}</label><div class="sl"><input type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${v}"/><span>${v}</span></div>`;
  }

  showEnd(win: boolean) {
    const r = this.game.run;
    const secs = Math.round((performance.now() - r.startTime) / 1000);
    this.meta.bestScore = Math.max(this.meta.bestScore, r.score);
    this.meta.bestSector = Math.max(this.meta.bestSector, r.sector + 1);
    if (win) this.meta.wins++;
    save(META, this.meta);
    this.el.className = 'menu end interactive ' + (win ? 'win' : 'lose');
    const ranks = ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
    this.el.innerHTML = `<div class="e-box">
      <div class="e-title">${win ? 'THE STACK GOES DARK' : 'SIGNAL LOST'}</div>
      <div class="e-sub">${win ? 'The Filament is severed. Every light in the arcology is yours.' : `Terminated in sector ${r.sector + 1}.`}</div>
      <div class="e-grid">
        <div><b>${r.score}</b><span>SCORE</span></div>
        <div><b>${r.kills}</b><span>KILLS</span></div>
        <div><b>${r.headshots}</b><span>HEADSHOTS</span></div>
        <div><b>${r.kineticKills}</b><span>KINETIC KILLS</span></div>
        <div><b>${r.lightsBroken}</b><span>LIGHTS BROKEN</span></div>
        <div><b>${r.roomsCleared}</b><span>ROOMS</span></div>
        <div><b>${ranks[Math.min(6, Math.floor(r.bestStyle))]}</b><span>BEST STYLE</span></div>
        <div><b>${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</b><span>TIME</span></div>
      </div>
      <div class="e-cards">${r.cards.map((id: string) => `<div class="mini" style="background-image:url(assets/cards/${id}.webp)" title="${id}"></div>`).join('')}</div>
      <div class="e-seed">SEED ${r.seed}</div>
      <div class="p-btns"></div></div>`;
    this.el.querySelector('.p-btns')!.append(
      this.btn('RETRY SEED', () => { this.hide(); this.meta.runs++; save(META, this.meta); this.game.newRun(r.seed); }, 'primary'),
      this.btn('NEW RUN', () => { this.hide(); this.meta.runs++; save(META, this.meta); this.game.newRun(); }),
      this.btn('TITLE', () => this.game.toTitle()),
    );
  }
}

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h | 0; }
