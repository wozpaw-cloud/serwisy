import { describe, expect, it } from 'vitest';
import { slugify, streetLabel } from '../src/normalize.ts';

describe('adresy stron i ulice', () => {
  it('długie nazwy skraca na granicy słowa', () => {
    const s = slugify('ul. Powstańców Wielkopolskich 1/1, 1/2, 2/3, 2/4, 3/5, 3/6, 4/7, 4/8, 5/9, 5/10, 6/11, 6/12, 7/13');
    expect(s.length).toBeLessThanOrEqual(70);
    expect(s.endsWith('-')).toBe(false);
    expect(s.startsWith('ul-powstancow-wielkopolskich-1-1')).toBe(true);
  });
  it.each([
    ['Sobieskiego 29', 'ul. Sobieskiego 29'], ['ul. Sobieskiego 29', 'ul. Sobieskiego 29'], ['ul ul. Sobieskiego', 'ul. Sobieskiego'],
    ['UL. Długa', 'ul. Długa'], ['al. Jana Pawła II 5', 'al. Jana Pawła II 5'], ['Aleja Zwycięstwa', 'al. Zwycięstwa'],
    ['os. Zielone 3', 'os. Zielone 3'], ['Plac Wolności 1', 'pl. Wolności 1'], ['', null], [null, null],
  ])('%s -> %s', (v, want) => expect(streetLabel(v as string | null)).toBe(want));
});
