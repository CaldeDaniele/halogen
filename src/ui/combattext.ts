import * as THREE from 'three';
import { DamageTally, TallyEntry, hpBarAlpha } from '../game/feedback';

/** What the combat text needs from an enemy (Androids and pseudo-boss parts both qualify). */
export interface TextTarget {
  alive: boolean; hp: number; maxHp: number; shield?: number; isBoss?: boolean; visibility?: number;
  center: THREE.Vector3; stats?: { scale: number; quad?: boolean; flying?: boolean };
}

interface Num { el: HTMLElement; txt: HTMLElement; pos: THREE.Vector3; shown: number }
interface Bar { el: HTMLElement; fill: HTMLElement; shield: HTMLElement; last: number }

const _v = new THREE.Vector3();
const MAX_NUMS = 24;

/**
 * Floating damage numbers (merged per enemy) and short-lived HP bars over damaged enemies.
 * DOM over canvas, positioned with transforms only; everything keys off real time so the text
 * keeps moving during bullet-time.
 */
export class CombatText {
  enabled = true;
  private root: HTMLElement;
  private tally = new DamageTally(0.45, 0.9);
  private nums = new Map<TallyEntry, Num>();
  private bars = new Map<TextTarget, Bar>();
  private keys = new WeakMap<object, number>();
  private nextKey = 1;

  constructor(ui: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'ctext';
    ui.appendChild(this.root);
  }

  private key(e: object) { let k = this.keys.get(e); if (!k) { k = this.nextKey++; this.keys.set(e, k); } return k; }

  hit(enemy: TextTarget, dmg: number, head: boolean, point: THREE.Vector3, now: number) {
    if (!this.enabled || dmg <= 0) return;
    const e = this.tally.add(this.key(enemy), dmg, now, head);
    let n = this.nums.get(e);
    if (!n) {
      if (this.nums.size >= MAX_NUMS) this.drop(this.nums.keys().next().value!);
      const el = document.createElement('div'); el.className = 'dmgnum';
      const txt = document.createElement('span'); el.appendChild(txt);
      this.root.appendChild(el);
      n = { el, txt, pos: point.clone().add(_v.set((Math.random() - 0.5) * 0.3, 0.15, 0)), shown: 0 };
      this.nums.set(e, n);
    }
    const shown = Math.round(e.total);
    if (shown !== n.shown) {
      n.shown = shown; n.txt.textContent = String(shown);
      n.el.classList.toggle('head', e.head);
      // the outer element is positioned by transform every frame; the pop animates the inner span
      n.txt.classList.remove('bump'); void n.txt.offsetWidth; n.txt.classList.add('bump');
    }
    if (!enemy.isBoss) {
      let b = this.bars.get(enemy);
      if (!b) {
        const el = document.createElement('div'); el.className = 'ehp';
        const shield = document.createElement('i'); shield.className = 'sh';
        const fill = document.createElement('b');
        el.append(fill, shield); this.root.appendChild(el);
        b = { el, fill, shield, last: now };
        this.bars.set(enemy, b);
      }
      b.last = now;
    }
  }

  kill(enemy: TextTarget, now: number) {
    this.tally.kill(this.key(enemy), now);
    for (const [e, n] of this.nums) if (e.kill && e.key === this.keys.get(enemy)) n.el.classList.add('kill');
    const b = this.bars.get(enemy);
    if (b) { b.el.remove(); this.bars.delete(enemy); }
  }

  update(cam: THREE.Camera, now: number) {
    const W = window.innerWidth, H = window.innerHeight;
    const live = new Set(this.tally.update(now));
    for (const [e, n] of this.nums) {
      if (!live.has(e)) { this.drop(e); continue; }
      const age = now - e.born, fade = 1 - Math.max(0, (now - e.last) / this.tally.life - 0.55) / 0.45;
      _v.copy(n.pos); _v.y += age * 0.7;
      if (!this.place(n.el, cam, _v, W, H)) continue;
      n.el.style.opacity = String(Math.max(0, fade));
    }
    for (const [t, b] of this.bars) {
      const a = hpBarAlpha(now - b.last);
      if (!t.alive || a <= 0 || !this.enabled) { b.el.remove(); this.bars.delete(t); continue; }
      const s = t.stats?.scale ?? 1;
      _v.copy(t.center); _v.y += (t.stats?.quad ? 0.45 : t.stats?.flying ? 0.5 : 0.75) * s;
      if (!this.place(b.el, cam, _v, W, H)) continue;
      b.el.style.opacity = String(a * (t.visibility ?? 1) > 0.5 ? a : 0); // never reveal a hidden Shade
      b.fill.style.transform = `scaleX(${Math.max(0, t.hp / t.maxHp)})`;
      b.shield.style.transform = `scaleX(${Math.min(1, (t.shield ?? 0) / t.maxHp)})`;
    }
  }

  clear() {
    for (const e of [...this.nums.keys()]) this.drop(e);
    for (const b of this.bars.values()) b.el.remove();
    this.bars.clear();
  }

  private drop(e: TallyEntry) { this.nums.get(e)?.el.remove(); this.nums.delete(e); }

  /** Project to screen; hides the element when behind the camera. */
  private place(el: HTMLElement, cam: THREE.Camera, p: THREE.Vector3, W: number, H: number) {
    p.project(cam);
    if (p.z > 1 || p.z < -1) { el.style.opacity = '0'; return false; }
    el.style.transform = `translate(${((p.x + 1) / 2 * W).toFixed(1)}px, ${((1 - p.y) / 2 * H).toFixed(1)}px) translate(-50%, -100%)`;
    return true;
  }
}
