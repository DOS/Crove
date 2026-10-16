// Built-in migration runner: applies supabase/migrations/*.sql in order, one transaction per file,
// recording a ledger in crove_meta.schema_migrations. Works on any PostgreSQL 17; no Supabase CLI.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const FILE_PATTERN = /^(\d{14})_crove_[a-z0-9]+_[a-z0-9_]+\.sql$/;

export interface MigrateOptions {
  adminUrl: string;
  dir: string;
  log?: (message: string) => void;
}

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  sha256: string;
}

export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const match = FILE_PATTERN.exec(name);
    if (!match?.[1]) throw new Error(`migration file name does not match the naming rule: ${name}`);
    // The 14-digit prefix is the ledger version: two files sharing it would fail on a fresh database.
    const other = seen.get(match[1]);
    if (other) throw new Error(`duplicate migration version ${match[1]}: ${other} and ${name}`);
    seen.set(match[1], name);
    // Normalize line endings so a Windows checkout (CRLF) and Linux (LF) hash the same file identically.
    const sql = (await readFile(join(dir, name), 'utf8')).replaceAll('\r\n', '\n');
    files.push({ version: match[1], name, sql, sha256: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

export async function migrate(options: MigrateOptions): Promise<string[]> {
  const log = options.log ?? (() => {});
  const files = await readMigrations(options.dir);
  const client = new pg.Client({ connectionString: options.adminUrl, application_name: 'crove-migrate' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('crove_migrate'))");
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS crove_meta;
      CREATE TABLE IF NOT EXISTS crove_meta.schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );`);
    const { rows } = await client.query<{ version: string; sha256: string }>(
      'SELECT version, sha256 FROM crove_meta.schema_migrations',
    );
    const ledger = new Map(rows.map((r) => [r.version, r.sha256]));
    for (const file of files) {
      const known = ledger.get(file.version);
      if (known !== undefined) {
        if (known !== file.sha256) {
          throw new Error(`migration ${file.name} was edited after it was applied; add a new migration instead`);
        }
        continue;
      }
      log(`applying ${file.name}`);
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO crove_meta.schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [
          file.version,
          file.name,
          file.sha256,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file.name} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(file.name);
    }
    // Let the app roles read the ledger for /readyz.
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crove_tenant') THEN
        GRANT USAGE ON SCHEMA crove_meta TO crove_tenant;
        GRANT SELECT ON crove_meta.schema_migrations TO crove_tenant;
      END IF;
    END $$;`);
    // PostgreSQL grants EXECUTE to PUBLIC on every new function. Module schemas only expose what a
    // migration grants explicitly, so a definer function added later without a REVOKE stays closed.
    await client.query(`DO $$ DECLARE s text; BEGIN
      FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'crove\\_%' AND nspname NOT IN ('crove_meta', 'crove_jobs') LOOP
        EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC', s);
      END LOOP;
    END $$;`);
    // Fails the run (and so the deploy) when a function or a privilege reopens the pg_temp hijack. The
    // files are already committed, so a function fix is a new forward migration; each item names its fix.
    const violations = await hardeningViolations(client);
    if (violations.length > 0) {
      throw new Error(`database hardening check failed (External-tenant gate T17):\n  - ${violations.join('\n  - ')}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('crove_migrate'))").catch(() => {});
    await client.end();
  }
  return applied;
}

// The only accepted function settings. pg_catalog first so built-in names win; pg_temp last so the
// caller's temporary schema is searched after it. An empty path is not enough: PostgreSQL still resolves
// type names in the caller's temporary schema first, so a caller could substitute its own types and casts.
export const PINNED_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';

/**
 * Lists every way the current database breaks the definer hardening (T17), or [] when it holds:
 * - every function and procedure in a `crove_*` schema has exactly `PINNED_SEARCH_PATH` as its settings.
 *   This covers SECURITY INVOKER functions too: an invoker function called from a definer body (a trigger
 *   on a table the definer writes, a helper) runs with the definer's privileges, so `SET search_path = ''`
 *   there is the same hole, and a later `ALTER FUNCTION ... SECURITY DEFINER` keeps the old settings.
 *   Excluded: extension members (their scripts own them; extensions live in `extensions` anyway) and the
 *   pg-boss schema `crove_jobs`, which pg-boss creates and versions itself (and checks for drift); its
 *   functions are SECURITY INVOKER, so a SECURITY DEFINER function appearing there is still reported.
 * - the `crove_jobs` exemption holds only while no role but the runner (and superusers) may CREATE in that
 *   schema; otherwise such a role could plant an unscanned function there.
 * - every function outside the `crove_*` schemas that a `crove_*` object reaches without naming it through
 *   search_path either pins `PINNED_SEARCH_PATH`, or sets no search_path and is SECURITY INVOKER (it then runs
 *   with its caller's path, which inside a definer is the pinned one). Reached means a function, or an
 *   operator's `oprcode`, that `pg_depend` binds by OID to: a `crove_*` object or one of its parts (a trigger
 *   and its WHEN clause, column defaults, generated columns, CHECK constraints, index expressions, RLS
 *   policies, view rules, SQL-standard bodies); a type a `crove_*` object uses, followed through domains,
 *   arrays, ranges and composite attributes (its input, output, receive, send, typmod, analyze and subscript
 *   functions, range canonical and subtype_diff, domain defaults) or a CHECK constraint of such a domain; or an
 *   aggregate reached that way (its support functions). Also the function of any cast to or from such a type:
 *   casts are found by type, and a body can name the other side in pg_catalog. Triggers fire on whatever
 *   writes the table, and casts and type support are found by type, so a definer runs them without naming
 *   them. A function or operator named in a body resolves through the pinned path, which reaches only
 *   pg_catalog (functions and operators are never looked up in pg_temp), so an outside one is reachable only
 *   when bound by OID. Built-in objects are pinned and have no `pg_depend` rows; none is SECURITY DEFINER or
 *   sets a search_path. Not covered: an explicitly schema-qualified call inside a PL/pgSQL body, which the
 *   catalog does not record; functions an outside function calls in turn; and triggers, defaults and
 *   constraints of tables outside `crove_*` that a definer writes (no definer does today).
 * - no Crove role (every role named `crove_*`: login, group, definer-owner and module roles) other than the
 *   one running the check can create temporary objects in this database. Without TEMPORARY a session has no
 *   temporary schema to plant types, casts or functions in.
 * - no other role that can act as a Crove role (use its privileges, SET ROLE to it, or hold ADMIN OPTION on
 *   it and so grant it to itself; directly or through other roles, per `pg_auth_members`) can create
 *   temporary objects either: its session would carry a temporary schema into that Crove role's rights, and
 *   from there into the owner of any `crove_*` SECURITY DEFINER function the role may run. This matters
 *   because 20261015120000_crove_kernel_revoke_temp granted TEMPORARY directly to every non-Crove role that
 *   held it. Skipped: a role that can already act as every owner of a `crove_*` SECURITY DEFINER function,
 *   since a planted object gains it nothing.
 *
 * There is deliberately no bypass (no environment flag, no warn-only mode): a deploy that fails this check is
 * fixed with a forward migration or by the database owner, never skipped. A skipped check leaves a privilege
 * escalation open in that database, and a warning nobody acts on is the same as no check.
 */
export async function hardeningViolations(client: pg.ClientBase): Promise<string[]> {
  // The catalog queries below cost enough to start JIT compilation, which took 0.8-0.9 s per call on the postgres:17
  // image (30-45 ms without it, issue #179) and gains nothing for a one-off query. Off for this session while the
  // check runs, then restored. In a transaction that an error here aborted, the restore fails too, but the caller's
  // rollback undoes the change anyway, so that failure is ignored and the original error propagates. A caller's
  // `SET LOCAL jit` is restored as a session value, so it outlives that transaction; that affects speed only.
  const { rows } = await client.query<{ jit: string }>("SELECT pg_catalog.current_setting('jit') AS jit");
  await client.query("SELECT pg_catalog.set_config('jit', 'off', false)");
  try {
    return await listHardeningViolations(client);
  } finally {
    await client.query("SELECT pg_catalog.set_config('jit', $1, false)", [rows[0]?.jit ?? 'on']).catch(() => {});
  }
}

async function listHardeningViolations(client: pg.ClientBase): Promise<string[]> {
  const { rows: functions } = await client.query<{ fn: string; kind: string; config: string | null; extra: boolean }>(
    `SELECT p.oid::pg_catalog.regprocedure::text AS fn, p.prokind::text AS kind,
            pg_catalog.array_to_string(p.proconfig, '; ') AS config,
            EXISTS (SELECT 1 FROM pg_catalog.unnest(p.proconfig) c WHERE c NOT LIKE 'search\\_path=%') AS extra
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname LIKE 'crove\\_%'
       AND p.prokind IN ('f', 'p')
       AND (n.nspname <> 'crove_jobs' OR p.prosecdef)
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
         WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
       AND p.proconfig IS DISTINCT FROM ARRAY[$1]::text[]
     ORDER BY 1`,
    [PINNED_SEARCH_PATH],
  );
  const { rows: reachable } = await client.query<{ fn: string; kind: string; path: string | null; via: string }>(
    `WITH RECURSIVE crove_ns AS (
       SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname LIKE 'crove\\_%'
     ),
     used_types(t) AS (
       SELECT a.atttypid FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       WHERE c.relnamespace IN (SELECT oid FROM crove_ns) AND a.attnum > 0 AND NOT a.attisdropped
       UNION
       SELECT t.oid FROM pg_catalog.pg_type t WHERE t.typnamespace IN (SELECT oid FROM crove_ns)
       UNION
       SELECT u.t FROM pg_catalog.pg_proc p,
         LATERAL pg_catalog.unnest(p.prorettype || COALESCE(p.proallargtypes, p.proargtypes::pg_catalog.oid[])) u(t)
       WHERE p.pronamespace IN (SELECT oid FROM crove_ns)
       UNION
       SELECT n.t FROM used_types u JOIN pg_catalog.pg_type t ON t.oid = u.t
       CROSS JOIN LATERAL (
         SELECT t.typbasetype UNION ALL SELECT t.typelem
         UNION ALL SELECT r.rngsubtype FROM pg_catalog.pg_range r WHERE r.rngtypid = t.oid
         UNION ALL SELECT r.rngtypid FROM pg_catalog.pg_range r WHERE r.rngmultitypid = t.oid
         UNION ALL SELECT a.atttypid FROM pg_catalog.pg_attribute a
           WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
       ) n(t)
       WHERE n.t <> 0
     ),
     bound AS MATERIALIZED (
       SELECT d.classid, d.objid, d.objsubid, d.refclassid, d.refobjid FROM pg_catalog.pg_depend d
       WHERE d.refclassid IN ('pg_catalog.pg_proc'::pg_catalog.regclass, 'pg_catalog.pg_operator'::pg_catalog.regclass)
     ),
     direct(fn, via) AS (
       SELECT CASE WHEN b.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass THEN b.refobjid ELSE o.oprcode::pg_catalog.oid END,
              pg_catalog.pg_describe_object(b.classid, b.objid, b.objsubid)
       FROM bound b
       LEFT JOIN pg_catalog.pg_operator o ON b.refclassid = 'pg_catalog.pg_operator'::pg_catalog.regclass AND o.oid = b.refobjid
       WHERE (b.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND b.objid IN (SELECT t FROM used_types))
          OR (b.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND EXISTS (
                SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.oid = b.objid AND k.contypid IN (SELECT t FROM used_types)))
          OR (pg_catalog.pg_identify_object_as_address(b.classid, b.objid, b.objsubid)).object_names[1] LIKE 'crove\\_%'
       UNION ALL
       SELECT k.castfunc, pg_catalog.pg_describe_object('pg_catalog.pg_cast'::pg_catalog.regclass, k.oid, 0)
       FROM pg_catalog.pg_cast k
       WHERE k.castfunc <> 0 AND (k.castsource IN (SELECT t FROM used_types) OR k.casttarget IN (SELECT t FROM used_types))
     ),
     reached(fn, via) AS (
       SELECT fn, via FROM direct
       UNION ALL
       SELECT b.refobjid, pg_catalog.pg_describe_object(b.classid, b.objid, b.objsubid)
       FROM direct r
       JOIN pg_catalog.pg_proc a ON a.oid = r.fn AND a.prokind = 'a'
       JOIN bound b ON b.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND b.objid = a.oid
         AND b.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
     )
     SELECT x.fn, x.kind, x.path, x.via FROM (
       SELECT p.oid::pg_catalog.regprocedure::text AS fn, p.prokind::text AS kind, p.prosecdef AS definer,
              (SELECT c FROM pg_catalog.unnest(p.proconfig) c WHERE c LIKE 'search\\_path=%' LIMIT 1) AS path,
              pg_catalog.string_agg(DISTINCT r.via COLLATE "C", '; ' ORDER BY r.via COLLATE "C") AS via
       FROM reached r
       JOIN pg_catalog.pg_proc p ON p.oid = r.fn
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT LIKE 'crove\\_%'
       GROUP BY p.oid, p.prokind, p.prosecdef, p.proconfig
     ) x
     WHERE x.path IS DISTINCT FROM $1 AND (x.definer OR x.path IS NOT NULL)
     ORDER BY x.fn COLLATE "C"`,
    [PINNED_SEARCH_PATH],
  );
  const { rows: roles } = await client.query<{ rolname: string }>(
    `SELECT r.rolname FROM pg_catalog.pg_roles r
     WHERE r.rolname LIKE 'crove\\_%' AND r.rolname <> current_user AND NOT r.rolsuper
       AND pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'TEMPORARY')
     ORDER BY 1`,
  );
  // "Acts as" y: uses y's privileges, may SET ROLE to y, or holds ADMIN OPTION on y and so may grant y to itself.
  const actsAs = (x: string, y: string) =>
    `(pg_catalog.pg_has_role(${x}, ${y}, 'USAGE') OR pg_catalog.pg_has_role(${x}, ${y}, 'SET')` +
    ` OR pg_catalog.pg_has_role(${x}, ${y}, 'MEMBER WITH ADMIN OPTION'))`;
  const { rows: members } = await client.query<{ rolname: string; via: string; grants: string }>(
    `WITH crove AS (SELECT c.oid, c.rolname FROM pg_catalog.pg_roles c WHERE c.rolname LIKE 'crove\\_%'),
     owners AS (
       SELECT DISTINCT p.proowner AS oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname LIKE 'crove\\_%' AND p.prosecdef
     )
     SELECT r.rolname,
            (SELECT pg_catalog.string_agg(c.rolname::text, ', ' ORDER BY c.rolname::text COLLATE "C")
             FROM crove c WHERE ${actsAs('r.oid', 'c.oid')}) AS via,
            (SELECT pg_catalog.string_agg(DISTINCT g.rolname::text COLLATE "C", ', ' ORDER BY g.rolname::text COLLATE "C")
             FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
             WHERE m.member = r.oid AND EXISTS (SELECT 1 FROM crove c WHERE g.oid = c.oid OR ${actsAs('g.oid', 'c.oid')})) AS grants
     FROM pg_catalog.pg_roles r
     WHERE r.rolname NOT LIKE 'crove\\_%' AND r.rolname <> current_user AND NOT r.rolsuper
       AND pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'TEMPORARY')
       AND EXISTS (SELECT 1 FROM crove c WHERE ${actsAs('r.oid', 'c.oid')})
       AND EXISTS (SELECT 1 FROM owners o WHERE NOT ${actsAs('r.oid', 'o.oid')})
     ORDER BY r.rolname::text COLLATE "C"`,
  );
  const { rows: jobCreators } = await client.query<{ rolname: string }>(
    `SELECT r.rolname FROM pg_catalog.pg_roles r
     WHERE pg_catalog.to_regnamespace('crove_jobs') IS NOT NULL
       AND r.rolname <> current_user AND NOT r.rolsuper
       AND pg_catalog.has_schema_privilege(r.oid, 'crove_jobs', 'CREATE')
     ORDER BY 1`,
  );
  const { rows: dbRows } = await client.query<{ name: string }>('SELECT pg_catalog.quote_ident(pg_catalog.current_database()) AS name');
  const dbName = dbRows[0]?.name ?? 'current_database';
  return [
    ...functions.map((f) => {
      const alter = `ALTER ${f.kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} ${f.fn}`;
      const fix = `${f.extra ? `${alter} RESET ALL; ` : ''}${alter} SET search_path = pg_catalog, pg_temp`;
      return `function ${f.fn} has settings ${f.config === null ? '(none)' : `"${f.config}"`}, expected "${PINNED_SEARCH_PATH}"; fix in a new migration: ${fix}`;
    }),
    ...reachable.map((f) => {
      const setting = f.path === null ? 'is SECURITY DEFINER with no search_path setting' : `sets "${f.path}"`;
      return (
        `function ${f.fn} is reached from crove_* objects (${f.via}) and ${setting}, expected "${PINNED_SEARCH_PATH}"; ` +
        `fix in a new migration as its owner: ALTER ${f.kind === 'p' ? 'PROCEDURE' : 'FUNCTION'} ${f.fn} SET search_path = pg_catalog, pg_temp, ` +
        'or stop using it from crove_* objects'
      );
    }),
    ...jobCreators.map(
      (r) =>
        `role ${r.rolname} may CREATE in schema crove_jobs, so functions there cannot stay exempt; fix: REVOKE CREATE ON SCHEMA crove_jobs FROM ${r.rolname}`,
    ),
    ...roles.map(
      (r) =>
        `role ${r.rolname} can create temporary objects (TEMPORARY on database ${dbName}); fix as the database owner or a superuser: ` +
        `GRANT TEMPORARY ON DATABASE ${dbName} directly to any non-Crove role that needs it, then ` +
        `REVOKE TEMPORARY ON DATABASE ${dbName} FROM PUBLIC, ${r.rolname}`,
    ),
    ...members.map(
      (r) =>
        `role ${r.rolname} can create temporary objects (TEMPORARY on database ${dbName}) and can act as ${r.via}; ` +
        `fix as the database owner or a superuser: REVOKE ${r.grants} FROM ${r.rolname}, or take TEMPORARY away from ${r.rolname} ` +
        `(REVOKE TEMPORARY ON DATABASE ${dbName} FROM ${r.rolname}, and from PUBLIC or any role it inherits TEMPORARY from)`,
    ),
  ];
}

// Versions present in the repo but missing from the database ledger (used by /readyz).
export async function schemaMissing(client: pg.ClientBase, dir: string): Promise<string[]> {
  const files = await readMigrations(dir);
  const { rows } = await client.query<{ version: string }>(
    "SELECT version FROM crove_meta.schema_migrations WHERE to_regclass('crove_meta.schema_migrations') IS NOT NULL",
  ).catch(() => ({ rows: [] as { version: string }[] }));
  const have = new Set(rows.map((r) => r.version));
  return files.filter((f) => !have.has(f.version)).map((f) => f.name);
}

export interface AuthGrantsOptions {
  adminUrl: string;
  // How long to wait for Supabase Auth to create auth.sessions and auth.users (ADR-0028: 2 minutes).
  timeoutMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
}

// The `auth-grants` one-shot step (ADR-0028, self-host db adapter). Waits until Supabase Auth has created its
// tables, then lets crove_auth_reader select exactly the columns the session check reads (column grants plus a
// SELECT policy, because Supabase Auth turns on row-level security): auth.sessions, auth.users and, for the MFA
// check (issue #126), auth.mfa_factors (user_id, status), never the factor secrets; plus
// auth.users.email_confirmed_at for the invite definers when the column exists (#134). Supabase Auth creates
// auth.mfa_factors before it adds auth.sessions.not_after, so all three exist together; without auth.mfa_factors
// the session check fails closed with 503 (issue #180), so the wait covers it too. Needs a superuser or the owner of
// the auth tables (supabase_auth_admin), so it runs with the admin URL, like `migrate`. Safe to run on every start:
// it re-applies the grant if Supabase Auth ever recreated a table.
export async function applyAuthGrants(options: AuthGrantsOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const client = new pg.Client({ connectionString: options.adminUrl, application_name: 'crove-auth-grants' });
  await client.connect();
  try {
    for (;;) {
      // Every column the check reads, not just the tables: Supabase Auth adds some (not_after) in later migrations.
      const { rows } = await client.query<{ ready: boolean }>(`
        SELECT count(*) = 8 AS ready FROM pg_attribute a
        WHERE a.attnum > 0 AND NOT a.attisdropped AND (
          (a.attrelid = to_regclass('auth.sessions') AND a.attname IN ('id', 'user_id', 'not_after'))
          OR (a.attrelid = to_regclass('auth.users') AND a.attname IN ('id', 'banned_until', 'deleted_at'))
          OR (a.attrelid = to_regclass('auth.mfa_factors') AND a.attname IN ('user_id', 'status')))`);
      if (rows[0]?.ready) break;
      if (Date.now() >= deadline) {
        throw new Error(
          'auth.sessions, auth.users and auth.mfa_factors do not exist (or lack columns the session check reads); start Supabase Auth and run auth-grants again',
        );
      }
      log('waiting for Supabase Auth to create auth.sessions, auth.users and auth.mfa_factors');
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2000));
    }
    await client.query('BEGIN');
    try {
      await client.query(`
        GRANT USAGE ON SCHEMA auth TO crove_auth_reader;
        GRANT SELECT (id, user_id, not_after) ON auth.sessions TO crove_auth_reader;
        GRANT SELECT (id, banned_until, deleted_at) ON auth.users TO crove_auth_reader;
        -- Supabase Auth enables row-level security on its tables without policies, so a grant alone shows no rows.
        -- These policies let only the reader see rows (still only the granted columns).
        DROP POLICY IF EXISTS crove_auth_reader_select ON auth.sessions;
        CREATE POLICY crove_auth_reader_select ON auth.sessions AS PERMISSIVE FOR SELECT TO crove_auth_reader USING (true);
        DROP POLICY IF EXISTS crove_auth_reader_select ON auth.users;
        CREATE POLICY crove_auth_reader_select ON auth.users AS PERMISSIVE FOR SELECT TO crove_auth_reader USING (true);
        GRANT SELECT (user_id, status) ON auth.mfa_factors TO crove_auth_reader;
        DROP POLICY IF EXISTS crove_auth_reader_select ON auth.mfa_factors;
        CREATE POLICY crove_auth_reader_select ON auth.mfa_factors AS PERMISSIVE FOR SELECT TO crove_auth_reader USING (true);`);
      // Invite acceptance in db mode also requires a confirmed email (#134). Every Supabase Auth release has the
      // column; while it exists without this grant, invites answer 503 and the session check keeps working.
      const { rows: confirmed } = await client.query<{ present: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = to_regclass('auth.users') AND a.attname = 'email_confirmed_at' AND a.attnum > 0 AND NOT a.attisdropped
        ) AS present`);
      if (confirmed[0]?.present === true) {
        await client.query('GRANT SELECT (email_confirmed_at) ON auth.users TO crove_auth_reader');
      } else {
        log('WARNING: auth.users.email_confirmed_at does not exist, so accepting an invite cannot require a confirmed email; upgrade Supabase Auth and run auth-grants again');
      }
      const { rows } = await client.query<{ ok: boolean }>('SELECT crove_kernel.auth_grants_ready() AS ok');
      if (!rows[0]?.ok) throw new Error('the session check still cannot read auth.sessions, auth.users and auth.mfa_factors after the grant');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    log('crove_auth_reader may read auth.sessions, auth.users and auth.mfa_factors (user_id, status)');
  } finally {
    await client.end();
  }
}

// Sets login-role passwords from configuration. Values never appear in migrations or logs.
export async function setRolePasswords(adminUrl: string, passwords: Record<string, string | undefined>): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl, application_name: 'crove-migrate' });
  await client.connect();
  try {
    for (const [role, password] of Object.entries(passwords)) {
      if (!password) continue;
      const { rows } = await client.query<{ sql: string }>('SELECT format($$ALTER ROLE %I PASSWORD %L$$, $1::text, $2::text) AS sql', [
        role,
        password,
      ]);
      const sql = rows[0]?.sql;
      if (sql) await client.query(sql);
    }
  } finally {
    await client.end();
  }
}
