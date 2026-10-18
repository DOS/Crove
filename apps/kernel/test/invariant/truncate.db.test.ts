// No Crove role may TRUNCATE (issue #333, item 3) on a real PostgreSQL 17. TRUNCATE skips row-level security and
// every row trigger (append-only guards, the agent write guard, the ledger checks), so a role holding it on any table
// of a crove_* schema could empty that table for every org at once. The RLS matrix checks the tables with org_id; this
// walks every table of every crove_* schema, pg-boss's and the migration ledger's included, for every crove_* role and
// every role a Crove role can act as. Part of the invariant suite: CI runs this file from the base branch on
// protected-path PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own
// database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@crove/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

suite('no TRUNCATE for Crove roles', () => {
  const dbName = `crove_test_truncate_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
  });

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('grants TRUNCATE on no table of a crove_* schema to any Crove role, directly or through a role it can act as', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows: roles } = await admin.query<{ rolname: string }>(`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\\_%' ORDER BY rolname`);
      // The login, group, definer-owner and module roles all exist after the migrations.
      expect(roles.map((r) => r.rolname)).toEqual(expect.arrayContaining(['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']));
      const { rows: tables } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname LIKE 'crove\\_%' AND c.relkind IN ('r', 'p')`,
      );
      expect(tables[0]?.n).toBeGreaterThan(40);
      // has_table_privilege counts privileges a role holds through the roles it inherits; a role it may only SET ROLE
      // to (no INHERIT) is checked as that role in its own right, since every role named crove_* is in the list.
      const { rows } = await admin.query<{ role: string; table: string }>(
        `SELECT r.rolname AS role, n.nspname || '.' || c.relname AS table
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN pg_catalog.pg_roles r
         WHERE n.nspname LIKE 'crove\\_%' AND c.relkind IN ('r', 'p') AND r.rolname LIKE 'crove\\_%'
           AND pg_catalog.has_table_privilege(r.oid, c.oid, 'TRUNCATE')
         ORDER BY 1, 2`,
      );
      expect(rows).toEqual([]);
      // Nor through PUBLIC.
      const { rows: publicGrants } = await admin.query<{ table: string }>(
        `SELECT n.nspname || '.' || c.relname AS table
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, pg_catalog.aclexplode(c.relacl) a
         WHERE n.nspname LIKE 'crove\\_%' AND a.grantee = 0 AND a.privilege_type = 'TRUNCATE'`,
      );
      expect(publicGrants).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});
