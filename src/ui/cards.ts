import type { CardDef } from '../game/run/cards';

const RARITY_COLOR: Record<string, string> = { common: '#19f0ff', rare: '#ffb02e', legendary: '#ff2bd6' };

/** 1-of-3 upgrade picker with hover tilt, rarity glow and synergy hints. Resolves with the chosen id. */
export function pickCard(ui: HTMLElement, cards: CardDef[], ownedTags: Set<string>, title: string, sfx: (n: string) => void): Promise<string> {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'cardpick interactive';
    wrap.innerHTML = `<div class="cp-title">${title}</div><div class="cp-row"></div><div class="cp-hint">CLICK OR PRESS 1 · 2 · 3</div>`;
    const row = wrap.querySelector('.cp-row')!;
    let done = false;
    const choose = (id: string, el: HTMLElement) => {
      if (done) return; done = true;
      el.classList.add('chosen');
      sfx('uiSelect');
      window.removeEventListener('keydown', onKey);
      setTimeout(() => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 350); resolve(id); }, 380);
    };
    const els: HTMLElement[] = [];
    cards.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = `card r-${c.rarity}`;
      el.style.setProperty('--rc', RARITY_COLOR[c.rarity]);
      el.style.animationDelay = `${i * 90}ms`;
      const syn = c.tags.some(t => ownedTags.has(t));
      const art = c.id === 'lumencharge' || c.id === 'focuscharge' ? 'lumenwell' : c.id;
      el.innerHTML = `<div class="c-art" style="background-image:url(assets/cards/${art}.webp)"></div>
        <div class="c-body"><div class="c-rar">${c.rarity.toUpperCase()}${syn ? ' · <span class="syn">SYNERGY</span>' : ''}</div>
        <div class="c-name">${c.name}</div><div class="c-desc">${c.desc}</div>
        <div class="c-tags">${c.tags.map(t => `<span>${t}</span>`).join('')}</div></div><div class="c-key">${i + 1}</div>`;
      el.addEventListener('mousemove', e => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(700px) rotateY(${x * 14}deg) rotateX(${-y * 14}deg) translateY(-8px)`;
        el.style.setProperty('--mx', `${(x + 0.5) * 100}%`); el.style.setProperty('--my', `${(y + 0.5) * 100}%`);
      });
      el.addEventListener('mouseenter', () => sfx('uiHover'));
      el.addEventListener('mouseleave', () => { el.style.transform = ''; });
      el.addEventListener('click', () => choose(c.id, el));
      row.appendChild(el); els.push(el);
    });
    const onKey = (e: KeyboardEvent) => { const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code); if (i >= 0 && cards[i]) choose(cards[i].id, els[i]); };
    window.addEventListener('keydown', onKey);
    ui.appendChild(wrap);
    sfx('cardReveal');
  });
}
