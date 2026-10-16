// Experiment 4: can the DBOS system schema live in committed SQL, applied by Crove's runner, with no runtime DDL?
//
// 1. Fresh: the vendored file (one transaction, non-superuser owner) gives the same schema DBOS creates itself.
// 2. Upgrade: a database at the schema of an older SDK (5.0.2) + the vendored delta file of 5.2.11 equals fresh.
// 3. runMigrations: false against a schema that is behind refuses to start; runMigrations: true as a role without
//    DDL rights fails; the runner role cannot create anything; re-applying a file trips its version guard.
// 4. Hardening: every DBOS function pins search_path, none is SECURITY DEFINER (Crove's T17 guard would accept them).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DEFAULT_SQL, applyFile, RUNNER_GRANTS, setup } from './setup.ts';
import { SCHEMA, adminUrl, dbUrl } from './env.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OLD = process.env.OLD_SDK ?? '5.0.2';
const container = process.env.SPIKE_PG_CONTAINER ?? 'crove-spike-dbos-pg';
const results: Record<string, unknown> = {};

function node(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8' });
  const line = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error(`${script} printed nothing: ${r.stderr}`);
  return JSON.parse(line);
}

async function createDb(name: string) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const db = new pg.Client({ connectionString: dbUrl('postgres', name) });
  await db.connect();
  await db.query(`GRANT CREATE, CONNECT ON DATABASE ${name} TO spike_migrate; GRANT CONNECT ON DATABASE ${name} TO spike_runner; REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await db.end();
}

async function one<T>(url: string, text: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text)).rows as T[];
  } finally {
    await c.end();
  }
}

async function tryQuery(url: string, text: string) {
  try {
    await one(url, text);
    return { ok: true };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { ok: false, code: err.code, message: err.message.slice(0, 200) };
  }
}

async function tryApply(url: string, file: string) {
  try {
    await applyFile(url, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message.slice(0, 200) };
  }
}

const version = async (db: string) => (await one<{ v: number }>(dbUrl('postgres', db), `SELECT max(version)::int AS v FROM "${SCHEMA}".dbos_migrations`))[0]!.v;

function dump(db: string): string {
  const r = spawnSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '--schema-only', `--schema=${SCHEMA}`, '--no-owner', '--no-privileges', db], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pg_dump failed: ${r.stderr}`);
  return r.stdout
    .split('\n')
    .filter((l) => !l.startsWith('--') && !l.startsWith('\\restrict') && !l.startsWith('\\unrestrict') && l.trim() !== '')
    .join('\n');
}

