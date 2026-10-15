import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { enterpriseCheckDigit } from '../src/index.ts';

// Plan §8.7: test data is synthetic. A checksum-valid Vietnamese tax code (MST) in a test or fixture file could
// belong to a real business, so every 10-digit code (optionally with a -NNN branch suffix) found under a
// test or fixtures directory must FAIL the MST checksum.
//
// Escape hatch: a test that must use a valid code on purpose (for example to prove the checksum accepts it) puts
// `mst-guard: allow <reason>` on the same line, in a comment. Give the reason, a reviewer reads it. Fixture files
// that cannot hold comments (JSON) cannot use it and must use invalid codes.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCAN_ROOTS = ['packages', 'modules', 'apps'];
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|xml|txt|csv|md|sql|html?|ya?ml)$/;
const ALLOW = /mst-guard:\s*allow\s+\S/;
// 10 digits, optionally "-NNN"; not part of a longer number, id or decimal.
const MST_LIKE = /(?<![\w.-])\d{10}(?:-\d{3})?(?![\w.])/g;

function checksumValid(code: string): boolean {
  const digit = enterpriseCheckDigit(code.slice(0, 9));
  return digit !== null && digit === Number(code[9]);
}

export function findValidTaxCodes(text: string): { line: number; code: string }[] {
  const found: { line: number; code: string }[] = [];
  text.split(/\r?\n/).forEach((content, index) => {
    if (ALLOW.test(content)) return;
    for (const match of content.matchAll(MST_LIKE)) {
      if (checksumValid(match[0])) found.push({ line: index + 1, code: match[0] });
    }
  });
  return found;
}

function* walk(dir: string, underTest: boolean): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path, underTest || entry.name === 'test' || entry.name === 'fixtures');
    } else if (underTest && TEXT_FILE.test(entry.name)) {
      yield path;
    }
  }
}

describe('MST fixture guard', () => {
  it('detects a checksum-valid code, with or without a branch suffix', () => {
    const prefix = '990000001';
    const valid = `${prefix}${enterpriseCheckDigit(prefix)}`;
    const invalid = `${prefix}${(enterpriseCheckDigit(prefix)! + 1) % 10}`;
    expect(findValidTaxCodes(`a ${valid} b\n<MST>${valid}-001</MST>\n${invalid} ${invalid}-002`)).toEqual([
      { line: 1, code: valid },
      { line: 2, code: `${valid}-001` },
    ]);
  });

  it('ignores longer digit runs and honours the allow comment only with a reason', () => {
    const prefix = '990000001';
    const valid = `${prefix}${enterpriseCheckDigit(prefix)}`;
    expect(findValidTaxCodes(`${valid}1 x${valid}`)).toEqual([]);
    expect(findValidTaxCodes(`${valid} // mst-guard: allow proves the checksum accepts it`)).toEqual([]);
    expect(findValidTaxCodes(`${valid} // mst-guard: allow`)).toHaveLength(1);
  });

  it('finds no checksum-valid tax code in any test or fixture file', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const top of SCAN_ROOTS) {
      for (const file of walk(join(ROOT, top), false)) {
        scanned += 1;
        for (const { line, code } of findValidTaxCodes(readFileSync(file, 'utf8'))) {
          offenders.push(`${relative(ROOT, file).split(sep).join('/')}:${line} ${code}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(20);
    expect(offenders, 'checksum-valid MST in test data; use a checksum-invalid synthetic code').toEqual([]);
  });
});
