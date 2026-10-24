// Images, alt texts, labels and a first comment in the sheet import (#1258): the cells with several values (quoted, one
// per line, ";" or a Publer-style list of URLs), the problems said before any lookup, the server's answers joined to
// each row, the labels the import would create, and a plan exported by social.plan.export coming back as it went out.
import { describe, expect, it } from 'vitest';
import { planCsv, type PlanRow } from '@crove/mod-social/contract';
import { parseCsv } from '../src/lib/bank-statement.ts';
import { IMPORT_TEMPLATE, LABEL_LIMIT, fetchableUrl, importRows, lookupKey, newLabels, pendingRefs, withMedia, type ImportRow, type MediaLookup } from '../src/lib/social-import.ts';

const channels = [
  { id: 'fb1', displayName: 'Quán A', provider: 'facebook_page', status: 'active' },
  { id: 'zl1', displayName: 'Quán A Zalo', provider: 'zalo_oa', status: 'active' },
];
const NOW = new Date(2026, 9, 20, 12, 0).getTime();
// 09:00 on 1 November 2099 where the test runs: the export writes it in that zone, the import reads it there.
const AT = new Date(2099, 10, 1, 9, 0).toISOString();
const rowsOf = (csv: string) => importRows(parseCsv(csv), channels, NOW) ?? [];
const file = (fileId: string, filename: string, sizeBytes = 200_000) => ({ fileId, filename, mime: 'image/jpeg', sizeBytes, durationMs: null, width: 1080, height: 1080 });

