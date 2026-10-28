// Check of the built kernel image, run by the `kernel-image` CI job inside the image (External-tenant gate T12):
// every kernel module loads without starting anything, the web app is there, no PDF, XML or MIME parser package
// exists anywhere in the image's node_modules, and the finance exports write workbooks without one (exceljs's XML
// reader, saxes, is removed at build time and reading a workbook fails, #1719).
// Usage: node image-check.mjs [app root, default /app]
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? '/app';
// Keep in step with PARSER_PACKAGES in tools/test/parser-imports.test.ts (a unit test compares the two lists).
const PARSERS = [
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
];
const failures = [];

// 1. No parser in the virtual store (pnpm names entries <name>@<version>, with "/" in scoped names as "+").
const store = join(root, 'node_modules/.pnpm');
const entries = existsSync(store) ? readdirSync(store) : [];
if (entries.length === 0) failures.push(`no pnpm virtual store at ${store}`);
for (const entry of entries) {
  // The name ends at the "@" of the version (the second "@" for a scoped name); peer suffixes come after it.
  const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0);
  const name = (at > 0 ? entry.slice(0, at) : entry).replace('+', '/');
  if (PARSERS.includes(name)) failures.push(`parser package in the image: ${entry}`);
}

// 2. No parser directory or link in any node_modules, the store's included: the links each store entry holds to
// its dependencies (<entry>/node_modules/<name>) and pnpm's hidden hoisting (.pnpm/node_modules/<name>). A link
// counts by its name, whether its target exists or not, and is never followed. No crove-extract app either.
function walk(dir, scope) {
  const inNodeModules = basename(dir) === 'node_modules';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (inNodeModules || scope) {
      const pkg = scope ? `${scope}/${entry.name}` : entry.name;
      if (PARSERS.includes(pkg)) failures.push(`parser package in the image: ${path}`);
    }
    if (entry.isDirectory()) walk(path, inNodeModules && entry.name.startsWith('@') ? entry.name : undefined);
  }
}
walk(root);
if (existsSync(join(root, 'apps/extract'))) failures.push('apps/extract is in the kernel image');
if (!existsSync(join(root, 'apps/app/dist/index.html'))) failures.push('the web app build (apps/app/dist) is missing');

// 3. exceljs carries no build that bundles or loads saxes (dist/ holds the browser and ES5 builds). Whether its
// lib/ loads without saxes (the patch) is what steps 4 and 5 show.
const finance = join(root, 'modules/finance');
const requireFromFinance = createRequire(join(finance, 'package.json'));
let exceljsDir = null;
try {
  exceljsDir = join(requireFromFinance.resolve('exceljs/package.json'), '..');
} catch (error) {
  failures.push(`exceljs does not resolve from modules/finance: ${error?.message ?? error}`);
}
if (exceljsDir && existsSync(join(exceljsDir, 'dist'))) failures.push(`exceljs's dist (it bundles saxes) is in the image: ${join(exceljsDir, 'dist')}`);

// 4. Every kernel module loads (main.ts starts a role, so it is left to the entry point check).
const src = join(root, 'apps/kernel/src');
const modules = existsSync(src) ? readdirSync(src).filter((f) => f.endsWith('.ts') && f !== 'main.ts') : [];
if (modules.length === 0) failures.push(`no kernel modules at ${src}`);
for (const file of modules) {
  try {
    await import(pathToFileURL(join(src, file)).href);
  } catch (error) {
    failures.push(`kernel module ${file} does not load: ${error?.code ?? ''} ${error?.message ?? error}`);
  }
}

// 5. The finance exports write workbooks without an XML reader, and reading one fails: saxes cannot be loaded.
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04];
try {
  const { buildJournalWorkbook } = await import(pathToFileURL(join(finance, 'src/export.ts')).href);
  const { buildMisaWorkbook, cashRows, MISA_SME_CASH_RECEIPT } = await import(pathToFileURL(join(finance, 'src/misa.ts')).href);
  const journal = await buildJournalWorkbook(
    [
      {
        id: 'e1',
        entryDate: '2026-10-01',
        description: 'Image check',
        sourceType: 'manual',
        sourceId: 'e1',
        lines: [
          { lineNo: 1, accountCode: '6422', accountName: 'Expense', debit: '1234567890123456.7891', credit: '0' },
          { lineNo: 2, accountCode: '331', accountName: 'Payable', debit: '0', credit: '1234567890123456.7891' },
        ],
        reverses: null,
        reversedBy: null,
        pendingReversalId: null,
        document: null,
      },
    ],
    'image check',
  );
  const voucher = {
    type: 'cash_receipt',
    code: 'PT00001',
    date: '2026-10-01',
    cashAccount: '1111',
    party: null,
    personName: null,
    description: 'Image check',
    lines: [{ lineNo: 1, account: '5111', amount: '1000000', memo: null }],
  };
  const misa = await buildMisaWorkbook(MISA_SME_CASH_RECEIPT, cashRows(voucher));
  for (const [name, bytes] of [
    ['journal', journal],
    ['MISA cash receipt', misa],
  ]) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1000 || !XLSX_MAGIC.every((b, i) => bytes[i] === b)) {
      failures.push(`the ${name} export did not write an xlsx file`);
    }
  }
  const ExcelJS = requireFromFinance('exceljs');
  try {
    await new ExcelJS.Workbook().xlsx.load(journal);
    failures.push('exceljs read a workbook in the kernel image: an XML reader is reachable');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND' || !error?.message?.includes("'saxes'")) {
      failures.push(`reading a workbook failed, but not for want of saxes: ${error?.code ?? ''} ${error?.message ?? error}`);
    }
  }
} catch (error) {
  failures.push(`the finance exports do not write a workbook: ${error?.code ?? ''} ${error?.message ?? error}`);
}

console.log(`checked ${entries.length} store entries and ${modules.length} kernel modules, wrote 2 workbooks`);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: no parser package in the kernel image, and the exports write without one');
