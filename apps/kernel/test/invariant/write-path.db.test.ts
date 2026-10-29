// Invariant suite (Decision 7; issue #680, MVP exit criterion 2, Phase 1 exit criterion 1): one write path, on a real
// PostgreSQL 17. write-path.test.ts checks the sources; this checks the database and the runtime:
// - the login roles (crove_app, crove_worker, crove_prober, crove_reporter) can write, directly or through a role they
//   can act as, only tables with org_id under row-level security, where a write needs the context the command path
//   enters, plus pg-boss's own tables for the worker. Every other relation they reach only through definer functions;
// - Runtime.query() runs its handler READ ONLY: a query that writes is refused, while the same write in a command
//   commits.
// TRUNCATE is covered by truncate.db.test.ts and the cross-org probes by rls-matrix.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

// The roles Crove's processes log in as.
const LOGIN_ROLES = ['crove_app', 'crove_worker', 'crove_prober', 'crove_reporter'];
// Relations a login role may write outside row-level security, each with its reason. Adding one is a security change.
const OUTSIDE_RLS: Array<{ role: string; schema: string; reason: string }> = [
  { role: 'crove_worker', schema: 'crove_jobs', reason: "pg-boss's queue tables: the job queue, holding no tenant data" },
];

const suite = ADMIN ? describe : describe.skip;

suite('one write path on PostgreSQL (#680)', () => {
  const dbName = `crove_test_write_path_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool | undefined;
  let runtime: Runtime;
  let owner = '';
  let orgId = '';

  // A query and a command that insert the same kind of row on ctx.trx.
  const party = (ctx: QueryContext) =>
    ctx.trx.insertInto('crove_kernel.party').values({ org_id: ctx.orgId, name: `write-path ${randomUUID()}` }).returning('id').executeTakeFirstOrThrow();
  const writingQuery = defineQuery({ name: 'test.write_path.query_writes', input: z.object({}), access: ['owner'], handler: (ctx) => party(ctx) });
  const writingCommand = defineCommand({ sideEffect: 'none', name: 'test.write_path.command_writes', input: z.object({}), risk: 'R0', access: ['owner'], handler: (ctx) => party(ctx) });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 2 });
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, writingCommand], queries: [...kernelQueries({ inboundDomain: null }), writingQuery] });
    owner = await upsertIdentity(db, { issuer: 'write-path.test', subject: randomUUID(), email: `owner-${randomUUID()}@write-path.test`, name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, 'Write path'));
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets login roles write only tables under row-level security, and pg-boss for the worker', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows: roles } = await admin.query<{ rolname: string }>(`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])`, [LOGIN_ROLES]);
      expect(roles.map((r) => r.rolname).sort()).toEqual([...LOGIN_ROLES].sort());
      // Every relation of every non-system schema a login role can insert into, update (any column), or delete from,
      // through any role it can act as; with whether it has org_id, row-level security on, and a policy.
      const { rows } = await admin.query<{ role: string; schema: string; relation: string; ops: string; org_id: boolean; rls: boolean; policies: number }>(
        `SELECT r.role, n.nspname AS schema, c.relname AS relation,
                pg_catalog.concat_ws(',',
                  CASE WHEN pg_catalog.has_any_column_privilege(r.role, c.oid, 'INSERT') THEN 'INSERT' END,
                  CASE WHEN pg_catalog.has_any_column_privilege(r.role, c.oid, 'UPDATE') THEN 'UPDATE' END,
                  CASE WHEN pg_catalog.has_table_privilege(r.role, c.oid, 'DELETE') THEN 'DELETE' END) AS ops,
                EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped) AS org_id,
                c.relrowsecurity AS rls,
                (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN pg_catalog.unnest($1::text[]) AS r(role)
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
           AND (pg_catalog.has_any_column_privilege(r.role, c.oid, 'INSERT')
                OR pg_catalog.has_any_column_privilege(r.role, c.oid, 'UPDATE')
                OR pg_catalog.has_table_privilege(r.role, c.oid, 'DELETE'))
         ORDER BY 2, 3, 1`,
        [LOGIN_ROLES],
      );
      // The tenant tables are writable (the command path), so the query sees what it is meant to.
      expect(rows.some((r) => r.role === 'crove_app' && r.schema === 'crove_kernel' && r.relation === 'party')).toBe(true);
      const offenders = rows
        .filter((r) => !(r.org_id && r.rls && r.policies > 0))
        .filter((r) => !OUTSIDE_RLS.some((o) => o.role === r.role && o.schema === r.schema))
        .map((r) => `${r.role} ${r.ops} ${r.schema}.${r.relation}${r.org_id ? ' (org_id without row-level security or a policy)' : ''}`);
      expect(offenders, 'a login role writes a relation outside row-level security: write it through a definer function').toEqual([]);
      // Each exception is still needed.
      for (const o of OUTSIDE_RLS) {
        expect(rows.some((r) => r.role === o.role && r.schema === o.schema && !r.rls), `${o.role} on ${o.schema} no longer needs OUTSIDE_RLS`).toBe(true);
      }
    } finally {
      await admin.end();
    }
  });

  it('runs a query READ ONLY: a query that writes is refused, the same write in a command commits', async () => {
    const actor = { type: 'user' as const, userId: owner, aal: 'aal1' as const };
    const count = async () => {
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        return (await admin.query<{ n: number }>(`SELECT pg_catalog.count(*)::int AS n FROM crove_kernel.party WHERE org_id = $1`, [orgId])).rows[0]?.n;
      } finally {
        await admin.end();
      }
    };
    const before = await count();
    // The runtime answers an unexpected database error as INTERNAL and logs the original; the log names the cause.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runtime.query('test.write_path.query_writes', {}, { actor, orgId })).rejects.toMatchObject({ code: 'INTERNAL' });
      const causes = logged.mock.calls.flat().map((x) => (x as { code?: string } | null)?.code);
      // 25006: read_only_sql_transaction.
      expect(causes).toContain('25006');
    } finally {
      logged.mockRestore();
    }
    expect(await count()).toBe(before);
    const written = await runtime.execute<{ id: string }>('test.write_path.command_writes', {}, { actor, orgId });
    expect(written.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await count()).toBe((before ?? 0) + 1);
  });
});
