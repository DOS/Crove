// The notes purge delays on PostgreSQL 17 (issue #1733, ADR-0037 §4, notes plan §3.7): the definers enforce them
// whatever their caller passes. crove_notes.trash_empty removes nothing put in the trash less than 30 days ago;
// crove_notes.member_items_purge removes nothing of a user removed from the org less than 30 days ago by the audit
// trail; crove_notes.former_members_due, the daily sweep's list, is the worker login's alone, outside every context,
// returns ids only, names a former member only once that delay has passed, and marks one whose removal the audit
// trail does not record, which the sweep keeps (fails closed). Part of the invariant suite; it imports
// package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL;
// each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'Số tài khoản riêng của tôi';
const DUE = 'SELECT * FROM crove_notes.former_members_due(100)';
const suite = ADMIN ? describe : describe.skip;

suite('notes purge delays on PostgreSQL (#1733, ADR-0037)', () => {
  const dbName = `crove_test_notes_purge_delay_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let orgId = '';
  // stay is a member; recent was removed today; old was removed today too, then moved 31 days back; unrecorded left
  // with no removal in the audit trail (an SQL delete).
  const users = { owner: '', stay: '', recent: '', old: '', unrecorded: '' };
  const trashed = { fresh: randomUUID(), stale: randomUUID() };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs fn as a login role in a context, always rolled back.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }));
  const system = (c: pg.Client) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
  const purge = (userId: string) => inContext(workerUrl, system, async (c) => (await c.query<{ n: string }>('SELECT crove_notes.member_items_purge($1::uuid) AS n', [userId])).rows[0]?.n);

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
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    app = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...notesCommands], queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'notes-purge-delay', subject: key, email: `${key}@notes-purge-delay.test`, name: null });
    }
    orgId = (await createOrg(app, asUser(users.owner), 'Hạn xóa ghi chú')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, [
        orgId,
        users.stay,
        users.recent,
        users.old,
        users.unrecorded,
      ]);
      // A private note and a to-do of each member; two notes of the member who stays in the trash, one since yesterday
      // and one for 31 days.
      for (const [i, user] of [users.stay, users.recent, users.old, users.unrecorded].entries()) {
        await c.query(`INSERT INTO crove_notes.note (org_id, id, author_user_id, title, body, visibility) VALUES ($1, $2, $3, $4, $4, 'private')`, [orgId, randomUUID(), user, SECRET]);
        await c.query(`INSERT INTO crove_notes.todo (org_id, id, owner_user_id, title, status, sort_key) VALUES ($1, $2, $3, $4, 'open', $5)`, [orgId, randomUUID(), user, SECRET, `k${i}`]);
      }
      await c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, title, body, visibility, deleted_at) VALUES
           ($1, $2, $4, $5, $5, 'private', now() - interval '1 day'), ($1, $3, $4, $5, $5, 'private', now() - interval '31 days')`,
        [orgId, trashed.fresh, trashed.stale, users.stay, SECRET],
      );
    });
    for (const user of [users.recent, users.old]) await app.execute('kernel.member.remove', { userId: user }, { actor: asMfa(users.owner), orgId });
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.unrecorded]));
    // The old removal, 31 days back. The audit trail is append-only, so its trigger is set aside for this statement.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '31 days' WHERE org_id = $1 AND command = 'kernel.member.remove' AND target_id = $2`, [
        orgId,
        users.old,
      ]);
      await c.query('COMMIT');
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('empties from the trash only what has been there 30 days, whatever cutoff the caller passes', async () => {
    // Each call rolled back: of the two notes in the trash, only the one there for 31 days goes, even with a cutoff in
    // the future.
    for (const cutoff of ["now() + interval '1 year'", 'now()', "now() - interval '2 days'"]) {
      const n = await inContext(workerUrl, system, async (c) => (await c.query<{ n: string }>(`SELECT crove_notes.trash_empty(${cutoff}) AS n`)).rows[0]?.n);
      expect(n, cutoff).toBe('1');
    }
    // Committed as the worker would: the note put in the trash yesterday stays.
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await system(c);
      await c.query(`SELECT crove_notes.trash_empty(now() + interval '1 year')`);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    const kept = await admin(async (a) => (await a.query<{ id: string }>('SELECT id FROM crove_notes.note WHERE id = ANY($1::uuid[])', [[trashed.fresh, trashed.stale]])).rows);
    expect(kept.map((r) => r.id)).toEqual([trashed.fresh]);
  });

  it("removes nothing of a member removed less than 30 days ago, and a former member's items after that", async () => {
    // A member: nothing. Removed today: nothing, though no longer a member.
    expect(await purge(users.stay)).toBe('0');
    expect(await purge(users.recent)).toBe('0');
    // Removed 31 days ago: the private note and the to-do.
    expect(await purge(users.old)).toBe('2');
  });

  it('lists for the sweep only former members past the delay, with ids only, marking the unrecorded, to the worker login outside every context', async () => {
    const callers: Array<[string, string, (c: pg.Client) => Promise<unknown>]> = [
      ['the app login, no context', appUrl, async () => {}],
      ['an owner of the org', appUrl, (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users.owner, orgId)])],
      ['the system context', workerUrl, system],
    ];
    for (const [name, url, enter] of callers) {
      expect(await outcome(inContext(url, enter, (c) => c.query(DUE))), name).toMatchObject({ ok: false, code: '42501' });
    }
    const due = await inContext(workerUrl, async () => {}, (c) => c.query(DUE));
    expect(due.fields.map((f) => f.name)).toEqual(['org_id', 'user_id', 'recorded']);
    // The recorded one first; the one whose membership ended with no removal row is marked, for the sweep to keep.
    expect(due.rows).toEqual([
      { org_id: orgId, user_id: users.old, recorded: true },
      { org_id: orgId, user_id: users.unrecorded, recorded: false },
    ]);
    expect(JSON.stringify(due.rows)).not.toContain(SECRET);
  });
});