try {
  await setup([DEFAULT_SQL]);
  mkdirSync(join(root, '.cache'), { recursive: true });
  mkdirSync(join(root, 'results'), { recursive: true });

  // 1. Fresh.
  await createDb('spike_fresh');
  await applyFile(dbUrl('spike_migrate', 'spike_fresh'), DEFAULT_SQL);
  await one(dbUrl('spike_migrate', 'spike_fresh'), RUNNER_GRANTS);
  const fresh = dump('spike_fresh');
  writeFileSync(join(root, 'results', 'schema-dump-5.2.11.sql'), `${fresh}\n`);
  const inventory = (
    await one<{ kind: string; n: number }>(
      dbUrl('postgres', 'spike_fresh'),
      `SELECT 'tables' AS kind, count(*)::int AS n FROM pg_tables WHERE schemaname = '${SCHEMA}'
       UNION ALL SELECT 'indexes', count(*)::int FROM pg_indexes WHERE schemaname = '${SCHEMA}'
       UNION ALL SELECT 'functions', count(*)::int FROM pg_proc WHERE pronamespace = '${SCHEMA}'::regnamespace
       UNION ALL SELECT 'triggers', count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = '${SCHEMA}'::regnamespace AND NOT t.tgisinternal`,
    )
  ).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.kind]: r.n }), {});
  results.fresh = {
    version: await version('spike_fresh'),
    appliedAs: 'spike_migrate (NOSUPERUSER), one transaction',
    inventory,
    launchAsRunnerWithRunMigrationsFalse: node('launch-check.ts', [dbUrl('spike_runner', 'spike_fresh'), 'false']),
    reapplySameFile: await tryApply(dbUrl('spike_migrate', 'spike_fresh'), DEFAULT_SQL),
    runnerCreateTable: await tryQuery(dbUrl('spike_runner', 'spike_fresh'), `CREATE TABLE "${SCHEMA}".x (id int)`),
    runnerCreateSchema: await tryQuery(dbUrl('spike_runner', 'spike_fresh'), `CREATE SCHEMA y`),
    runnerAlterTable: await tryQuery(dbUrl('spike_runner', 'spike_fresh'), `ALTER TABLE "${SCHEMA}".workflow_status ADD COLUMN z int`),
  };

  // 4. Hardening, on the fresh schema.
  results.functions = await one(
    dbUrl('postgres', 'spike_fresh'),
    `SELECT proname, prosecdef AS security_definer, coalesce(array_to_string(proconfig, ','), '') AS settings
       FROM pg_proc WHERE pronamespace = '${SCHEMA}'::regnamespace ORDER BY 1`,
  );

  // 2. Upgrade from an older SDK's schema.
  const oldDir = join(root, '.cache', `sdk-${OLD}`);
  if (!existsSync(join(oldDir, 'node_modules', '@dbos-inc', 'dbos-sdk'))) {
    const r = spawnSync(`npm install --prefix "${oldDir}" --no-save --no-fund --no-audit @dbos-inc/dbos-sdk@${OLD}`, { encoding: 'utf8', shell: true });
    if (r.status !== 0) throw new Error(`npm install ${OLD} failed: ${r.stderr}`);
  }
  const oldFile = join(root, '.cache', `dbos-${OLD}-from-1.sql`);
  const oldInfo = node('vendor-schema.ts', ['--sdk-dir', join(oldDir, 'node_modules', '@dbos-inc', 'dbos-sdk'), '--out', oldFile]);
  const delta = node('vendor-schema.ts', ['--from', String(oldInfo.target + 1)]);
  await createDb('spike_upgrade');
  await applyFile(dbUrl('spike_migrate', 'spike_upgrade'), oldFile);
  await one(dbUrl('spike_migrate', 'spike_upgrade'), RUNNER_GRANTS);
  const before = await version('spike_upgrade');
  const behindFalse = node('launch-check.ts', [dbUrl('spike_runner', 'spike_upgrade'), 'false']);
  const behindTrue = node('launch-check.ts', [dbUrl('spike_runner', 'spike_upgrade'), 'true']);
  const deltaFirstApply = await tryApply(dbUrl('spike_migrate', 'spike_upgrade'), delta.out);
  await one(dbUrl('spike_migrate', 'spike_upgrade'), RUNNER_GRANTS);
  const upgraded = dump('spike_upgrade');
  results.upgrade = {
    oldSdk: OLD,
    oldSchemaVersion: before,
    deltaFile: delta.out.split(/[\\/]/).slice(-2).join('/'),
    deltaMigrations: `${oldInfo.target + 1}..${delta.target}`,
    launchBehindWithRunMigrationsFalse: behindFalse,
    launchBehindWithRunMigrationsTrueAsRunner: behindTrue,
    deltaApply: deltaFirstApply,
    versionAfter: await version('spike_upgrade'),
    dumpIdenticalToFresh: upgraded === fresh,
    dumpLineDiff: upgraded === fresh ? 0 : diffCount(fresh, upgraded),
    deltaReapply: await tryApply(dbUrl('spike_migrate', 'spike_upgrade'), delta.out),
    launchAfterUpgrade: node('launch-check.ts', [dbUrl('spike_runner', 'spike_upgrade'), 'false']),
  };
} finally {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const db of ['spike_fresh', 'spike_upgrade']) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.end();
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(new URL('../results/schema.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
}

function diffCount(a: string, b: string) {
  const sa = new Set(a.split('\n'));
  const sb = new Set(b.split('\n'));
  return [...sa].filter((l) => !sb.has(l)).length + [...sb].filter((l) => !sa.has(l)).length;
}
