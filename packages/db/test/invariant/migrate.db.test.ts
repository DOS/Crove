// Hosted PostgreSQL runs migrations as a role that is not a superuser (CREATEROLE, owns the database).
// The built-in runner must apply every migration as such a role, run again cleanly, and every file must be
// re-applicable. Set CROVE_TEST_ADMIN_URL to a superuser URL; the test creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hardeningViolations, migrate, readMigrations } from '../../src/migrate.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const RUNNER = 'crove_test_runner';
// Roles are cluster-wide. When an earlier run already created them, the runner gets the ADMIN OPTION it
// would hold as their creator.
const CROVE_ROLES = ['crove_tenant', 'crove_app', 'crove_worker', 'crove_definer_tenant', 'crove_auth_reader'];

// A run's database is crove_test_runner_<id> (plus <id>_notowner) and its roles t100_test_runner_<id>_*, with
// <id> = <Date.now()>_<random>. Another run's leftovers are swept once they are this old and unused.
const STALE_MS = 10 * 60_000;
const RUN_ID = /^(?:crove|t100)_test_runner_(\d+)_(\d+)(?:_|$)/;

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

function adminUrlFor(db: string): string {
  const url = new URL(ADMIN as string);
  url.pathname = `/${db}`;
  return url.toString();
}

// Roles are cluster-wide. A run that dies before its cleanup leaves its roles behind, and the next migrate of any
// database on the cluster grants them TEMPORARY (20261015120000_crove_kernel_revoke_temp keeps it for every
// non-Crove role that holds it through PUBLIC); a proxy that can act as Crove roles then fails the T17 check
// there. Such a grant also blocks a plain DROP ROLE. So: DROP OWNED in every database where the role owns or
// holds something (it also revokes privileges on shared objects such as databases), then DROP ROLE.
async function dropRoles(prefix: string): Promise<void> {
  await withClient(ADMIN as string, async (admin) => {
    const { rows } = await admin.query<{ rolname: string; dbs: string[] }>(
      `SELECT r.rolname, COALESCE(array_agg(DISTINCT d.datname::text) FILTER (WHERE d.datname IS NOT NULL), '{}') AS dbs
       FROM pg_roles r
       LEFT JOIN pg_shdepend s ON s.refclassid = 'pg_authid'::regclass AND s.refobjid = r.oid
       LEFT JOIN pg_database d ON d.oid = s.dbid AND d.datallowconn AND d.datname <> current_database()
       WHERE starts_with(r.rolname, $1)
       GROUP BY r.rolname`,
      [prefix],
    );
    // A concurrent sweep may drop the same role or database first.
    const gone = (error: unknown) => ['42704', '3D000'].includes((error as { code?: string }).code ?? '');
    for (const { rolname, dbs } of rows) {
      const role = admin.escapeIdentifier(rolname);
      for (const db of dbs) {
        await withClient(adminUrlFor(db), (c) => c.query(`DROP OWNED BY ${role}`)).catch((error: unknown) => {
          if (!gone(error)) throw error;
        });
      }
      await admin.query(`DROP OWNED BY ${role}`).catch((error: unknown) => {
        if (!gone(error)) throw error;
      });
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
  });
}

// Drops the databases and roles of earlier runs that are older than STALE_MS and have no session in their
// databases, so an aborted run stops breaking migrate on a shared cluster. A live concurrent run is younger
// or connected, so it keeps its own.
async function dropStaleRuns(): Promise<void> {
  const ids = await withClient(ADMIN as string, async (admin) => {
    const { rows } = await admin.query<{ name: string }>(
      `SELECT rolname::text AS name FROM pg_roles WHERE rolname LIKE 't100\\_test\\_runner\\_%'
       UNION SELECT datname::text FROM pg_database WHERE datname LIKE 'crove\\_test\\_runner\\_%'`,
    );
    const stale = new Set<string>();
    for (const { name } of rows) {
      const match = RUN_ID.exec(name);
      if (match && Date.now() - Number(match[1]) > STALE_MS) stale.add(`${match[1]}_${match[2]}`);
    }
    const idle: string[] = [];
    for (const id of stale) {
      const { rows: busy } = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname = ANY($1::text[])', [
        [`crove_test_runner_${id}`, `crove_test_runner_${id}_notowner`],
      ]);
      if (busy.length === 0) idle.push(id);
    }
    return idle;
  });
  for (const id of ids) {
    // No FORCE: a session that connected since the check above (55006) means the run is not dead after all.
    const dropped = await withClient(ADMIN as string, async (admin) => {
      try {
        await admin.query(`DROP DATABASE IF EXISTS crove_test_runner_${id}_notowner`);
        await admin.query(`DROP DATABASE IF EXISTS crove_test_runner_${id}`);
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === '55006') return false;
        throw error;
      }
    });
    if (dropped) await dropRoles(`t100_test_runner_${id}_`);
  }
}

