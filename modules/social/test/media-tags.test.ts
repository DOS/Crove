// Tags on media library files (#904): how a typed tag is normalized, checked and compared.
import { describe, expect, it } from 'vitest';
import { MEDIA_TAG_MAX_LENGTH, mediaTagKey, mediaTagProblem, normalizeMediaTag, normalizeMediaTags, splitMediaTags } from '../src/domain/media-tags.ts';
import { zMediaTag } from '../src/media-tags.ts';

describe('media tag normalization', () => {
  it('trims, collapses inner white space and keeps the case', () => {
    expect(normalizeMediaTag('  Tết   2027 ')).toBe('Tết 2027');
    expect(normalizeMediaTag('Khuyến\tmãi\n hè')).toBe('Khuyến mãi hè');
    expect(normalizeMediaTag('Áo Dài')).toBe('Áo Dài');
  });

  it('makes combining marks precomposed, so both spellings are one tag', () => {
    const decomposed = 'Tết';
    expect(normalizeMediaTag(decomposed)).toBe('Tết');
    expect(mediaTagKey(decomposed)).toBe(mediaTagKey('TẾT'));
  });

  it('keeps each tag once, its first spelling, in the order given, and drops empty ones', () => {
    expect(normalizeMediaTags(['Tết', ' tết ', 'TẾT', '', '   ', 'Áo dài', 'áo  DÀI'])).toEqual(['Tết', 'Áo dài']);
  });

  it('splits what a member types at commas', () => {
    expect(splitMediaTags('Tết, áo dài ,, Khách A, tết')).toEqual(['Tết', 'áo dài', 'Khách A']);
    expect(splitMediaTags(' , ')).toEqual([]);
  });

  it('refuses an empty tag, one too long and one with control characters', () => {
    expect(mediaTagProblem('')).toBe('empty');
    expect(mediaTagProblem('a'.repeat(MEDIA_TAG_MAX_LENGTH))).toBeNull();
    expect(mediaTagProblem('a'.repeat(MEDIA_TAG_MAX_LENGTH + 1))).toBe('too_long');
    // Counted in characters as the database does, not in UTF-16 units.
    expect(mediaTagProblem('🎉'.repeat(MEDIA_TAG_MAX_LENGTH))).toBeNull();
    expect(mediaTagProblem('a\u0000b')).toBe('control');
  });

  it('parses a command tag to its normalized form, or refuses it', () => {
    expect(zMediaTag.parse('  Sale   hè ')).toBe('Sale hè');
    expect(zMediaTag.safeParse('   ').success).toBe(false);
    expect(zMediaTag.safeParse(`${'x'.repeat(MEDIA_TAG_MAX_LENGTH)}  `).success).toBe(true);
    expect(zMediaTag.safeParse('x'.repeat(MEDIA_TAG_MAX_LENGTH + 1)).success).toBe(false);
  });
});
