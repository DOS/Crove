import { describe, expect, it } from 'vitest';
import { PLAN_CSV_COLUMNS, planCsv, planTime, type PlanRow } from '../src/plan-export.ts';
import { altCell, altsOf, labelNamesOf, mediaCell, mediaRefsOf, plainMediaName } from '../src/domain/plan-csv.ts';

const row = (over: Partial<PlanRow> = {}): PlanRow => ({
  postId: 'p1',
  variantId: 'v1',
  connectionId: 'c1',
  channel: 'Quán A',
  provider: 'facebook_page',
  status: 'scheduled',
  at: '2026-11-01T02:00:00.000Z',
  title: null,
  body: 'Khai trương chi nhánh Quận 3',
  linkUrl: null,
  media: [],
  firstComment: null,
  labels: [],
  assignee: null,
  ...over,
});

const HEADER = 'text,title,link,channels,time,media,alt,first_comment,labels,status,assignee,post_id';

describe('content plan CSV (#978)', () => {
  it("starts with the import template's columns, in its names, then the plan's own", () => {
    expect(PLAN_CSV_COLUMNS.slice(0, 9)).toEqual(['text', 'title', 'link', 'channels', 'time', 'media', 'alt', 'first_comment', 'labels']);
    const csv = planCsv([row()], 'Asia/Ho_Chi_Minh');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([HEADER, 'Khai trương chi nhánh Quận 3,,,Quán A,2026-11-01 09:00,,,,,scheduled,,p1', '']);
  });

  it('writes times as the import reads them, local to the zone asked for', () => {
    expect(planTime('2026-11-01T02:00:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('2026-11-01 09:00');
    expect(planTime('2026-11-01T02:00:00.000Z', 'America/New_York')).toBe('2026-10-31 22:00');
    // After the clocks go back in New York (1 November 2026).
    expect(planTime('2026-11-02T14:05:00.000Z', 'America/New_York')).toBe('2026-11-02 09:05');
    expect(planTime('2026-11-01T02:00:00.000Z', 'UTC')).toBe('2026-11-01 02:00');
  });

  it('quotes, joins the labels and keeps a spreadsheet from running a cell as a formula', () => {
    const line = planCsv(
      [row({ body: '=HYPERLINK("x")', title: '- Giảm 20%, tuần đầu', linkUrl: 'https://example.test/a', labels: ['Khai trương', 'Tết'], assignee: '@Lan', channel: '+Kênh', firstComment: '-#khaitruong' })],
      'Asia/Ho_Chi_Minh',
    )
      .slice(1)
      .split('\r\n')[1];
    expect(line).toBe(`"'=HYPERLINK(""x"")","'- Giảm 20%, tuần đầu",https://example.test/a,'+Kênh,2026-11-01 09:00,,,'-#khaitruong,"Khai trương, Tết",scheduled,'@Lan,p1`);
  });

  it('keeps line breaks of a text inside one quoted cell', () => {
    const lines = planCsv([row({ body: 'Dòng một\nDòng hai' })], 'UTC').slice(1).split('\r\n');
    expect(lines[1]).toBe('"Dòng một\nDòng hai",,,Quán A,2026-11-01 02:00,,,,,scheduled,,p1');
  });
});

describe('cells with several values (#1258)', () => {
  it('writes media one per line, and the alt texts on the same lines', () => {
    const media = [
      { ref: 'banh-mi.jpg', altText: 'Ổ bánh mì\ntrên khay' },
      { ref: '0b9f6c1e-4a1d-4c9e-9a51-2a3b4c5d6e7f', altText: null },
      { ref: 'quay.png', altText: 'Quầy bán' },
    ];
    expect(mediaCell(media)).toBe('banh-mi.jpg\n0b9f6c1e-4a1d-4c9e-9a51-2a3b4c5d6e7f\nquay.png');
    expect(altCell(media)).toBe('Ổ bánh mì trên khay\n\nQuầy bán');
    // No alt text after the last one: no trailing lines.
    expect(altCell([{ ref: 'a.jpg', altText: 'A' }, { ref: 'b.jpg', altText: null }])).toBe('A');
    const line = planCsv([row({ media })], 'UTC').slice(1).split('\r\n')[1];
    expect(line).toBe('Khai trương chi nhánh Quận 3,,,Quán A,2026-11-01 02:00,"banh-mi.jpg\n0b9f6c1e-4a1d-4c9e-9a51-2a3b4c5d6e7f\nquay.png","Ổ bánh mì trên khay\n\nQuầy bán",,,scheduled,,p1');
  });

  it('reads media by line, ";" and before each https:// of a list, keeping commas inside a URL', () => {
    expect(mediaRefsOf('banh-mi.jpg\r\n quay.png ;; ')).toEqual(['banh-mi.jpg', 'quay.png']);
    expect(mediaRefsOf('https://cdn.example/a.jpg, https://res.example/w_500,h_300/b.jpg https://cdn.example/c.png')).toEqual([
      'https://cdn.example/a.jpg',
      'https://res.example/w_500,h_300/b.jpg',
      'https://cdn.example/c.png',
    ]);
    expect(mediaRefsOf('ảnh 1, bìa.jpg')).toEqual(['ảnh 1, bìa.jpg']);
    expect(mediaRefsOf('')).toEqual([]);
  });

  it('splits a long run of tabs, spaces or commas in linear time (CodeQL js/polynomial-redos)', () => {
    for (const run of ['\t', ' ', ',', '\t,']) {
      const long = run.repeat(50_000);
      const started = performance.now();
      expect(mediaRefsOf(`a.jpg${long}x`)).toEqual([`a.jpg${long}x`.trim()]);
      expect(mediaRefsOf(`https://cdn.example/a.jpg${long}https://cdn.example/b.jpg`)).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
      expect(altsOf(`${'\n\t'.repeat(50_000)}Quầy${'\t\r\n'.repeat(50_000)}mới`, 1)).toEqual(['Quầy mới']);
      expect(performance.now() - started).toBeLessThan(1000);
    }
    expect(mediaRefsOf('HTTPS://cdn.example/a.jpg,http://cdn.example/b.jpg;ftp://x.example/c')).toEqual(['HTTPS://cdn.example/a.jpg', 'http://cdn.example/b.jpg', 'ftp://x.example/c']);
  });

  it('reads alt texts one per image, the whole cell for one image', () => {
    expect(altsOf('Ổ bánh mì\n\nQuầy bán', 3)).toEqual(['Ổ bánh mì', null, 'Quầy bán']);
    expect(altsOf('Dòng một\nDòng hai', 1)).toEqual(['Dòng một Dòng hai']);
    expect(altsOf('a\nb\nc', 2)).toEqual(['a', 'b', 'c']);
    expect(altsOf('  ', 2)).toEqual([]);
  });

  it('reads label names by comma, semicolon or line, once each whatever the case', () => {
    expect(labelNamesOf('Tết, Khai trương;tết\nKhuyến mãi , ')).toEqual(['Tết', 'Khai trương', 'Khuyến mãi']);
    // NFC: a name typed with combining marks is the same name.
    expect(labelNamesOf('Tết')).toEqual(['Tết']);
  });

  it('writes a file name only when the import reads it back as that name', () => {
    expect(plainMediaName('banh-mi.jpg')).toBe(true);
    for (const name of ['a;b.jpg', 'a\nb.jpg', ' a.jpg', '0b9f6c1e-4a1d-4c9e-9a51-2a3b4c5d6e7f', 'https://x.example/a.jpg', '']) expect(plainMediaName(name), name).toBe(false);
  });
});
