// Dead-letter Inbox items on PostgreSQL 17 (issue #1747, from the review of #1738), through raw SQL in each context:
//   - a dismissal names the context's own user: a member context cannot record another user as the one who dismissed
//     an item, and the system context, which has no user, dismisses nothing; a dismissal, once made, stays;
//   - only the system context changes an item's detail (the count of the day's failures), and only on an open item;
//     nobody changes its key, kind or raise time;
//   - only the system context deletes items (the daily prune); a member context deletes none;
//   - crove_kernel.inbox_item_prune_due answers the worker login alone, outside every context, with org ids only, paged.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('dead-letter Inbox items on PostgreSQL (#1747)', () => {
  const dbName = `crove_test_inbox_item_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool | undefined;
  let orgId = '';
  const users = { owner: '', admin: '' };
  // An open item and a dismissed one of the org.
  const items = { open: randomUUID(), dismissed: randomUUID() };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs fn as a login role in a context (or none), always rolled back.
  async function inContext<T>(url: string, enter: ((c: pg.Client) => Promise<unknown>) | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      if (enter) await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const asMember = (userId: string) => (c: pg.Client) => c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
  const asSystem = (c: pg.Client) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
  // The outcome of a statement: its row count, or the SQLSTATE and message it failed with.
  const outcome = async (run: Promise<pg.QueryResult>) =>
    run.then(
      (r) => ({ ok: true as const, rows: r.rowCount }),
      (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code, message: e.message }),
    );

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 2 });
    const db = createDb(pool);
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'inbox-item', subject: key, email: `${key}@inbox-item.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser(users.owner), 'Hộp thư')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, users.admin]);
      const detail = JSON.stringify({ queue: 'finance-portal-list', jobId: randomUUID(), retries: 0, failures: 1 });
      await c.query(
        `INSERT INTO crove_kernel.inbox_item (org_id, id, kind, dedupe_key, detail, dismissed_at, dismissed_by) VALUES
           ($1, $2, 'kernel.job.dead_lettered', 'queue:finance-portal-list:2026-10-01', $4, NULL, NULL),
           ($1, $3, 'kernel.job.dead_lettered', 'queue:finance-portal-list:2026-09-30', $4, now(), $5)`,
        [orgId, items.open, items.dismissed, detail, users.admin],
      );
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("records a dismissal only by the context's own user", async () => {
    const dismissAs = (by: string | null) => (c: pg.Client) =>
      c.query('UPDATE crove_kernel.inbox_item SET dismissed_at = now(), dismissed_by = $2 WHERE id = $1', [items.open, by]);
    // The owner as themself: allowed.
    expect(await inContext(appUrl, asMember(users.owner), (c) => outcome(dismissAs(users.owner)(c)))).toEqual({ ok: true, rows: 1 });
    // The owner recording the admin, or nobody with a time (the CHECK), as the one who dismissed it: refused.
    expect(await inContext(appUrl, asMember(users.owner), (c) => outcome(dismissAs(users.admin)(c)))).toMatchObject({
      ok: false,
      code: '42501',
      message: expect.stringContaining('inbox_item_dismiss'),
    });
    expect(await inContext(appUrl, asMember(users.owner), (c) => outcome(dismissAs(null)(c)))).toMatchObject({ ok: false, code: '23514' });
    // The system context has no user: it dismisses nothing, in anyone's name.
    for (const by of [users.owner, users.admin]) {
      expect(await inContext(workerUrl, asSystem, (c) => outcome(dismissAs(by)(c)))).toMatchObject({ ok: false, code: '42501' });
    }
  });

  it('keeps a dismissal as it was made: no re-dismissal in another name, no reopening', async () => {
    const change = (sql: string) => (c: pg.Client) => c.query(`UPDATE crove_kernel.inbox_item SET ${sql} WHERE id = $1`, [items.dismissed]);
    for (const set of ['dismissed_at = now(), dismissed_by = crove_kernel.ctx_user_id()', 'dismissed_at = NULL, dismissed_by = NULL']) {
      expect(await inContext(appUrl, asMember(users.owner), (c) => outcome(change(set)(c))), set).toMatchObject({
        ok: false,
        code: '42501',
        message: expect.stringContaining('INBOX_ITEM_DISMISSED'),
      });
    }
    // Writing the same values again changes nothing, and is allowed.
    expect(await inContext(appUrl, asMember(users.admin), (c) => outcome(change('dismissed_at = dismissed_at')(c)))).toEqual({ ok: true, rows: 1 });
  });

  it('lets only the system context change the detail, and only of an open item', async () => {
    const recount = (id: string) => (c: pg.Client) =>
      c.query(`UPDATE crove_kernel.inbox_item SET detail = detail || '{"failures": 7}'::jsonb WHERE id = $1`, [id]);
    expect(await inContext(workerUrl, asSystem, (c) => outcome(recount(items.open)(c)))).toEqual({ ok: true, rows: 1 });
    expect(await inContext(workerUrl, asSystem, (c) => outcome(recount(items.dismissed)(c)))).toMatchObject({
      ok: false,
      code: '42501',
      message: expect.stringContaining('INBOX_ITEM_SYSTEM_COUNTS_ONLY'),
    });
    for (const user of [users.owner, users.admin]) {
      expect(await inContext(appUrl, asMember(user), (c) => outcome(recount(items.open)(c)))).toMatchObject({
        ok: false,
        code: '42501',
        message: expect.stringContaining('INBOX_ITEM_DETAIL_SYSTEM_ONLY'),
      });
    }
    // The key, kind and raise time are fixed for every context (no column grant).
    for (const set of [`dedupe_key = 'job:x'`, 'raised_at = now()', `kind = 'kernel.job.dead_lettered'`]) {
      expect(await inContext(workerUrl, asSystem, (c) => outcome(c.query(`UPDATE crove_kernel.inbox_item SET ${set} WHERE id = $1`, [items.open]))), set).toMatchObject({
        ok: false,
        code: '42501',
      });
    }
  });

  it('lets only the system context delete items', async () => {
    const remove = (c: pg.Client) => c.query('DELETE FROM crove_kernel.inbox_item WHERE org_id = $1', [orgId]);
    for (const user of [users.owner, users.admin]) {
      expect(await inContext(appUrl, asMember(user), (c) => outcome(remove(c)))).toEqual({ ok: true, rows: 0 });
    }
    expect(await inContext(workerUrl, asSystem, (c) => outcome(remove(c)))).toEqual({ ok: true, rows: 2 });
    // Still both there: every attempt was rolled back.
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.inbox_item WHERE org_id = $1', [orgId])).rowCount)).toBe(2);
  });

  it('answers inbox_item_prune_due to the worker login alone, outside every context', async () => {
    const due = (c: pg.Client, after: string | null = null) =>
      c.query(`SELECT org_id FROM crove_kernel.inbox_item_prune_due($1::uuid, now() + interval '1 day', now() - interval '1 day', 10)`, [after]);
    const outside = await inContext(workerUrl, null, (c) => due(c));
    expect(outside.rows).toEqual([{ org_id: orgId }]);
    // Paged by org id: nothing after the last one.
    expect((await inContext(workerUrl, null, (c) => due(c, orgId))).rows).toEqual([]);
    expect(await inContext(workerUrl, asSystem, (c) => outcome(due(c)))).toMatchObject({ ok: false, code: '42501', message: expect.stringContaining('INBOX_ITEM_WORKER_ONLY') });
    expect(await inContext(appUrl, null, (c) => outcome(due(c)))).toMatchObject({ ok: false, code: '42501' });
    expect(await inContext(appUrl, asMember(users.owner), (c) => outcome(due(c)))).toMatchObject({ ok: false, code: '42501' });
  });
});
