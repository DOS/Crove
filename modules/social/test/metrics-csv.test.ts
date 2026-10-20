import { describe, expect, it } from 'vitest';
import { csvCell, metricsCsv, type MetricsRow } from '../src/metrics.ts';

describe('metrics CSV (#578)', () => {
  it('quotes what needs quoting and keeps a spreadsheet from running a formula', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5 off')).toBe("'-5 off");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });

  it('writes one row per channel with a byte order mark and every count column', () => {
    const row: MetricsRow = {
      variantId: 'v1',
      postId: 'p1',
      provider: 'facebook_page',
      connectionId: 'c1',
      excerpt: 'Khai trương, giảm 50%',
      publishedAt: '2026-10-20T01:00:00.000Z',
      externalUrl: 'https://example.test/p/1',
      metrics: { reach: 30, reactions: 3 },
      capturedAt: '2026-10-20T07:00:00.000Z', clicks: null,
    };
    const csv = metricsCsv([row], new Map([['c1', 'Quán A']]));
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'post_id,channel,provider,published_at,url,text,labels,impressions,reach,reactions,comments,shares,saves,clicks,views,captured_at',
      'p1,Quán A,facebook_page,2026-10-20T01:00:00.000Z,https://example.test/p/1,"Khai trương, giảm 50%",,,30,3,,,,,,2026-10-20T07:00:00.000Z',
      '',
    ]);
  });

  it("writes a post's label names in one cell, joined and guarded like any text (#639)", () => {
    const row: MetricsRow = {
      variantId: 'v1',
      postId: 'p1',
      provider: 'facebook_page',
      connectionId: 'c1',
      excerpt: 'Hi',
      publishedAt: null,
      externalUrl: null,
      metrics: {},
      capturedAt: null, clicks: null,
    };
    const line = (labels?: Map<string, string[]>) => metricsCsv([row], new Map(), labels).slice(1).split('\r\n')[1];
    expect(line(new Map([['p1', ['Khai trương', 'Tết']]]))).toBe('p1,,facebook_page,,,Hi,Khai trương; Tết,,,,,,,,,');
    expect(line(new Map([['p1', ['=SUM(A1)', 'b']]]))).toBe("p1,,facebook_page,,,Hi,'=SUM(A1); b,,,,,,,,,");
    expect(line(new Map([['p1', ['a, b']]]))).toBe('p1,,facebook_page,,,Hi,"a, b",,,,,,,,,');
    expect(line()).toBe('p1,,facebook_page,,,Hi,,,,,,,,,,');
  });
});
