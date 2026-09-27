import { describe, it, expect } from 'vitest';
import { Budget } from '../src/core/budget';

describe('Budget', () => {
  it('evicts the oldest when over cap and never exceeds cap', () => {
    const evicted: number[] = [];
    const b = new Budget<number>(3, x => evicted.push(x));
    for (let i = 0; i < 10; i++) { b.add(i); expect(b.size).toBeLessThanOrEqual(3); }
    expect(evicted).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...b.items]).toEqual([7, 8, 9]);
  });
  it('remove takes an item out without eviction callback', () => {
    const evicted: number[] = [];
    const b = new Budget<number>(2, x => evicted.push(x));
    b.add(1); b.add(2); b.remove(1); b.add(3);
    expect(evicted).toEqual([]);
    expect(b.size).toBe(2);
  });
});
