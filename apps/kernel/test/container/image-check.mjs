// Check of the built kernel image, run by the `kernel-image` CI job inside the image (External-tenant gate T12):
// every kernel module loads without starting anything, the web app is there, and no PDF, XML or MIME parser
// package exists anywhere in the image's node_modules. Usage: node image-check.mjs [app root, default /app]
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? '/app';
// Keep in step with PARSER_PACKAGES in tools/test/parser-imports.test.ts.
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
  'xmldom',
  '@xmldom/xmldom',
  'xml-crypto',
  'libxmljs',
  'libxmljs2',
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

// 2. No parser directory or link in any node_modules outside the store (hoisted or linked), and no crove-extract
// app. Links are checked by name and never followed.
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (dir.endsWith('/node_modules') || dir.endsWith('/node_modules/@xmldom')) {
      const pkg = dir.endsWith('/@xmldom') ? `@xmldom/${entry.name}` : entry.name;
      if (PARSERS.includes(pkg)) failures.push(`parser package in the image: ${path}`);
    }
    if (entry.isDirectory() && entry.name !== '.pnpm') walk(path);
  }
}
walk(root);
if (existsSync(join(root, 'apps/extract'))) failures.push('apps/extract is in the kernel image');
if (!existsSync(join(root, 'apps/app/dist/index.html'))) failures.push('the web app build (apps/app/dist) is missing');

// 3. Every kernel module loads (main.ts starts a role, so it is left to the entry point check).
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

console.log(`checked ${entries.length} store entries and ${modules.length} kernel modules`);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ok: no parser package in the kernel image');
