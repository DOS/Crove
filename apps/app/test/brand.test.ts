// The product name users see comes from one setting, BRAND_NAME (issue #1040): messages and guides say {brand}, and
// the i18n layer fills it in, so no screen hard-codes "Crove".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranslator } from 'use-intl/core';
import { DEFAULT_BRAND, brandCatalog, brandFileName, brandName, setBrandName, withBrand } from '../src/i18n/brand.ts';
import { LOCALES } from '../src/i18n/locale.ts';
import { SOURCE_CATALOGS, catalog, translator } from '../src/i18n/runtime.ts';
import { firmGuide } from '../src/lib/firm-guide.ts';
import { quickGuide } from '../src/lib/quick-guide.ts';

// Messages that may name Crove itself whatever the brand: legal and source notices (the AGPL notice and the link to
// the source code name the project, not the product). Dotted keys; none today.
const ALLOWED_MESSAGES: ReadonlySet<string> = new Set<string>([]);

// Source lines outside the catalogs that may say "Crove": the default name itself. File paths relative to src/.
const ALLOWED_SOURCE: Readonly<Record<string, RegExp>> = {
  'i18n/brand.ts': /^export const DEFAULT_BRAND = 'Crove';$|^type FillBrand</,
};

const src = join(import.meta.dirname, '..', 'src');

function messages(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => messages(value, prefix ? `${prefix}.${key}` : key));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'messages' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

// The code of a line without its comment: a line that is a comment, or the part after ` // `, a JSX comment or a
// one-line block comment. Good enough for this codebase, where comments are whole lines or trail the code.
function code(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return line.replace(/\{\/\*.*?\*\/\}/g, '').replace(/\/\*.*?\*\//g, '').replace(/(^|\s)\/\/\s.*$/, '');
}

describe('brand name (#1040)', () => {
  afterEach(() => setBrandName(undefined));

  it('no message hard-codes "Crove": every one says {brand}', () => {
    for (const locale of LOCALES) {
      const offenders = messages(SOURCE_CATALOGS[locale]).filter(([key, text]) => /\bCrove\b/.test(text) && !ALLOWED_MESSAGES.has(key));
      expect(offenders, locale).toEqual([]);
    }
  });

  it('no screen, guide or helper text in the app source hard-codes "Crove"', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(src)) {
      const name = relative(src, file).replaceAll('\\', '/');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bCrove\b/.test(code(line)) && !ALLOWED_SOURCE[name]?.test(line.trim())) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('fills the configured name into every message and guide, and "Crove" by default', () => {
    expect(brandName()).toBe(DEFAULT_BRAND);
    expect(translator()('common.serverUnreachable')).toContain('Crove');
    setBrandName('Tên Mới');
    expect(brandName()).toBe('Tên Mới');
    // Translators made before the name was set are replaced.
    expect(translator()('common.serverUnreachable')).toContain('Tên Mới');
    for (const locale of LOCALES) {
      const text = messages(catalog(locale))
        .map(([, message]) => message)
        .join('\n');
      expect(text, locale).not.toMatch(/\bCrove\b|\{brand\}/);
      expect(text, locale).toContain('Tên Mới');
    }
    const guides = [...quickGuide(), ...firmGuide()].flatMap((step) => [step.title, ...step.items]).join('\n');
    expect(guides).toContain('Tên Mới');
    expect(guides).not.toMatch(/\bCrove\b|\{brand\}/);
  });

  // #1045: downloaded files are named after the product too, so no message spells a file name with "crove-".
  it('names downloaded files after the brand', () => {
    for (const locale of LOCALES) {
      const offenders = messages(SOURCE_CATALOGS[locale]).filter(([, text]) => /\bcrove-/.test(text));
      expect(offenders, locale).toEqual([]);
    }
    expect(catalog('vi').journal.exportFile).toBe('crove-but-toan-{org}.xlsx');
    setBrandName('Tên Mới');
    expect(catalog('vi').journal.exportFile).toBe('ten-moi-but-toan-{org}.xlsx');
    expect(brandFileName('crove-ke-hoach-2026-10.csv')).toBe('ten-moi-ke-hoach-2026-10.csv');
    expect(brandFileName('chung-tu.pdf')).toBe('chung-tu.pdf');
    expect(withBrand('Tệp {brandSlug}-but-toan.xlsx của {brand}')).toBe('Tệp ten-moi-but-toan.xlsx của Tên Mới');
  });

  it('keeps an apostrophe literal inside ICU messages', () => {
    const messages = brandCatalog({ a: '{brand} đọc {count, plural, other {# tệp}}', b: "{brand}'s {x}" }, "Joe's");
    const t = createTranslator({ locale: 'vi', messages });
    expect(t('a', { count: 2 })).toBe("Joe's đọc 2 tệp");
    expect(t('b', { x: '{y}' })).toBe("Joe's's {y}");
    expect(withBrand('Trong {brand}: {brand}', "Joe's")).toBe("Trong Joe's: Joe's");
  });

  it('ignores a name that is missing, too long or not plain text', () => {
    for (const name of [undefined, null, 42, '', '   ', 'x'.repeat(41), '<b>X</b>', '{brand}', 'A "B"', '-X']) {
      setBrandName('Sổ Xanh');
      setBrandName(name);
      expect(brandName(), String(name)).toBe(DEFAULT_BRAND);
    }
    setBrandName('  Sổ Xanh & Co  ');
    expect(brandName()).toBe('Sổ Xanh & Co');
  });
});
