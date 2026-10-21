// Invariant suite (Decision 7; issue #680, MVP exit criterion 2, Phase 1 exit criterion 1): one write path. Every
// state change is a command executed through Runtime.execute(), so tenant data is written only on the transaction the
// runtime hands a command (ctx.trx), or by the database's own definer functions. This file checks the sources:
// - every write a TypeScript source issues (a Kysely insertInto, updateTable, deleteFrom, mergeInto or replaceInto, or
//   raw SQL that inserts, updates, deletes, merges or truncates) runs on `ctx.trx`, or on `trx`, a transaction passed
//   in by such a caller;
// - only the files listed below open a database handle, a connection or a transaction of their own, so any
//   transaction a module or package holds came from the runtime. Queries get a READ ONLY one (write-path.db.test.ts
//   checks that a query that writes is refused), so a write on ctx.trx happens in a command;
// - no query definition writes, since ctx.query() from a command runs a query in the command's writable transaction.
// The kernel's own machinery (the runtime, the migration runner, the worker's relays and sweeps, the prober) is
// listed by file with its reason; its SQL calls definer functions and issues no DML outside the runtime.
// Keep this directory self-contained: no imports from outside test/invariant/.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
// Every app's sources, every module and every package.
const SCANNED = [...readdirSync(join(ROOT, 'apps')).map((app) => `apps/${app}/src`), 'modules', 'packages'].filter((dir) =>
  existsSync(join(ROOT, dir)),
);

// Files that may issue DML on something other than ctx.trx, each with its reason. Adding one is a security change.
const DML_ALLOWED: Record<string, string> = {
  'packages/db/src/migrate.ts': 'the migration runner records applied migrations as the migration owner, not a login role',
};

// Files that may open a database handle, a connection or a transaction, each with its reason. Their SQL is checked by
// the DML rule like any other source. Adding one is a security change.
const HANDLE_ALLOWED: Record<string, string> = {
  'packages/db/src/index.ts': 'createPool and createDb, the only constructors',
  'packages/db/src/migrate.ts': 'the migration runner, on the admin URL',
  'packages/kernel-runtime/src/runtime.ts': 'execute() and query() open the transactions every command and query runs on',
  'apps/kernel/src/kernel.ts': 'process wiring: the pool and Kysely instance handed to the runtime',
  'apps/kernel/src/worker.ts': 'outbox, inbound and mail-event relays: claim through definer functions, no tenant DML',
  'apps/kernel/src/credential-reseal.ts': 'lists due credentials through a definer; resealing runs as a command',
  'apps/kernel/src/channel-refresh.ts': 'lists due channel tokens through a definer; refreshing runs as a command',
  'apps/kernel/src/usage-report.ts': 'reads crove_kernel.usage_weekly() as crove_reporter',
  'apps/kernel/src/prober.ts': 'reads crove_kernel.health() as crove_prober',
  'apps/kernel/src/alert-gate.ts': 'records alert decisions through crove_kernel.prober_alert_gate() as crove_prober',
  'apps/kernel/src/stream.ts': 'issues and redeems stream tickets through their definers on its own listener',
};

