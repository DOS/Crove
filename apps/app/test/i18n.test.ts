// The message catalogs and locale selection (issue #47).
import { createTranslator } from 'use-intl/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, resolveLocale } from '../src/i18n/locale.ts';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { SOURCE_CATALOGS, catalog, translatorFor } from '../src/i18n/runtime.ts';
import { authErrorText, authFailure } from '../src/lib/auth.ts';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

// Argument names ({name}, {count, plural, ...}) and rich text tags (<strong>) a message uses.
function argumentsOf(message: string): string[] {
  const args = [...message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].map((m) => `{${m[1]}}`);
  const tags = [...message.matchAll(/<([A-Za-z]\w*)>/g)].map((m) => `<${m[1]}>`);
  return [...new Set([...args, ...tags])].sort();
}

const catalogs = { vi: flatten(vi), en: flatten(en) };

describe('message catalogs', () => {
  it('has a catalog for every locale', () => {
    expect(Object.keys(SOURCE_CATALOGS).sort()).toEqual([...LOCALES].sort());
  });

  it('vi and en have the same keys', () => {
    expect([...catalogs.en.keys()].sort()).toEqual([...catalogs.vi.keys()].sort());
  });

  it('vi and en use the same arguments and tags in every message', () => {
    for (const [key, message] of catalogs.vi) {
      expect({ key, args: argumentsOf(catalogs.en.get(key) ?? '') }).toEqual({ key, args: argumentsOf(message) });
    }
  });

  it('every message is valid ICU and formats without errors', () => {
    for (const locale of LOCALES) {
      const errors: string[] = [];
      const t = createTranslator({ locale, messages: catalog(locale), onError: (error) => errors.push(`${locale}: ${error.message}`) });
      for (const [key, message] of catalogs[locale]) {
        const values: Record<string, string | number | ((chunks: string[]) => string)> = {};
        for (const arg of argumentsOf(message)) {
          const name = arg.slice(1, -1);
          values[name] = arg.startsWith('<') ? (chunks: string[]) => chunks.join('') : 2;
        }
        const out = (t.markup as (key: string, values: object) => string)(key, values);
        expect(out, `${locale} ${key}`).not.toBe('');
      }
      expect(errors).toEqual([]);
    }
  });

  it('has no empty messages, em dashes or en dashes', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, message] of catalog) {
        expect(message.trim(), `${locale} ${key}`).not.toBe('');
        expect(message, `${locale} ${key}`).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  it('formats plurals in English and keeps Vietnamese uninflected', () => {
    const tEn = createTranslator({ locale: 'en', messages: en });
    const tVi = createTranslator({ locale: 'vi', messages: vi });
    expect(tEn('inbox.failedChecks', { count: 1 })).toBe('1 error');
    expect(tEn('inbox.failedChecks', { count: 3 })).toBe('3 errors');
    expect(tVi('inbox.failedChecks', { count: 3 })).toBe('3 lỗi');
  });
});

describe('resolveLocale', () => {
  it('defaults to Vietnamese', () => {
    expect(DEFAULT_LOCALE).toBe('vi');
    expect(resolveLocale(null)).toBe('vi');
    expect(resolveLocale(undefined, [])).toBe('vi');
    expect(resolveLocale(null, ['fr-FR', 'de'])).toBe('vi');
  });

  it("prefers the user's saved choice", () => {
    expect(resolveLocale('en', ['vi-VN'])).toBe('en');
    expect(resolveLocale('vi', ['en-US'])).toBe('vi');
  });

  it('ignores an unknown saved value and falls back to the first supported browser language', () => {
    expect(resolveLocale('xx', ['fr-FR', 'en-US', 'vi'])).toBe('en');
    expect(resolveLocale(null, ['vi-VN', 'en'])).toBe('vi');
    expect(resolveLocale(null, ['EN-gb'])).toBe('en');
  });
});

// Issue #215: screens keep codes, not words, so a language switch rewords what is already on screen.
describe('auth errors', () => {
  it('keeps the Supabase code and words it at render', () => {
    const failure = authFailure({ code: 'invalid_credentials', message: 'Invalid login credentials' });
    expect(failure).toEqual({ code: 'invalid_credentials' });
    expect(authErrorText(failure, translatorFor('vi'))).toBe('Email hoặc mật khẩu không đúng');
    expect(authErrorText(failure, translatorFor('en'))).toBe(en.auth.errors.invalid_credentials);
  });

  it('keeps the server message for other codes', () => {
    const failure = authFailure({ code: 'unexpected_failure', message: 'Database error' });
    expect(authErrorText(failure, translatorFor('en'))).toBe('Database error');
  });
});
