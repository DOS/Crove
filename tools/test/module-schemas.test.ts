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
