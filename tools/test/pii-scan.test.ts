// The G5 PII scan (#1628): planted personal data fails, look-alikes and synthetic values pass, the log masks what it
// found, and the tree as it is passes with every allowlist entry in use.
//
// The planted values never appear in this file as one string: they are joined, or drawn at random, at run time, so the
// scan of this file finds nothing and the repository holds no value that could be a real person's. The planted citizen
// ID has birth year 2099, so no one holds it.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALLOWLIST_FILE,
  allowlistErrors,
  commandProperty,
  entryAllows,
  looksSynthetic,
  mask,
  readText,
  repeatedGroups,
  scanFiles,
  scanText,
  taxCheckDigitValid,
} from '../ci/pii-scan.mjs';

const SCRIPT = fileURLToPath(new URL('../ci/pii-scan.mjs', import.meta.url));
const join2 = (...parts: string[]) => parts.join('');
const randomDigits = (n: number) => Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');
// Random digits that do not look made up, so the scan must report them.
function realLooking(n: number): string {
  for (;;) {
    const d = randomDigits(n);
    if (!looksSynthetic(d)) return d;
  }
}

const cccd = join2('079', '2', '99', realLooking(6));
const mobileTail = realLooking(7);
const mobile = join2('09', '1', mobileTail);
const mobileSpaced = join2('09', '1', mobileTail.slice(0, 1), ' ', mobileTail.slice(1, 4), ' ', mobileTail.slice(4));
const mobileIntl = join2('+', '84', ' ', '91', mobileTail.slice(0, 1), ' ', mobileTail.slice(1, 4), ' ', mobileTail.slice(4));
const mobileDots = join2('09', '1', mobileTail.slice(0, 1), '.', mobileTail.slice(1, 4), '.', mobileTail.slice(4));
const mobileParens = join2('(+', '84) ', '91', mobileTail.slice(0, 1), ' ', mobileTail.slice(1, 4), ' ', mobileTail.slice(4));
function individualTaxCode(): string {
  for (;;) {
    const code = join2('8', randomDigits(9));
    if (taxCheckDigitValid(code)) return code;
  }
}
const taxCode = individualTaxCode();
const email = join2('nguyen.van.', realLooking(4), '@', 'gmail', '.com');
const planted = [cccd, mobile, mobileSpaced, mobileIntl, mobileDots, mobileParens, taxCode, email];

