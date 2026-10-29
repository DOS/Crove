// No cross-module SQL (plan §5.4): a module's code names only its own schema (crove_<id>) and the kernel's
// (crove_kernel), never another module's, so modules stay independent and a deployment may leave any of them out
// (ADR-0031). Modules reach each other through ctx.query and events, never through each other's tables. Schemas are
// found wherever a module's source names one: Kysely table names (`selectFrom('crove_social.post')`), raw SQL and
// strings alike. A module's tests are held to the same rule. Migrations are checked by the G2 lint
// (tools/ci/migration-lint.mjs).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MODULES = join(ROOT, 'modules');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);
// A Crove schema named as a qualifier: crove_<name> followed by a dot.
const SCHEMA = /\bcrove_([a-z][a-z0-9_]*)\./g;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.isFile() && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sql)$/.test(entry.name)) out.push(path);
  }
  return out;
}

// The schemas a text names that a module `id` may not.
function foreignSchemas(id: string, text: string): string[] {
  const allowed = new Set([id, 'kernel']);
  return [...new Set([...text.matchAll(SCHEMA)].map((m) => m[1] as string))].filter((schema) => !allowed.has(schema));
}

describe('no cross-module SQL (plan §5.4)', () => {
  it('finds another module\'s schema in queries and strings, and lets the own and the kernel schema pass', () => {
    expect(foreignSchemas('social', "ctx.trx.selectFrom('crove_finance.journal_entry')")).toEqual(['finance']);
    expect(foreignSchemas('finance', 'SELECT 1 FROM crove_social.post p JOIN crove_crm.booking b ON true')).toEqual(['social', 'crm']);
    expect(foreignSchemas('crm', 'sql`SELECT crove_jobs.send()`')).toEqual(['jobs']);
    expect(foreignSchemas('social', "selectFrom('crove_social.post').innerJoin('crove_kernel.tenant as t')")).toEqual([]);
    expect(foreignSchemas('finance', 'the crove_finance schema, crove_kernel_tenant')).toEqual([]);
  });

  it('keeps every module to its own schema and crove_kernel', () => {
    const ids = readdirSync(MODULES).filter((name) => existsSync(join(MODULES, name, 'package.json')));
    expect(ids.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const id of ids) {
      for (const file of sources(join(MODULES, id))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const foreign = foreignSchemas(id, line);
            if (foreign.length > 0) offenders.push(`${relative(ROOT, file).replaceAll('\\', '/')}:${i + 1}: ${foreign.map((s) => `crove_${s}`).join(', ')}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});

// The reverse direction (#1471): the kernel names a module's schema only where a reason is written down, because a
// deployment may leave any module out (ADR-0031). Migrations still apply to every schema, so a module's tables and
// functions always exist; what a reason must show is that the code is right with the module off: it runs only when the
// module is installed (Runtime.installed), or it is meant to reach the module's data whatever is installed.
const KERNEL_DIRS = ['packages/kernel/src', 'apps/kernel/src', 'packages/db/src'];
// The kernel source files that name a module's schema, with the modules they name and why.
const KERNEL_MODULE_REFERENCES: Record<string, { modules: readonly string[]; why: string }> = {
  'packages/db/src/generated/database.ts': { modules: ['crm', 'finance', 'notes', 'social'], why: 'Kysely types of every table crove_tenant reads, generated (pnpm db:types); types only, no SQL' },
  'packages/db/src/schema.ts': { modules: ['crm', 'finance', 'notes', 'social'], why: 'refinements of the generated table types (CHECK unions, trigger-set columns); types only, no SQL' },
  'packages/kernel/src/offboarding.ts': {
    modules: ['crm', 'finance', 'notes', 'social'],
    why: 'the org export lists every table of every schema (its manifest needs a part per table): a module left out exports its old rows or none, and its data stays, as ADR-0031 says',
  },
  'packages/kernel/src/personal-data.ts': {
    modules: ['crm', 'finance', 'social'],
    why: 'the personal-data registry, find and erase: an erasure reaches data an earlier install of the module left, whatever is installed now',
  },
  'packages/kernel/src/commands.ts': { modules: ['notes'], why: 'a comment: kernel.member.remove queues the notes purge, which the notes worker runs only with the module' },
  'apps/kernel/src/bio-page.ts': { modules: ['social'], why: 'public bio page routes, registered only when social is installed (http.ts)' },
  'apps/kernel/src/booking-feed.ts': { modules: ['crm'], why: 'the booking calendar feed, served only when crm is installed (http.ts)' },
  'apps/kernel/src/booking-page.ts': { modules: ['crm'], why: 'public booking routes, registered only when crm is installed (http.ts)' },
  'apps/kernel/src/calendar-feed.ts': { modules: ['social'], why: 'the post calendar feed, served only when social is installed (http.ts)' },
  'apps/kernel/src/chat-alert-save.ts': { modules: ['social'], why: 'a comment: the procedure answers 404 when social is not installed (rpc.ts)' },
  'apps/kernel/src/chat-alerts.ts': { modules: ['social'], why: 'a comment: the sender is built only when social is installed (worker.ts)' },
  'apps/kernel/src/credential-reseal.ts': { modules: ['social'], why: 'the chat alert targets are resealed only when social is installed; the channel credentials are kernel work' },
  'apps/kernel/src/feeds.ts': { modules: ['social'], why: 'the RSS feed sweep, timed only when social is installed (worker.ts)' },
  'apps/kernel/src/missing-invoice-mail.ts': { modules: ['finance'], why: 'the missing invoice reminders, timed only when finance is installed (worker.ts)' },
  'apps/kernel/src/notes-worker.ts': { modules: ['notes'], why: 'the notes jobs, worked and scheduled only when notes is installed (worker.ts)' },
  'apps/kernel/src/period-balance.ts': { modules: ['finance'], why: 'the period balance reconciliation, worked and scheduled only when finance is installed (worker.ts)' },
  'apps/kernel/src/report-link.ts': { modules: ['social'], why: 'public report link routes, registered only when social is installed (http.ts)' },
  'apps/kernel/src/review-link.ts': { modules: ['social'], why: 'public review link routes, registered only when social is installed (http.ts)' },
  'apps/kernel/src/short-link.ts': { modules: ['social'], why: 'the short link route, registered only when social is installed (http.ts)' },
  'apps/kernel/src/stock-photos.ts': { modules: ['social'], why: 'a comment: the stock photo procedures answer 404 when social is not installed (rpc.ts)' },
  'apps/kernel/src/worker.ts': { modules: ['social'], why: 'the publishing sweep claims social posts only when social is installed (no publishers otherwise)' },
};

// The modules a text names by schema (crove_<module>.), among `modules`.
function moduleSchemas(modules: ReadonlySet<string>, text: string): string[] {
  return [...new Set([...text.matchAll(SCHEMA)].map((m) => m[1] as string))].filter((schema) => modules.has(schema)).sort();
}

describe('kernel code names a module schema only for a written reason (#1471)', () => {
  const modules = new Set(readdirSync(MODULES).filter((name) => existsSync(join(MODULES, name, 'package.json'))));

  it('finds a module schema but not the kernel, jobs or meta schemas', () => {
    expect(moduleSchemas(new Set(['finance', 'social']), "selectFrom('crove_finance.journal_entry') JOIN crove_kernel.tenant, crove_jobs.job, crove_social.post")).toEqual(['finance', 'social']);
    expect(moduleSchemas(new Set(['finance']), 'crove_kernel.audit_event crove_meta.schema_migrations')).toEqual([]);
  });

  it('lists every kernel file that names a module schema, with the modules it names and why, and nothing more', () => {
    expect(modules.size).toBeGreaterThan(0);
    const found: Record<string, string[]> = {};
    for (const dir of KERNEL_DIRS) {
      for (const file of sources(join(ROOT, dir))) {
        const named = moduleSchemas(modules, readFileSync(file, 'utf8'));
        if (named.length > 0) found[relative(ROOT, file).replaceAll('\\', '/')] = named;
      }
    }
    const listed = Object.fromEntries(Object.entries(KERNEL_MODULE_REFERENCES).map(([file, entry]) => [file, [...entry.modules].sort()]));
    // A new file, a new module in a listed file, or a listed file that no longer names it: write down why, or drop it.
    expect(found).toEqual(listed);
    for (const [file, entry] of Object.entries(KERNEL_MODULE_REFERENCES)) expect(entry.why.length, file).toBeGreaterThan(20);
  });
});
