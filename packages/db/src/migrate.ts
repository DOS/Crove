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
  for (const name of names) {
    const match = FILE_PATTERN.exec(name);
    if (!match?.[1]) throw new Error(`migration file name does not match the naming rule: ${name}`);
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
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('crove_migrate'))").catch(() => {});
    await client.end();
  }
  return applied;
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
