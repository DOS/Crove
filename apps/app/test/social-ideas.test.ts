import { describe, expect, it } from 'vitest';
import { BOARD_STAGES, linkHost } from '../src/lib/social-ideas.ts';

describe('ideas board (#701)', () => {
  it('shows new, planned and drafted ideas as columns, archived ones apart', () => {
    expect(BOARD_STAGES).toEqual(['new', 'planned', 'drafted']);
  });

  it('shows a link by its site', () => {
    expect(linkHost('https://www.cuahang.vn/khuyen-mai?x=1')).toBe('cuahang.vn');
    expect(linkHost('https://shop.example/a')).toBe('shop.example');
    expect(linkHost('không phải link')).toBe('không phải link');
  });
});
