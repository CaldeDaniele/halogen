import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  (globalThis as any).window = new EventTarget();
  (globalThis as any).document = Object.assign(new EventTarget(), { pointerLockElement: null, exitPointerLock() {} });
});

function key(type: string, code: string) { const e = new Event(type) as any; e.code = code; e.repeat = false; e.preventDefault = () => {}; return e; }

describe('Input', () => {
  it('releases every held key on window blur (no stuck movement after alt-tab)', async () => {
    const { Input } = await import('../src/core/input');
    const inp = new Input({} as any);
    window.dispatchEvent(key('keydown', 'KeyW'));
    window.dispatchEvent(key('keydown', 'ShiftLeft'));
    expect(inp.isDown('KeyW')).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(inp.isDown('KeyW')).toBe(false);
    expect(inp.isDown('ShiftLeft')).toBe(false);
    expect(inp.released('KeyW')).toBe(true);
  });
  it('pointer lock loss resets state and notifies', async () => {
    const { Input } = await import('../src/core/input');
    const el = {} as any;
    const inp = new Input(el);
    let notified: boolean | null = null;
    inp.onLockChange = l => { notified = l; };
    (document as any).pointerLockElement = el; document.dispatchEvent(new Event('pointerlockchange'));
    expect(inp.locked).toBe(true);
    window.dispatchEvent(key('keydown', 'KeyA'));
    (document as any).pointerLockElement = null; document.dispatchEvent(new Event('pointerlockchange'));
    expect(inp.locked).toBe(false);
    expect(inp.isDown('KeyA')).toBe(false);
    expect(notified).toBe(false);
  });
});
