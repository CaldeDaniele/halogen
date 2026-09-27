import * as THREE from 'three';

const RANKS = ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
const RANK_NAMES = ['DULL', 'CRISP', 'BRUTAL', 'AGGRESSIVE', 'SAVAGE', 'SUPERNOVA', 'HALOGEN'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html = '') {
  const e = document.createElement(tag); e.className = cls; if (html) e.innerHTML = html; parent.appendChild(e); return e;
}

export interface HudState {
  hp: number; maxHp: number; shield: number; lumen: number; maxLumen: number; focus: number;
  weapon: string; ammo: number; mag: number; reload: number; charge: number; slots: string[]; cur: number;
  dash: number; maxDash: number; style: number; enemies: number; room: string; bulletTime: boolean; inLight: number;
  holding: boolean;
}

/** DOM HUD. Everything is transform/opacity animated so it never forces layout per frame. */
export class Hud {
  root: HTMLElement;
  private hpFill: HTMLElement; private shFill: HTMLElement; private hpText: HTMLElement;
  private lumenArc: SVGCircleElement; private focusArc: SVGCircleElement; private chargeArc: SVGCircleElement;
  private ammo: HTMLElement; private wname: HTMLElement; private slots: HTMLElement;
  private dash: HTMLElement;
  private hit: HTMLElement;
  private feed: HTMLElement;
  private rank: HTMLElement; private rankName: HTMLElement; private rankBar: HTMLElement;
  private vign: HTMLElement; private flash: HTMLElement; private bt: HTMLElement;
  private dmgDirs: HTMLElement;
  private toastEl: HTMLElement;
  private info: HTMLElement;
  private prompt: HTMLElement;
  private lowHp: HTMLElement;
  private hitT = 0;
  private dmgT = 0;
  private toastT = 0;
  private lastRank = -1;
  private cross: HTMLElement;
  private bossEl: HTMLElement; private bossFill: HTMLElement; private bossName: HTMLElement;

  constructor(ui: HTMLElement) {
    const r = this.root = el('div', 'hud', ui);
    this.vign = el('div', 'hud-vign', r);
    this.lowHp = el('div', 'hud-lowhp', r);
    this.bt = el('div', 'hud-bt', r, '<div class="bt-label">BULLET TIME</div>');
    this.flash = el('div', 'hud-flash', r);
    const c = this.cross = el('div', 'hud-cross', r);
    c.innerHTML = `<svg viewBox="-50 -50 100 100" width="100" height="100">
      <circle class="ring-bg" r="30" /><circle class="ring-lumen" r="30" />
      <circle class="ring-bg2" r="36" /><circle class="ring-focus" r="36" />
      <circle class="ring-charge" r="22" />
      <line x1="-9" y1="0" x2="-4" y2="0"/><line x1="4" y1="0" x2="9" y2="0"/><line x1="0" y1="-9" x2="0" y2="-4"/><line x1="0" y1="4" x2="0" y2="9"/>
      <circle class="dot" r="1.2"/></svg>`;
    this.lumenArc = c.querySelector('.ring-lumen')!; this.focusArc = c.querySelector('.ring-focus')!; this.chargeArc = c.querySelector('.ring-charge')!;
    this.hit = el('div', 'hud-hit', r, '<i></i><i></i><i></i><i></i>');
    this.dmgDirs = el('div', 'hud-dmgdirs', r);
    const hp = el('div', 'hud-hp', r);
    el('div', 'lbl', hp, 'INTEGRITY');
    const bar = el('div', 'bar', hp);
    this.hpFill = el('div', 'fill', bar); this.shFill = el('div', 'shield', bar);
    this.hpText = el('div', 'num', hp);
    this.dash = el('div', 'hud-dash', hp);
    const wp = el('div', 'hud-weapon', r);
    this.wname = el('div', 'wname', wp);
    this.ammo = el('div', 'ammo', wp);
    this.slots = el('div', 'slots', wp);
    this.feed = el('div', 'hud-feed', r);
    const st = el('div', 'hud-style', r);
    this.rank = el('div', 'rank', st, 'D');
    this.rankName = el('div', 'rname', st, '');
    const rb = el('div', 'rbar', st); this.rankBar = el('div', 'rfill', rb);
    this.toastEl = el('div', 'hud-toast', r);
    this.info = el('div', 'hud-info', r);
    this.prompt = el('div', 'hud-prompt', r);
    this.bossEl = el('div', 'hud-boss', r);
    this.bossName = el('div', 'bname', this.bossEl);
    const bb = el('div', 'bbar', this.bossEl); this.bossFill = el('div', 'bfill', bb);
    this.bossEl.style.display = 'none';
    el('div', 'hud-keys', r, 'WASD move · SPACE jump ×2 · SHIFT dash · CTRL slide · LMB fire · RMB hold/release kinetic · R reload · 1/2 swap · F1 dev');
  }

  show(v: boolean) { this.root.style.display = v ? '' : 'none'; }

