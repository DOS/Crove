// Invariant suite (Decision 7): what commands declare they write (CommandDef.writes, plan §4.7 "Derived risk", #1697,
// #1710). P04 flags an agent's proposal of a command that writes a `contact` or `payment` column, refuses agent access
// to such a command, and lets agents approve only proposals of commands declared free of them. Those answers rest on
// the declared writes and on the manifests' column classes, so this file holds both: the runtime, given the
// manifests, refuses a declaration whose classes are not its manifest's (a hand-built map, a '*' column) and keeps its
// own frozen copy of every definition it registers; the server builds its one runtime with the manifests (no other
// way to reach the Runtime class is in server code), which are frozen plain data; every command the server registers declares writes
// that match the manifests, every command an agent may run declares its writes (the runtime refuses one that does
// not) and none is a contact or payment column; no proposal command escapes P04 unless it is listed here; and no
// contact or payment column of the manifests is reclassified away. No database needed. Keep this file
// self-contained: import package code under test, never helpers from outside test/invariant/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CellResolver } from '@crove/db';
import { kernelManifest } from '@crove/kernel';
import { DATA_CLASSES, defineModule, tableWrite, type ModuleManifest } from '@crove/kernel-contract';
import { Runtime, WRITE_DATA_CLASSES, defineCommand, type AgentApprovers, type CommandDef, type CommandWrite, type ManifestTables } from '@crove/kernel-runtime';
import { financeManifest } from '@crove/mod-finance';
import { loadConfig } from '../../src/config.ts';
import { moduleDefinitions, moduleManifests, serverRuntime } from '../../src/kernel.ts';
import { orgPurgeCommand } from '../../src/org-purge.ts';
import { numberReseedCommand } from '../../src/restore-report.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const noDatabase = (): never => {
  throw new Error('no database in this test');
};
const cells: CellResolver = { resolveTenant: async () => noDatabase(), controlPlane: () => noDatabase() };

// Every module on, as the server runs when CROVE_MODULES is unset.
const CONFIG_ENV = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };
const config = loadConfig(CONFIG_ENV);
const manifests = (): ManifestTables[] => moduleManifests(config).map((m) => m.tables);
const shipped = (): Array<CommandDef<unknown, unknown>> =>
  [...moduleDefinitions(config).commands, orgPurgeCommand({ store: {} as never }), numberReseedCommand()] as Array<CommandDef<unknown, unknown>>;

// The server's own sources: the kernel app and every package and module it loads (the runtime package aside, which
// defines Runtime). Comments are scanned too: a comment that trips a rule below is reworded.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : SOURCE_FILE.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
const serverSources = (): Array<{ file: string; text: string }> =>
  [
    'apps/kernel/src',
    ...['packages', 'modules'].flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((name) => name !== 'kernel-runtime' && statSync(join(ROOT, dir, name, 'src'), { throwIfNoEntry: false })?.isDirectory())
        .map((name) => `${dir}/${name}/src`),
    ),
  ].flatMap((dir) => sourceFiles(join(ROOT, dir)).map((path) => ({ file: relative(ROOT, path).split(sep).join('/'), text: readFileSync(path, 'utf8').replace(/\r\n/g, '\n') })));