describe('media, alt texts, labels and a first comment in the import (#1258)', () => {
  it('reads quoted cells with several images, their alt texts by line, labels and a first comment', () => {
    const csv =
      'text,channels,media,alt,first_comment,labels\r\n' +
      '"Khai trương, giảm 20%",Quán A,"banh-mi.jpg\nhttps://cdn.example/a.jpg, https://res.example/w_500,h_300/b.jpg","Ổ bánh mì\n\nQuầy","#khaitruong, ghé nhé","Tết, Khai trương;tết"\r\n';
    const [row] = rowsOf(csv);
    expect(row?.problems).toEqual([]);
    expect(row?.media).toEqual([
      { kind: 'file', ref: 'banh-mi.jpg', altText: 'Ổ bánh mì' },
      { kind: 'url', ref: 'https://cdn.example/a.jpg', altText: null },
      { kind: 'url', ref: 'https://res.example/w_500,h_300/b.jpg', altText: 'Quầy' },
    ]);
    expect(row?.labels).toEqual(['Tết', 'Khai trương']);
    expect(row?.firstComment).toBe('#khaitruong, ghé nhé');
  });

  it('finds the columns by their Vietnamese names too, and one image takes the whole alt cell', () => {
    const [row] = rowsOf('Nội dung;Kênh;Ảnh;Mô tả ảnh;Bình luận đầu tiên;Nhãn\r\nBài;Quán A;quay.png;"Quầy pha chế\nmới";Xem menu;Khuyến mãi\r\n');
    expect(row?.media).toEqual([{ kind: 'file', ref: 'quay.png', altText: 'Quầy pha chế mới' }]);
    expect([row?.labels, row?.firstComment]).toEqual([['Khuyến mãi'], 'Xem menu']);
  });

  it('says on the row what is wrong before asking the server', () => {
    const many = Array.from({ length: 11 }, (_, i) => `anh-${i}.jpg`).join(';');
    const labels = Array.from({ length: 11 }, (_, i) => `Nhãn ${i}`).join(',');
    const rows = rowsOf(
      'text,channels,media,alt,first_comment,labels\n' +
        `A,Quán A,${many},,,\n` +
        'B,Quán A,"http://cdn.example/a.jpg;https://user:pw@cdn.example/b.jpg;ftp://x.example/c.jpg",,,\n' +
        `C,Quán A,a.jpg,"x\ny",,\n` +
        `D,Quán A,a.jpg;b.jpg,"${'x'.repeat(1001)}",,\n` +
        `E,Quán A,,,${'c'.repeat(10_001)},"${labels}"\n` +
        `F,Quán A,,,,${'n'.repeat(51)}\n`,
    );
    expect(rows.map((r) => r.problems.map((p) => p.code))).toEqual([
      ['TOO_MANY_MEDIA'],
      ['MEDIA_BAD_URL', 'MEDIA_BAD_URL', 'MEDIA_BAD_URL'],
      [],
      ['ALT_TOO_LONG'],
      ['COMMENT_TOO_LONG', 'TOO_MANY_LABELS'],
      ['LABEL_TOO_LONG'],
    ]);
    // One image takes the whole alt cell, so two lines are its alt text, not a second one.
    expect(rows[2]?.media[0]?.altText).toBe('x y');
    const extra = rowsOf('text,channels,media,alt\nA,Quán A,a.jpg;b.jpg,"x\ny\nz"\n');
    expect(extra[0]?.problems.map((p) => p.code)).toEqual(['TOO_MANY_ALT']);
    expect(fetchableUrl('https://cdn.example/a.jpg')).toBe(true);
    expect(fetchableUrl(`https://cdn.example/${'a'.repeat(2000)}`)).toBe(false);
  });

  it('asks the server once for each file name and fetchable URL, and joins its answers to the rows', () => {
    const rows = rowsOf('text,channels,media,alt\nA,Quán A,"banh-mi.jpg;https://cdn.example/a.jpg",Bánh mì\nB,Quán A,"banh-mi.jpg;http://x.example/b.jpg;khong-co.jpg;rieng.jpg"\n');
    expect(pendingRefs(rows, new Map())).toEqual({ files: ['banh-mi.jpg', 'khong-co.jpg', 'rieng.jpg'], urls: ['https://cdn.example/a.jpg'] });
    const lookups = new Map<string, MediaLookup>([
      [lookupKey({ kind: 'file', ref: 'banh-mi.jpg' }), { file: file('f1', 'banh-mi.jpg'), problem: null }],
      [lookupKey({ kind: 'file', ref: 'khong-co.jpg' }), { file: null, problem: 'UNKNOWN_FILE' }],
    ]);
    // Still waiting for the URL and one file: not ready.
    const [a, b] = rows.map((r) => withMedia(r, lookups));
    expect(a?.pending).toBe(true);
    expect(a?.files).toEqual([{ ...file('f1', 'banh-mi.jpg'), altText: 'Bánh mì' }]);
    lookups.set(lookupKey({ kind: 'url', ref: 'https://cdn.example/a.jpg' }), { file: file('f1', 'banh-mi.jpg'), problem: null });
    lookups.set(lookupKey({ kind: 'file', ref: 'rieng.jpg' }), { file: null, problem: 'FILE_NOT_ALLOWED' });
    expect(pendingRefs(rows, lookups)).toEqual({ files: [], urls: [] });
    const after = rows.map((r) => withMedia(r, lookups));
    // The URL gave the same file as the name: attached once.
    expect(after[0]).toEqual({ files: [{ ...file('f1', 'banh-mi.jpg'), altText: 'Bánh mì' }], problems: [], pending: false });
    expect(after[1]?.problems.map((p) => [p.code, p.value])).toEqual([
      ['MEDIA_BAD_URL', 'http://x.example/b.jpg'],
      ['UNKNOWN_FILE', 'khong-co.jpg'],
      ['FILE_NOT_ALLOWED', 'rieng.jpg'],
    ]);
    expect(b?.pending).toBe(true);
  });

  it('names the labels it would create, and the rows past the org limit', () => {
    const rows = rowsOf('text,channels,labels\nA,Quán A,"Tết, Mới"\nB,Quán A,"mới, Khác"\n');
    expect(newLabels(rows, ['tết'])).toEqual({ names: ['Mới', 'Khác'], overLimit: new Set() });
    const full = Array.from({ length: LABEL_LIMIT - 1 }, (_, i) => `L${i}`);
    expect(newLabels(rows, full)).toEqual({ names: ['Tết'], overLimit: new Set([2, 3]) });
  });

  it('reads its own template', () => {
    const [row] = rowsOf(IMPORT_TEMPLATE);
    expect(row?.media.map((m) => m.kind)).toEqual(['url', 'file']);
    expect(row?.labels).toEqual(['Khai trương', 'Quận 3']);
    expect(row?.firstComment).toBe('#khaitruong #quan3');
  });
});

