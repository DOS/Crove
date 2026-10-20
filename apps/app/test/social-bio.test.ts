import { describe, expect, it } from 'vitest';
import { slugFrom } from '../src/lib/social-bio.ts';

describe('link-in-bio slugs (#707)', () => {
  it('makes a slug from a Vietnamese name', () => {
    expect(slugFrom('Tiệm Bánh Đà Lạt')).toBe('tiem-banh-da-lat');
    expect(slugFrom('  Cà phê & Trà  ')).toBe('ca-phe-tra');
    expect(slugFrom('A')).toBe('a-bio');
    expect(slugFrom('')).toBe('trang-bio');
    expect(slugFrom('x'.repeat(60))).toHaveLength(40);
    expect(slugFrom('Công ty TNHH Một Thành Viên Thương Mại Dịch Vụ Sài Gòn')).toMatch(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
  });
});
