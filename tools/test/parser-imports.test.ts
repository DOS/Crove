// Dependency rule (External-tenant gate T12): PDF, XML and MIME parsers run only in crove-extract (apps/extract),
// which also holds the e-invoice parser. The API, the worker and the modules and packages they load must not
// import a parser, must not depend on one, and the kernel image's production dependency tree must not contain one.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  'xmldom',
  '@xmldom/xmldom',
  'xml-crypto',
  'libxmljs',
  'libxmljs2',
];
const PARSER_NAME = new RegExp(`^(${PARSER_PACKAGES.map((p) => p.replace(/[/.]/g, '\\$&')).join('|')})$`);
// Any string literal naming a parser package (or a path inside one) counts, whatever loads it: `import ... from`,
// `export ... from`, a side-effect `import 'x'`, a dynamic `import('x')`, `require('x')`, `require.resolve('x')`
// or a `createRequire(...)('x')`. A false alarm (the name in an ordinary string) is fixed by rewording; a missed
// import is not caught anywhere else. Calling the e-invoice parser by name counts too.
const PARSER_SPECIFIER = PARSER_PACKAGES.map((p) => p.replace(/[/.]/g, '\\$&')).join('|');
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
    ]) {
      expect(PARSER_IMPORT.test(line), line).toBe(true);
    }
    for (const line of [
      "import { z } from 'zod';",
      // exceljs's XML reader and look-alike names are not on the list.
      "import 'saxes';",
      "require('fast-xml-parser-plus');",
      "import { x } from 'my-unpdf';",
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

  it("the kernel image's production dependency tree holds no parsing library", () => {
    const { packages, parsers } = productionTree(join(ROOT, 'apps/kernel'));
    expect(parsers).toEqual([]);
    const names = new Set(packages.values());
    // The walk covers the workspace packages and the libraries they load (a broken walk finds nothing).
    for (const name of ['@crove/kernel-server', '@crove/mod-finance', '@crove/l10n-vn', '@crove/extract-contract', 'pg', 'hono', 'exceljs']) {
      expect(names.has(name), name).toBe(true);
    }
    // crove-extract itself is a devDependency (the database tests start it); it is never in the kernel image.
    expect(names.has('@crove/extract')).toBe(false);
  });

  it('crove-extract does hold the parsers, so the walk would find them', () => {
    const { parsers } = productionTree(join(ROOT, 'apps/extract'));
    // xml-crypto and @xmldom/xmldom verify e-invoice signatures (#674).
    expect(parsers.map((chain) => chain.split(' > ').pop()).sort()).toEqual(['@xmldom/xmldom', 'fast-xml-parser', 'postal-mime', 'unpdf', 'xml-crypto']);
  });
});
