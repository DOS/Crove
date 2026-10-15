// Dependency rule (External-tenant gate T12): PDF, XML and MIME parsers run only in crove-extract (apps/extract).
// The API, the worker and the modules they load must not import a parser. The e-invoice parser itself lives in
// packages/l10n-vn, which only crove-extract calls. TRANSITIONAL lists the one file still allowed during step 1.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED = ['apps/kernel/src', 'modules', 'packages'];
const PARSER_HOMES = ['packages/l10n-vn/src/', 'apps/extract/'];
// Step 1 of 2: the in-process fallback kept for the invariant suite on main (see legacyInProcess there; #120).
const TRANSITIONAL = ['modules/finance/src/extract.ts'];

const PARSER_IMPORT = /\bfrom\s+['"](fast-xml-parser|unpdf|pdfjs-dist|postal-mime|mailparser|xml2js|sax|@xmldom\/xmldom|xml-crypto)(\/[^'"]*)?['"]|import\(\s*['"](unpdf|pdfjs-dist|postal-mime|fast-xml-parser)['"]\s*\)|\bparseEInvoiceXml\b/;

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

describe('parsers stay in crove-extract', () => {
  it('no API, worker or module source imports a PDF, XML or MIME parser', () => {
    const offenders = SCANNED.flatMap((dir) => sources(join(ROOT, dir)))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'))
      .filter((path) => !PARSER_HOMES.some((home) => path.startsWith(home)))
      .filter((path) => PARSER_IMPORT.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(offenders.filter((path) => !TRANSITIONAL.includes(path))).toEqual([]);
    // The allowance ends with step 2: once it is no longer needed, this fails and the entry must go.
    expect(offenders).toEqual(TRANSITIONAL);
  });

  it('the parsing libraries are dependencies of crove-extract only (and of l10n-vn for the e-invoice parser)', () => {
    const manifests = ['apps/kernel/package.json', 'packages/extract-contract/package.json', 'packages/kernel-runtime/package.json', 'packages/kernel/package.json'];
    for (const manifest of manifests) {
      const { dependencies = {} } = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8')) as { dependencies?: Record<string, string> };
      expect(Object.keys(dependencies).filter((d) => /^(fast-xml-parser|unpdf|pdfjs-dist|postal-mime)$/.test(d)), manifest).toEqual([]);
    }
  });
});
