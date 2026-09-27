import './ui/style.css';
import { Game } from './game/game';

function fail(msg: string) {
  const boot = document.getElementById('boot')!;
  boot.innerHTML = `<div class="boot-title">HALOGEN</div><div class="boot-err">${msg}</div>`;
}

function hasWebGL2() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

async function main() {
  if (!hasWebGL2()) return fail('This game needs WebGL2. Try a recent Chrome, Edge or Firefox on a desktop with hardware acceleration enabled.');
  if (typeof WebAssembly !== 'object') return fail('This game needs WebAssembly support.');
  const setBoot = (p: number, msg: string) => {
    const f = document.getElementById('boot-fill'); if (f) f.style.width = `${Math.round(p * 100)}%`;
    const m = document.getElementById('boot-msg'); if (m) m.textContent = msg;
  };
  try {
    const game = await Game.create(document.getElementById('c') as HTMLCanvasElement, document.getElementById('ui')!, setBoot);
    (window as any).__halogen = game;
    if (new URLSearchParams(location.search).has('bench')) setTimeout(() => game.bench(), 500);
    document.getElementById('boot')?.classList.add('gone');
    setTimeout(() => document.getElementById('boot')?.remove(), 800);
  } catch (e) {
    console.error(e);
    fail('Failed to start: ' + (e as Error).message);
  }
}
main();