describe('G5 PII scan (#1628)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crove-pii-scan-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds each planted kind: a citizen ID, mobile numbers as people write them, a tax code in a fixture, an address', () => {
    const text = [
      `CCCD: ${cccd}`,
      `Hotline ${mobile} (${mobileSpaced})`,
      `<phone>${mobileIntl}</phone> or ${mobileDots}, ${mobileParens}`,
      `{"taxCode": "${taxCode}", "branch": "${taxCode}-001"}`,
      `mailto:${email}`,
    ].join('\n');
    expect(scanText(text, 'apps/kernel/test/fixtures/party.json').map((f) => [f.line, f.kind, f.value])).toEqual([
      [1, 'cccd', cccd],
      [2, 'mobile', mobile],
      [2, 'mobile', mobileSpaced],
      [3, 'mobile', mobileIntl],
      [3, 'mobile', mobileDots],
      [3, 'mobile', mobileParens],
      [4, 'tax-code', taxCode],
      [4, 'tax-code', `${taxCode}-001`],
      [5, 'email', email],
    ]);
  });

  it('looks for an individual tax code only where test data lives (a company code is public)', () => {
    expect(scanText(taxCode, 'apps/kernel/src/party.ts')).toEqual([]);
    for (const path of ['packages/agent/test/fixtures/a.json', 'apps/app/test/x.ts', 'e2e/tests/a.spec.ts', 'supabase/seed.sql', 'src/party.test.ts']) {
      expect(scanText(taxCode, path).map((f) => f.kind), path).toEqual(['tax-code']);
    }
    const wrongCheck = join2(taxCode.slice(0, 9), String((Number(taxCode[9]) + 1) % 10));
    expect(scanText(wrongCheck, 'apps/app/test/x.ts')).toEqual([]);
  });

  it('lets look-alikes, reserved domains and made-up values through', () => {
    const tail = realLooking(9);
    const lookAlikes = [
      // reserved domains (RFC 2606, RFC 6761)
      'a@example.com b@mail.example.org c@example.net d@shop.test e@x.example f@y.invalid g@z.localhost',
      // credentials in a URL are not an address; package and image versions are not either
      'https://user:pass@www.pexels.com/x react@18.3.1 node:26-slim@sha256:abc @crove/kernel',
      // a CCCD needs a province that exists and a century digit of 0 to 3
      join2('000', '2', '99', tail.slice(0, 6)),
      join2('079', '7', '99', tail.slice(0, 6)),
      // longer digit runs, UUID segments, decimals, migration versions
      join2('0', '79', '2', '99', tail.slice(0, 6), '1'),
      join2('00000000-0000-0000-0000-', '079', '2', '99', tail.slice(0, 6)),
      join2('079', '2', '99', tail.slice(0, 6), '.50'),
      '20261018130000_crove_kernel.sql',
      // colour values and coordinates are not a phone number
      'oklch(0.97 0.014 250) translate(0 912 345 678)',
      join2('0', '20', tail.slice(0, 8)),
      // made up on purpose: one or two digits, or a run up or down
      join2('09', '0', '0000000'),
      join2('09', '1', '2345678'),
      join2('03', '9', '8765432'),
      join2('+84 ', '91', '2 345 678'),
      join2('079', '2', '99', '123456'),
    ];
    for (const text of lookAlikes) expect(scanText(text, 'apps/app/test/a.ts'), text.replace(/\d/g, '#')).toEqual([]);
  });

  it('finds pairs after a first group, a code that ends a sentence, and tells a company tax code from a phone', () => {
    const pairs = join2('09', '1', mobileTail.slice(0, 1), ' ', mobileTail.slice(1, 3), ' ', mobileTail.slice(3, 5), ' ', mobileTail.slice(5));
    expect(scanText(`Zalo ${pairs}`).map((f) => f.kind)).toEqual(['mobile']);
    expect(scanText(`MST: ${taxCode}.`, 'apps/app/test/a.ts').map((f) => f.kind)).toEqual(['tax-code']);
    // Ten digits that start like a mobile number and carry a valid tax check digit.
    let company = '';
    while (!company) {
      const candidate = join2('09', '1', realLooking(7));
      if (taxCheckDigitValid(candidate)) company = candidate;
    }
    expect(scanText(`<MST>${company}</MST>`)).toEqual([]);
    expect(scanText(`"taxCode": "${company}"`)).toEqual([]);
    expect(scanText(`Hotline ${company}`).map((f) => f.kind)).toEqual(['mobile']);
  });

  it('lets repeated digit groups through as made up', () => {
    expect(repeatedGroups('999888777')).toBe(true);
    expect(repeatedGroups('112233')).toBe(true);
    expect(repeatedGroups('9888777')).toBe(false);
    expect(scanText(join2('Hotline 0', '999 888 777'))).toEqual([]);
  });

  it('masks every value it reports, keeping only the prefix that says what it is', () => {
    expect(mask('cccd', cccd)).toBe(`079${'*'.repeat(9)}`);
    expect(mask('mobile', mobileIntl)).toBe(`849${'*'.repeat(8)}`);
    expect(mask('email', email)).toBe('n***@g***.com');
    for (const value of [mobile, mobileSpaced, mobileIntl, mobileDots, mobileParens]) expect(mask('mobile', value)).not.toContain(mobileTail.slice(1));
    expect(mask('tax-code', taxCode)).toBe(`${taxCode.slice(0, 3)}${'*'.repeat(7)}`);
  });

  it('fails the step on a planted file, naming file, line and kind, and never prints a planted value', () => {
    mkdirSync(join(dir, 'fixtures'));
    const file = join(dir, 'fixtures', 'planted.txt');
    writeFileSync(file, planted.join('\n'));
    const run = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    const log = run.stdout + run.stderr;
    expect(log).toContain('line=1::');
    for (const kind of ['cccd', 'mobile', 'tax-code', 'email']) expect(log).toContain(`(${kind} `);
    for (const value of planted) expect(log).not.toContain(value);
    for (const part of [cccd.slice(3), mobileTail, taxCode.slice(3), email.split('@')[0]?.slice(1) ?? '']) expect(log).not.toContain(part);
  });

  it('applies an allowlist entry only to its kind, paths and domains', () => {
    const finding = { line: 1, kind: 'email', value: 'a@shop.test' };
    const entry = { kind: 'email', domains: ['shop.test'], paths: ['modules/social/test/'], reason: 'a sample shop address in post text' };
    expect(entryAllows(entry, finding, 'modules/social/test/a.test.ts')).toBe(true);
    expect(entryAllows(entry, { ...finding, value: 'a@m.shop.test' }, 'modules/social/test/a.test.ts')).toBe(true);
    expect(entryAllows(entry, { ...finding, value: 'a@evilshop.test' }, 'modules/social/test/a.test.ts')).toBe(false);
    expect(entryAllows(entry, finding, 'modules/social/src/a.ts')).toBe(false);
    expect(entryAllows({ ...entry, kind: 'mobile' }, finding, 'modules/social/test/a.test.ts')).toBe(false);
    expect(entryAllows({ kind: 'email', paths: ['pnpm-lock.yaml'], reason: 'x' }, finding, 'pnpm-lock.yaml')).toBe(true);
    expect(entryAllows({ kind: 'email', paths: ['pnpm-lock.yaml'], reason: 'x' }, finding, 'sub/pnpm-lock.yaml')).toBe(false);
  });

  it('matches Windows paths, lets a pinned value through only in the allowlist itself, and counts skipped files', () => {
    const other = join2('le.thi.', realLooking(4), '@', 'mail', '.vn');
    const pinned = join2('pinned', '@', 'mail', '.vn');
    const allowlist = [
      { kind: 'email', domains: ['mail.vn'], paths: ['apps/x/test/'], reason: 'a reason that is long enough' },
      { kind: 'email', values: [pinned], paths: ['docs/a.md'], reason: 'a reason that is long enough' },
    ];
    const texts: Record<string, string | null> = {
      'apps\\x\\test\\a.ts': other,
      'tools/ci/pii-scan-allowlist.json': `${pinned} ${other}`,
      'docs/a.md': pinned,
      'docs/b.md': pinned,
      'logo.png': null,
    };
    const { findings, skipped } = scanFiles(Object.keys(texts), (p: string) => texts[p] ?? null, allowlist);
    expect(findings.map((f: { path: string; value: string }) => [f.path, f.value === other ? 'other' : 'pinned'])).toEqual([
      ['tools/ci/pii-scan-allowlist.json', 'other'],
      ['docs/b.md', 'pinned'],
    ]);
    expect(skipped).toBe(1);
  });

  it('escapes the file name in the workflow command', () => {
    expect(commandProperty('a,b:c%d\ne')).toBe('a%2Cb%3Ac%25d%0Ae');
  });

  it('refuses an allowlist entry without a reason, or one that names nothing and so exempts a kind everywhere', () => {
    expect(allowlistErrors({})).toEqual(['the allowlist is not a JSON array']);
    expect(allowlistErrors([
      { kind: 'email', reason: 'a reason that is long enough' },
      { kind: 'email', domains: ['x.vn'], reason: 'short' },
      { kind: 'phone', paths: ['a'], reason: 'a reason that is long enough' },
      { kind: 'mobile', domains: ['x.vn'], reason: 'a reason that is long enough' },
      { kind: 'email', paths: [], reason: 'a reason that is long enough' },
      { kind: 'email', path: 'a', reason: 'a reason that is long enough' },
    ])).toEqual([
      'entry 0: names no paths, domains or values',
      'entry 1: needs a reason',
      'entry 2: kind must be one of cccd, mobile, tax-code, email',
      'entry 3: domains apply to email only',
      'entry 4: paths must be a non-empty list of strings',
      'entry 5: unknown field path',
      'entry 5: names no paths, domains or values',
    ]);
  });

  it('passes on the tree as it is, with a valid allowlist whose every entry is still needed', () => {
    const allowlist = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
    expect(allowlistErrors(allowlist)).toEqual([]);
    const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const { findings, unused } = scanFiles(paths, readText, allowlist);
    expect(findings.map((f) => `${f.path}:${f.line} ${f.kind} ${mask(f.kind, f.value)}`)).toEqual([]);
    expect(unused.map((e: { reason: string }) => e.reason)).toEqual([]);
  });
});
