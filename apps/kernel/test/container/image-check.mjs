// Check of the built kernel image, run by the `kernel-image` CI job inside the image (External-tenant gate T12):
// every kernel module loads without starting anything, the web app is there, no PDF, XML or MIME parser package
// exists anywhere in the image's node_modules nor parser code inside another package (but the reasoned exceptions
// pinned in PINNED, #1740, #1770), no test or tooling file is in it (#1770), and the finance exports write workbooks
// without one (exceljs's XML reader, saxes, is removed at build time and reading a workbook fails, #1719).
// Usage: node image-check.mjs [app root, default /app]
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, join, relative, sep } from 'node:path';
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
// A name, or `@scope/*` for every package of the scope.
const isParser = (name) => PARSERS.some((p) => (p.endsWith('/*') ? name.startsWith(p.slice(0, -1)) && !name.slice(p.length - 1).includes('/') : p === name));

// Parser code no package name shows (#1740), in a package's JavaScript or in the workspace's own code: a parser
// defined under its name (parseXML, class AwsXmlParser, function multipartFormDataParser; parseMIMEType, a
// Content-Type helper, is not one), a DOM parser at work, or the cross-reference lookup of a PDF reader. A tripwire,
// not a proof: a parser under a plain or minified name (class Parser, function parse) passes it, and the name list,
// the dependency rule (tools/test/parser-imports.test.ts) and review stay the main guard. A PDF writer also says
// startxref; one would need its own reasoned exception.
const PARSER_CODE = [
  /\b(?:class|function\*?)\s+(?:\w*(?:xml|sax|pdf|mime|html|multipart|formdata|mail|eml)\w*(?:parser|reader|tokeni[sz]er)|parse_?(?:xml|pdf|mime(?!type)|html|mail|eml|multipart)\w*)\b/i,
  /\b(?:const|let|var)\s+parse_?(?:xml|pdf|mime(?!type)|html|mail|eml|multipart)\w*\s*=/i,
  /^\s*(?:async\s+)?parse_?(?:xml|pdf|mime(?!type)|html|mail|eml|multipart)\w*\s*\([^)]*\)\s*\{/im,
  /\bnew\s+DOMParser\b|\.parseFromString\s*\(/,
  /\bstartxref\b/,
];
// The files whose parser code or inlined module is accepted, each with its reason and pinned by its package's version
// and the sha256 of its content, as read when it was pinned (#1770). A pinned file passes without being searched;
// one whose version or content changed (an upgrade, a patch) fails until someone reads the new file and pins it
// again, so an upgrade cannot slip a new parser into an accepted file. Parser code in any other file fails, in these
// packages too, and so does a pinned file the image no longer holds.
const PINNED = [
  {
    pkg: '@aws-sdk/xml-builder',
    version: '3.972.41',
    reason: "its hand-written parseXML reads only the S3 answers of the operator's own endpoint",
    files: {
      'dist-cjs/index.js': 'ebaa02fe69fb4bf244f2ed10cdbb3ef9c725ab5b39be4b36532a68308804ff81',
      'dist-es/xml-parser.js': '5cf78ee442ca71df8037c69a182be175727362c3591b4007d31768f20b25c25b',
      'dist-es/xml-parser.browser.js': 'f0283367a322119ec2c0ad6df8b66d38074215b7d19cae4a031728c0e70fdc5e',
    },
  },
  {
    pkg: '@aws-sdk/core',
    version: '3.978.3',
    reason: "the S3 client's protocol layer, which hands those answers to @aws-sdk/xml-builder",
    files: {
      'dist-cjs/submodules/protocols/index.js': 'ee36508322ba0dc6829eba7c26b3414bfed0bcd98543564618f8c50a5cb92ece',
      'dist-es/submodules/protocols/xml/parseXmlBody.js': 'f8eb5bdad0a0eefb4a0b6ebdc6b4e1628f48921fcbd0a8e8129c34eeac2511cd',
      'dist-es/submodules/protocols/xml/XmlShapeDeserializer.js': 'ada9587eacc163869f93297839480d6bf0ca8713d1623587ae529e02c8c8c872',
    },
  },
  {
    pkg: 'undici',
    version: '7.30.0',
    reason: "fetch's multipart/form-data reader (Request.formData()), the same one Node ships built in",
    files: { 'lib/web/fetch/formdata-parser.js': 'd5d048201a040865a4376e423fd78b102ad164cb51ad7b0ade56897c7318bd6b' },
  },
  {
    pkg: 'undici',
    version: '7.30.0',
    reason: "llhttp inlined as WebAssembly, the HTTP/1.1 parser undici's fetch runs and Node's own HTTP is built on",
    files: {
      'lib/llhttp/llhttp-wasm.js': '344f7ae80c983694372d9234584a1261ef5492ab219d6e573e933f5d1c715b00',
      'lib/llhttp/llhttp_simd-wasm.js': '52c16227482700834512f2c2257eb44652f39b11f868600562274f476025e4bd',
    },
  },
];
const PINS = new Map(PINNED.flatMap(({ pkg, version, reason, files }) => Object.entries(files).map(([file, sha256]) => [`${pkg}/${file}`, { version, reason, sha256 }])));
const seen = new Set();
// Native and WebAssembly modules, whose code no text check reads (a PDF engine such as mupdf or pdfium ships as
// one), are refused outright, wherever they are and whatever their name: a file that starts with the WebAssembly or
// ELF magic bytes, a .node or .wasm file, or JavaScript holding one in base64 ("\0asm" and "\x7fELF" encode to
// AGFzbQ and f0VMRg). The image holds none but the pinned llhttp builds.
const BINARY_NAME = /\.(?:node|wasm)$/;
const BINARY_MAGIC = [Buffer.from('\0asm', 'latin1'), Buffer.from('\x7fELF', 'latin1')];
const BINARY_INLINE = /AGFzbQ|f0VMRg/;
const head = Buffer.alloc(4);
function isBinary(path) {
  const fd = openSync(path, 'r');
  try {
    const n = readSync(fd, head, 0, 4, 0);
    return n === 4 && BINARY_MAGIC.some((magic) => magic.equals(head));
  } finally {
    closeSync(fd);
  }
}
let scannedFiles = 0;
const failures = [];

// 1. No parser in the virtual store (pnpm names entries <name>@<version>, with "/" in scoped names as "+").
const store = join(root, 'node_modules/.pnpm');
const entries = existsSync(store) ? readdirSync(store) : [];
if (entries.length === 0) failures.push(`no pnpm virtual store at ${store}`);
for (const entry of entries) {
  // The name ends at the "@" of the version (the second "@" for a scoped name); peer suffixes come after it.
  const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0);
  const name = (at > 0 ? entry.slice(0, at) : entry).replace('+', '/');
  if (isParser(name)) failures.push(`parser package in the image: ${entry}`);
}

