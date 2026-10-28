// Dependency rule (External-tenant gate T12): PDF, XML and MIME parsers run only in crove-extract (apps/extract),
// which also holds the e-invoice parser. The API, the worker and the modules and packages they load must not
// import a parser, must not depend on one, and the kernel image's production dependency tree must not contain one
// but exceljs's saxes, which the image build removes (#1719; the kernel-image CI job checks the built image).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED = ['apps/kernel/src', 'modules', 'packages'];
const PARSER_HOMES = ['apps/extract/'];
// Step 2 done (#120): no file outside crove-extract may parse. Keep this empty.
const TRANSITIONAL: string[] = [];

// Parsers of untrusted documents: XML, PDF and MIME.
const PARSER_PACKAGES = [
  'fast-xml-parser',
  'unpdf',
  'pdfjs-dist',
  'pdf-parse',
  'pdf-lib',
  'postal-mime',
  'mailparser',
  'xml2js',
  'sax',
  'saxes',
  'sax-wasm',
  'xml-js',
  'xml2json',
  'xmldoc',
  'txml',
  'ltx',
  'node-expat',
  'xmlbuilder2',
  'htmlparser2',
  '@rgrove/parse-xml',
  'xmldom',
  '@xmldom/xmldom',
  'xml-crypto',
  'libxmljs',
  'libxmljs2',
  'libxml2-wasm',
  'parse5',
  'cheerio',
  'jsdom',
  'happy-dom',
  'linkedom',
  'node-html-parser',
  '@oozcitak/*',
  'pdf2json',
  'pdfreader',
  'mailsplit',
  '@zone-eu/mailsplit',
  'libmime',
  'libqp',
  'libbase64',
  'emailjs-mime-parser',
];
// A name, or `@scope/*` for every package of a scope (#1740: the @oozcitak family under xmlbuilder2).
const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const pattern = (p: string) => p.split('*').map(escape).join(`[^/'"\`]+`);
const PARSER_NAME = new RegExp(`^(${PARSER_PACKAGES.map(pattern).join('|')})$`);
// Any string literal naming a parser package (or a path inside one) counts, whatever loads it: `import ... from`,
// `export ... from`, a side-effect `import 'x'`, a dynamic `import('x')`, `require('x')`, `require.resolve('x')`
// or a `createRequire(...)('x')`. A false alarm (the name in an ordinary string) is fixed by rewording; a missed
// import is not caught anywhere else. Calling the e-invoice parser by name counts too.
const PARSER_SPECIFIER = PARSER_PACKAGES.map(pattern).join('|');
const PARSER_IMPORT = new RegExp(`(['"\`])(${PARSER_SPECIFIER})(\\/[^'"\`]*)?\\1|\\bparseEInvoiceXml\\b`);

