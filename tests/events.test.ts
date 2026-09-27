import { describe, it, expect } from 'vitest';
import { Events } from '../src/core/events';

type M = { hit: { dmg: number }; clear: void };
describe('Events', () => {
  it('emits to subscribers and off unsubscribes', () => {
    const e = new Events<M>(); const got: number[] = [];
    const off = e.on('hit', p => got.push(p.dmg));
    e.emit('hit', { dmg: 3 }); off(); e.emit('hit', { dmg: 4 });
    expect(got).toEqual([3]);
  });
  it('a throwing listener does not block others', () => {
    const e = new Events<M>(); let ok = false;
    e.on('clear', () => { throw new Error('x'); });
    e.on('clear', () => { ok = true; });
    e.emit('clear', undefined);
    expect(ok).toBe(true);
  });
});
