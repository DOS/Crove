// The excerpt kept of a post published outside Crove (#1054): one line, no control, zero-width or direction marks, at
// most 500 characters as PostgreSQL counts them, never half an emoji.
import { describe, expect, it } from 'vitest';
import { EXTERNAL_EXCERPT_MAX, EXTERNAL_POST_ID, excerptOf } from '../src/external-posts.ts';

describe('excerptOf', () => {
  it('keeps one clean line', () => {
    expect(excerptOf('  Khai trương\n\nchi nhánh\tmới  ')).toBe('Khai trương chi nhánh mới');
    expect(excerptOf('a​b‮c⁦d﻿e\u0007f')).toBe('a b c d e f');
    // Decomposed Vietnamese marks are composed.
    expect(excerptOf('Việt')).toBe('Việt');
    expect(excerptOf('')).toBe('');
  });

  it('cuts at 500 code points without splitting a character', () => {
    expect(Array.from(excerptOf('x'.repeat(800)))).toHaveLength(EXTERNAL_EXCERPT_MAX);
    const emoji = excerptOf('🎉'.repeat(600));
    expect(Array.from(emoji)).toHaveLength(EXTERNAL_EXCERPT_MAX);
    expect(emoji.endsWith('🎉')).toBe(true);
  });

  it('takes the platform id shapes Graph gives', () => {
    expect(EXTERNAL_POST_ID.test('111222333_444555')).toBe(true);
    expect(EXTERNAL_POST_ID.test('18000000000000101')).toBe(true);
    expect(EXTERNAL_POST_ID.test('a b')).toBe(false);
    expect(EXTERNAL_POST_ID.test('../x')).toBe(false);
    expect(EXTERNAL_POST_ID.test('x'.repeat(201))).toBe(false);
  });
});
