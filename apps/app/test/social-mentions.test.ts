// The @mention picker's matching (#793, #1360): what follows the @ finds members whatever the marks and case, so
// "dien thoai" finds "Điện thoại", as the command palette's fold() does; a query with marks still matches.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: null }));

const { mentionMatches } = await import('../src/components/social-mentions.tsx');

const members = [
  { userId: 'u1', label: 'Điện thoại Minh Châu' },
  { userId: 'u2', label: 'Nguyễn Văn Dũng' },
  { userId: 'u3', label: 'Đức Anh' },
  { userId: 'u4', label: 'Lan (lan@shop.test)' },
];
const ids = (query: string) => mentionMatches(members, query).map((m) => m.userId);

describe('mentionMatches', () => {
  it('finds a member without typing the marks', () => {
    expect(ids('dien thoai')).toEqual(['u1']);
    expect(ids('dung')).toEqual(['u2']);
    expect(ids('duc')).toEqual(['u3']);
  });

  it('still matches what is typed with marks, whatever the case', () => {
    expect(ids('Điện')).toEqual(['u1']);
    expect(ids('ĐỨC')).toEqual(['u3']);
    expect(ids('nguyễn văn')).toEqual(['u2']);
  });

  it('lists everyone for a bare @ and nobody for a stranger, at most six', () => {
    expect(ids('')).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(ids('lan@shop')).toEqual(['u4']);
    expect(ids('quang')).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => ({ userId: `m${i}`, label: `Thành viên ${i}` }));
    expect(mentionMatches(many, 'thanh vien')).toHaveLength(6);
  });
});
