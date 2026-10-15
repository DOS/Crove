// Hosted PostgreSQL runs migrations as a role that is not a superuser (CREATEROLE, owns the database).
// The built-in runner must apply every migration as such a role, run again cleanly, and every file must be
// re-applicable. Set CROVE_TEST_ADMIN_URL to a superuser URL; the test creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hardeningViolations, migrate, readMigrations } from '../src/migrate.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const RUNNER = 'crove_test_runner';
// Roles are cluster-wide. When an earlier run already created them, the runner gets the ADMIN OPTION it
// would hold as their creator.
const CROVE_ROLES = ['crove_tenant', 'crove_app', 'crove_worker', 'crove_definer_tenant', 'crove_auth_reader'];

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

  it('hands the Supabase Auth readers to crove_auth_reader, callable only through the session check', async () => {
    await withClient(runnerUrl, async (runner) => {
      const { rows } = await runner.query<{ fn: string; owner: string; app: boolean; public: boolean }>(`
        SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner,
               has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app,
               EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
        FROM pg_proc p
        WHERE p.oid IN ('crove_kernel.auth_session_valid(uuid, uuid)'::regprocedure, 'crove_kernel.auth_user_sessions(uuid)'::regprocedure)
        ORDER BY 1`);
      expect(rows).toEqual([
        { fn: 'crove_kernel.auth_session_valid(uuid,uuid)', owner: 'crove_auth_reader', app: false, public: false },
        { fn: 'crove_kernel.auth_user_sessions(uuid)', owner: 'crove_auth_reader', app: false, public: false },
      ]);
      const role = await runner.query(
        `SELECT rolcanlogin, rolsuper, rolbypassrls, has_schema_privilege('crove_auth_reader', 'crove_kernel', 'CREATE') AS can_create
         FROM pg_roles WHERE rolname = 'crove_auth_reader'`,
      );
      expect(role.rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false, can_create: false }]);
    });
  });

  // External-tenant gate T17: every crove_* function pins search_path, and Crove roles have no TEMP.
  it('pins search_path on every function and leaves Crove roles without TEMPORARY', async () => {
    await withClient(runnerUrl, async (runner) => {
      expect(await hardeningViolations(runner)).toEqual([]);
      const { rows } = await runner.query<{ role: string; temp: boolean }>(
        `SELECT r AS role, has_database_privilege(r, current_database(), 'TEMPORARY') AS temp
         FROM unnest(ARRAY[${CROVE_ROLES.map((r) => `'${r}'`).join(', ')}, 'supabase_auth_admin']) r ORDER BY 1`,
      );
      // The bundled Supabase Auth keeps what PUBLIC gave it; only Crove roles lose it.
      expect(rows).toEqual([
        { role: 'crove_app', temp: false },
        { role: 'crove_auth_reader', temp: false },
        { role: 'crove_definer_tenant', temp: false },
        { role: 'crove_tenant', temp: false },
        { role: 'crove_worker', temp: false },
        { role: 'supabase_auth_admin', temp: true },
      ]);
      const { rows: pub } = await runner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_database d, aclexplode(d.datacl) a
         WHERE d.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY'`,
      );
      expect(pub[0]?.n).toBe(0);
    });
  });

  it('reports planted functions that do not pin search_path, and TEMPORARY granted back', async () => {
    await withClient(runnerUrl, async (runner) => {
      await runner.query('BEGIN');
      try {
        await runner.query(`
          CREATE SCHEMA crove_t17;
          CREATE FUNCTION crove_finance.t17_none() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
          CREATE FUNCTION crove_finance.t17_empty() RETURNS int LANGUAGE sql SET search_path = '' AS $$ SELECT 1 $$;
          CREATE FUNCTION crove_t17.t17_partial() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$;
          CREATE FUNCTION crove_t17.t17_extra() RETURNS int LANGUAGE sql SET search_path = pg_catalog, pg_temp SET work_mem = '64kB' AS $$ SELECT 1 $$;
          CREATE PROCEDURE crove_t17.t17_proc() LANGUAGE sql AS $$ SELECT 1 $$;
          CREATE FUNCTION crove_t17.t17_ok() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;
          CREATE SCHEMA IF NOT EXISTS crove_jobs;
          CREATE FUNCTION crove_jobs.t17_invoker() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
          CREATE FUNCTION crove_jobs.t17_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;`);
        await runner.query(`GRANT TEMPORARY ON DATABASE ${dbName} TO crove_app`);
        expect(await hardeningViolations(runner)).toEqual([
          'function crove_finance.t17_empty() has settings "search_path=""", expected "search_path=pg_catalog, pg_temp"',
          'function crove_finance.t17_none() has settings (none), expected "search_path=pg_catalog, pg_temp"',
          'function crove_jobs.t17_definer() has settings (none), expected "search_path=pg_catalog, pg_temp"',
          'function crove_t17.t17_extra() has settings "search_path=pg_catalog, pg_temp; work_mem=64kB", expected "search_path=pg_catalog, pg_temp"',
          'function crove_t17.t17_partial() has settings "search_path=pg_catalog", expected "search_path=pg_catalog, pg_temp"',
          'function crove_t17.t17_proc() has settings (none), expected "search_path=pg_catalog, pg_temp"',
          'role crove_app can create temporary objects (TEMPORARY on the database)',
        ]);
      } finally {
        await runner.query('ROLLBACK');
      }
      expect(await hardeningViolations(runner)).toEqual([]);
    });
  });

  it('fails the migration run loudly while an unpinned function exists', async () => {
    await withClient(runnerUrl, (runner) =>
      runner.query(`CREATE FUNCTION crove_finance.t17_unpinned() RETURNS int LANGUAGE sql SET search_path = '' AS $$ SELECT 1 $$`),
    );
    try {
      await expect(migrate({ adminUrl: runnerUrl, dir: MIGRATIONS })).rejects.toThrow(
        /database hardening check failed[\s\S]*crove_finance\.t17_unpinned\(\)/,
      );
    } finally {
      await withClient(runnerUrl, (runner) => runner.query('DROP FUNCTION crove_finance.t17_unpinned()'));
    }
    expect(await migrate({ adminUrl: runnerUrl, dir: MIGRATIONS })).toEqual([]);
  });
});
