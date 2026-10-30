// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7; #1710): no file that defines a command or a query holds a pg-boss handle. A command's
// writes are checked on its own transaction (ctx.trx: the table-level execution check reads pg_stat_xact_user_tables,
// #1785), and a command declared free of contact and payment writes declares no job table (#2107). A handler that
// held pg-boss itself (`boss.send`, a `JobSender`) would enqueue on pg-boss's own pool, outside the command's
// transaction and invisible to both checks, and the job it queued would run later under its own declaration. Today no
// handler holds one: jobs are sent by the worker's relays from the outbox events a command emits. This file keeps it so
// by reading the sources: a file that calls defineCommand() or defineQuery() may not import 'pg-boss' or name `boss`,
// `JobSender` or `PgBoss` anywhere in its code (type positions included; comments and strings are not code).
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
// command emits an event (ctx.emit) and the worker's relay sends the job, on the relay's own transaction.
const ALLOWED: Record<string, string> = {};

// What defines a handler, and the names that are a pg-boss handle.
const DEFINERS = new Set(['defineCommand', 'defineQuery']);
const HANDLES = new Set(['boss', 'JobSender', 'PgBoss']);
const PACKAGE = 'pg-boss';

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
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && DEFINERS.has(n.callee.name)) defines = true;
    if (n.type === 'Identifier' && HANDLES.has(n.name)) handles.add(`${line(n)}: ${n.name}`);
    // import ... from 'pg-boss', import type ... from 'pg-boss', export ... from 'pg-boss', import('pg-boss').
    const moduleNodes = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'];
    if (moduleNodes.includes(n.type) && n.source?.value === PACKAGE) handles.add(`${line(n)}: ${PACKAGE}`);
  });
  return { defines, handles: [...handles].sort() };
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'dist' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir))).map((path) => ({ path: relative(ROOT, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));

describe('no command or query handler holds a pg-boss handle', () => {
  it('no file that defines a command or a query imports pg-boss or names a boss, JobSender or PgBoss', () => {
    expect(SCANNED).toEqual(expect.arrayContaining(['apps/kernel/src', 'modules', 'packages']));
    // Only a source that could define a handler is parsed; the rest cannot be one.
    const defining = files.filter((f) => /\bdefine(?:Command|Query)\b/.test(f.text)).map((f) => ({ ...f, ...read(f.text) }));
    const offenders = defining
      .filter((f) => f.defines && f.handles.length > 0 && !(f.path in ALLOWED))
      .map((f) => `${f.path} (${f.handles.join('; ')})`);
    expect(offenders).toEqual([]);
    // The scan sees what it is meant to: the commands of the kernel and of every module.
    const paths = defining.filter((f) => f.defines).map((f) => f.path);
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toEqual(expect.arrayContaining(['packages/kernel/src/agents.ts', 'modules/finance/src/bank-feed.ts', 'apps/kernel/src/org-purge.ts']));
    // A listed file still defines a handler (a stale entry would hide nothing and say nothing).
    for (const path of Object.keys(ALLOWED)) expect(paths, path).toContain(path);
  });

  it('is not vacuous: the worker side holds pg-boss and defines no handler, and a comment that names it is not a handle', () => {
    const holders = files.filter((f) => /\bboss\b|\bJobSender\b|\bPgBoss\b|['"]pg-boss['"]/.test(f.text));
    expect(holders.map((f) => f.path)).toEqual(expect.arrayContaining(['apps/kernel/src/worker.ts', 'apps/kernel/src/jobs-schema.ts']));
    const worker = read((files.find((f) => f.path === 'apps/kernel/src/worker.ts') as { text: string }).text);
    expect(worker.defines).toBe(false);
    expect(worker.handles.length).toBeGreaterThan(0);
    // A command file whose comment says pg-boss: it defines handlers and holds none.
    const inbox = files.find((f) => f.path === 'packages/kernel/src/inbox-items.ts') as { text: string };
    expect(inbox.text).toContain('pg-boss');
    expect(read(inbox.text)).toEqual({ defines: true, handles: [] });
  });

  it('reads handles in code, in every position, and nothing else (planted sources)', () => {
    const command = (body: string, head = '') => `${head}\nexport const c = defineCommand({ name: 'x.y', handler: async (ctx) => { ${body} } });`;
    // A handle used, passed, typed or imported is found in a file that defines a command.
    expect(read(command('await boss.send("q", {});')).handles).toEqual(['2: boss']);
    expect(read(command('', "import type { JobSender } from '../../apps/kernel/src/worker.ts';")).handles).toEqual(['1: JobSender']);
    expect(read(command('const sender: JobSender = deps.sender;')).handles).toEqual(['2: JobSender']);
    expect(read(command('', "import PgBoss from 'pg-boss';")).handles).toEqual(['1: PgBoss', '1: pg-boss']);
    expect(read(command('', "import type { SendOptions } from 'pg-boss';")).handles).toEqual(['1: pg-boss']);
    expect(read(command('const { default: B } = await import("pg-boss");')).handles).toEqual(['2: pg-boss']);
    expect(read(`export { x } from 'pg-boss';\n${command('')}`).handles).toEqual(['1: pg-boss']);
    expect(read(command('return deps.boss;')).handles).toEqual(['2: boss']);
    // A query defines a handler too, with generics too.
    const query = "export const q = defineQuery<A, B>({ name: 'x.q', handler: async () => { await boss.send('q'); } });";
    expect(read(query)).toEqual({ defines: true, handles: ['1: boss'] });
    expect(read("export const c = defineCommand<I, O>({ name: 'x.y', handler: async (ctx) => { ctx.run(boss); } });")).toEqual({ defines: true, handles: ['1: boss'] });
    // A comment, a string and a template text that say the word are not code.
    expect(read(command('// boss.send is the relay\'s\nconst s = "boss"; const t = `JobSender ${1} pg-boss`; /* PgBoss */')).handles).toEqual([]);
    // The worker side holds pg-boss and defines no handler: not an offender.
    expect(read("import PgBoss from 'pg-boss';\nexport function start(boss: PgBoss) { return boss.start(); }").defines).toBe(false);
  });
});
