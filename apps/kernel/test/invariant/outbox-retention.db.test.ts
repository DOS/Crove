// Outbox retention (issue #997, plan §4.9) on a real PostgreSQL 17. Events older than 30 days are archived to the
// WORM store one org day at a time, then deleted; nothing else may delete an outbox event. Checked here:
//   - only the worker runs the retention functions, and no runtime role touches crove_kernel.outbox_archive;
//   - a plain DELETE or UPDATE of outbox_event fails for every role, the database owner included, and so does a
//     DELETE that names the purge setting without an archived day;
//   - a day newer than 30 days, or not archived, is refused; a day whose rows changed after archiving rolls back;
//   - an event still waiting for the relay defers its day; another org's day and recent events stay;
//   - the archive object holds exactly the deleted events, and a second run changes nothing.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { OUTBOX_ARCHIVE_PREFIX, archiveOutbox, type OutboxManifest } from '../../src/outbox-retention.ts';
import { LocalArchiveStore } from '../../src/worm.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const RETENTION_FUNCTIONS = [
  'crove_kernel.outbox_archive_due(int,int)',
  'crove_kernel.outbox_archive_rows(uuid,date)',
  'crove_kernel.outbox_archive_record(uuid,date,text,text,int)',
  'crove_kernel.outbox_archive_purge(uuid,date,int)',
];

const suite = ADMIN ? describe : describe.skip;