// The source with comments blanked out (newlines kept) and strings left as they are, so prose in a comment ("an
// import (#465)") is not read as code. A small scanner: it follows string and template literals (and the code inside
// `${...}`) and regular expression literals (a `/` where an expression starts), so a quote or backtick inside a
// regular expression does not throw it off; the raw text is checked for the plain forms as well.
const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await))\s*$/;
function stripComments(source: string): string {
  let out = '';
  // Open template literals and, inside each `${`, the depth of braces since it opened.
  const stack: Array<'template' | number> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    const top = stack.at(-1);
    if (top === 'template') {
      if (ch === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
      } else if (ch === '`') {
        stack.pop();
        out += ch;
        i += 1;
      } else if (ch === '$' && next === '{') {
        stack.push(0);
        out += '${';
        i += 2;
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '/' && REGEX_BEFORE.test(out.slice(-24))) {
      // A regular expression literal: up to the `/` that closes it outside a character class, on the same line.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j += 1;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j += 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '`') stack.push('template');
    else if (typeof top === 'number' && ch === '{') stack[stack.length - 1] = top + 1;
    else if (typeof top === 'number' && ch === '}') {
      if (top === 0) stack.pop();
      else stack[stack.length - 1] = top - 1;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Node modules that run code past the import graph (a child process, a thread, the inspector, a REPL, a cluster
// worker), by the server source that may import them and why (#1824). None does today.
const PROCESS_MODULES_ALLOWED: Readonly<Record<string, readonly string[]>> = {};

// The names a file imports the Runtime class under as a value (an alias too), and what it does that could reach the
// class some other way: import the runtime package whole, re-export from it, import a module whose name is computed.
function runtimeImports(raw: string, file = '', allowed: Readonly<Record<string, readonly string[]>> = PROCESS_MODULES_ALLOWED): { names: string[]; problems: string[] } {
  const text = stripComments(raw);
  const names: string[] = [];
  const problems: string[] = [];
  for (const m of text.matchAll(/\b(import|export)\b([^;]*?)\bfrom\s*(['"`])([^'"`]*)\3/g)) {
    const [, verb, clause = '', , specifier = ''] = m;
    const fromRuntime = specifier.includes('kernel-runtime');
    const cleaned = clause.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').trim();
    if (/^type\b/.test(cleaned)) continue;
    const braces = cleaned.match(/\{([\s\S]*)\}/);
    if (fromRuntime) {
      if (cleaned.includes('*')) problems.push(`${verb} * from ${specifier}`);
      const outside = braces ? cleaned.replace(braces[0], '').replace(/,/g, ' ').trim() : cleaned;
      if (verb === 'import' && outside.length > 0) problems.push(`a default import from ${specifier}`);
    }
    for (const spec of (braces?.[1] ?? '').split(',')) {
      const part = spec.trim();
      if (part.length === 0 || /^type\b/.test(part)) continue;
      const [name, alias] = part.split(/\s+as\s+/);
      // An import name may be written as a string: import { 'Runtime' as R }.
      if (name?.trim().replace(/^(['"])(.*)\1$/, '$2') !== 'Runtime') continue;
      if (verb === 'export') problems.push(`re-exports Runtime from ${specifier}`);
      // From any other module, Runtime can only be the class passed on (kernel.ts exporting it, say).
      else if (!fromRuntime) problems.push(`imports Runtime from ${specifier}`);
      else names.push((alias ?? name).trim());
    }
  }
  // A local export of the class: export { Runtime } or export default Runtime.
  if (/\bexport\s*\{[^}]*\bRuntime\b[^}]*\}(?!\s*from)|\bexport\s+default\s+Runtime\b/.test(text)) problems.push('exports Runtime');
  if (/\bimport\s*\(/.test(text) || /\bimport\(/.test(raw)) problems.push('a dynamic import()');
  if (/\brequire\s*\(/.test(text) || /\brequire\(/.test(raw)) problems.push('require()');
  if (/createRequire\((?!import\.meta\.url\)\.resolve\()/.test(raw)) problems.push('createRequire() used for more than resolve()');
  // Ways to construct a class held in a value rather than by its name: from an instance (`.constructor`, the
  // `'constructor'` key, destructuring it), by reflection, by a subclass. None is needed in server code; a class's own
  // `constructor(` stays allowed.
  if (/\.[ \t]*constructor\b|['"`]constructor['"`]|\bconstructor\s*:|\{[^{}]*\bconstructor\b[^{}]*\}\s*=[^=>]|Reflect[ \t]*\.[ \t]*construct\b|\bextends\s+Runtime\b/.test(text)) {
    problems.push('reaches a class through its constructor, Reflect.construct or a Runtime subclass');
  }
  // Code built from strings, and an object made over another (a shadow of a runtime); Object.create(null) stays allowed.
  if (/\beval\s*\(|\bFunction\s*\(|\bObject\s*\.\s*create\s*\((?!\s*null\s*\))/.test(text)) problems.push('eval, Function or Object.create over an object');
  // Loading code past the import graph (#1772): Node's module loader and its builtins by name, the vm module, and every
  // descriptor of an object at once (a prototype's constructor among them).
  if (/\bgetBuiltinModule\b|\b_load\b|\bModule\s*\.\s*prototype\b|\bgetOwnPropertyDescriptors\b/.test(text)) {
    problems.push('the module loader, a builtin by name or every descriptor of an object');
  }
  for (const m of text.matchAll(/\b(?:import|export)\b([^;]*?)\bfrom\s*['"`](?:node:)?(vm|module)['"`]/g)) {
    // node:module only for createRequire, which the scan above holds to resolve().
    if (m[2] === 'vm' || !/^\s*\{\s*createRequire\s*\}\s*$/.test(m[1] ?? '')) problems.push(`imports ${m[2]}`);
  }
  if (/\bvm\s*\./.test(text)) problems.push('the vm module');
  // A property of process, globalThis or Module named at run time (#1824): `process['getBuiltin' + 'Module']` or
  // `Module['_lo' + 'ad']` reach what the name checks above refuse. So process and globalThis appear only before a
  // `.name` (or as an object key): not bracketed, parenthesized, cast, spread, copied, iterated or passed on, and
  // process not reached through globalThis or global; Module not bracketed either, Reflect.get or a descriptor of it,
  // or a computed key destructured from it. `process.env[name]` stays allowed. Out of reach of a text scan: the
  // legacy alias `global` (a local of that name exists), and a value aliased through a parameter or a closure.
  if (
    // Not after a member dot (`job.process`), but after a spread (`...process`).
    /(?<![\w$])(?<![^.]\.)(?<!^\.)(?:process|globalThis)\b(?!\s*\??\.\s*[\w$]|\s*\??:)/m.test(text) ||
    /\b(?:globalThis|global)\s*\??\.\s*process\b/.test(text) ||
    /(?<![\w$.])Module\s*(?:\?\.\s*)?\[/.test(text) ||
    /\b(?:Reflect\s*\.\s*get|Object\s*\.\s*getOwnPropertyDescriptor)\s*\(\s*(?:process|globalThis|Module)\b/.test(text) ||
    /\{[^{}]*\[[^{}]*\}\s*=\s*(?:process|globalThis|Module)\b/.test(text)
  ) {
    problems.push('a computed property of process, globalThis or Module');
  }
  // Node's internal bindings and native addons load code by name: process.binding('contextify') compiles a string,
  // process.binding('spawn_sync') spawns a process (#1824 review).
  if (/\bprocess\s*\??\.\s*(?:binding|_linkedBinding|dlopen)\b/.test(text)) problems.push("process's internal bindings or a native addon");
  for (const m of text.matchAll(/\b(?:(?:import|export)\b[^;]*?\bfrom|import)\s*['"`](?:node:)?(worker_threads|child_process|inspector|repl|cluster)(?:\/[\w/]*)?['"`]/g)) {
    const name = m[1] ?? '';
    if (!(allowed[file] ?? []).includes(name)) problems.push(`imports ${name}`);
  }
  // A database handle without ctx.trx's plugins, or a query compiled past them (Kysely runs a CompiledQuery without
  // transformQuery): its statements would escape the declared-writes count and the transaction-control guard (#1831).
  // The worker's relay runs pg-boss's own SQL on its own transaction, not a handler's.
  if (/\b(?:withoutPlugins|getExecutor)\b/.test(text)) problems.push("a handle past ctx.trx's plugins");
  // A plugin of the handler's own would run after the runtime's and could rewrite the checked query (#1831 review).
  if (/\bwithPlugin\b/.test(text)) problems.push('a plugin of its own on ctx.trx');
  if (/\bexecuteQuery\b|\bCompiledQuery\b/.test(text) && file !== 'apps/kernel/src/worker.ts') problems.push('a query compiled past the plugins');
  return { names, problems };
}

// Proposal commands an agent's proposal of which is not flagged P04: their declared writes name no contact or payment
// column. None yet. Adding one is a review of its declaration and of the handlers of the events it emits (#1710): land
// the name here first, then the declaration.
const PROPOSALS_WITHOUT_P04: readonly string[] = [];

// The contact and payment columns of the manifests (plan §4.7, §5.2). A manifest may add more; reclassifying one of
// these, or dropping it while its table stays, would take P04 off every command that writes it.
const P04_COLUMNS: Readonly<Record<string, 'contact' | 'payment'>> = {
  'crove_kernel.inbound_message.from_address': 'contact',
  'crove_kernel.mail_message.to_address': 'contact',
  'crove_kernel.member_invite.email': 'contact',
  'crove_kernel.party.address': 'contact',
  'crove_kernel.party.email': 'contact',
  'crove_kernel.party.phone': 'contact',
  'crove_kernel.tenant.address': 'contact',
  'crove_kernel.tenant.contact_email': 'contact',
  'crove_finance.bank_line.bank_account': 'payment',
  'crove_social.report_schedule.recipients': 'contact',
  'crove_crm.booking.email': 'contact',
  'crove_crm.booking.phone': 'contact',
};

const PARTY = kernelManifest.tables.crove_kernel.party;
const CONTACT = tableWrite(kernelManifest.tables, 'crove_kernel', 'party', ['email']);
const PAYMENT = tableWrite(financeManifest.tables, 'crove_finance', 'bank_line', ['bank_account']);
const INTERNAL = tableWrite(kernelManifest.tables, 'crove_kernel', 'task_comment', ['body']);

const def = (extra: Partial<CommandDef<unknown, unknown>>): CommandDef<unknown, unknown> =>
  defineCommand({ sideEffect: 'none', name: 't1710.reg', input: z.object({}), risk: 'R1', access: 'proposal', handler: async () => ({}), ...extra }) as CommandDef<unknown, unknown>;
const withManifests = (extra: Partial<CommandDef<unknown, unknown>>) => () => new Runtime(cells, { manifests: manifests() }).register({ commands: [def(extra)] });
const forged = (classes: Record<string, string>, columns: readonly string[] = ['email']): CommandWrite => ({ table: 'crove_kernel.party', classes, columns });

describe('declared command writes against the manifests (#1697, #1710)', () => {
  it('knows the data classes the manifests use', () => {
    expect([...WRITE_DATA_CLASSES]).toEqual([...DATA_CLASSES]);
  });

  it('refuses, given the manifests, a declaration whose classes are not its manifest', () => {
    // The contact column passed off as internal, so the command would look free of P04.
    expect(withManifests({ writes: [forged({ ...PARTY, email: 'internal' })], agentApprovers: { roles: ['finance.chief_accountant'] } })).toThrow(
      /not its manifest's/,
    );
    expect(withManifests({ access: [], agent: { roles: 'any' }, writes: [forged({ ...PARTY, email: 'internal' })] })).toThrow(/not its manifest's/);
    // Only the columns it writes, a column the table does not have, or one left out.
    expect(withManifests({ writes: [forged({ email: 'internal' })] })).toThrow(/not its manifest's/);
    expect(withManifests({ writes: [forged({ ...PARTY, nickname: 'internal' })] })).toThrow(/not its manifest's/);
    const { email: _email, ...withoutEmail } = PARTY;
    expect(withManifests({ writes: [forged(withoutEmail, ['name'])] })).toThrow(/not its manifest's/);
    // A table no manifest has.
    expect(withManifests({ writes: [{ table: 'crove_kernel.no_such_table', classes: { body: 'internal' }, columns: ['body'] }] })).toThrow(/no module manifest has/);
    // What the manifests give passes, and P04 follows their classes.
    expect(withManifests({ writes: [CONTACT, PAYMENT, INTERNAL] })).not.toThrow();
    const runtime = new Runtime(cells, { manifests: manifests() }).register({
      commands: [def({ name: 't1710.contact', writes: [INTERNAL, CONTACT] }), def({ name: 't1710.clean', writes: [INTERNAL] })],
    });
    expect(runtime.commandInfo('t1710.contact')?.contactOrPayment).toBe(true);
    expect(runtime.commandInfo('t1710.clean')?.contactOrPayment).toBe(false);
  });

  it('refuses a pattern for a column', () => {
    expect(withManifests({ writes: [forged({ '*': 'internal' }, ['*'])] })).toThrow(/not a column name/);
    expect(withManifests({ writes: [forged({ ...PARTY, '*': 'internal' })] })).toThrow(/not a column name/);
  });

  it('reads the classes once, so a getter cannot answer the checks one class and P04 another', () => {
    let reads = 0;
    const classes = { ...PARTY };
    Object.defineProperty(classes, 'email', { enumerable: true, get: () => (reads++ === 0 ? 'contact' : 'internal') });
    const runtime = new Runtime(cells, { manifests: manifests() }).register({ commands: [def({ writes: [forged(classes)] })] });
    expect(runtime.commandInfo('t1710.reg')?.contactOrPayment).toBe(true);
  });

  it('builds no runtime without the manifests, and registers no command without a side effect (#1772, #1637)', () => {
    // Whatever path builds a runtime (the server's serverRuntime() or any other), it checks declared writes against
    // the manifests; a runtime whose commands declare none takes an empty list.
    expect(() => new (Runtime as unknown as new (c: CellResolver) => Runtime)(cells)).toThrow(/RuntimeOptions\.manifests/);
    expect(() => new Runtime(cells, {} as never)).toThrow(/RuntimeOptions\.manifests/);
    expect(() => new Runtime(cells, { manifests: null } as never)).toThrow(/RuntimeOptions\.manifests/);
    expect(() => new Runtime(cells, { manifests: [] }).register({ commands: [def({ name: 't1772.writes', writes: [INTERNAL] })] })).toThrow(/no module manifest has/);
    expect(() => new Runtime(cells, { manifests: [] }).register({ commands: [def({ name: 't1772.reads' })] })).not.toThrow();
    // Every command says what it does beyond its transaction.
    const { sideEffect: _sideEffect, ...without } = def({ name: 't1637.none' });
    expect(() => new Runtime(cells, { manifests: [] }).register({ commands: [without as CommandDef<unknown, unknown>] })).toThrow(/declares no side effect/);
    expect(() => new Runtime(cells, { manifests: [] }).register({ commands: [def({ name: 't1637.bad', sideEffect: 'some' as never })] })).toThrow(/declares no side effect or an unknown one/);
    expect(() => new Runtime(cells, { manifests: [] }).register({ commands: [def({ name: 't1637.low', risk: 'R1', sideEffect: 'external' })] })).toThrow(/below R2/);
  });

  it('refuses manifests that give one table twice', () => {
    expect(() => new Runtime(cells, { manifests: [kernelManifest.tables, kernelManifest.tables] })).toThrow(/in two manifests/);
    expect(() => new Runtime(cells, { manifests: [{ crove_kernel: { party: { email: 'secret' } } }] })).toThrow(/unknown class/);
  });

  it('gives the server every enabled module its own manifest', () => {
    expect(config.CROVE_MODULES.length).toBeGreaterThan(1);
    expect(moduleManifests(config).map((m) => m.id)).toEqual([...config.CROVE_MODULES]);
  });

  it('builds the server runtime with the manifests, for every set of enabled modules', () => {
    const forgedCommand = def({ name: 'kernel.t1710_forged', writes: [forged({ ...PARTY, email: 'internal' })] });
    for (const modules of [undefined, 'finance', 'crm', 'notes', 'social']) {
      const runtime = serverRuntime(cells, loadConfig({ ...CONFIG_ENV, ...(modules ? { CROVE_MODULES: modules } : {}) }), {});
      // Registered on it later, as createKernel registers the org purge, a forged write is refused too.
      expect(() => runtime.register({ commands: [forgedCommand] }), String(modules)).toThrow(/not its manifest's/);
    }
  });

  it('constructs a runtime in the server only through serverRuntime()', () => {
    const sources = serverSources();
    expect(sources.some((s) => s.file === 'apps/kernel/src/kernel.ts')).toBe(true);
    expect(sources.some((s) => s.file.startsWith('modules/'))).toBe(true);
    const problems: string[] = [];
    const importers: Array<{ file: string; names: string[]; text: string }> = [];
    for (const { file, text } of sources) {
      const found = runtimeImports(text, file);
      for (const problem of found.problems) problems.push(`${file}: ${problem}`);
      if (found.names.length > 0) importers.push({ file, names: found.names, text });
    }
    expect(problems).toEqual([]);
    // As before #1766: no source but kernel.ts writes `new Runtime`.
    expect(sources.filter((s) => /\bnew\s+Runtime\b/.test(s.text)).map((s) => s.file)).toEqual(['apps/kernel/src/kernel.ts']);
    // Only kernel.ts holds the class as a value, under its own name, and uses it only in serverRuntime(): with its
    // import from the runtime package and that function taken out (comments blanked), the name appears nowhere else,
    // so it is not re-exported, passed on or stored.
    expect(importers.map((i) => [i.file, i.names])).toEqual([['apps/kernel/src/kernel.ts', ['Runtime']]]);
    const kernel = stripComments(importers[0]?.text ?? '');
    const start = kernel.indexOf('export function serverRuntime(');
    const end = kernel.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(kernel.slice(start, end)).toMatch(/new Runtime\(/);
    const runtimeImport = [...kernel.matchAll(/\bimport\b[^;]*?\bfrom\s*'@crove\/kernel-runtime';/g)];
    expect(runtimeImport).toHaveLength(1);
    const outside = [kernel.slice(0, runtimeImport[0]?.index), kernel.slice((runtimeImport[0]?.index ?? 0) + (runtimeImport[0]?.[0].length ?? 0), start), kernel.slice(end)]
      .join('\n')
      .split('\n')
      .filter((line) => /\bRuntime\b/.test(line));
    expect(outside).toEqual([]);
  });

  it('finds every way the scan names to reach the Runtime class, and nothing in comments', () => {
    const scan = (source: string) => runtimeImports(source);
    expect(scan(`import { DomainError, type Runtime } from '@crove/kernel-runtime';`)).toEqual({ names: [], problems: [] });
    expect(scan(`import type { Runtime } from '@crove/kernel-runtime';`)).toEqual({ names: [], problems: [] });
    expect(scan(`// an import (#465) of a .constructor, Reflect.construct\nconst a = 1;`)).toEqual({ names: [], problems: [] });
    expect(scan(`class A {\n  constructor(a: string) {}\n}`)).toEqual({ names: [], problems: [] });
    expect(scan('const out = Object.create(null) as Record<string, unknown>;')).toEqual({ names: [], problems: [] });
    expect(scan(`import { createRequire } from 'node:module';\nconst p = createRequire(import.meta.url).resolve('x');`)).toEqual({ names: [], problems: [] });
    expect(scan('const d = Object.getOwnPropertyDescriptor(value, key);')).toEqual({ names: [], problems: [] });
    // A quote or backtick in a regular expression does not hide the code after it.
    expect(scan("const re = /[`'*]/g;\nconst k = require('x');").problems).toEqual(['require()']);
    expect(scan(`import { 'Runtime' as R } from '@crove/kernel-runtime';`).names).toEqual(['R']);
    expect(scan(`import { Runtime } from '@crove/kernel-runtime';`).names).toEqual(['Runtime']);
    expect(scan(`import {\n  DomainError,\n  Runtime as R, // the class\n} from '@crove/kernel-runtime';`).names).toEqual(['R']);
    expect(scan(`import { Runtime as R } from '../../packages/kernel-runtime/src/runtime.ts';`).names).toEqual(['R']);
    for (const source of [
      `import * as K from '@crove/kernel-runtime';`,
      `export * from '@crove/kernel-runtime';`,
      `export { Runtime } from '@crove/kernel-runtime';`,
      `import K from '@crove/kernel-runtime';`,
      `const k = await import('@crove/kernel-runtime');`,
      'const k = await import (name);',
      `const k = require('@crove/kernel-runtime');`,
      `const r = createRequire(import.meta.url);`,
      'const R = runtime.constructor;',
      `const R = Object.getPrototypeOf(runtime)['constructor'];`,
      'const r = Reflect.construct(Cls, [cells]);',
      'class Mine extends Runtime {}',
      'const { constructor: C } = runtime;',
      'const { constructor } = runtime;',
      `const C = Reflect.get(Object.getPrototypeOf(runtime), 'constructor');`,
      'const shadow = Object.create(runtime);',
      `const f = new Function('return 1');`,
      'eval(code);',
      // The module loader and code built past the import graph (#1772).
      `const mod = process.getBuiltinModule('module');`,
      `const k = Module._load('@crove/kernel-runtime');`,
      `const r = Module.prototype.require.call(m, 'x');`,
      'const all = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(runtime));',
      `import vm from 'node:vm';`,
      `import { runInThisContext } from 'vm';`,
      `import { Module } from 'node:module';`,
      `const v = vm.runInThisContext(code);`,
      // Past the counting plugin of ctx.trx (#1831).
      'await ctx.trx.withoutPlugins().insertInto(table).values(row).execute();',
      'const executor = ctx.trx.getExecutor();',
      `const g = ctx.trx['withoutPlugins'];`,
      'const { getExecutor } = ctx.trx;',
      `await ctx.trx.executeQuery(CompiledQuery.raw('COMMIT'));`,
      'await sql`SELECT 1`.execute(ctx.trx.withPlugin(rewrite));',
      // The class passed on through another module (#1771 review): kernel.ts exporting it, another file importing it.
      'export {\n  Runtime,\n};',
      'export default Runtime;',
      `import { Runtime } from './kernel.ts';`,
      `import { Runtime as R } from './kernel.ts';`,
      // A property of process, globalThis or Module named at run time (#1824).
      `const m = process['getBuiltin' + 'Module']('vm');`,
      `const load = Module['_lo' + 'ad'];`,
      'const g = globalThis[name];',
      `const b = process?.['bind' + 'ing'];`,
      'const f = Reflect.get(process, key);',
      'const d = Object.getOwnPropertyDescriptor(Module, key);',
      'const { [key]: f } = globalThis;',
      // The same through a parenthesis, a cast, an alias, a copy or an iteration, and process through globalThis (#1824
      // review).
      'const m = (process)[k];',
      'const m = process![k];',
      'const m = (process as any)[k];',
      'const p = process;\np[k]();',
      'const m = ({ ...process })[k];',
      'const m = Object.assign({}, process)[k];',
      'const all = Object.entries(process);',
      'for (const n in globalThis) use(n);',
      'const keys = Reflect.ownKeys(process);',
      `const m = Reflect['get'](process, k);`,
      `const m = globalThis.process['getBuiltin' + 'Module']('vm');`,
      `const m = global?.process[k];`,
      `const c = process.binding('contextify');`,
      `const s = process._linkedBinding('spawn_sync');`,
      'process.dlopen(mod, path);',
      // Code run past the import graph, outside the allowlist (#1824).
      `import { spawn } from 'node:child_process';`,
      `import { Worker } from 'worker_threads';`,
      `import 'node:child_process';`,
      `export { Session } from 'node:inspector';`,
      `import { start } from 'node:repl';`,
      `import cluster from 'node:cluster';`,
      `import { Session } from 'node:inspector/promises';`,
    ]) {
      expect(scan(source).problems, source).not.toEqual([]);
    }
    // Plain property access stays allowed, a local name that merely ends in one of the three too, and an import
    // the allowlist names for its file.
    for (const source of [
      'const v = process.env[name];',
      'const v = process.env?.[name];',
      'const a = process.argv[2];',
      'const x = job.process[0];',
      'const first = rows[0];',
      'const t = process.hrtime.bigint();',
      'const s = { process: 1, other: 2 };',
      'const g = globalThis.crypto.randomUUID();',
    ]) {
      expect(scan(source), source).toEqual({ names: [], problems: [] });
    }
    expect(runtimeImports(`import { spawn } from 'node:child_process';`, 'apps/kernel/src/x.ts', { 'apps/kernel/src/x.ts': ['child_process'] })).toEqual({ names: [], problems: [] });
    expect(runtimeImports(`import { spawn } from 'node:child_process';`, 'apps/kernel/src/y.ts', { 'apps/kernel/src/x.ts': ['child_process'] }).problems).toEqual(['imports child_process']);
  });

  it('refuses a getter or setter in a manifest', () => {
    const tables = { crove_t1766: { party: { email: 'contact' } } };
    Object.defineProperty(tables.crove_t1766, 'other', { enumerable: true, get: () => ({ email: 'internal' }) });
    expect(() => defineModule({ id: 't1766', dependsOn: [], tables, permissions: [], entities: [], routes: [], nav: [] } as unknown as ModuleManifest)).toThrow(
      /not a getter or setter/,
    );
  });

  it('keeps its own copy of a registered definition, so changing the caller object changes nothing', () => {
    const approvers = def({ name: 't1766.clean', writes: [INTERNAL], agentApprovers: { roles: ['finance.chief_accountant'] } });
    const contactWriter = def({ name: 't1766.contact', writes: [CONTACT] });
    const runtime = new Runtime(cells, { manifests: manifests() }).register({ commands: [approvers, contactWriter] });
    // More approvers added to a clean command, the contact write taken off a writer: P04 reads what registered.
    (approvers.agentApprovers as { roles: string[] }).roles.push('kernel.owner');
    (contactWriter.writes as CommandWrite[]).length = 0;
    expect(runtime.commandInfo('t1766.clean')?.agentApprovers).toEqual(['finance.chief_accountant']);
    expect(runtime.commandInfo('t1766.contact')?.contactOrPayment).toBe(true);
    // (Agent access set on a definition after it registers grants nothing: agents.db.test.ts runs it as an agent.)
  });

  it('counts a declared table that holds a contact or payment column as a write of it, since writes are checked per table', () => {
    const name = tableWrite(kernelManifest.tables, 'crove_kernel', 'party', ['name']);
    const runtime = new Runtime(cells, { manifests: manifests() }).register({ commands: [def({ name: 't1710.party_name', writes: [name] })] });
    expect(runtime.commandInfo('t1710.party_name')?.contactOrPayment).toBe(true);
    expect(() => new Runtime(cells, { manifests: manifests() }).register({ commands: [def({ name: 't1710.agent_party', access: [], agent: { roles: 'any' }, writes: [name] })] })).toThrow(
      /crove_kernel\.party \(holds .*email \(contact\).*checked per table\), so no agent may run it/,
    );
  });

  it('refuses a definition it could copy only in part, and an unknown risk or access', () => {
    const hidden: Record<string, unknown> = { ...def({ name: 't1766.hidden' }) };
    delete hidden.risk;
    Object.defineProperty(hidden, 'risk', { enumerable: false, value: 'R3' });
    expect(() => new Runtime(cells, { manifests: TEST_MANIFESTS }).register({ commands: [hidden as unknown as CommandDef<unknown, unknown>] })).toThrow(/hidden or symbol property risk/);
    const inherited = Object.assign(Object.create({ risk: 'R3' }) as object, { ...def({ name: 't1766.inherited' }), risk: undefined });
    expect(() => new Runtime(cells, { manifests: TEST_MANIFESTS }).register({ commands: [inherited as CommandDef<unknown, unknown>] })).toThrow(/not a plain object/);
    expect(() => new Runtime(cells, { manifests: TEST_MANIFESTS }).register({ commands: [def({ name: 't1766.risk', risk: 'R9' as never })] })).toThrow(/unknown risk/);
    // An object that names R2 when made a string is not the string R2 the agent checks compare with.
    expect(() => new Runtime(cells, { manifests: TEST_MANIFESTS }).register({ commands: [def({ name: 't1766.risk_object', risk: { toString: () => 'R2' } as never })] })).toThrow(/unknown risk/);
    expect(() => new Runtime(cells, { manifests: TEST_MANIFESTS }).register({ commands: [def({ name: 't1766.access', access: 'agents' as never })] })).toThrow(/access is a role list/);
    expect(() => new Runtime(cells, { manifests: TEST_MANIFESTS }).register({ commands: [def({ name: 't1766.agent', access: [], writes: [], agent: { roles: 'all' as never } })] })).toThrow(
      /agent access names a role list/,
    );
  });

  it('reads a field a definition leaves out as absent, whatever Object.prototype holds', () => {
    const contactWriter = def({ name: 't1766.proto', access: ['owner'], writes: [CONTACT] });
    const proto = Object.prototype as Record<string, unknown>;
    proto.agent = { roles: 'any' };
    try {
      // Read through the prototype, the inherited agent access would make it a contact writer agents run.
      expect(() => new Runtime(cells, { manifests: TEST_MANIFESTS }).register({ commands: [contactWriter] })).not.toThrow();
    } finally {
      delete proto.agent;
    }
  });

  it('keeps its own copy of the session source', () => {
    const source = { mode: 'db' as 'db' | 'off', liveCheckForR3: false, check: async () => {} };
    const runtime = new Runtime(cells, { manifests: TEST_MANIFESTS, sessions: source });
    source.mode = 'off';
    source.check = async () => {};
    expect(runtime.sessionMode).toBe('db');
    expect(() => new Runtime(cells, { manifests: TEST_MANIFESTS, sessions: { ...source, mode: 'none' as never } })).toThrow(/known mode/);
  });

  it('keeps its registry out of reach: no cast, Object.create or assignment changes a runtime', () => {
    const forgedCommand = def({ name: 't1766.forged', access: [], agent: { roles: 'any' }, writes: [forged({ ...PARTY, email: 'internal' })] });
    const runtime = serverRuntime(cells, config, {});
    // A shadow object over the runtime is not one: its methods cannot reach the registry.
    const shadow = Object.create(runtime) as Runtime & Record<string, unknown>;
    shadow.manifestTables = null;
    expect(() => shadow.register({ commands: [forgedCommand] })).toThrow(TypeError);
    expect(runtime.commandInfo('t1766.forged')).toBeNull();
    // No field or method of the runtime, or of the class, can be replaced or added.
    const open = runtime as unknown as Record<string, unknown>;
    expect(open.commands).toBeUndefined();
    expect(open.contactOrPayment).toBeUndefined();
    expect(() => {
      open.register = () => runtime;
    }).toThrow(TypeError);
    expect(() => {
      open.stepUp = 'off';
    }).toThrow(TypeError);
    expect(() => {
      (Runtime.prototype as unknown as Record<string, unknown>).authorizeAgent = () => {};
    }).toThrow(TypeError);
    expect(() => runtime.register({ commands: [forgedCommand] })).toThrow(/not its manifest's/);
  });

  it('freezes every manifest, and the runtime keeps its own copy of the classes', () => {
    const unfrozen: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value !== 'object' || value === null) return;
      if (!Object.isFrozen(value)) unfrozen.push(path);
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    };
    for (const manifest of moduleManifests(config)) walk(manifest, manifest.id);
    expect(unfrozen).toEqual([]);
    expect(() => {
      (kernelManifest.tables.crove_kernel as Record<string, unknown>).party = { email: 'internal' };
    }).toThrow(TypeError);
    // A manifest object changed after the runtime read it does not change the check.
    const tables = { crove_kernel: { party: { ...PARTY } } };
    const runtime = new Runtime(cells, { manifests: [tables] });
    tables.crove_kernel.party.email = 'internal';
    expect(() => runtime.register({ commands: [def({ writes: [forged({ ...PARTY, email: 'internal' })] })] })).toThrow(/not its manifest's/);
  });

  it('refuses a command an agent may run that does not declare its writes, and the old noContactOrPayment form', () => {
    expect(withManifests({ access: [], agent: { roles: 'any' } })).toThrow(/an agent may run it, so it declares its writes/);
    expect(withManifests({ access: [], agent: { roles: 'any' }, writes: [] })).not.toThrow();
    expect(withManifests({ agentApprovers: { roles: ['finance.chief_accountant'] } })).toThrow(/declares its writes/);
    expect(withManifests({ agentApprovers: { roles: ['finance.chief_accountant'], noContactOrPayment: true } as AgentApprovers })).toThrow(/declares its writes/);
    expect(withManifests({ agentApprovers: { roles: ['finance.chief_accountant'], noContactOrPayment: true } as AgentApprovers, writes: [INTERNAL] })).toThrow(
      /no longer take noContactOrPayment/,
    );
  });

  it('registers every command the server ships against the manifests', () => {
    const commands = shipped();
    expect(() => new Runtime(cells, { manifests: manifests() }).register({ commands })).not.toThrow();
  });

  it('declares the writes of every command an agent may run, none of them a contact or payment column', () => {
    const commands = shipped();
    const runtime = new Runtime(cells, { manifests: manifests() }).register({ commands });
    const agentCommands = commands.filter((c) => c.agent !== undefined);
    expect(agentCommands.length).toBeGreaterThan(0);
    expect(agentCommands.filter((c) => c.writes === undefined).map((c) => c.name)).toEqual([]);
    expect(agentCommands.filter((c) => runtime.commandInfo(c.name)?.contactOrPayment !== false).map((c) => c.name)).toEqual([]);
  });

  it('declares the writes of every command with agent approvers', () => {
    expect(shipped().filter((c) => c.agentApprovers !== undefined && c.writes === undefined).map((c) => c.name)).toEqual([]);
  });

  it('flags P04 on an agent proposal of every proposal command but the listed ones', () => {
    const commands = shipped();
    const runtime = new Runtime(cells, { manifests: manifests() }).register({ commands });
    const proposals = commands.filter((c) => c.access === 'proposal');
    expect(proposals.length).toBeGreaterThan(0);
    const clean = proposals.filter((c) => runtime.commandInfo(c.name)?.contactOrPayment === false).map((c) => c.name);
    expect(clean.filter((name) => !PROPOSALS_WITHOUT_P04.includes(name))).toEqual([]);
  });

  it('keeps every contact and payment column of the manifests', () => {
    const classes = new Map<string, string>();
    for (const tables of manifests()) {
      for (const [schema, byTable] of Object.entries(tables)) {
        for (const [table, columns] of Object.entries(byTable)) {
          for (const [column, cls] of Object.entries(columns)) classes.set(`${schema}.${table}.${column}`, cls);
        }
      }
    }
    const lost = Object.entries(P04_COLUMNS).filter(([column, cls]) => classes.get(column) !== cls);
    expect(lost).toEqual([]);
  });
});
