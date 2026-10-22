// The agency note of a client report link (#1056) as it is kept: plain text in NFC, line breaks as LF, without the
// characters that hide or reorder text, but with the zero width joiner emoji sequences need.
import { describe, expect, it } from 'vitest';
import { plainNote } from '../src/report-links.ts';

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe('report link note (#1056)', () => {
  it('keeps text, markup as text, tabs and line breaks', () => {
    expect(plainNote('  Tháng này tốt.\r\n<b>x</b>\tvà\rhết  ')).toBe('Tháng này tốt.\n<b>x</b>\tvà\nhết');
  });

  it('removes controls, separators, bidi and other format characters', () => {
    const hidden = [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x061c, 0x200b, 0x200c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff, 0xe0001, 0xe0041, 0xe007f];
    for (const c of hidden) expect(plainNote(`a${cp(c)}b`)).toBe('ab');
  });

  it('keeps the zero width joiner and the emoji it joins', () => {
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(plainNote(`Cảm ơn ${family}`)).toBe(`Cảm ơn ${family}`);
  });

  it('composes to NFC and leaves nothing of an empty note', () => {
    expect(plainNote(`Vie${cp(0x0302, 0x0323)}t`)).toBe(`Vi${cp(0x1ec7)}t`);
    expect(plainNote(` \n${cp(0x200b)}\t `)).toBe('');
  });
});