// Kysely's write builders.
const KYSELY_WRITE = /\.\s*(insertInto|updateTable|deleteFrom|mergeInto|replaceInto)\s*\(/g;
// A data-changing SQL statement, in any case and across line breaks. GRANT and REVOKE lists ("REVOKE INSERT, UPDATE")
// and SELECT ... FOR UPDATE do not match, nor does a CSS class like "truncate text-sm": a TRUNCATE names TABLE or a
// schema-qualified table, as every Crove statement does. The runtime's own writes (audit rows, activity, idempotency keys) run on the
// command's transaction as trx and need no exception.
const SQL_DML = /\b(INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+TABLE\s+[\w".]+|TRUNCATE\s+(ONLY\s+)?[\w"]+\s*\.\s*[\w"]+|UPDATE\s+(ONLY\s+)?[\w".]+(\s+(AS\s+)?\w+)?\s+SET)\b/gi;
// Opening a handle, a connection or a transaction.
const HANDLE = /\b(createDb|createPool)\s*\(|\bnew\s+(Kysely|(pg\s*\.\s*)?(Pool|Client))\b|\.\s*(transaction|connection|startTransaction)\s*\(\s*\)/g;
// The receivers a write may run on: the command's transaction, or a transaction parameter named trx.
const RECEIVER_OK = new Set(['ctx.trx', 'trx']);

// Comments may say anything; code may not. A small scanner blanks // and /* */ comments (keeping line breaks, so
// offenders report their line) and leaves strings, template literals and regular expressions as they are, so a
// "/*" inside a string or a line comment never hides the code after it. With blankStrings the contents of strings and
// template literals are blanked too (for matching brackets); the result always has the input's length.
function code(text: string, blankStrings = false): string {
  let out = '';
  let i = 0;
  // Template literal nesting: each entry counts the braces open inside one ${ } of a template.
  const templates: number[] = [];
  let lastSignificant = '';
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += blankStrings ? `${ch}${blank(text.slice(i + 1, j))}${text[j] ?? ''}` : text.slice(i, j + 1);
      i = j + 1;
      lastSignificant = ch;
      continue;
    }
    if (ch === '`' || (ch === '}' && templates.length > 0 && templates[templates.length - 1] === 0)) {
      // The body of a template literal, up to its end or the next ${.
      if (ch === '}') templates.pop();
      let j = i + 1;
      while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) j += text[j] === '\\' ? 2 : 1;
      const literal = (from: number, to: number) => (blankStrings ? `${text[from] ?? ''}${blank(text.slice(from + 1, to))}` : text.slice(from, to));
      if (text[j] === '$') {
        templates.push(0);
        out += `${literal(i, j)}\${`;
        i = j + 2;
      } else {
        out += `${literal(i, j)}${text[j] ?? ''}`;
        i = j + 1;
      }
      lastSignificant = '`';
      continue;
    }
    if (ch === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant) || /\b(return|typeof|case)\s*$/.test(out))) {
      // A regular expression literal.
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j += 1;
      }
      while (/[a-z]/i.test(text[j + 1] ?? '')) j += 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      lastSignificant = '/';
      continue;
    }
    if (templates.length > 0 && ch === '{') templates[templates.length - 1] = (templates[templates.length - 1] ?? 0) + 1;
    if (templates.length > 0 && ch === '}') templates[templates.length - 1] = (templates[templates.length - 1] ?? 0) - 1;
    if (!/\s/.test(ch)) lastSignificant = ch;
    out += ch;
    i += 1;
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

// The identifier chain right before a method call (`ctx.trx` in `await ctx.trx\n .insertInto(`), or null when the
// call follows anything else (a call, a bracket), which is then reported.
function receiver(before: string): string | null {
  const m = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/.exec(before);
  return m?.[1] ? m[1].replace(/\s+/g, '') : null;
}