// G3 (plan §10): re-applying the migrations must change nothing. The fingerprint maps every object of the crove_*
// schemas (plus the event triggers, the Crove roles and their memberships) to its definition, and every table to
// its row count, so a file that re-runs without error but adds a seed row, widens a grant, toggles a setting or
// leaves an older function body behind shows up as a named difference. Names, never OIDs: re-created objects get
// new ones. ACLs are sorted, since a REVOKE and GRANT may reorder them without changing what they allow.
const acl = (column: string) => `'acl=' || (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(${column}) x)`;
const FINGERPRINT_QUERIES: Record<string, string> = {
  schema: `
    SELECT n.nspname AS key, concat_ws(' ', pg_get_userbyid(n.nspowner), ${acl('n.nspacl')}) AS def
    FROM pg_namespace n WHERE n.nspname LIKE 'crove\\_%'`,
  relation: `
    SELECT format('%s.%s', n.nspname, c.relname) AS key,
           concat_ws(' ', c.relkind, c.relpersistence, pg_get_userbyid(c.relowner), ${acl('c.relacl')}, 'rls=' || c.relrowsecurity,
                     'force=' || c.relforcerowsecurity, 'replica=' || c.relreplident::text, c.reloptions::text) AS def
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'crove\\_%'`,
  column: `
    SELECT format('%s.%s.%s', n.nspname, c.relname, a.attname) AS key,
           concat_ws(' ', format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'not null' END,
                     'default=' || pg_get_expr(d.adbin, d.adrelid), 'identity=' || NULLIF(a.attidentity::text, ''),
                     'generated=' || NULLIF(a.attgenerated::text, ''), 'collation=' || NULLIF(a.attcollation, 0)::regcollation::text,
                     ${acl('a.attacl')}) AS def
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname LIKE 'crove\\_%' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')`,
  constraint: `
    SELECT format('%s.%s.%s', n.nspname, COALESCE(c.relname, t.typname), k.conname) AS key,
           concat_ws(' ', pg_get_constraintdef(k.oid), CASE WHEN NOT k.convalidated THEN 'not valid' END) AS def
    FROM pg_constraint k
    JOIN pg_namespace n ON n.oid = k.connamespace
    LEFT JOIN pg_class c ON c.oid = k.conrelid
    LEFT JOIN pg_type t ON t.oid = k.contypid
    WHERE n.nspname LIKE 'crove\\_%'`,
  index: `
    SELECT format('%s.%s', n.nspname, c.relname) AS key, pg_get_indexdef(c.oid) AS def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname LIKE 'crove\\_%'`,
  view: `
    SELECT format('%s.%s', n.nspname, c.relname) AS key, pg_get_viewdef(c.oid) AS def
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname LIKE 'crove\\_%' AND c.relkind IN ('v', 'm')`,
  sequence: `
    SELECT s.seqrelid::regclass::text AS key,
           concat_ws(' ', format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle) AS def
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname LIKE 'crove\\_%'`,
  policy: `
    SELECT format('%s.%s.%s', p.schemaname, p.tablename, p.policyname) AS key,
           concat_ws(' ', p.permissive, p.cmd, (SELECT string_agg(r, ',' ORDER BY r) FROM unnest(p.roles) r),
                     'using=' || p.qual, 'check=' || p.with_check) AS def
    FROM pg_policies p WHERE p.schemaname LIKE 'crove\\_%'`,
  trigger: `
    SELECT format('%s.%s.%s', n.nspname, c.relname, t.tgname) AS key, concat_ws(' ', pg_get_triggerdef(t.oid), t.tgenabled) AS def
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname LIKE 'crove\\_%' AND NOT t.tgisinternal`,
  function: `
    SELECT p.oid::regprocedure::text AS key,
           concat_ws(' ', p.prokind, pg_get_function_result(p.oid), pg_get_userbyid(p.proowner), ${acl('p.proacl')},
                     CASE WHEN p.prosecdef THEN 'definer' END, p.provolatile, p.proparallel,
                     CASE WHEN p.proleakproof THEN 'leakproof' END, CASE WHEN p.proisstrict THEN 'strict' END,
                     p.proconfig::text, md5(p.prosrc)) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname LIKE 'crove\\_%'`,
  type: `
    SELECT format('%s.%s', n.nspname, t.typname) AS key,
           concat_ws(' ', t.typtype, pg_get_userbyid(t.typowner), ${acl('t.typacl')}, format_type(NULLIF(t.typbasetype, 0), NULLIF(t.typtypmod, -1)),
                     CASE WHEN t.typnotnull THEN 'not null' END, 'default=' || t.typdefault,
                     (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)) AS def
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_class c ON c.oid = t.typrelid
    WHERE n.nspname LIKE 'crove\\_%' AND (t.typtype IN ('e', 'd', 'r', 'm') OR c.relkind = 'c')`,
  comment: `
    SELECT format('%s:%s', d.classoid::regclass, pg_describe_object(d.classoid, d.objoid, d.objsubid)) AS key, d.description AS def
    FROM pg_description d
    WHERE d.classoid IN ('pg_class'::regclass, 'pg_proc'::regclass, 'pg_namespace'::regclass, 'pg_type'::regclass)
      AND pg_describe_object(d.classoid, d.objoid, d.objsubid) ~ '(^| )crove_'`,
  'event trigger': `
    SELECT e.evtname AS key,
           concat_ws(' ', e.evtevent, e.evtfoid::regprocedure, e.evtenabled, pg_get_userbyid(e.evtowner),
                     (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(e.evttags) x)) AS def
    FROM pg_event_trigger e`,
  'default privileges': `
    SELECT concat_ws('.', pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype) AS key, ${acl('d.defaclacl')} AS def
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace`,
  database: `SELECT 'acl' AS key, ${acl('d.datacl')} AS def FROM pg_database d WHERE d.datname = current_database()`,
  role: `
    SELECT r.rolname AS key,
           concat_ws(' ', 'super=' || r.rolsuper, 'inherit=' || r.rolinherit, 'createrole=' || r.rolcreaterole,
                     'createdb=' || r.rolcreatedb, 'login=' || r.rolcanlogin, 'bypassrls=' || r.rolbypassrls,
                     (SELECT s.setconfig::text FROM pg_db_role_setting s
                      WHERE s.setrole = r.oid AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                      ORDER BY s.setdatabase LIMIT 1)) AS def
    FROM pg_roles r WHERE r.rolname LIKE 'crove\\_%' AND r.rolname NOT LIKE 'crove\\_test\\_%'`,
  membership: `
    SELECT format('%s in %s', pg_get_userbyid(m.member), pg_get_userbyid(m.roleid)) AS key,
           concat_ws(' ', 'admin=' || m.admin_option, 'inherit=' || m.inherit_option, 'set=' || m.set_option) AS def
    FROM pg_auth_members m
    WHERE pg_get_userbyid(m.roleid) LIKE 'crove\\_%' AND pg_get_userbyid(m.member) LIKE 'crove\\_%'
      AND pg_get_userbyid(m.member) NOT LIKE 'crove\\_test\\_%' AND pg_get_userbyid(m.roleid) NOT LIKE 'crove\\_test\\_%'`,
};

