// Recreates the spike database: roles, the DBOS system schema from committed SQL, and the spike's own tables.
//
//   node src/setup.ts [--sql FILE ...]      (default: sql/dbos-5.2.11-from-1.sql)
//
// Roles mirror Crove's split: a non-superuser `spike_migrate` owns the schema and applies the vendored file in ONE
// transaction (Crove's runner does the same per file); `spike_runner` only gets DML and EXECUTE, so it cannot run
// any DDL. DBOS then launches as `spike_runner` with `runMigrations: false`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DB_NAME, SCHEMA, adminUrl, migrateUrl, observerUrl } from './env.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SQL = join(here, '..', 'sql', 'dbos-5.2.11-from-1.sql');

export async function applyFile(connectionString: string, file: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(readFileSync(file, 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

// What the runner gets: narrower than `npx dbos schema --print-user-role` (which grants ALL, including TRUNCATE,
// TRIGGER and REFERENCES), to check that DML plus EXECUTE is enough.
export const RUNNER_GRANTS = `
GRANT USAGE ON SCHEMA "${SCHEMA}" TO spike_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${SCHEMA}" TO spike_runner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${SCHEMA}" TO spike_runner;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${SCHEMA}" TO spike_runner;
`;

const APP_TABLES = `
CREATE SCHEMA spike;
-- One row per executed step body: counts re-executions after a crash.
CREATE TABLE spike.effects (id bigserial PRIMARY KEY, workflow_id text NOT NULL, step int NOT NULL, executor_id text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp());
-- One row per started org job: start order and times for the fairness experiment.
CREATE TABLE spike.fair (id bigserial PRIMARY KEY, org text NOT NULL, i int NOT NULL, executor_id text NOT NULL, started_at timestamptz NOT NULL DEFAULT clock_timestamp());
-- Liveness of each worker process, written every second. DBOS has no executor heartbeat of its own.
CREATE TABLE spike.executor_heartbeat (executor_id text PRIMARY KEY, beat_at timestamptz NOT NULL);
-- Log of the self-hosted recovery sweeper.
CREATE TABLE spike.recovery_log (id bigserial PRIMARY KEY, swept_by text NOT NULL, dead_executor text NOT NULL, workflows int NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp());
GRANT USAGE ON SCHEMA spike TO spike_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA spike TO spike_runner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA spike TO spike_runner;
`;

export async function setup(files: string[]): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // Also drops the schema experiment's databases, so the roles below have no objects left anywhere.
  const { rows: dbs } = await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $1 || '\_%'`, [DB_NAME]);
  for (const { datname } of dbs) await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  for (const role of ['spike_runner', 'spike_migrate']) {
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
  }
  await admin.query(`CREATE ROLE spike_migrate LOGIN PASSWORD 'spike' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await admin.query(`CREATE ROLE spike_runner LOGIN PASSWORD 'spike' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await admin.query(`CREATE DATABASE ${DB_NAME} OWNER postgres`);
  await admin.end();

  const db = new pg.Client({ connectionString: observerUrl });
  await db.connect();
  // The migrate role may create schemas in this database; nobody may create objects in public (PG15+ default).
  await db.query(`GRANT CREATE, CONNECT ON DATABASE ${DB_NAME} TO spike_migrate`);
  await db.query(`GRANT CONNECT ON DATABASE ${DB_NAME} TO spike_runner`);
  await db.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await db.end();

  for (const file of files) await applyFile(migrateUrl, file);
  const m = new pg.Client({ connectionString: migrateUrl });
  await m.connect();
  await m.query(RUNNER_GRANTS);
  await m.query(APP_TABLES);
  const { rows } = await m.query(`SELECT max(version)::int AS v FROM "${SCHEMA}".dbos_migrations`);
  await m.end();
  console.log(JSON.stringify({ setup: 'ok', files, dbosSchemaVersion: rows[0].v }));
}

if (process.argv[1]?.endsWith('setup.ts')) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => a !== '--sql');
  await setup(files.length ? files : [DEFAULT_SQL]);
}
