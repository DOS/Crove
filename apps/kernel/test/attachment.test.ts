import { describe, expect, it } from 'vitest';
import { ORG_SLUG, attachmentDisposition } from '../src/attachment.ts';

describe('attachmentDisposition', () => {
  it('builds the same filenames the routes always served, with both RFC 6266 forms', () => {
    expect(attachmentDisposition('acme-vn', ['crove', 'but-toan', ORG_SLUG], 'xlsx')).toBe(
      `attachment; filename="crove-but-toan-acme-vn.xlsx"; filename*=UTF-8''crove-but-toan-acme-vn.xlsx`,
    );
    expect(attachmentDisposition('acme-vn', ['crove', 'gtgt', '2026-Q3', ORG_SLUG], 'xlsx')).toContain('filename="crove-gtgt-2026-Q3-acme-vn.xlsx"');
    expect(attachmentDisposition('acme-vn', ['crove', ORG_SLUG, 'manifest'], 'json')).toContain('filename="crove-acme-vn-manifest.json"');
    expect(attachmentDisposition('acme-vn', ['crove', ORG_SLUG, 'kernel.party'], 'ndjson')).toContain('filename="crove-acme-vn-kernel.party.ndjson"');
  });

  it.each([null, '', 'a', 'A-Upper', '-lead', 'trail-', 'a b', 'a"b', 'a\r\nSet-Cookie: x=1', 'a;b', 'tên-việt', 'x'.repeat(49), 'a/b', 'a\b'])(
    'refuses %j as a slug',
    (slug) => {
      expect(() => attachmentDisposition(slug, ['crove', ORG_SLUG], 'xlsx')).toThrow();
    },
  );

  it.each(['', 'a"b', 'a\rb', 'a\nb', 'a b', 'a;b', 'a/b', '../x', 'việt', 'x'.repeat(65)])('refuses %j as another segment', (segment) => {
    expect(() => attachmentDisposition('acme-vn', ['crove', segment, ORG_SLUG], 'xlsx')).toThrow();
  });

  it.each(['', 'XLSX', 'x.y', 'a"b', 'toolongext1'])('refuses %j as an extension', (extension) => {
    expect(() => attachmentDisposition('acme-vn', ['crove', ORG_SLUG], extension)).toThrow();
  });

  it('never lets a quote, CR or LF into the header', () => {
    const header = attachmentDisposition('acme-vn', ['crove', ORG_SLUG, 'orders_2026'], 'csv');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/"/g)).toHaveLength(2);
  });
});