// Tables whose rows record the re-application itself rather than what the migrations define.
const ROWS_EXEMPT = new Set<string>([]);

async function catalogFingerprint(client: pg.Client): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [kind, sql] of Object.entries(FINGERPRINT_QUERIES)) {
    const { rows } = await client.query<{ key: string; def: string | null }>(sql);
    for (const { key, def } of rows) out.set(`${kind} ${key}`, def ?? '');
  }
  const { rows: tables } = await client.query<{ name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname LIKE 'crove\\_%' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
  for (const { name } of tables) {
    if (ROWS_EXEMPT.has(name)) continue;
    const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ONLY ${name}`);
    out.set(`rows ${name}`, rows[0]?.n ?? '');
  }
  return out;
}

function fingerprintDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [key, def] of before) {
    if (!after.has(key)) out.push(`removed ${key}: ${def}`);
    else if (after.get(key) !== def) out.push(`changed ${key}: ${def} -> ${after.get(key) ?? ''}`);
  }
  for (const [key, def] of after) if (!before.has(key)) out.push(`added ${key}: ${def}`);
  return out.sort();
}

suite('migrations with a runner that is not a superuser', () => {
  const dbName = `crove_test_runner_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const tag = dbName.replace(/^crove_/, 't100_');
  let runnerUrl = '';

  beforeAll(async () => {
    await dropStaleRuns();
    // The runner role is shared by every run on the cluster, so concurrent runs must set the same password. It is
    // derived from the superuser credentials, which already grant everything the runner has.
    const password = createHash('sha256').update(`${RUNNER}:${ADMIN as string}`).digest('hex');
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

  // Runs when a test fails too; a killed run is swept by a later run (dropStaleRuns).
  afterAll(async () => {
    if (!ADMIN) return;
    try {
      await withClient(ADMIN, async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}_notowner WITH (FORCE)`);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      });
    } finally {
      await dropRoles(`${tag}_`);
    }
  });

  it('applies every migration, runs again cleanly, and every file can be re-applied without changing anything', async () => {
    const files = await readMigrations(MIGRATIONS);
    expect(await migrate({ adminUrl: runnerUrl, dir: MIGRATIONS })).toEqual(files.map((f) => f.name));
    expect(await migrate({ adminUrl: runnerUrl, dir: MIGRATIONS })).toEqual([]);

    await withClient(runnerUrl, async (runner) => {
      const { rows } = await runner.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
      expect(rows[0]?.rolsuper).toBe(false);
      const before = await catalogFingerprint(runner);
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
      expect(fingerprintDiff(before, await catalogFingerprint(runner))).toEqual([]);
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
        WHERE p.oid IN ('crove_kernel.auth_session_valid(uuid, uuid)'::regprocedure, 'crove_kernel.auth_user_sessions(uuid)'::regprocedure,
                        'crove_kernel.auth_user_has_verified_factor(uuid)'::regprocedure,
                        'crove_kernel.auth_session_oauth_bound(uuid)'::regprocedure)
        ORDER BY 1`);
      expect(rows).toEqual([
        { fn: 'crove_kernel.auth_session_oauth_bound(uuid)', owner: 'crove_auth_reader', app: false, public: false },
        { fn: 'crove_kernel.auth_session_valid(uuid,uuid)', owner: 'crove_auth_reader', app: false, public: false },
        { fn: 'crove_kernel.auth_user_has_verified_factor(uuid)', owner: 'crove_auth_reader', app: false, public: false },
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

  // #179: the guard turns JIT off while it runs (it cost about 0.8 s per call) and gives the session its setting back.
  it('leaves the caller with its own jit setting', async () => {
    await withClient(runnerUrl, async (runner) => {
      const jit = async () => (await runner.query<{ jit: string }>("SELECT current_setting('jit') AS jit")).rows[0]?.jit;
      for (const setting of ['on', 'off']) {
        await runner.query(`SET jit = ${setting}`);
        expect(await hardeningViolations(runner)).toEqual([]);
        expect(await jit()).toBe(setting);
        await runner.query('BEGIN');
        expect(await hardeningViolations(runner)).toEqual([]);
        expect(await jit()).toBe(setting);
        await runner.query('COMMIT');
        expect(await jit()).toBe(setting);
      }
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
          CREATE FUNCTION crove_jobs.t17_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
          GRANT CREATE ON SCHEMA crove_jobs TO crove_worker;`);
        await runner.query(`GRANT TEMPORARY ON DATABASE ${dbName} TO crove_app`);
        const unpinned = (fn: string, settings: string, fix: string) =>
          `function ${fn} has settings ${settings}, expected "search_path=pg_catalog, pg_temp"; fix in a new migration: ${fix}`;
        const pin = (fn: string, kind = 'FUNCTION') => `ALTER ${kind} ${fn} SET search_path = pg_catalog, pg_temp`;
        expect(await hardeningViolations(runner)).toEqual([
          unpinned('crove_finance.t17_empty()', '"search_path="""', pin('crove_finance.t17_empty()')),
          unpinned('crove_finance.t17_none()', '(none)', pin('crove_finance.t17_none()')),
          unpinned('crove_jobs.t17_definer()', '(none)', pin('crove_jobs.t17_definer()')),
          unpinned(
            'crove_t17.t17_extra()',
            '"search_path=pg_catalog, pg_temp; work_mem=64kB"',
            `ALTER FUNCTION crove_t17.t17_extra() RESET ALL; ${pin('crove_t17.t17_extra()')}`,
          ),
          unpinned('crove_t17.t17_partial()', '"search_path=pg_catalog"', pin('crove_t17.t17_partial()')),
          unpinned('crove_t17.t17_proc()', '(none)', pin('crove_t17.t17_proc()', 'PROCEDURE')),
          'role crove_worker may CREATE in schema crove_jobs, so functions there cannot stay exempt; fix: REVOKE CREATE ON SCHEMA crove_jobs FROM crove_worker',
          `role crove_app can create temporary objects (TEMPORARY on database ${dbName}); fix as the database owner or a superuser: ` +
            `GRANT TEMPORARY ON DATABASE ${dbName} directly to any non-Crove role that needs it, then ` +
            `REVOKE TEMPORARY ON DATABASE ${dbName} FROM PUBLIC, crove_app`,
        ]);
      } finally {
        await runner.query('ROLLBACK');
      }
      expect(await hardeningViolations(runner)).toEqual([]);
    });
  });

  // #100: functions outside crove_* schemas that crove_* objects reach without naming them, and TEMPORARY for
  // non-Crove roles that can act as a Crove role. Each planted function is reached through exactly one path.
  it('reports reachable functions outside crove_* schemas, and TEMPORARY for members of Crove roles', async () => {
    // Acts as every owner of a crove_* definer (through the runner), so TEMPORARY gains it nothing. Granting the
    // runner role needs a superuser, and the runner's transaction cannot see an uncommitted role. The role is
    // committed, so a concurrent run of this file on the same cluster sees it: INHERIT FALSE (it still acts as the
    // runner through SET) keeps it from holding CREATE on the crove_jobs schema that run's runner owns.
    await withClient(ADMIN as string, (admin) =>
      admin.query(`CREATE ROLE ${tag}_proxy; GRANT ${RUNNER} TO ${tag}_proxy WITH INHERIT FALSE`),
    );
    try {
      await withClient(runnerUrl, async (runner) => {
        await runner.query('BEGIN');
        try {
          const diff = (name: string) =>
            `CREATE FUNCTION t100_ext.diff_${name}(float8, float8) RETURNS float8 LANGUAGE sql IMMUTABLE SECURITY DEFINER AS $$ SELECT $1 - $2 $$;
             CREATE TYPE t100_ext.span_${name} AS RANGE (subtype = float8, subtype_diff = t100_ext.diff_${name});`;
          await runner.query(`
            CREATE SCHEMA crove_t100;
            CREATE SCHEMA t100_ext;
            CREATE FUNCTION t100_ext.trg_definer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$;
            CREATE FUNCTION t100_ext.trg_pinned() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
              SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$;
            CREATE FUNCTION t100_ext.trg_invoker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
            CREATE FUNCTION t100_ext.when_fn(int) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT true $$;
            CREATE FUNCTION t100_ext.dflt() RETURNS int LANGUAGE sql SET search_path = public AS $$ SELECT 1 $$;
            CREATE FUNCTION t100_ext.op_fn(int, int) RETURNS boolean LANGUAGE sql SET search_path = '' AS $$ SELECT $1 = $2 $$;
            CREATE OPERATOR t100_ext.=== (LEFTARG = int, RIGHTARG = int, FUNCTION = t100_ext.op_fn);
            ${diff('base')}
            ${diff('elem')}
            ${diff('attr')}
            ${diff('multi')}
            ${diff('arg')}
            ${diff('sub')}
            CREATE TYPE t100_ext.inner AS (x t100_ext.span_sub);
            CREATE TYPE t100_ext.outer_range AS RANGE (subtype = t100_ext.inner);
            CREATE DOMAIN crove_t100.span_base AS t100_ext.span_base;
            CREATE TYPE t100_ext.pair AS (a int, s t100_ext.span_attr);
            CREATE FUNCTION t100_ext.bit_pair(bit) RETURNS t100_ext.pair LANGUAGE sql SET search_path = public, pg_temp AS $$ SELECT NULL::t100_ext.pair $$;
            CREATE CAST (bit AS t100_ext.pair) WITH FUNCTION t100_ext.bit_pair(bit);
            CREATE FUNCTION t100_ext.dom_default() RETURNS int LANGUAGE sql SET search_path = public AS $$ SELECT 1 $$;
            CREATE FUNCTION t100_ext.dom_check(int) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT true $$;
            CREATE DOMAIN t100_ext.dom AS int DEFAULT t100_ext.dom_default() CONSTRAINT dom_ok CHECK (t100_ext.dom_check(VALUE));
            CREATE FUNCTION t100_ext.agg_step(int, int) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT $1 + $2 $$;
            CREATE AGGREGATE t100_ext.agg(int) (sfunc = t100_ext.agg_step, stype = int);
            CREATE FUNCTION t100_ext.unused() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
            CREATE TABLE crove_t100.t (
              a int DEFAULT t100_ext.dflt() CONSTRAINT t_a_same CHECK (a OPERATOR(t100_ext.===) a),
              s crove_t100.span_base,
              sa t100_ext.span_elem[],
              p t100_ext.pair,
              m t100_ext.span_multi_multirange,
              d t100_ext.dom,
              o t100_ext.outer_range);
            CREATE VIEW crove_t100.v AS SELECT t100_ext.agg(a) AS total FROM crove_t100.t;
            CREATE FUNCTION crove_t100.f(t100_ext.span_arg) RETURNS int LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;
            CREATE TRIGGER t_definer BEFORE INSERT ON crove_t100.t FOR EACH ROW EXECUTE FUNCTION t100_ext.trg_definer();
            CREATE TRIGGER t_pinned BEFORE INSERT ON crove_t100.t FOR EACH ROW EXECUTE FUNCTION t100_ext.trg_pinned();
            CREATE TRIGGER t_when BEFORE INSERT ON crove_t100.t FOR EACH ROW WHEN (t100_ext.when_fn(NEW.a))
              EXECUTE FUNCTION t100_ext.trg_invoker();
            CREATE ROLE ${tag}_member;
            GRANT crove_tenant TO ${tag}_member WITH INHERIT TRUE, SET FALSE;
            CREATE ROLE ${tag}_group;
            GRANT crove_definer_tenant TO ${tag}_group;
            CREATE ROLE ${tag}_nested;
            GRANT ${tag}_group TO ${tag}_nested;
            CREATE ROLE ${tag}_setonly;
            GRANT crove_tenant TO ${tag}_setonly WITH INHERIT FALSE, SET TRUE;
            CREATE ROLE ${tag}_admin;
            GRANT crove_tenant TO ${tag}_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
            CREATE ROLE ${tag}_outsider;
            GRANT TEMPORARY ON DATABASE ${dbName}
              TO ${tag}_member, ${tag}_nested, ${tag}_setonly, ${tag}_admin, ${tag}_outsider, ${tag}_proxy;`);
          const reached = (fn: string, via: string, setting: string) =>
            `function ${fn} is reached from crove_* objects (${via}) and ${setting}, expected "search_path=pg_catalog, pg_temp"; ` +
            `fix in a new migration as its owner: ALTER FUNCTION ${fn} SET search_path = pg_catalog, pg_temp, or stop using it from crove_* objects`;
          const member = (role: string, via: string, grants: string) =>
            `role ${role} can create temporary objects (TEMPORARY on database ${dbName}) and can act as ${via}; ` +
            `fix as the database owner or a superuser: REVOKE ${grants} FROM ${role}, or take TEMPORARY away from ${role} ` +
            `(REVOKE TEMPORARY ON DATABASE ${dbName} FROM ${role}, and from PUBLIC or any role it inherits TEMPORARY from)`;
          const definer = 'is SECURITY DEFINER with no search_path setting';
          const diffFn = (name: string) => `t100_ext.diff_${name}(double precision,double precision)`;
          expect(await hardeningViolations(runner)).toEqual([
            reached('t100_ext.agg_step(integer,integer)', 'function t100_ext.agg(integer)', definer),
            reached('t100_ext.bit_pair(bit)', 'cast from bit to t100_ext.pair', 'sets "search_path=public, pg_temp"'),
            reached('t100_ext.dflt()', 'default value for column a of table crove_t100.t', 'sets "search_path=public"'),
            reached(diffFn('arg'), 'type t100_ext.span_arg', definer),
            reached(diffFn('attr'), 'type t100_ext.span_attr', definer),
            reached(diffFn('base'), 'type t100_ext.span_base', definer),
            reached(diffFn('elem'), 'type t100_ext.span_elem', definer),
            reached(diffFn('multi'), 'type t100_ext.span_multi', definer),
            reached(diffFn('sub'), 'type t100_ext.span_sub', definer),
            reached('t100_ext.dom_check(integer)', 'constraint dom_ok', definer),
            reached('t100_ext.dom_default()', 'type t100_ext.dom', 'sets "search_path=public"'),
            reached('t100_ext.op_fn(integer,integer)', 'constraint t_a_same on table crove_t100.t', 'sets "search_path="""'),
            reached('t100_ext.trg_definer()', 'trigger t_definer on table crove_t100.t', definer),
            reached('t100_ext.when_fn(integer)', 'trigger t_when on table crove_t100.t', definer),
            member(`${tag}_admin`, 'crove_tenant', 'crove_tenant'),
            member(`${tag}_member`, 'crove_tenant', 'crove_tenant'),
            member(`${tag}_nested`, 'crove_definer_tenant, crove_tenant', `${tag}_group`),
            member(`${tag}_setonly`, 'crove_tenant', 'crove_tenant'),
          ]);
        } finally {
          await runner.query('ROLLBACK');
        }
        expect(await hardeningViolations(runner)).toEqual([]);
      });
    } finally {
      // Not a plain DROP ROLE: a migrate of another database on the cluster may have granted the proxy TEMPORARY
      // there in the meantime.
      await dropRoles(`${tag}_`);
    }
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

  // GRANT and REVOKE on a database by a role that does not own it only warn, so the file must refuse
  // instead of landing in the ledger with nothing revoked.
  it('refuses the TEMP revoke for a runner that does not own the database, until the owner has done it', async () => {
    const file = (await readMigrations(MIGRATIONS)).find((f) => f.name.endsWith('_crove_kernel_revoke_temp.sql'));
    expect(file).toBeDefined();
    const other = `${dbName}_notowner`;
    await withClient(ADMIN as string, (admin) => admin.query(`CREATE DATABASE ${other}`));
    try {
      const url = new URL(runnerUrl);
      url.pathname = `/${other}`;
      await withClient(url.toString(), async (runner) => {
        await expect(runner.query(file?.sql ?? '')).rejects.toThrow(
          new RegExp(`neither a superuser nor a member of the owner of database ${other}[\\s\\S]*Run migrate as the database owner`),
        );
        const adminUrl = new URL(ADMIN as string);
        adminUrl.pathname = `/${other}`;
        await withClient(adminUrl.toString(), (owner) => owner.query(`REVOKE TEMPORARY ON DATABASE ${other} FROM PUBLIC`));
        await runner.query(file?.sql ?? '');
      });
    } finally {
      await withClient(ADMIN as string, (admin) => admin.query(`DROP DATABASE IF EXISTS ${other} WITH (FORCE)`));
    }
  });
});