suite('outbox retention: archive, then delete (#997)', () => {
  const dbName = `crove_test_outbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let worker: Db;
  let dir = '';
  let store: LocalArchiveStore;
  const orgs: string[] = [];

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  // An event of the org, written as the database owner at a given time (setup; emit() always stamps now()).
  const event = (orgId: string, createdAt: string, type = 'test.event') =>
    admin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.outbox_event (org_id, type, payload, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [orgId, type, JSON.stringify({ n: randomUUID() }), createdAt],
      );
      return rows[0]?.id as string;
    });
  const count = (orgId: string, from: string, to: string) =>
    admin(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM crove_kernel.outbox_event WHERE org_id = $1 AND created_at >= $2 AND created_at < $3`,
        [orgId, from, to],
      );
      return Number(rows[0]?.n);
    });
  const daysAgo = (n: number, time = '10:00:00') => {
    const d = new Date(Date.now() - n * 86_400_000);
    return `${d.toISOString().slice(0, 10)}T${time}Z`;
  };
  const day = (iso: string) => iso.slice(0, 10);
  const nextDay = (iso: string) => new Date(Date.parse(`${day(iso)}T00:00:00Z`) + 86_400_000).toISOString();

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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    worker = createDb(workerPool);
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    for (const name of ['a', 'b']) {
      const userId = await upsertIdentity(db, { issuer: 'test', subject: `outbox-${name}`, email: `outbox-${name}@example.com`, name: null });
      orgs.push((await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, `Outbox ${name.toUpperCase()}`)).orgId);
    }
    dir = mkdtempSync(join(tmpdir(), 'crove-outbox-'));
    store = new LocalArchiveStore(dir);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only the worker run the retention functions, and no runtime role touch the archive records', async () => {
    const grants = await admin(async (c) => {
      const { rows } = await c.query<{ fn: string; role: string; allowed: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS allowed
         FROM unnest($1::text[]) f CROSS JOIN unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) r`,
        [RETENTION_FUNCTIONS],
      );
      return rows.filter((r) => r.allowed).map((r) => `${r.role} ${r.fn}`);
    });
    expect(grants.sort()).toEqual(RETENTION_FUNCTIONS.map((f) => `crove_worker ${f}`).sort());
    const tableGrants = await admin(async (c) => {
      const { rows } = await c.query<{ grantee: string }>(
        `SELECT grantee FROM information_schema.role_table_grants WHERE table_schema = 'crove_kernel' AND table_name = 'outbox_archive'
           AND grantee IN ('crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober', 'PUBLIC')`,
      );
      return rows;
    });
    expect(tableGrants).toEqual([]);
    // The app's login role cannot call them, even with a valid org and day.
    await expect(sql`SELECT crove_kernel.outbox_archive_purge(${orgs[0]}::uuid, '2020-01-01'::date, 30)`.execute(db)).rejects.toThrow(/permission denied/);
  });

  it('refuses a plain delete or update of an event for every role, the database owner included', async () => {
    const old = daysAgo(40);
    const id = await event(orgs[0] as string, old);
    await admin(async (c) => {
      await expect(c.query('DELETE FROM crove_kernel.outbox_event WHERE id = $1', [id])).rejects.toThrow(/append-only/);
      await expect(c.query(`UPDATE crove_kernel.outbox_event SET type = 'x' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
      await expect(c.query('TRUNCATE crove_kernel.outbox_event')).rejects.toThrow(/append-only/);
      // Naming the purge setting is not enough: the day is not archived.
      await c.query('BEGIN');
      await c.query(`SELECT set_config('crove.outbox_purge', $1, true)`, [`${orgs[0]}:${day(old)}`]);
      await expect(c.query('DELETE FROM crove_kernel.outbox_event WHERE id = $1', [id])).rejects.toThrow(/append-only/);
      await c.query('ROLLBACK');
    });
    // The worker cannot delete outside the purge either.
    await expect(sql`DELETE FROM crove_kernel.outbox_event WHERE id = ${id}::uuid`.execute(worker)).rejects.toThrow(/permission denied|append-only/);
  });

  it('refuses a day newer than 30 days or not archived', async () => {
    const recent = daysAgo(5);
    await event(orgs[0] as string, recent);
    await expect(sql`SELECT crove_kernel.outbox_archive_record(${orgs[0]}::uuid, ${day(recent)}::date, 'k', ${'a'.repeat(64)}, 1)`.execute(worker)).rejects.toThrow(/OUTBOX_DAY_TOO_RECENT/);
    await expect(sql`SELECT crove_kernel.outbox_archive_purge(${orgs[0]}::uuid, ${day(recent)}::date, 30)`.execute(worker)).rejects.toThrow(/OUTBOX_DAY_TOO_RECENT/);
    // A keep period below 30 days counts as 30.
    await expect(sql`SELECT crove_kernel.outbox_archive_purge(${orgs[0]}::uuid, ${day(recent)}::date, 1)`.execute(worker)).rejects.toThrow(/OUTBOX_DAY_TOO_RECENT/);
    await expect(sql`SELECT crove_kernel.outbox_archive_purge(${orgs[0]}::uuid, ${day(daysAgo(60))}::date, 30)`.execute(worker)).rejects.toThrow(/OUTBOX_DAY_NOT_ARCHIVED/);
  });

  it('archives each due org day, deletes exactly its events, keeps recent ones, and changes nothing on a second run', async () => {
    const [a, b] = orgs as [string, string];
    const old = daysAgo(45);
    const ids = [await event(a, old), await event(a, daysAgo(45, '11:00:00')), await event(a, daysAgo(45, '23:59:59'))];
    const otherOrg = await event(b, old);
    const recent = await event(a, daysAgo(3));
    // The earlier tests left one 40-day-old event of org A.
    const result = await archiveOutbox(worker, store);
    expect(result.purged).toBe(5);
    expect(result.deferred).toBe(0);
    expect(await count(a, `${day(old)}T00:00:00Z`, nextDay(old))).toBe(0);
    expect(await count(b, `${day(old)}T00:00:00Z`, nextDay(old))).toBe(0);
    expect(await count(a, daysAgo(3, '00:00:00'), nextDay(daysAgo(3)))).toBe(1);

    // The archive holds exactly the deleted events of org A's day, in order, with a manifest that matches.
    const manifest = JSON.parse(new TextDecoder().decode((await store.get(`${OUTBOX_ARCHIVE_PREFIX}${a}/${day(old)}.manifest.json`)) as Uint8Array)) as OutboxManifest;
    expect(manifest).toMatchObject({ format: 'crove-outbox-archive', orgId: a, day: day(old), rows: 3, firstId: ids[0], lastId: ids[2] });
    const lines = new TextDecoder().decode((await store.get(manifest.object)) as Uint8Array).trim().split('\n').map((l) => JSON.parse(l) as { id: string; org_id: string });
    expect(lines.map((l) => l.id)).toEqual(ids);
    expect(lines.every((l) => l.org_id === a)).toBe(true);
    const otherManifest = JSON.parse(new TextDecoder().decode((await store.get(`${OUTBOX_ARCHIVE_PREFIX}${b}/${day(old)}.manifest.json`)) as Uint8Array)) as OutboxManifest;
    expect(otherManifest).toMatchObject({ orgId: b, rows: 1, firstId: otherOrg, lastId: otherOrg });
    expect(recent).toBeTruthy();

    expect(await archiveOutbox(worker, store)).toEqual({ archived: 0, purged: 0, deferred: 0 });
  });

  it('defers a day while one of its events waits for the relay', async () => {
    const a = orgs[0] as string;
    const old = daysAgo(50);
    const id = await event(a, old);
    await admin((c) => c.query('INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES ($1, $2)', [a, id]));
    expect(await archiveOutbox(worker, store)).toMatchObject({ archived: 1, purged: 0, deferred: 1 });
    expect(await count(a, `${day(old)}T00:00:00Z`, nextDay(old))).toBe(1);
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending WHERE event_id = $1', [id]));
    expect(await archiveOutbox(worker, store)).toMatchObject({ archived: 0, purged: 1, deferred: 0 });
  });

  it('rolls back the whole day when its events differ from the archived count', async () => {
    const a = orgs[0] as string;
    const old = daysAgo(55);
    await event(a, old);
    // Archived with one event, then a backdated one appears (only the database owner can write that).
    const due = await sql<{ org_id: string; day: string }>`SELECT org_id, day::text AS day FROM crove_kernel.outbox_archive_due(30, 10) WHERE org_id = ${a}::uuid`.execute(worker);
    expect(due.rows.map((r) => r.day)).toEqual([day(old)]);
    const { archiveOutboxDay } = await import('../../src/outbox-retention.ts');
    await archiveOutboxDay(worker, store, a, day(old));
    await event(a, daysAgo(55, '12:00:00'));
    await expect(sql`SELECT crove_kernel.outbox_archive_purge(${a}::uuid, ${day(old)}::date, 30)`.execute(worker)).rejects.toThrow(/OUTBOX_PURGE_MISMATCH/);
    expect(await count(a, `${day(old)}T00:00:00Z`, nextDay(old))).toBe(2);
  });
});
