// Two orgs with the same logical key never dedupe against each other (plan §4.8 "Job keys", #1694), on PostgreSQL 17
// with the vendored pg-boss schema and its queues as the migrations create them: the queues that dedupe on the key
// (stately: agent wake-ups, publishing, mail) and a singletonSeconds slot (team chat alerts). A raw key, as some sends
// had before, lets one org's job swallow another's; the same org's second job is still deduped. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { jobKey } from '../src/job-keys.ts';
import { JOB_SCHEMA, MAIL_QUEUES, QUEUES, socialPublishQueue } from '../src/jobs-schema.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('job keys across orgs (#1694)', () => {
  const dbName = `crove_test_job_keys_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    const adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    // As the worker sends them.
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
    boss = new PgBoss({ connectionString: url.toString(), schema: JOB_SCHEMA, migrate: false, createSchema: false, supervise: false, schedule: false });
    boss.on('error', () => {});
    await boss.start();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false }).catch(() => {});
    await pool?.end().catch(() => {});
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const policyOf = async (queue: string) =>
    (await pool.query<{ policy: string }>(`SELECT policy FROM ${JOB_SCHEMA}.queue WHERE name = $1`, [queue])).rows[0]?.policy;
  const queued = async (queue: string, orgId: string) =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${JOB_SCHEMA}.job WHERE name = $1 AND data->>'orgId' = $2`, [queue, orgId])).rows[0]?.n;

  it.each([QUEUES.agentWake, socialPublishQueue('sandbox'), ...MAIL_QUEUES])('queues one job per org for the same logical key on %s', async (queue) => {
    // The queue dedupes on the key, so the test would see a collision.
    expect(await policyOf(queue)).toBe('stately');
    const [orgA, orgB] = [randomUUID(), randomUUID()];
    const logical = randomUUID();
    const send = (orgId: string) => boss.send(queue, { orgId, key: logical }, { singletonKey: jobKey(orgId, queue, logical) });
    expect(await send(orgA)).toEqual(expect.any(String));
    expect(await send(orgB)).toEqual(expect.any(String));
    // Each org's own second job is still deduped.
    expect(await send(orgA)).toBeNull();
    expect(await send(orgB)).toBeNull();
    expect([await queued(queue, orgA), await queued(queue, orgB)]).toEqual([1, 1]);
  });

  it('gives each org its own singletonSeconds slot for the same logical key', async () => {
    const queue = QUEUES.socialChatAlert;
    const [orgA, orgB] = [randomUUID(), randomUUID()];
    const send = (orgId: string) => boss.send(queue, { orgId, test: true }, { singletonKey: jobKey(orgId, queue, 'test'), singletonSeconds: 3600, retryLimit: 0 });
    expect(await send(orgA)).toEqual(expect.any(String));
    expect(await send(orgB)).toEqual(expect.any(String));
    expect(await send(orgA)).toBeNull();
    expect([await queued(queue, orgA), await queued(queue, orgB)]).toEqual([1, 1]);
  });

  it("lets one org's job swallow another org's under a raw key, which the helper prevents", async () => {
    const queue = MAIL_QUEUES[0] as string;
    const [orgA, orgB] = [randomUUID(), randomUUID()];
    const raw = randomUUID();
    expect(await boss.send(queue, { orgId: orgA }, { singletonKey: raw })).toEqual(expect.any(String));
    expect(await boss.send(queue, { orgId: orgB }, { singletonKey: raw })).toBeNull();
    expect(await queued(queue, orgB)).toBe(0);
  });
});
