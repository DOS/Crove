// The landing page names the product Ludy and the AI assistant Vy (#1683): no copy, metadata or component text says
// Crove, the old name, but the places listed below, each waiting for a step of #1682 that is not this one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/content/en';
import { vi } from '../src/content/vi';

// Copy that may say Crove, by its path in the dictionary, with the reason.
const ALLOWED_COPY: Readonly<Record<string, string>> = {
  // The self-host command clones the repository and enters its folder; both keep the name until the owner renames
  // the repository (DOS/Crove to DOS/Ludy, phase 2 of #1682).
  'trust.command': 'repository URL and folder',
};

// Source lines outside the copy that may say Crove, by file under src/, with the reason.
const ALLOWED_SOURCE: Readonly<Record<string, RegExp>> = {
  // The GitHub link's target, not text on the page: the repository keeps its name until phase 2 of #1682.
  'content/site.ts': /^export const GITHUB_URL = 'https:\/\/github\.com\/DOS\/Crove';$/,
};

const src = join(import.meta.dirname, '..', 'src');
// The copy, which the first test reads as data.
const COPY_FILES = new Set(['content/vi.ts', 'content/en.ts']);

function strings(value: unknown, path: string): Array<[path: string, text: string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => strings(item, path ? `${path}.${key}` : key));
  return [];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

// The code of a line without its comment, as in the app's brand test: a whole-line comment, or the part after ` // `,
// a JSX comment or a one-line block comment.
function code(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return line.replace(/\{\/\*.*?\*\/\}/g, '').replace(/\/\*.*?\*\//g, '').replace(/(^|\s)\/\/\s.*$/, '');
}

describe('brand on the landing page (#1683)', () => {
  it('no copy says Crove', () => {
    for (const dict of [vi, en]) {
      const offenders = strings(dict, '').filter(([path, text]) => /\bCrove\b/.test(text) && !(path in ALLOWED_COPY));
      expect(offenders, dict.lang).toEqual([]);
      expect(dict.meta.title, dict.lang).toMatch(/^Ludy: /);
      expect(dict.footer.copyright, dict.lang).toContain('Ludy');
    }
  });

  it('no component, page or style says Crove', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(src)) {
      const name = relative(src, file).replaceAll('\\', '/');
      if (COPY_FILES.has(name)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bCrove\b/.test(code(line)) && !ALLOWED_SOURCE[name]?.test(line.trim())) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every exception in use, so the list does not outlive the copy', () => {
    for (const dict of [vi, en]) {
      const copy = Object.fromEntries(strings(dict, ''));
      for (const path of Object.keys(ALLOWED_COPY)) expect(copy[path], `${dict.lang} ${path}`).toMatch(/\bCrove\b/);
    }
    for (const [name, line] of Object.entries(ALLOWED_SOURCE)) {
      expect(readFileSync(join(src, name), 'utf8').split('\n').some((text) => line.test(text.trim())), name).toBe(true);
    }
  });

  it('presents the AI assistant as Vy in both languages', () => {
    expect(vi.hero.title).toBe('Vy, trợ lý AI, làm việc dưới quyền của bạn.');
    expect(en.hero.title).toBe('Vy, your AI assistant, works under your authority.');
    for (const dict of [vi, en]) {
      expect(dict.trust.title, dict.lang).toMatch(/^Vy /);
      expect(dict.faq.items[1]?.a, dict.lang).toMatch(/\bVy\b/);
      expect(dict.modules.crm.suggest, dict.lang).toMatch(/\bVy\b/);
    }
  });

  it('names the products Ludy Accounting and Ludy CRM', () => {
    expect([vi.modules.finance.name, vi.modules.crm.name]).toEqual(['Ludy Kế toán', 'Ludy CRM']);
    expect([en.modules.finance.name, en.modules.crm.name]).toEqual(['Ludy Accounting', 'Ludy CRM']);
  });
});
