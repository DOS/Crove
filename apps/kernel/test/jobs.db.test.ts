// The crove_jobs schema comes only from committed migrations (External-tenant gate T6). Set CROVE_TEST_ADMIN_URL
// to a superuser URL; each test creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { JOB_SCHEMA, QUEUES, SOCIAL_PUBLISH_QUEUES, pgBossSchemaVersion } from '../src/jobs-schema.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const created: string[] = [];

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createDatabase(): Promise<string> {
  const name = `crove_test_jobs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await withClient(ADMIN as string, (admin) => admin.query(`CREATE DATABASE ${name}`));
  created.push(name);
  const url = new URL(ADMIN as string);
  url.pathname = `/${name}`;
  return url.toString();
}

function loginUrl(adminUrl: string, username: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

suite('crove_jobs from committed migrations', () => {
  afterAll(async () => {
    if (!ADMIN) return;
    for (const name of created) await withClient(ADMIN, (admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });

  it('installs the expected version and queues; only the worker may use the schema', async () => {
    const adminUrl = await createDatabase();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await withClient(adminUrl, async (admin) => {
      const version = await admin.query<{ version: number }>(`SELECT max(version) AS version FROM ${JOB_SCHEMA}.version`);
      expect(version.rows[0]?.version).toBe(pgBossSchemaVersion());
      const queues = await admin.query<{ name: string; policy: string }>(`SELECT name, policy FROM ${JOB_SCHEMA}.queue ORDER BY name`);
      expect(queues.rows).toEqual(
        [...Object.values(QUEUES), ...SOCIAL_PUBLISH_QUEUES]
          .sort()
          .map((name) => ({ name, policy: name === QUEUES.agentWake || SOCIAL_PUBLISH_QUEUES.includes(name) ? 'stately' : 'standard' })),
      );

      const functions = await admin.query<{ fn: string; pinned: boolean; public: boolean; worker: boolean; app: boolean }>(`
        SELECT p.oid::regprocedure::text AS fn,
               coalesce('search_path=pg_catalog, pg_temp' = ANY (p.proconfig), false) AS pinned,
               EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public,
               has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker,
               has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app
        FROM pg_proc p WHERE p.pronamespace = '${JOB_SCHEMA}'::regnamespace ORDER BY 1`);
      expect(functions.rows.length).toBeGreaterThan(0);
      for (const row of functions.rows) expect(row, row.fn).toMatchObject({ pinned: true, public: false, worker: true, app: false });

      const schema = await admin.query<{ worker: boolean; app: boolean; worker_create: boolean }>(`
        SELECT has_schema_privilege('crove_worker', '${JOB_SCHEMA}', 'USAGE') AS worker,
               has_schema_privilege('crove_app', '${JOB_SCHEMA}', 'USAGE') AS app,
               has_schema_privilege('crove_worker', '${JOB_SCHEMA}', 'CREATE') AS worker_create`);
      expect(schema.rows).toEqual([{ worker: true, app: false, worker_create: false }]);
    });

    // The API role sees only the version, for /readyz.
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    await withClient(loginUrl(adminUrl, 'crove_app', 'test-app-pw'), async (app) => {
      const { rows } = await app.query<{ version: number }>('SELECT crove_kernel.jobs_schema_version() AS version');
      expect(rows[0]?.version).toBe(pgBossSchemaVersion());
      await expect(app.query(`SELECT 1 FROM ${JOB_SCHEMA}.queue`)).rejects.toThrow(/permission denied/);
    });

    // pg-boss as the worker, with migrate: false: starts on the vendored schema, sends and fetches a job.
    const boss = new PgBoss({ connectionString: loginUrl(adminUrl, 'crove_worker', 'test-worker-pw'), schema: JOB_SCHEMA, migrate: false, createSchema: false, supervise: false });
    boss.on('error', () => {});
    await boss.start();
    try {
      const id = await boss.send(QUEUES.extract, { probe: true });
      const [job] = await boss.fetch<{ probe: boolean }>(QUEUES.extract);
      expect(job?.id).toBe(id);
      expect(job?.data).toEqual({ probe: true });
    } finally {
      await boss.stop({ graceful: false });
    }

    // The version row decides whether a vendored upgrade runs, so only migrations write it; pg-boss with
    // migrate: false stamps the maintenance columns (cron, BAM, flow, reindex, monitor back-off).
    await withClient(loginUrl(adminUrl, 'crove_worker', 'test-worker-pw'), async (worker) => {
      await expect(worker.query(`UPDATE ${JOB_SCHEMA}.version SET version = version + 1`)).rejects.toThrow(/permission denied/);
      await expect(worker.query(`INSERT INTO ${JOB_SCHEMA}.version (version) VALUES (0)`)).rejects.toThrow(/permission denied/);
      await expect(worker.query(`DELETE FROM ${JOB_SCHEMA}.version`)).rejects.toThrow(/permission denied/);
      const { rows } = await worker.query(
        `UPDATE ${JOB_SCHEMA}.version SET cron_on = now(), bam_on = now(), flow_on = now(), reindex_on = now(), monitor_backoff_on = now()
          WHERE version = ${pgBossSchemaVersion()} RETURNING true AS stamped`,
      );
      expect(rows).toEqual([{ stamped: true }]);
    });
  });

  it('leaves a schema pg-boss already created at the same version in place', async () => {
    const adminUrl = await createDatabase();
    // Before #25 the migrate role let pg-boss create crove_jobs at runtime.
    const boss = new PgBoss({ connectionString: adminUrl, schema: JOB_SCHEMA, migrate: true, supervise: false, schedule: false });
    boss.on('error', () => {});
    await boss.start();
    await boss.createQueue(QUEUES.extract);
    await boss.stop({ graceful: false });

    await withClient(adminUrl, async (admin) => {
      const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = '${JOB_SCHEMA}'::regnamespace AND proconfig IS NULL`);
      expect(rows[0]?.n).toBeGreaterThan(0);
    });

    await migrate({ adminUrl, dir: MIGRATIONS });
    await withClient(adminUrl, async (admin) => {
      const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${JOB_SCHEMA}.queue`);
      expect(rows[0]?.n).toBe(Object.values(QUEUES).length + SOCIAL_PUBLISH_QUEUES.length);
      // The functions pg-boss created get the pinned search_path, like the vendored ones.
      const unpinned = await admin.query<{ fn: string }>(
        `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
          WHERE p.pronamespace = '${JOB_SCHEMA}'::regnamespace AND p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']`,
      );
      expect(unpinned.rows).toEqual([]);
    });
  });

  it('stops on a crove_jobs schema with more than one version row', async () => {
    const adminUrl = await createDatabase();
    const target = pgBossSchemaVersion();
    await withClient(adminUrl, (admin) =>
      admin.query(`CREATE SCHEMA ${JOB_SCHEMA}; CREATE TABLE ${JOB_SCHEMA}.version (version int PRIMARY KEY); INSERT INTO ${JOB_SCHEMA}.version VALUES (${target}), (${target + 1})`),
    );
    await expect(migrate({ adminUrl, dir: MIGRATIONS })).rejects.toThrow(`holds pg-boss schema version ${target}, ${target + 1}`);
  });

  it('stops on a crove_jobs schema at another version', async () => {
    const adminUrl = await createDatabase();
    await withClient(adminUrl, (admin) =>
      admin.query(`CREATE SCHEMA ${JOB_SCHEMA}; CREATE TABLE ${JOB_SCHEMA}.version (version int PRIMARY KEY); INSERT INTO ${JOB_SCHEMA}.version VALUES (${pgBossSchemaVersion() - 1})`),
    );
    await expect(migrate({ adminUrl, dir: MIGRATIONS })).rejects.toThrow(`holds pg-boss schema version ${pgBossSchemaVersion() - 1}`);
  });
});
