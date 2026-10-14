// Hosted PostgreSQL runs migrations as a role that is not a superuser (CREATEROLE, owns the database).
// The built-in runner must apply every migration as such a role, run again cleanly, and every file must be
// re-applicable. Set CROVE_TEST_ADMIN_URL to a superuser URL; the test creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, readMigrations } from '../src/migrate.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const RUNNER = 'crove_test_runner';
// Roles are cluster-wide. When an earlier run already created them, the runner gets the ADMIN OPTION it
// would hold as their creator.
const CROVE_ROLES = ['crove_tenant', 'crove_app', 'crove_worker', 'crove_definer_tenant'];

const suite = ADMIN ? describe : describe.skip;

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

suite('migrations with a runner that is not a superuser', () => {
  const dbName = `crove_test_runner_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let runnerUrl = '';

  beforeAll(async () => {
    const password = randomUUID();
    await withClient(ADMIN as string, async (admin) => {
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNNER}') THEN
          CREATE ROLE ${RUNNER} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS;
        END IF;
        -- Hosted Supabase already has this role, so the bootstrap leaves it alone.
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
          CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE;
        END IF;
      END $$`);
      const { rows } = await admin.query<{ sql: string }>('SELECT format($$ALTER ROLE %I PASSWORD %L$$, $1::text, $2::text) AS sql', [
        RUNNER,
        password,
      ]);
      await admin.query(rows[0]?.sql ?? '');
      for (const role of CROVE_ROLES) {
        await admin.query(`DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            GRANT ${role} TO ${RUNNER} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
          END IF;
        END $$`);
      }
      await admin.query(`CREATE DATABASE ${dbName} OWNER ${RUNNER}`);
    });
    const url = new URL(ADMIN as string);
    url.username = RUNNER;
    url.password = password;
    url.pathname = `/${dbName}`;
    runnerUrl = url.toString();
  });

  afterAll(async () => {
    if (!ADMIN) return;
    await withClient(ADMIN, (admin) => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
  });

  it('applies every migration, runs again cleanly, and every file can be re-applied', async () => {
    const files = await readMigrations(MIGRATIONS);
    expect(await migrate({ adminUrl: runnerUrl, dir: MIGRATIONS })).toEqual(files.map((f) => f.name));
    expect(await migrate({ adminUrl: runnerUrl, dir: MIGRATIONS })).toEqual([]);

    await withClient(runnerUrl, async (runner) => {
      const { rows } = await runner.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
      expect(rows[0]?.rolsuper).toBe(false);
      for (const file of files) {
        await runner.query('BEGIN');
        try {
          await runner.query(file.sql);
          await runner.query('COMMIT');
        } catch (error) {
          await runner.query('ROLLBACK');
          throw new Error(`re-applying ${file.name} failed: ${(error as Error).message}`, { cause: error });
        }
      }
    });
  });

  it('hands the posting function to the definer role with only the intended privileges', async () => {
    await withClient(runnerUrl, async (runner) => {
      const { rows } = await runner.query<{ owner: string; tenant: boolean; public: boolean; definer_create: boolean }>(`
        SELECT pg_get_userbyid(p.proowner) AS owner,
               has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant,
               EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public,
               has_schema_privilege('crove_definer_tenant', 'crove_finance', 'CREATE') AS definer_create
        FROM pg_proc p WHERE p.oid = 'crove_finance.post_journal_entry(date, text, text, uuid, jsonb)'::regprocedure`);
      expect(rows).toEqual([{ owner: 'crove_definer_tenant', tenant: true, public: false, definer_create: false }]);
    });
  });
});
