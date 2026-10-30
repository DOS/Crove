// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7; #1710): no file that defines a command or a query holds a pg-boss handle. A command's
// writes are checked on its own transaction (ctx.trx: the table-level execution check reads pg_stat_xact_user_tables,
// #1785), and a command declared free of contact and payment writes declares no job table (#2107). A handler that
// held pg-boss itself (`boss.send`, a `JobSender`) would enqueue on pg-boss's own pool, outside the command's
// transaction and invisible to both checks, and the job it queued would run later under its own declaration. Today no
// handler holds one: jobs are sent by the worker (its relays and sweeps), from rows and events a command wrote. This
// file keeps it so by reading the sources: a file that defines a command or a query (it calls defineCommand() or
// defineQuery(), by that name or through an alias or a namespace, or types an object as a CommandDef or a QueryDef) may
// not import 'pg-boss' (or a subpath), import by a computed name, call require(), or name `boss`, `JobSender` or `PgBoss`
// anywhere in its code (type positions included; comments and strings are not code). What it does not cover: a handle
// passed in under another name (nothing exports the worker's own, and only apps/kernel depends on pg-boss, so a
// command file elsewhere cannot import it), which review sees.
// The sources are parsed by Vite's parser (an ESTree with TypeScript nodes), as job-egress.ts does.
// Keep this directory self-contained: no imports from outside test/invariant/.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAst } from 'vitest/node';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
// Every app's sources, every module and every package.
const SCANNED = [...readdirSync(join(ROOT, 'apps')).map((app) => `apps/${app}/src`), 'modules', 'packages'].filter((dir) => existsSync(join(ROOT, dir)));

// Files that define a command or a query and may still hold a pg-boss handle, each with its reason. Keep it empty: a
// command emits an event (ctx.emit) and the worker sends the job, on its own transaction.
const ALLOWED: Record<string, string> = {};

// What defines a handler (the definers by name, and the types a hand-built definition would carry), and the names that
// are a pg-boss handle.
const DEFINERS = new Set(['defineCommand', 'defineQuery', 'CommandDef', 'QueryDef']);
const HANDLES = new Set(['boss', 'JobSender', 'PgBoss']);
const PACKAGE = 'pg-boss';
const MODULE_NODES = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'];

type N = { type: string; [key: string]: any };

function walk(node: unknown, visit: (n: N) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
  } else if (node !== null && typeof node === 'object') {
    const n = node as N;
    if (typeof n.type === 'string') visit(n);
    for (const key of Object.keys(n)) if (key !== 'type') walk(n[key], visit);
  }
}

// Whether the source defines a handler, and every pg-boss handle its code holds (by line).
function read(text: string): { defines: boolean; handles: string[] } {
  const program = parseAst(text, { lang: 'ts' } as never) as unknown as N;
  let defines = false;
  // A set: an import specifier names its handle twice (imported and local), one finding is enough.
  const handles = new Set<string>();
  const line = (n: N) => text.slice(0, n.start).split('\n').length;
  walk(program, (n) => {
    // Any mention of a definer or a definition type: a call, an alias (`import { defineCommand as dc }`), a namespace
    // member (`rt.defineCommand(...)`), a re-export, a CommandDef literal.
    if (n.type === 'Identifier' && DEFINERS.has(n.name)) defines = true;
    if (n.type === 'Identifier' && HANDLES.has(n.name)) handles.add(`${line(n)}: ${n.name}`);
    // import ... from 'pg-boss' (or a subpath), import type ..., export ... from, import('pg-boss').
    const from: unknown = n.source?.value;
    if (MODULE_NODES.includes(n.type) && typeof from === 'string' && (from === PACKAGE || from.startsWith(`${PACKAGE}/`))) handles.add(`${line(n)}: ${PACKAGE}`);
    // A module named at run time could be pg-boss, as could a require().
    if (n.type === 'ImportExpression' && n.source?.type !== 'Literal') handles.add(`${line(n)}: import(computed)`);
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && (n.callee.name === 'require' || n.callee.name === 'createRequire')) handles.add(`${line(n)}: ${n.callee.name}()`);
  });
  return { defines, handles: [...handles].sort() };
}

