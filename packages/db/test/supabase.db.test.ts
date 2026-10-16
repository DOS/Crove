// The migrations and the definer hardening guard (External-tenant gate T17) on the Supabase Postgres image (the
// image line hosted Supabase runs; a hosted project may differ in supautils and extension configuration), with its extensions, its roles (supabase_admin, authenticator, anon, service_role, ...)
// and the supautils hooks. Hosted Supabase runs migrations as `postgres`, which is not a superuser there, so the
// runner here is `postgres` too (issue #179).
//
// Set CROVE_TEST_SUPABASE_URL to the `postgres` role on the `postgres` database of a throwaway supabase/postgres
// container, e.g. postgres://postgres:<password>@127.0.0.1:<port>/postgres. The test migrates that database in place
// and cannot be undone, so it refuses any host but this machine. CI runs it in the `supabase-stack` job.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hardeningViolations, migrate, readMigrations } from '../src/migrate.ts';

const URL_ENV = process.env.CROVE_TEST_SUPABASE_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

// Enabled before migrating, so their types, casts, operators and definer functions are in the catalog the guard
// reads. A new hosted project has pg_graphql, pg_stat_statements, pgcrypto, uuid-ossp and supabase_vault; the rest
// are extensions a project owner can enable from the dashboard. Schemas follow what the dashboard picks.
const EXTENSIONS: ReadonlyArray<readonly [string, string | null]> = [
  ['pg_graphql', 'graphql'],
  ['pg_stat_statements', 'extensions'],
  ['pgcrypto', 'extensions'],
  ['uuid-ossp', 'extensions'],
  ['supabase_vault', 'vault'],
  ['pg_net', null],
  ['pgsodium', null],
  ['pg_cron', null],
  ['pgmq', null],
  ['pgaudit', null],
  ['vector', 'extensions'],
  ['postgis', 'extensions'],
  ['citext', 'extensions'],
  ['hstore', 'extensions'],
  ['ltree', 'extensions'],
  ['pg_trgm', 'extensions'],
  ['btree_gist', 'extensions'],
  ['http', 'extensions'],
  ['pg_jsonschema', 'extensions'],
  ['pg_hashids', 'extensions'],
  ['wrappers', 'extensions'],
];

// The CI job sets CROVE_REQUIRE_SUPABASE_TEST, so losing the URL there fails the job instead of skipping the suite.
if (process.env.CROVE_REQUIRE_SUPABASE_TEST && !URL_ENV) {
  throw new Error('CROVE_REQUIRE_SUPABASE_TEST is set but CROVE_TEST_SUPABASE_URL is not');
}
const suite = URL_ENV ? describe : describe.skip;

suite('migrations and the hardening guard on the Supabase Postgres image', () => {
  const url = URL_ENV as string;
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    // The host pg will connect to, after the URL is parsed the way migrate() parses it (a `host=` query parameter
    // overrides the URL's host name, so checking the URL alone is not enough).
    if (!['127.0.0.1', 'localhost', '::1'].includes(client.host)) {
      throw new Error(`CROVE_TEST_SUPABASE_URL must point at a throwaway local container, not ${client.host}`);
    }
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('runs as a postgres role that is not a superuser, on the Supabase image', async () => {
    const { rows } = await client.query<{ user: string; superuser: boolean; admin: boolean; preload: string }>(`
      SELECT current_user AS user, r.rolsuper AS superuser,
             EXISTS (SELECT 1 FROM pg_roles a WHERE a.rolname = 'supabase_admin' AND a.rolsuper) AS admin,
             current_setting('session_preload_libraries') AS preload
      FROM pg_roles r WHERE r.rolname = current_user`);
    expect(rows).toEqual([{ user: 'postgres', superuser: false, admin: true, preload: expect.stringContaining('supautils') }]);
  });

  it('applies every migration with the extensions enabled, runs again cleanly, and passes the guard', async () => {
    for (const [name, schema] of EXTENSIONS) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${pg.escapeIdentifier(name)}${schema ? ` SCHEMA ${schema}` : ''}`);
    }
    const files = await readMigrations(MIGRATIONS);
    const { rows } = await client.query<{ migrated: boolean }>(
      "SELECT to_regclass('crove_meta.schema_migrations') IS NOT NULL AS migrated",
    );
    // A fresh container applies every file; a rerun of the suite against the same container applies none.
    const expected = rows[0]?.migrated ? [] : files.map((f) => f.name);
    expect(await migrate({ adminUrl: url, dir: MIGRATIONS })).toEqual(expected);
    expect(await migrate({ adminUrl: url, dir: MIGRATIONS })).toEqual([]);
    expect(await hardeningViolations(client)).toEqual([]);
  }, 120_000);

  // The guard is not vacuous on this image: it still reports an unpinned crove_* function, and an extension's
  // definer function once a crove_* object reaches it (an extension member is skipped only inside crove_* schemas).
  it('still reports planted violations, including a reached extension function', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE FUNCTION crove_kernel.t179_unpinned() RETURNS int LANGUAGE sql SET search_path = '' AS $$ SELECT 1 $$;
        CREATE TABLE crove_kernel.t179 (v bigint DEFAULT graphql.get_schema_version());`);
      expect(await hardeningViolations(client)).toEqual([
        'function crove_kernel.t179_unpinned() has settings "search_path=""", expected "search_path=pg_catalog, pg_temp"; ' +
          'fix in a new migration: ALTER FUNCTION crove_kernel.t179_unpinned() SET search_path = pg_catalog, pg_temp',
        'function graphql.get_schema_version() is reached from crove_* objects (default value for column v of table crove_kernel.t179) ' +
          'and is SECURITY DEFINER with no search_path setting, expected "search_path=pg_catalog, pg_temp"; fix in a new migration as its owner: ' +
          'ALTER FUNCTION graphql.get_schema_version() SET search_path = pg_catalog, pg_temp, or stop using it from crove_* objects',
      ]);
    } finally {
      await client.query('ROLLBACK');
    }
    expect(await hardeningViolations(client)).toEqual([]);
  });
});
