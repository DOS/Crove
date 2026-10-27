// The English copy holds no Vietnamese (DESIGN.md §8, #1629): every string of content/en.ts, once the allowed example
// names are taken out, has no Vietnamese letter. The rendered /en page gets the same check in a11y.spec.ts.
import { describe, expect, it } from 'vitest';
import { en } from '../src/content/en';
import { allowedPhrases, vietnameseLeft } from './vietnamese';

function strings(value: unknown, path: string): Array<[path: string, text: string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  return [];
}

const copy = strings(en, 'en').map(([path, text]) => [path, text.normalize('NFC')] as const);

describe('the English copy (content/en.ts)', () => {
  it('has no Vietnamese but the allowed example names', () => {
    const found = copy.flatMap(([path, text]) => vietnameseLeft(text).map((context) => `${path}: ${context}`));
    expect(found).toEqual([]);
  });

  it('uses every allowed example name, so the list does not outlive the copy', () => {
    const unused = allowedPhrases.filter(([phrase]) => !copy.some(([, text]) => text.includes(phrase))).map(([phrase]) => phrase);
    expect(unused).toEqual([]);
  });

  it('sees a Vietnamese word, also next to an allowed name and in decomposed form', () => {
    expect(vietnameseLeft('Chị Lan approved')).toEqual([]);
    expect(vietnameseLeft('Chị Lan đã duyệt')).toHaveLength(3);
    expect(vietnameseLeft('Hoá đơn'.normalize('NFD'))).toHaveLength(3);
    expect(vietnameseLeft('Invoice')).toEqual([]);
  });
});