// sql`...` and sql<T>`...` templates with the argument of the .execute() that follows them. A template holding a
// nested template literal is cut short, so its DML falls outside every template and is reported (fails safe).
function sqlTemplates(body: string): Array<{ start: number; end: number; executeOn: string | null }> {
  const out: Array<{ start: number; end: number; executeOn: string | null }> = [];
  for (const m of body.matchAll(/\bsql\s*(<[^`>]*(?:<[^`>]*>[^`>]*)*>)?\s*`([^`]*)`/g)) {
    const end = (m.index ?? 0) + m[0].length;
    const execute = /^\s*\.\s*execute\s*\(\s*([^)]*?)\s*\)/.exec(body.slice(end, end + 300));
    out.push({ start: m.index ?? 0, end, executeOn: execute?.[1] ? execute[1].replace(/\s+/g, '') : null });
  }
  return out;
}

export function writeOffenders(text: string): string[] {
  const body = code(text);
  const offenders: string[] = [];
  for (const m of body.matchAll(KYSELY_WRITE)) {
    const on = receiver(body.slice(0, m.index));
    if (!on || !RECEIVER_OK.has(on)) offenders.push(`${lineOf(body, m.index ?? 0)}: ${m[1]} on ${on ?? 'an expression'}`);
  }
  const templates = sqlTemplates(body);
  for (const m of body.matchAll(SQL_DML)) {
    const at = m.index ?? 0;
    const template = templates.find((t) => t.start <= at && at < t.end);
    const statement = m[0].replace(/\s+/g, ' ');
    if (!template) offenders.push(`${lineOf(body, at)}: ${statement} outside a sql template`);
    else if (!template.executeOn || !RECEIVER_OK.has(template.executeOn)) {
      offenders.push(`${lineOf(body, at)}: ${statement} executed on ${template.executeOn ?? 'nothing visible'}`);
    }
  }
  return offenders;
}

// The extents of every defineQuery({...}) call, found on the code with strings blanked so a bracket in a string does
// not count.
function queryDefinitions(text: string): Array<{ start: number; end: number }> {
  const body = code(text, true);
  const out: Array<{ start: number; end: number }> = [];
  for (const m of body.matchAll(/\bdefineQuery\s*(<[^(]*>)?\s*\(/g)) {
    let depth = 0;
    let end = body.length;
    for (let i = (m.index ?? 0) + m[0].length - 1; i < body.length; i += 1) {
      if (body[i] === '(') depth += 1;
      else if (body[i] === ')' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    out.push({ start: m.index ?? 0, end });
  }
  return out;
}

// Writes inside a query definition. Runtime.query() runs a query READ ONLY, but ctx.query() from a command runs it in
// the command's writable transaction, so a query handler must not write at all.
export function queryWriteOffenders(text: string): string[] {
  const body = code(text);
  const queries = queryDefinitions(text);
  const inQuery = (at: number) => queries.some((q) => q.start <= at && at < q.end);
  return [...body.matchAll(KYSELY_WRITE), ...body.matchAll(SQL_DML)]
    .filter((m) => inQuery(m.index ?? 0))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((m) => `${lineOf(body, m.index ?? 0)}: ${m[0].replace(/\s+/g, ' ').replace(/^\.\s*/, '').replace(/\s*\($/, '')} in a query`);
}

export function handleOffenders(text: string): string[] {
  const body = code(text);
  return [...body.matchAll(HANDLE)].map((m) => `${lineOf(body, m.index ?? 0)}: ${m[0].replace(/\s+/g, ' ')}`);
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'dist' || name === '.next' || name === 'generated') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) out.push(path);
  }
  return out;
}

const files = () =>
  SCANNED.flatMap((dir) => sources(join(ROOT, dir))).map((path) => ({ path: relative(ROOT, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));

describe('one write path (#680)', () => {
  it('scans every app, module and package', () => {
    expect(SCANNED).toEqual(expect.arrayContaining(['apps/kernel/src', 'modules', 'packages']));
    // The scan sees the write sites it is meant to see: commands in the modules and the kernel.
    const all = files();
    expect(all.filter((f) => /\.\s*insertInto\s*\(/.test(f.text)).length).toBeGreaterThan(10);
    expect(all.reduce((n, f) => n + queryDefinitions(f.text).length, 0)).toBeGreaterThan(20);
  });

  it('writes only on the command transaction (ctx.trx) or a transaction passed in as trx', () => {
    const offenders = files()
      .filter((f) => !(f.path in DML_ALLOWED))
      .flatMap((f) => writeOffenders(f.text).map((o) => `${f.path}:${o}`));
    expect(offenders, 'a write outside a command transaction: run it in a command (ctx.trx) or a definer function').toEqual([]);
  });

  it('never writes inside a query definition', () => {
    const offenders = files().flatMap((f) => queryWriteOffenders(f.text).map((o) => `${f.path}:${o}`));
    expect(offenders, 'a query that writes: make it a command').toEqual([]);
  });

  it('opens database handles, connections and transactions only in the listed kernel files', () => {
    const offenders = files()
      .filter((f) => !(f.path in HANDLE_ALLOWED))
      .flatMap((f) => handleOffenders(f.text).map((o) => `${f.path}:${o}`));
    expect(offenders, 'a module or package opened its own database handle or transaction: take ctx.trx from the runtime').toEqual([]);
  });

  it('lists only files that exist and still need the exception', () => {
    const byPath = new Map(files().map((f) => [f.path, f.text]));
    for (const path of Object.keys(DML_ALLOWED)) {
      const text = byPath.get(path);
      expect(text, `${path} is listed in DML_ALLOWED but does not exist`).toBeDefined();
      expect(writeOffenders(text ?? ''), `${path} no longer needs DML_ALLOWED: remove it`).not.toEqual([]);
    }
    for (const path of Object.keys(HANDLE_ALLOWED)) {
      const text = byPath.get(path);
      expect(text, `${path} is listed in HANDLE_ALLOWED but does not exist`).toBeDefined();
      expect(handleOffenders(text ?? ''), `${path} no longer needs HANDLE_ALLOWED: remove it`).not.toEqual([]);
    }
  });
});

describe('the write-path scanner', () => {
  it('accepts writes on ctx.trx and trx, across line breaks and through a sql template', () => {
    expect(
      writeOffenders(`
        await ctx.trx
          .insertInto('crove_finance.purchase_line').values(rows).execute();
        await trx.updateTable('crove_kernel.task').set({ x: 1 }).execute();
        const { rows } = await sql<{ id: string }>\`
          UPDATE crove_kernel.file SET image_width = \${w}
          WHERE org_id = \${ctx.orgId} RETURNING id\`.execute(ctx.trx);
        await sql\`DELETE FROM crove_social.notification WHERE org_id = \${o}\`.execute(trx);
        // a comment may say INSERT INTO anything, and db.insertInto('x')
        /* or DELETE FROM x */
        const locked = await ctx.trx.selectFrom('crove_finance.period_lock').forUpdate().executeTakeFirst();
      `),
    ).toEqual([]);
  });

  it('reports writes on any other receiver or outside a command transaction', () => {
    expect(
      writeOffenders(`
        await db.insertInto('crove_kernel.party').values(row).execute();
        await this.db
          .deleteFrom('crove_kernel.party').execute();
        await ctx.trx.with('x', (q) => q).updateTable('crove_kernel.party').set({}).execute();
        await sql\`INSERT INTO crove_kernel.party (org_id) VALUES (\${o})\`.execute(pool);
        await client.query('DELETE FROM crove_kernel.party WHERE org_id = $1', [o]);
        await sql\`TRUNCATE crove_kernel.party\`.execute(db);
        await ctx.trx.executeQuery(CompiledQuery.raw('update crove_kernel.party p set name = 1'));
      `),
    ).toEqual([
      '2: insertInto on db',
      '4: deleteFrom on this.db',
      '5: updateTable on an expression',
      '6: INSERT INTO executed on pool',
      '7: DELETE FROM outside a sql template',
      '8: TRUNCATE crove_kernel.party executed on db',
      '9: update crove_kernel.party p set outside a sql template',
    ]);
  });

  it('never lets a "/*" in a string, a line comment or a regular expression hide the code after it', () => {
    expect(
      writeOffenders(`
        // applies supabase/migrations/*.sql in order
        const glob = 'src/**/*.ts';
        const re = /a\\/*b/g;
        const t = \`\${'/*'} and \${x}\`;
        await db.insertInto('crove_kernel.party').values(row).execute();
        // closing */ here must not end anything
      `),
    ).toEqual(['6: insertInto on db']);
  });

  it('does not mistake grants, locks or words in strings for writes', () => {
    expect(
      writeOffenders(`
        await sql\`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON t FROM crove_worker\`.execute(admin);
        await ctx.trx.selectFrom('t').forUpdate().execute();
        const message = 'Không cập nhật được';
        const className = 'truncate text-sm font-medium';
      `),
    ).toEqual([]);
  });

  it('reports a write inside a query definition, whatever its receiver', () => {
    expect(
      queryWriteOffenders(`
        export const listThings = defineQuery({
          name: 'x.list',
          handler: async (ctx) => {
            const label = 'a ) in a string';
            await ctx.trx.updateTable('crove_kernel.party').set({ seen: true }).execute();
            return sql\`DELETE FROM crove_kernel.party\`.execute(ctx.trx);
          },
        });
        export const doThing = defineCommand({ handler: async (ctx) => ctx.trx.insertInto('t').values({}).execute() });
      `),
    ).toEqual(['6: updateTable in a query', '7: DELETE FROM in a query']);
  });

  it('reports handles, connections and transactions opened outside the runtime', () => {
    expect(
      handleOffenders(`
        const db = createDb(createPool({ connectionString }));
        const client = new pg.Client({ connectionString });
        await db.transaction().execute(async (trx) => {});
        await db.connection().execute(async (c) => {});
        const k = new Kysely<Database>({ dialect });
        // new pg.Pool() in a comment is fine
        await ctx.trx.selectFrom('t').execute();
      `),
    ).toEqual(['2: createDb(', '2: createPool(', '3: new pg.Client', '4: .transaction()', '5: .connection()', '6: new Kysely']);
  });
});