describe('formula cells in the exported plan (#978, #1258)', () => {
  it('writes every cell a spreadsheet would run as text, and the import drops the guard again', () => {
    const exported = planCsv(
      [
        {
          postId: 'p1',
          variantId: 'v1',
          connectionId: 'fb1',
          channel: 'Quán A',
          provider: 'facebook_page',
          status: 'draft',
          at: AT,
          title: '@title',
          body: '=HYPERLINK("https://evil.example")',
          linkUrl: null,
          media: [
            { ref: '@banh-mi.jpg', altText: '=1+1' },
            { ref: 'quay.png', altText: '-giảm 20%' },
          ],
          firstComment: '\tthẻ',
          labels: ['+Sale', 'Tết'],
          assignee: null,
        },
      ],
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    const cells = exported.slice(1).split('\r\n')[1] ?? '';
    // Each cell that would start with =, +, -, @ or a tab starts with a quote instead.
    expect(cells).toContain(`"'=HYPERLINK(""https://evil.example"")",'@title,,Quán A,`);
    expect(cells).toContain(`"'@banh-mi.jpg\nquay.png","'=1+1\n-giảm 20%",'\tthẻ,"'+Sale, Tết",draft`);
    const [row] = importRows(parseCsv(exported), channels, NOW) ?? [];
    expect([row?.body, row?.title, row?.media, row?.firstComment, row?.labels]).toEqual([
      '=HYPERLINK("https://evil.example")',
      '@title',
      [
        { kind: 'file', ref: '@banh-mi.jpg', altText: '=1+1' },
        { kind: 'file', ref: 'quay.png', altText: '-giảm 20%' },
      ],
      '	thẻ',
      ['+Sale', 'Tết'],
    ]);
  });
});

describe('a plan exported and imported again (#978, #1258)', () => {
  const plan = (over: Partial<PlanRow>): PlanRow => ({
    postId: 'p1',
    variantId: 'v1',
    connectionId: 'fb1',
    channel: 'Quán A',
    provider: 'facebook_page',
    status: 'scheduled',
    at: AT,
    title: null,
    body: 'Khai trương',
    linkUrl: null,
    media: [],
    firstComment: null,
    labels: [],
    assignee: null,
    ...over,
  });

  it('keeps the text, the channel, the time, the media with their alt texts, the first comment and the labels', () => {
    const exported = [
      plan({
        body: '- Giảm 20%, tuần đầu\nGhé quán nhé',
        title: '=Ưu đãi',
        linkUrl: 'https://example.test/a',
        media: [
          { ref: 'banh-mi.jpg', altText: 'Ổ bánh mì\ntrên khay' },
          { ref: '0b9f6c1e-4a1d-4c9e-9a51-2a3b4c5d6e7f', altText: null },
          { ref: 'quay.png', altText: 'Quầy, "mới"' },
        ],
        firstComment: '+#khaitruong #quan3',
        labels: ['Tết', 'Khai trương'],
        assignee: 'Lan',
      }),
      plan({ postId: 'p2', variantId: 'v2', connectionId: 'zl1', channel: 'Quán A Zalo', provider: 'zalo_oa', body: 'Bài hai', media: [{ ref: 'bia.jpg', altText: 'Bìa' }] }),
    ];
    const rows = importRows(parseCsv(planCsv(exported, Intl.DateTimeFormat().resolvedOptions().timeZone)), channels, NOW) ?? [];
    const kept = (r: ImportRow) => ({ body: r.body, title: r.title, link: r.link, connectionIds: r.connectionIds, plannedAt: r.plannedAt, media: r.media, firstComment: r.firstComment, labels: r.labels, problems: r.problems });
    expect(rows.map(kept)).toEqual([
      {
        body: '- Giảm 20%, tuần đầu\nGhé quán nhé',
        title: '=Ưu đãi',
        link: 'https://example.test/a',
        connectionIds: ['fb1'],
        plannedAt: AT,
        media: [
          { kind: 'file', ref: 'banh-mi.jpg', altText: 'Ổ bánh mì trên khay' },
          { kind: 'file', ref: '0b9f6c1e-4a1d-4c9e-9a51-2a3b4c5d6e7f', altText: null },
          { kind: 'file', ref: 'quay.png', altText: 'Quầy, "mới"' },
        ],
        firstComment: '+#khaitruong #quan3',
        labels: ['Tết', 'Khai trương'],
        problems: [],
      },
      { body: 'Bài hai', title: '', link: '', connectionIds: ['zl1'], plannedAt: AT, media: [{ kind: 'file', ref: 'bia.jpg', altText: 'Bìa' }], firstComment: '', labels: [], problems: [] },
    ]);
  });
});
