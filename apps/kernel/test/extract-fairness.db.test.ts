// Fair order on the extraction queue (#432, ADR-0035) on PostgreSQL 17 with the vendored pg-boss schema: one org's
// 500-entry ZIP does not hold back another org's single upload. The jobs are sent as the outbox relay sends them (in
// batches of 100, with extractPriorities and sendExtractJob, as crove_worker) and fetched as the extraction worker
// fetches them (one at a time). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { JOB_SCHEMA, QUEUES } from '../src/jobs-schema.ts';
import { extractPriorities, sendExtractJob, type OutboxRow } from '../src/worker.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Job {
  orgId: string;
  fileId: string;
  version?: number;
}

suite('fair order of extraction jobs across orgs (#432)', () => {
  const dbName = `crove_test_fairness_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool;
  let db: Db;
  let boss: PgBoss;
  let seq = 0;

  const event = (orgId: string, type = 'kernel.file.ingested', payload: Record<string, unknown> = {}): OutboxRow => ({
    seq: String(++seq),
    org_id: orgId,
    event_id: randomUUID(),
    type,
    payload: { fileId: randomUUID(), ...payload },
  });

  // What the relay does with one claimed batch.
  async function relay(rows: OutboxRow[]): Promise<void> {
    const priorities = await extractPriorities(db, rows);
    await Promise.all(rows.map((row) => sendExtractJob(boss, row, priorities.get(row) ?? 0)));
  }
  async function relayAll(rows: OutboxRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 100) await relay(rows.slice(i, i + 100));
  }

  // The next job the extraction worker would run, marked done.
  async function runNext(): Promise<Job | null> {
    const [job] = await boss.fetch<Job>(QUEUES.extract);
    if (!job) return null;
    await boss.complete(QUEUES.extract, job.id);
    return job.data;
  }

  async function drain(): Promise<void> {
    while (await runNext());
  }

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
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    pool = createPool({ connectionString: url.toString(), max: 2 });
    db = createDb(pool);
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

  it("runs another org's single upload within two jobs while one org has 500 entries queued", { timeout: 120_000 }, async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    // Org A's ZIP is opened: its 500 entries reach the outbox in one transaction and the relay sends them.
    await relayAll(Array.from({ length: 500 }, () => event(orgA)));
    // Org A's first two entries are read, then org B uploads one file.
    expect((await runNext())?.orgId).toBe(orgA);
    expect((await runNext())?.orgId).toBe(orgA);
    const single = event(orgB);
    await relay([single]);
    const order: string[] = [];
    for (let i = 0; i < 2; i++) order.push((await runNext())?.fileId ?? '');
    expect(order).toContain(single.payload.fileId);

    // A second upload of org B, and a re-extraction it asked for, again overtake org A's backlog.
    await runNext();
    const again = [event(orgB), event(orgB, 'kernel.file.reextract_requested', { version: 2 })];
    await relay(again);
    const next = [await runNext(), await runNext(), await runNext()].map((job) => job?.fileId);
    for (const row of again) expect(next).toContain(row.payload.fileId);

    // Org A's entries all run in the end, and nothing else is left.
    let remaining = 0;
    while (await runNext()) remaining++;
    expect(remaining).toBeGreaterThan(490);
  });

  it('gives each org its k-th waiting job in round k, and counts the jobs already queued', async () => {
    await drain();
    const [orgA, orgB, orgC] = [randomUUID(), randomUUID(), randomUUID()];
    // One batch with three orgs interleaved unevenly, then a later batch for org A.
    await relay([...Array.from({ length: 4 }, () => event(orgA)), event(orgB), event(orgB), event(orgC)]);
    await relay([event(orgA)]);
    const { rows } = await pool.query<{ group_id: string; priority: number }>(
      `SELECT group_id, priority FROM ${JOB_SCHEMA}.job WHERE name = $1 AND state = 'created' ORDER BY priority DESC, created_on`,
      [QUEUES.extract],
    );
    const label = (id: string) => (id === orgA ? 'A' : id === orgB ? 'B' : 'C');
    // The jobs of one batch are sent at once, so within a round their creation order is not fixed.
    const rounds = new Map<number, string[]>();
    for (const r of rows) rounds.set(-r.priority, [...(rounds.get(-r.priority) ?? []), label(r.group_id)].sort());
    expect(Object.fromEntries(rounds)).toEqual({ 0: ['A', 'B', 'C'], 1: ['A', 'B'], 2: ['A'], 3: ['A'], 4: ['A'] });
    // An org with nothing queued starts at priority 0 again once its jobs are done.
    await drain();
    await relay([event(orgA)]);
    const [fresh] = (await pool.query<{ priority: number }>(`SELECT priority FROM ${JOB_SCHEMA}.job WHERE name = $1 AND state = 'created'`, [QUEUES.extract])).rows;
    expect(fresh?.priority).toBe(0);
    await drain();
  });

  it('leaves the priorities of other events alone', async () => {
    const orgA = randomUUID();
    const priorities = await extractPriorities(db, [event(orgA, 'kernel.org.export_requested'), event(orgA, 'kernel.proposal.created')]);
    expect(priorities.size).toBe(0);
  });
});