// Workspace packages the kernel image runs; their manifests must not list a parser.
const KERNEL_MANIFESTS = [
  'apps/kernel/package.json',
  'modules/finance/package.json',
  'packages/agent/package.json',
  'packages/db/package.json',
  'packages/extract-contract/package.json',
  'packages/kernel-contract/package.json',
  'packages/kernel-runtime/package.json',
  'packages/kernel/package.json',
  'packages/l10n-vn/package.json',
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;

// Node's lookup: the nearest node_modules/<name> from the package's real directory upwards (pnpm's layout puts a
// package's own dependencies next to it, in the same node_modules).
function locate(fromDir: string, name: string): string | null {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

// Every package a production install of `start` resolves: dependencies and installed optional dependencies, never
// devDependencies (the kernel image is installed with --prod). Returns the chains that end in a parser.
function productionTree(start: string): { packages: Map<string, string>; parsers: string[] } {
  const packages = new Map<string, string>();
  const parsers: string[] = [];
  const queue: Array<{ dir: string; chain: string[] }> = [{ dir: realpathSync(start), chain: [] }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { dir, chain } = queue.shift() as { dir: string; chain: string[] };
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = readManifest(dir);
    const name = manifest.name ?? relative(ROOT, dir);
    packages.set(dir, name);
    const here = [...chain, name];
    if (PARSER_NAME.test(name)) parsers.push(here.join(' > '));
    const deps = { ...manifest.optionalDependencies, ...manifest.dependencies };
    for (const dep of Object.keys(deps)) {
      const found = locate(dir, dep);
      // A missing optional dependency (another platform's binary) is not installed, so it is not in the image.
      if (!found) {
        if (manifest.dependencies?.[dep] !== undefined) throw new Error(`${name} depends on ${dep}, which is not installed`);
        continue;
      }
      queue.push({ dir: found, chain: here });
    }
  }
  return { packages, parsers };
}

describe('parsers stay in crove-extract', () => {
  it('no API, worker, module or package source imports a PDF, XML or MIME parser', () => {
    const offenders = SCANNED.flatMap((dir) => sources(join(ROOT, dir)))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'))
      .filter((path) => !PARSER_HOMES.some((home) => path.startsWith(home)))
      .filter((path) => PARSER_IMPORT.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(TRANSITIONAL).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it('the scan recognizes parser imports', () => {
    for (const line of [
      "import { XMLParser } from 'fast-xml-parser';",
      "import PostalMime from 'postal-mime';",
      "const { extractText } = await import('unpdf');",
      "import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';",
      "import { DOMParser } from '@xmldom/xmldom';",
      'const invoice = parseEInvoiceXml(bytes);',
      // Side-effect, re-export and dynamic imports.
      "import 'postal-mime';",
      'import "fast-xml-parser/src/fxp.js";',
      "export { XMLParser } from 'fast-xml-parser';",
      "export * from 'unpdf';",
      "const pdf = await import( 'unpdf' );",
      'const mod = await import(`pdfjs-dist`);',
      // CommonJS and createRequire.
      "const { XMLParser } = require('fast-xml-parser');",
      'const sax = require("sax");',
      "const where = require.resolve('postal-mime');",
      "const xml2js = createRequire(import.meta.url)('xml2js');",
      "const load = createRequire(import.meta.url);\nconst parser = load('mailparser');",
      // exceljs's XML reader (#1719).
      "import { SaxesParser } from 'saxes';",
      // HTML parsers, the @oozcitak scope and the mailsplit and libmime family (#1740).
      "import { parse } from 'parse5';",
      "const { JSDOM } = require('jsdom');",
      "import { DOMParser } from '@oozcitak/dom';",
      "import '@oozcitak/util/lib/index.js';",
      "import { Splitter } from '@zone-eu/mailsplit';",
      "const libmime = require('libmime');",
      "import PDFParser from 'pdf2json';",
    ]) {
      expect(PARSER_IMPORT.test(line), line).toBe(true);
    }
    expect(PARSER_NAME.test('@oozcitak/infra')).toBe(true);
    expect(PARSER_NAME.test('@oozcitak')).toBe(false);
    expect(PARSER_NAME.test('@oozcitak/dom/x')).toBe(false);
    for (const line of [
      "import { z } from 'zod';",
      // Look-alike names are not on the list.
      "import 'saxes-plus';",
      "require('fast-xml-parser-plus');",
      "import { x } from 'my-unpdf';",
      "import { x } from 'parse5-utils';",
      "import { x } from '@oozcitak-x/dom';",
      '// fast-xml-parser runs only in crove-extract.',
    ]) {
      expect(PARSER_IMPORT.test(line), line).toBe(false);
    }
  });

  it('no manifest of the kernel image lists a parsing library', () => {
    for (const manifest of KERNEL_MANIFESTS) {
      const { dependencies = {}, optionalDependencies = {} } = readManifest(join(ROOT, dirname(manifest)));
      const parsers = Object.keys({ ...dependencies, ...optionalDependencies }).filter((d) => PARSER_NAME.test(d));
      expect(parsers, manifest).toEqual([]);
    }
  });

  it("the kernel image's production dependency tree holds no parsing library but saxes, which the image build removes", () => {
    const { packages, parsers } = productionTree(join(ROOT, 'apps/kernel'));
    // exceljs depends on saxes, its XML reader, and loads it only to read a workbook (patches/exceljs.patch).
    // The workspace keeps it for the tests that read exports back; the kernel image build removes it (#1719).
    expect(parsers.map((chain) => chain.split(' > ').slice(-2).join(' > '))).toEqual(['exceljs > saxes']);
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    for (const pruned of ['node_modules/.pnpm/saxes@*', 'node_modules/.pnpm/node_modules/saxes', 'node_modules/.pnpm/exceljs@*/node_modules/saxes']) {
      expect(dockerfile, pruned).toContain(pruned);
    }
    const names = new Set(packages.values());
    // The walk covers the workspace packages and the libraries they load (a broken walk finds nothing).
    for (const name of ['@crove/kernel-server', '@crove/mod-finance', '@crove/l10n-vn', '@crove/extract-contract', 'pg', 'hono', 'exceljs']) {
      expect(names.has(name), name).toBe(true);
    }
    // crove-extract itself is a devDependency (the database tests start it); it is never in the kernel image.
    expect(names.has('@crove/extract')).toBe(false);
  });

  it('the image check looks for the same parser packages', () => {
    const check = readFileSync(join(ROOT, 'apps/kernel/test/container/image-check.mjs'), 'utf8');
    const list = /const PARSERS = \[([^\]]*)\];/.exec(check)?.[1] ?? '';
    expect([...list.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(PARSER_PACKAGES);
  });

  // Node's module hooks and --input-type; the nightly Bun canary runs this file with Bun as process.execPath.
  it.skipIf('bun' in process.versions)('the finance exports write workbooks with saxes unresolvable, and reading one fails', () => {
    // What the kernel image does once saxes is removed: a resolve hook refuses it, as a missing package would.
    const exportUrl = pathToFileURL(join(ROOT, 'modules/finance/src/export.ts')).href;
    const financeManifest = join(ROOT, 'modules/finance/package.json');
    const script = `
      import { createRequire, registerHooks } from 'node:module';
      registerHooks({
        resolve(specifier, context, next) {
          if (specifier === 'saxes' || specifier.startsWith('saxes/')) {
            throw Object.assign(new Error("Cannot find module '" + specifier + "'"), { code: 'MODULE_NOT_FOUND' });
          }
          return next(specifier, context);
        },
      });
      const { buildJournalWorkbook } = await import(${JSON.stringify(exportUrl)});
      const line = (lineNo, accountCode, debit, credit) => ({ lineNo, accountCode, accountName: accountCode, debit, credit });
      const bytes = await buildJournalWorkbook([{
        id: 'e1', entryDate: '2026-10-01', description: 'no saxes', sourceType: 'manual', sourceId: 'e1',
        lines: [line(1, '6422', '1234567890123456.7891', '0'), line(2, '331', '0', '1234567890123456.7891')],
        reverses: null, reversedBy: null, pendingReversalId: null, document: null,
      }], 'no saxes');
      const ExcelJS = createRequire(${JSON.stringify(financeManifest)})('exceljs');
      let read = 'read';
      try { await new ExcelJS.Workbook().xlsx.load(bytes); } catch (error) { read = error.code + ' ' + error.message; }
      console.log(JSON.stringify({ written: bytes.length, zip: bytes[0] === 0x50 && bytes[1] === 0x4b, read }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: ROOT, encoding: 'utf8' });
    const result = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { written: number; zip: boolean; read: string };
    expect(result.zip).toBe(true);
    expect(result.written).toBeGreaterThan(1000);
    expect(result.read).toMatch(/^MODULE_NOT_FOUND Cannot find module 'saxes'/);
  });

  it('crove-extract does hold the parsers, so the walk would find them', () => {
    const { parsers } = productionTree(join(ROOT, 'apps/extract'));
    // xml-crypto and @xmldom/xmldom verify e-invoice signatures (#674).
    expect(parsers.map((chain) => chain.split(' > ').pop()).sort()).toEqual(['@xmldom/xmldom', 'fast-xml-parser', 'postal-mime', 'unpdf', 'xml-crypto']);
  });
});
