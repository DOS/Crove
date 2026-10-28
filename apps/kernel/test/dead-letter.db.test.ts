// Dead letters (#1720) on a real PostgreSQL 17 with the pinned pg-boss: a job that fails its last retry goes to
// kernel-job.dlq, and its worker raises exactly one Inbox item kernel.job.dead_lettered in the job's own org and none in
// another, with nothing of the job's data or error. Owners and admins read and dismiss it; members do not see it. A job
// of no org raises nothing in any org; the failed job stays where the prober counts it. Taking the same dead letter
// twice raises nothing new, and a member context cannot raise an item itself.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss, type JobWithMetadata } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { zRaisedInboxItems, type RaisedInboxItem } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { takeDeadLetter } from '../src/dead-letter.ts';
import { jobGroup, jobKey } from '../src/job-keys.ts';
import { JOB_SCHEMA, QUEUES } from '../src/jobs-schema.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
// What a failing job carried and threw: none of it may reach an Inbox item.
const SECRET = 'payload-text-that-must-not-leak';

suite('dead letters raise an Inbox item in their own org (#1720)', () => {
  const dbName = `crove_test_dlq_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let boss: PgBoss;
  const people = { owner: '', admin: '', member: '', outsider: '' };
  let orgA = { slug: '', orgId: '' };
  let orgB = { slug: '', orgId: '' };

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const raised = async (userId: string, orgId: string) => zRaisedInboxItems.parse(await runtime.query('kernel.inbox.raised', {}, { actor: asUser(userId), orgId }));

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const loginUrl = (username: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = username;
    url.password = password;
    return url.toString();
  };
  const items = (orgId?: string) =>
    admin(async (c) =>
      (
        await c.query<{ org_id: string; kind: string; dedupe_key: string; detail: Record<string, unknown>; dismissed_at: Date | null }>(
          `SELECT org_id, kind, dedupe_key, detail, dismissed_at FROM crove_kernel.inbox_item ${orgId ? 'WHERE org_id = $1' : ''} ORDER BY raised_at, id`,
          orgId ? [orgId] : [],
        )
      ).rows,
    );

  // Sends a job with no retry left, fails it as its handler would, and returns the copy pg-boss put in the dead letter
  // queue (fetched as the worker's loop does, with its metadata).
  async function deadLetter(queue: string, data: object | null, options: { singletonKey?: string; group?: { id: string } } = {}): Promise<{ id: string; letter: JobWithMetadata<unknown> }> {
    const id = await boss.send(queue, data, { ...options, retryLimit: 0 });
    if (!id) throw new Error('job not created');
    const [job] = await boss.fetch(queue, { includeMetadata: true });
    expect(job?.id).toBe(id);
    await boss.fail(queue, id, { message: SECRET });
    const [letter] = await boss.fetch<unknown>(QUEUES.deadLetter, { includeMetadata: true });
    if (!letter) throw new Error('no dead letter');
    expect(letter).toMatchObject({ sourceName: queue, sourceId: id });
    return { id, letter };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (db: ReturnType<typeof createDb>) => new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const db = createDb(pool);
    runtime = register(db);
    workerRuntime = register(createDb(workerPool));
    for (const key of Object.keys(people) as (keyof typeof people)[]) {
      people[key] = await upsertIdentity(db, { issuer: 'test', subject: `dlq-${key}`, email: `${key}@dlq.test`, name: key });
    }
    orgA = await createOrg(runtime, asUser(people.owner), 'Công ty Hàng đợi');
    for (const [who, email, role] of [
      [people.admin, 'admin@dlq.test', 'admin'],
      [people.member, 'member@dlq.test', 'member'],
    ] as const) {
      const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role }, { actor: asMfa(people.owner), orgId: orgA.orgId });
      await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(who) });
    }
    orgB = await createOrg(runtime, asUser(people.outsider), 'Công ty Khác');
    boss = new PgBoss({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), schema: JOB_SCHEMA, migrate: false, createSchema: false, supervise: false, schedule: false });
    boss.on('error', () => {});
    await boss.start();
  }, 120_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false }).catch(() => {});
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives exactly one Inbox item in its own org and none in another, with nothing of the job', async () => {
    const listId = randomUUID();
    const { id, letter } = await deadLetter(QUEUES.portalList, { orgId: orgA.orgId, listId, note: SECRET }, { singletonKey: jobKey(orgA.orgId, QUEUES.portalList, listId) });
    // The failed job itself stays failed, where the prober counts it.
    const failed = await admin(async (c) => (await c.query<{ state: string }>(`SELECT state FROM ${JOB_SCHEMA}.job WHERE id = $1`, [id])).rows);
    expect(failed).toEqual([{ state: 'failed' }]);

    expect(await takeDeadLetter(workerRuntime, letter)).toBe('raised');
    // The same copy again (a retry after the command committed): nothing new.
    expect(await takeDeadLetter(workerRuntime, letter)).toBe('repeat');

    const a = await items(orgA.orgId);
    expect(a).toEqual([{ org_id: orgA.orgId, kind: 'kernel.job.dead_lettered', dedupe_key: `job:${id}`, detail: { queue: QUEUES.portalList, jobId: id, retries: 0 }, dismissed_at: null }]);
    expect(await items(orgB.orgId)).toEqual([]);
    expect(JSON.stringify(a)).not.toContain(SECRET);
    expect(JSON.stringify(a)).not.toContain(listId);

    // Owners and admins of the org see it; its members and the other org do not.
    const shown = await raised(people.owner, orgA.orgId);
    expect(shown.total).toBe(1);
    expect(shown.items).toEqual([{ id: expect.any(String), kind: 'kernel.job.dead_lettered', queue: QUEUES.portalList, jobId: id, retries: 0, raisedAt: expect.any(String) }] satisfies RaisedInboxItem[]);
    expect(JSON.stringify(shown)).not.toContain(SECRET);
    expect((await raised(people.admin, orgA.orgId)).total).toBe(1);
    expect(await raised(people.member, orgA.orgId)).toEqual({ items: [], total: 0 });
    expect(await raised(people.outsider, orgB.orgId)).toEqual({ items: [], total: 0 });

    // Another org cannot dismiss it: it does not see it.
    const itemId = shown.items[0]?.id as string;
    await expect(runtime.execute('kernel.inbox.dismiss', { id: itemId }, { actor: asUser(people.outsider), orgId: orgB.orgId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A member may not; an admin may, and dismissing it again changes nothing.
    await expect(runtime.execute('kernel.inbox.dismiss', { id: itemId }, { actor: asUser(people.member), orgId: orgA.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runtime.execute('kernel.inbox.dismiss', { id: itemId }, { actor: asUser(people.admin), orgId: orgA.orgId });
    await runtime.execute('kernel.inbox.dismiss', { id: itemId }, { actor: asUser(people.owner), orgId: orgA.orgId });
    expect(await raised(people.owner, orgA.orgId)).toEqual({ items: [], total: 0 });
    const [dismissed] = await items(orgA.orgId);
    expect(dismissed?.dismissed_at).toBeInstanceOf(Date);
  });

  it('reads the org of a job from its group, the extraction queue', async () => {
    const before = (await items(orgB.orgId)).length;
    const fileId = randomUUID();
    const { id, letter } = await deadLetter(QUEUES.extract, { orgId: orgB.orgId, fileId }, { group: jobGroup(orgB.orgId, QUEUES.extract), singletonKey: jobKey(orgB.orgId, QUEUES.extract, fileId) });
    expect(await takeDeadLetter(workerRuntime, letter)).toBe('raised');
    const b = await items(orgB.orgId);
    expect(b).toHaveLength(before + 1);
    expect(b.at(-1)).toMatchObject({ dedupe_key: `job:${id}`, detail: { queue: QUEUES.extract, jobId: id } });
    expect((await items(orgA.orgId)).some((i) => i.dedupe_key === `job:${id}`)).toBe(false);
  });

  it('raises nothing in any org for a job of no org, which the prober still counts', async () => {
    const before = await items();
    const { id, letter } = await deadLetter(QUEUES.retention, null);
    expect(await takeDeadLetter(workerRuntime, letter)).toBe('system');
    expect(await items()).toEqual(before);
    const health = await admin(async (c) => (await c.query<{ dead_letter_count: number }>('SELECT dead_letter_count FROM crove_kernel.health(3600)')).rows[0]);
    expect(health?.dead_letter_count).toBeGreaterThanOrEqual(1);
    const failed = await admin(async (c) => (await c.query<{ state: string }>(`SELECT state FROM ${JOB_SCHEMA}.job WHERE id = $1`, [id])).rows);
    expect(failed).toEqual([{ state: 'failed' }]);
  });

  it('raises nothing when the key and the data name different orgs', async () => {
    const before = await items();
    const listId = randomUUID();
    const { letter } = await deadLetter(QUEUES.portalList, { orgId: orgB.orgId, listId }, { singletonKey: jobKey(orgA.orgId, QUEUES.portalList, listId) });
    expect(await takeDeadLetter(workerRuntime, letter)).toBe('conflict');
    expect(await items()).toEqual(before);
  });

  it('raises nothing, and completes, for an org the system may not enter', async () => {
    const before = await items();
    const gone = randomUUID();
    const { letter } = await deadLetter(QUEUES.portalList, { orgId: gone, listId: 'l' }, { singletonKey: jobKey(gone, QUEUES.portalList, 'l') });
    expect(await takeDeadLetter(workerRuntime, letter)).toBe('refused');
    expect(await items()).toEqual(before);
  });

  it('fails a job that is not a copy pg-boss made, so the prober counts it', async () => {
    await expect(takeDeadLetter(workerRuntime, { id: randomUUID(), data: { orgId: orgA.orgId }, singletonKey: null, groupId: null, sourceName: null, sourceId: null, sourceRetryCount: null })).rejects.toThrow(
      /not a dead letter pg-boss made/,
    );
  });

  it('refuses an item a member context makes up', async () => {
    const client = new pg.Client({ connectionString: loginUrl('crove_app', 'test-app-pw') });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [people.owner, orgA.orgId]);
      await expect(
        client.query(`INSERT INTO crove_kernel.inbox_item (org_id, kind, dedupe_key) VALUES ($1, 'kernel.job.dead_lettered', 'job:made-up')`, [orgA.orgId]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('inbox_item_raise') });
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});
