import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/lib/bank-statement.ts';
import { importRows, parseLocalTime } from '../src/lib/social-import.ts';

const channels = [
  { id: 'fb1', displayName: 'Quán A', provider: 'facebook_page', status: 'active' },
  { id: 'zl1', displayName: 'Quán A Zalo', provider: 'zalo_oa', status: 'active' },
  { id: 'fb2', displayName: 'Quán B', provider: 'facebook_page', status: 'active' },
  { id: 'old', displayName: 'Trang cũ', provider: 'threads', status: 'revoked' },
];
const NOW = new Date(2026, 9, 20, 12, 0).getTime();

describe('Social import from a sheet (#586)', () => {
  it('reads Vietnamese headers, quoted text with commas and line breaks, and a byte order mark', () => {
    const csv = '﻿Nội dung;Kênh;Giờ đăng\r\n"Khai trương, giảm 20%\nTuần đầu";Quán A Zalo;01/11/2026 09:30\r\n';
    const rows = importRows(parseCsv(csv), channels, NOW);
    expect(rows).toEqual([{ row: 2, body: 'Khai trương, giảm 20%\nTuần đầu', title: '', link: '', connectionIds: ['zl1'], plannedAt: new Date(2026, 10, 1, 9, 30).toISOString(), problems: [] }]);
  });

  it('names a channel, a provider with one channel, or all; and says what it cannot match', () => {
    const csv = 'text,channels\nA,zalo; Quán B\nB,facebook\nC,all\nD,Trang cũ\nE,\n';
    const rows = importRows(parseCsv(csv), channels, NOW) ?? [];
    expect(rows.map((r) => [r.connectionIds, r.problems.map((p) => p.code)])).toEqual([
      [['zl1', 'fb2'], []],
      [[], ['AMBIGUOUS_CHANNEL']],
      [['fb1', 'zl1', 'fb2'], []],
      [[], ['UNKNOWN_CHANNEL']],
      [[], ['NO_CHANNEL']],
    ]);
  });

  it('flags missing text, a bad or past time and a link that is not http(s)', () => {
    const csv = 'text,channels,time,link\n,all,,\nX,all,31/02/2026,\nY,all,2026-10-01 09:00,\nZ,all,,www.a.vn\n';
    expect((importRows(parseCsv(csv), channels, NOW) ?? []).map((r) => r.problems.map((p) => p.code))).toEqual([['NO_TEXT'], ['BAD_TIME'], ['PAST_TIME'], ['BAD_LINK']]);
  });

  it('needs a header with a text column, and reads times in both forms', () => {
    expect(importRows(parseCsv('a,b\n1,2\n'), channels, NOW)).toBeNull();
    expect(parseLocalTime('2026-11-01')?.getHours()).toBe(9);
    expect(parseLocalTime('2026-11-01T18:05')?.getMinutes()).toBe(5);
    expect(parseLocalTime('1/11/2026 7:00')?.getDate()).toBe(1);
    expect(parseLocalTime('25:00')).toBeNull();
  });
});