// 2. No parser directory or link in any node_modules, the store's included: the links each store entry holds to
// its dependencies (<entry>/node_modules/<name>) and pnpm's hidden hoisting (.pnpm/node_modules/<name>). A link
// counts by its name, whether its target exists or not, and is never followed. No crove-extract app either.
// 3. On the way, every JavaScript file of a package (`pkg`: the package the walk is in, { name, dir }) and every
// source file of the workspace's own code is read for PARSER_CODE, and no native or WebAssembly module may be
// anywhere. The web app's build is browser code, which never runs in the kernel, so its text is not read; the
// binary check covers it too. Outside node_modules no test directory or test file may be (#1770).
const WEB_DIST = join(root, 'apps/app/dist');
function walk(dir, scope, pkg, textScan = true) {
  const inNodeModules = basename(dir) === 'node_modules';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (!relative(root, path).split(sep).includes('node_modules')) {
      if (entry.isDirectory() && (entry.name === 'test' || entry.name === 'tests')) failures.push(`a test directory is in the image: ${path}`);
      if (entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name)) failures.push(`a test file is in the image: ${path}`);
    }
    if (entry.isFile()) {
      if (BINARY_NAME.test(entry.name) || isBinary(path)) failures.push(`native or WebAssembly module in the image: ${path}`);
      else if (textScan && (pkg !== undefined ? /\.[cm]?js$/.test(entry.name) : /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name))) scanFile(path, pkg);
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let inside = pkg;
    if (inNodeModules || scope) {
      const name = scope ? `${scope}/${entry.name}` : entry.name;
      if (isParser(name)) failures.push(`parser package in the image: ${path}`);
      inside = name.startsWith('.') || (inNodeModules && name.startsWith('@')) ? undefined : { name, dir: path };
    }
    if (entry.isDirectory()) walk(path, inNodeModules && entry.name.startsWith('@') ? entry.name : undefined, inside, textScan && path !== WEB_DIST);
  }
}
function scanFile(path, pkg) {
  scannedFiles++;
  const bytes = readFileSync(path);
  const key = pkg === undefined ? undefined : `${pkg.name}/${relative(pkg.dir, path).split(sep).join('/')}`;
  const pin = key === undefined ? undefined : PINS.get(key);
  if (pin !== undefined) {
    seen.add(key);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const version = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')).version;
    if (sha256 !== pin.sha256 || version !== pin.version) {
      failures.push(`the pinned file ${key} changed (now ${pkg.name}@${version}, sha256 ${sha256}; pinned ${pin.version}, ${pin.sha256}): read the new file, then pin it again in PINNED`);
    }
    return;
  }
  const code = bytes.toString('utf8');
  if (BINARY_INLINE.test(code)) failures.push(`native or WebAssembly module inlined in the image: ${path}`);
  const match = PARSER_CODE.map((re) => re.exec(code)?.[0]).find((m) => m !== undefined);
  if (match !== undefined) failures.push(`parser code in the image, ${pkg === undefined ? 'outside node_modules' : `in ${pkg.name}`}: ${path} (${match.trim().slice(0, 60)})`);
}
walk(root);
if (scannedFiles === 0) failures.push(`no JavaScript file was read under ${root}`);
for (const key of PINS.keys()) {
  if (!seen.has(key)) failures.push(`the pinned file ${key} is not in the image any more: update PINNED`);
}
// Tests, their fixtures and the repo's tooling stay out of the image (.dockerignore, #1770); only the git hook
// installer the root package's prepare script runs is left of tools/.
if (existsSync(join(root, 'e2e'))) failures.push(`the end-to-end suite is in the image: ${join(root, 'e2e')}`);
const tools = join(root, 'tools');
for (const name of existsSync(tools) ? readdirSync(tools) : []) {
  if (name !== 'install-git-hooks.mjs') failures.push(`tooling is in the image: ${join(tools, name)}`);
}
if (existsSync(join(root, 'apps/extract'))) failures.push('apps/extract is in the kernel image');
if (!existsSync(join(root, 'apps/app/dist/index.html'))) failures.push('the web app build (apps/app/dist) is missing');

// 4. exceljs carries no build that bundles or loads saxes (dist/ holds the browser and ES5 builds). Whether its
// lib/ loads without saxes (the patch) is what steps 5 and 6 show.
const finance = join(root, 'modules/finance');
const requireFromFinance = createRequire(join(finance, 'package.json'));
let exceljsDir = null;
try {
  exceljsDir = join(requireFromFinance.resolve('exceljs/package.json'), '..');
} catch (error) {
  failures.push(`exceljs does not resolve from modules/finance: ${error?.message ?? error}`);
}
if (exceljsDir && existsSync(join(exceljsDir, 'dist'))) failures.push(`exceljs's dist (it bundles saxes) is in the image: ${join(exceljsDir, 'dist')}`);

// 5. Every kernel module loads (main.ts starts a role, so it is left to the entry point check).
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

// 6. The finance exports write workbooks without an XML reader, and reading one fails: saxes cannot be loaded.
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

console.log(`checked ${entries.length} store entries, ${scannedFiles} package files and ${modules.length} kernel modules, wrote 2 workbooks`);
for (const key of seen) console.log(`pinned ${key} (${PINS.get(key).version}): ${PINS.get(key).reason}`);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: no parser package in the kernel image, and the exports write without one');