// A package's own test directory is not a source; a directory called test inside src is.
function sources(dir: string): string[] {
  const out: string[] = [];
  const packageRoot = existsSync(join(dir, 'package.json'));
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next' || (name === 'test' && packageRoot)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

interface Source {
  path: string;
  text: string;
}

// The files that define a handler, with their handles. Only a source that could define one is parsed.
function analyze(files: readonly Source[]): Array<Source & { defines: boolean; handles: string[] }> {
  return files.filter((f) => /\b(?:defineCommand|defineQuery|CommandDef|QueryDef)\b/.test(f.text)).map((f) => ({ ...f, ...read(f.text) }));
}

// The files that define a handler and hold a pg-boss handle, unless listed.
function offendersOf(files: readonly Source[], allowed: Readonly<Record<string, string>>): string[] {
  return analyze(files)
    .filter((f) => f.defines && f.handles.length > 0 && !Object.hasOwn(allowed, f.path))
    .map((f) => `${f.path} (${f.handles.join('; ')})`);
}

const files: Source[] = SCANNED.flatMap((dir) => sources(join(ROOT, dir))).map((path) => ({ path: relative(ROOT, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));

describe('no command or query handler holds a pg-boss handle', () => {
  it('no file that defines a command or a query imports pg-boss or names a boss, JobSender or PgBoss', () => {
    expect(SCANNED).toEqual(expect.arrayContaining(['apps/kernel/src', 'modules', 'packages']));
    expect(offendersOf(files, ALLOWED)).toEqual([]);
    // The scan sees what it is meant to: the commands of the kernel and of every module.
    const paths = analyze(files)
      .filter((f) => f.defines)
      .map((f) => f.path);
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toEqual(expect.arrayContaining(['packages/kernel/src/agents.ts', 'modules/finance/src/bank-feed.ts', 'apps/kernel/src/org-purge.ts']));
    // A listed file still defines a handler (a stale entry would hide nothing and say nothing).
    for (const path of Object.keys(ALLOWED)) expect(paths, path).toContain(path);
  });

  it('is not vacuous: the worker side holds pg-boss and defines no handler, and a comment that names it is not a handle', () => {
    const holders = files.filter((f) => /\bboss\b|\bJobSender\b|\bPgBoss\b|['"]pg-boss['"]/.test(f.text));
    expect(holders.map((f) => f.path)).toEqual(expect.arrayContaining(['apps/kernel/src/worker.ts', 'apps/kernel/src/jobs-schema.ts']));
    const worker = read((files.find((f) => f.path === 'apps/kernel/src/worker.ts') as Source).text);
    expect(worker.defines).toBe(false);
    expect(worker.handles.length).toBeGreaterThan(0);
    // A command file whose comment says pg-boss: it defines handlers and holds none.
    const inbox = files.find((f) => f.path === 'packages/kernel/src/inbox-items.ts') as Source;
    expect(inbox.text).toContain('pg-boss');
    expect(read(inbox.text)).toEqual({ defines: true, handles: [] });
  });

  it('finds a handle planted in a real command file, and a listed file is not reported', () => {
    const real = files.find((f) => f.path === 'modules/finance/src/bank-feed.ts') as Source;
    for (const planted of [`import PgBoss from 'pg-boss';\n${real.text}`, `${real.text}\nawait boss.send('q');`, `${real.text}\nawait import('pg-boss');`]) {
      expect(offendersOf([{ path: real.path, text: planted }], {}), planted.slice(0, 40)).toEqual([expect.stringContaining(real.path)]);
    }
    // The real file is clean, and a listed file is not reported.
    expect(offendersOf([real], {})).toEqual([]);
    expect(offendersOf([{ path: real.path, text: `${real.text}\nawait boss.send('q');` }], { [real.path]: 'a reason' })).toEqual([]);
  });

  it('reads handles in code, in every position, and nothing else (planted sources)', () => {
    const command = (body: string, head = '') => `${head}\nexport const c = defineCommand({ name: 'x.y', handler: async (ctx) => { ${body} } });`;
    // A handle used, passed, typed or imported is found in a file that defines a command.
    expect(read(command('await boss.send("q", {});')).handles).toEqual(['2: boss']);
    expect(read(command('', "import type { JobSender } from '../../apps/kernel/src/worker.ts';")).handles).toEqual(['1: JobSender']);
    expect(read(command('const sender: JobSender = deps.sender;')).handles).toEqual(['2: JobSender']);
    expect(read(command('', "import PgBoss from 'pg-boss';")).handles).toEqual(['1: PgBoss', '1: pg-boss']);
    expect(read(command('', "import type { SendOptions } from 'pg-boss';")).handles).toEqual(['1: pg-boss']);
    expect(read(command('', "import { x } from 'pg-boss/dist/index.js';")).handles).toEqual(['1: pg-boss']);
    expect(read(command('const { default: B } = await import("pg-boss");')).handles).toEqual(['2: pg-boss']);
    expect(read(`export { x } from 'pg-boss';\n${command('')}`).handles).toEqual(['1: pg-boss']);
    expect(read(command('return deps.boss;')).handles).toEqual(['2: boss']);
    // A module named at run time, and a require, could be pg-boss.
    expect(read(command('const m = await import(name);')).handles).toEqual(['2: import(computed)']);
    expect(read(command('const m = require("pg-boss");')).handles).toEqual(['2: require()']);
    expect(read(command('const m = createRequire(import.meta.url)("pg-boss");')).handles).toEqual(['2: createRequire()']);
    // A query defines a handler too, with generics too.
    const query = "export const q = defineQuery<A, B>({ name: 'x.q', handler: async () => { await boss.send('q'); } });";
    expect(read(query)).toEqual({ defines: true, handles: ['1: boss'] });
    expect(read("export const c = defineCommand<I, O>({ name: 'x.y', handler: async (ctx) => { ctx.run(boss); } });")).toEqual({ defines: true, handles: ['1: boss'] });
    // A definition is recognised through an alias, a namespace, and a hand-built object typed as a CommandDef or a QueryDef.
    expect(read("import { defineCommand as dc } from './rt.ts';\nexport const c = dc({ name: 'x', handler: async () => boss.send('q') });")).toEqual({ defines: true, handles: ['2: boss'] });
    expect(read("import * as rt from './rt.ts';\nexport const c = rt.defineCommand({ name: 'x', handler: async () => boss.send('q') });")).toEqual({ defines: true, handles: ['2: boss'] });
    expect(read("export const c = { name: 'x', handler: async () => boss.send('q') } as CommandDef<unknown, unknown>;")).toEqual({ defines: true, handles: ['1: boss'] });
    expect(read("export const q: QueryDef<I, O> = { name: 'x', handler: async () => boss.send('q') };")).toEqual({ defines: true, handles: ['1: boss'] });
    // A comment, a string and a template text that say the word are not code.
    expect(read(command('// boss.send is the relay\'s\nconst s = "boss"; const t = `JobSender ${1} pg-boss`; /* PgBoss */')).handles).toEqual([]);
    // The worker side holds pg-boss and defines no handler: not an offender.
    expect(read("import PgBoss from 'pg-boss';\nexport function start(boss: PgBoss) { return boss.start(); }").defines).toBe(false);
  });
});
