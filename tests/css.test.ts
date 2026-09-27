import { describe, it, expect } from 'vitest';
import css from '../src/ui/style.css?raw';

describe('stylesheet', () => {
  it('does not reference public assets with relative url() (breaks once built into dist/assets/)', () => {
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)/g)].map(m => m[1]);
    expect(urls.filter(u => !/^(data:|https?:|\/|#)/.test(u))).toEqual([]);
  });
});