  update(s: HudState, dt: number) {
    const hpK = Math.max(0, s.hp / s.maxHp);
    this.hpFill.style.transform = `scaleX(${hpK})`;
    this.shFill.style.transform = `scaleX(${Math.min(1, s.shield / s.maxHp)})`;
    this.hpText.textContent = `${Math.ceil(s.hp)}${s.shield > 0 ? ` +${Math.ceil(s.shield)}` : ''}`;
    this.root.classList.toggle('low', hpK < 0.3);
    const C1 = 2 * Math.PI * 30, C2 = 2 * Math.PI * 36, C3 = 2 * Math.PI * 22;
    this.lumenArc.style.strokeDasharray = `${(s.lumen / s.maxLumen) * C1 * 0.5} ${C1}`;
    this.focusArc.style.strokeDasharray = `${s.focus * C2 * 0.5} ${C2}`;
    this.chargeArc.style.strokeDasharray = `${Math.max(s.charge, s.reload) * C3} ${C3}`;
    this.cross.classList.toggle('full', s.focus >= 1);
    this.cross.classList.toggle('lit', s.inLight > 0.25);
    this.cross.classList.toggle('holding', s.holding);
    this.wname.textContent = s.weapon;
    this.ammo.innerHTML = s.reload > 0 ? '<span class="rl">RELOADING</span>' : `${s.ammo}<small>/${s.mag}</small>`;
    this.slots.innerHTML = s.slots.map((w, i) => `<span class="${i === s.cur ? 'on' : ''}">${i + 1} ${w}</span>`).join('');
    this.dash.innerHTML = Array.from({ length: s.maxDash }, (_, i) => `<i class="${i < s.dash ? 'on' : ''}"></i>`).join('');
    // style rank
    const ri = Math.min(RANKS.length - 1, Math.floor(s.style));
    if (ri !== this.lastRank) {
      this.lastRank = ri;
      this.rank.textContent = RANKS[ri]; this.rankName.textContent = s.style > 0.05 ? RANK_NAMES[ri] : '';
      this.rank.classList.remove('pop'); void this.rank.offsetWidth; this.rank.classList.add('pop');
      this.rank.dataset.r = String(ri);
    }
    this.rankBar.style.transform = `scaleX(${s.style % 1})`;
    this.rank.parentElement!.style.opacity = s.style > 0.05 ? '1' : '0';
    this.info.innerHTML = `${s.room}${s.enemies > 0 ? ` <b>${s.enemies}</b> HOSTILE` : ''}`;
    this.bt.classList.toggle('on', s.bulletTime);
    this.hitT = Math.max(0, this.hitT - dt);
    this.hit.style.opacity = String(Math.min(1, this.hitT * 8));
    this.dmgT = Math.max(0, this.dmgT - dt * 1.8);
    this.vign.style.opacity = String(this.dmgT);
    this.lowHp.style.opacity = hpK < 0.35 ? String(0.35 + 0.25 * Math.sin(performance.now() / 180)) : '0';
    this.toastT -= dt;
    if (this.toastT <= 0) this.toastEl.classList.remove('on');
  }

  boss(name: string | null, frac = 1, state = '') {
    if (!name) { this.bossEl.style.display = 'none'; return; }
    this.bossEl.style.display = '';
    this.bossName.innerHTML = name + (state ? ` <span>${state}</span>` : '');
    this.bossFill.style.transform = `scaleX(${Math.max(0, frac)})`;
    this.bossEl.classList.toggle('shield', state === 'SHIELDED');
  }

  hitmarker(kind: 'hit' | 'kill' | 'head') {
    this.hitT = kind === 'hit' ? 0.12 : 0.3;
    this.hit.className = 'hud-hit ' + kind;
  }

  damage(fromAngle: number | null) {
    this.dmgT = Math.min(1, this.dmgT + 0.55);
    if (fromAngle !== null) {
      const d = el('div', 'dmgdir', this.dmgDirs);
      d.style.transform = `rotate(${fromAngle}rad)`;
      setTimeout(() => d.remove(), 900);
    }
  }

  impactFlash() { this.flash.classList.remove('on'); void this.flash.offsetWidth; this.flash.classList.add('on'); }

  feedMsg(text: string, pts: number, color = '#e8f4f8') {
    const d = el('div', 'fm', this.feed, `<span style="color:${color}">${text}</span><b>+${pts}</b>`);
    setTimeout(() => d.classList.add('out'), 1600);
    setTimeout(() => d.remove(), 2100);
    while (this.feed.children.length > 6) this.feed.firstElementChild?.remove();
  }

  toast(msg: string, color = '#19f0ff', t = 1.6) {
    this.toastEl.innerHTML = msg; this.toastEl.style.color = color;
    this.toastEl.classList.remove('on'); void this.toastEl.offsetWidth; this.toastEl.classList.add('on');
    this.toastT = t;
  }

  setPrompt(text: string | null) { this.prompt.textContent = text ?? ''; this.prompt.style.opacity = text ? '1' : '0'; }

  /** Angle of a world point relative to camera facing, for damage indicators. */
  static angleTo(cam: THREE.Camera, p: THREE.Vector3) {
    const local = p.clone().applyMatrix4(cam.matrixWorldInverse);
    return Math.atan2(local.x, -local.z);
  }
}
