// A former member's purge and their re-add on PostgreSQL 17 (issues #1722 and #1757, ADR-0037 §4). Both take the
// membership lock (crove_kernel.membership_lock): a re-add (crove_kernel.invite_accept) that commits while
// crove_notes.member_items_purge waits keeps the member's private notes and to-dos, and a re-add that comes while a
// purge holds the lock waits for it and joins after. The purge delay's audit read (in member_items_purge and
// former_members_due) uses audit_event_member_remove_idx. Part of the invariant suite; it imports package code under
// test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its
// own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
// How long a statement that should wait on the lock is given to show it does.
const BLOCKED_MS = 500;
const suite = ADMIN ? describe : describe.skip;

suite("a former member's purge and their re-add (#1722, #1757)", () => {
  const dbName = `crove_test_notes_purge_readd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool | undefined;
  let app: Runtime;
  let orgId = '';
  // Each removed 31 days ago with a private note and a to-do, then invited back: readded comes back while a purge
  // waits, gone while a purge runs.
  const users = { owner: '', readded: '', gone: '' };
  const tokens = { readded: '', gone: '' };
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
  async function connect(url: string): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    return c;
  }
  // Whether a pending statement is still waiting after BLOCKED_MS.
  async function stillWaiting(p: Promise<unknown>): Promise<boolean> {
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, BLOCKED_MS));
    return !settled;
  }
  const items = (userId: string) =>
    admin(async (c) => {
      const notes = (await c.query('SELECT 1 FROM crove_notes.note WHERE org_id = $1 AND author_user_id = $2', [orgId, userId])).rowCount ?? 0;
      const todos = (await c.query('SELECT 1 FROM crove_notes.todo WHERE org_id = $1 AND owner_user_id = $2', [orgId, userId])).rowCount ?? 0;
      return notes + todos;
    });
  const isMember = (userId: string) =>
    admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rowCount === 1);
  // A purge in the org's system context, as notes.member_items.purge runs it, left open for the test to commit.
  async function startPurge(userId: string) {
    const c = await connect(workerUrl);
    await c.query('BEGIN');
    await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
    const result = c.query<{ n: string }>('SELECT crove_notes.member_items_purge($1::uuid) AS n', [userId]).then((r) => Number(r.rows[0]?.n));
    return { c, result };
  }
  // An invite accepted through the command the API runs (kernel.member.invite.accept, with its audit row), which
  // commits on its own.
  const accept = (userId: string, token: string) => app.executeOrgless('kernel.member.invite.accept', { token }, { actor: asUser(userId) });
  // Waits until n transactions of this database wait for an advisory lock (the membership lock).
  async function lockWaiters(n: number): Promise<void> {
    const until = Date.now() + 10_000;
    for (;;) {
      const waiting = await admin(
        async (c) =>
          (
            await c.query<{ n: string }>(
              `SELECT pg_catalog.count(*) AS n FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_database d ON d.oid = l.database
               WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = pg_catalog.current_database()`,
            )
          ).rows[0]?.n,
      );
      if (Number(waiting) >= n) return;
      if (Date.now() > until) throw new Error(`${waiting} transactions wait for the membership lock, not ${n}`);
      await new Promise((r) => setTimeout(r, 25));
    }
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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    const db = createDb(pool);
    app = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'notes-purge-readd', subject: key, email: `${key}@notes-purge-readd.test`, name: null });
    }
    orgId = (await createOrg(app, asUser(users.owner), 'Mời lại')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, users.readded, users.gone]);
      for (const [i, user] of [users.readded, users.gone].entries()) {
        await c.query(`INSERT INTO crove_notes.note (org_id, id, author_user_id, title, body, visibility) VALUES ($1, $2, $3, 'Riêng', 'Riêng', 'private')`, [orgId, randomUUID(), user]);
        await c.query(`INSERT INTO crove_notes.todo (org_id, id, owner_user_id, title, status, sort_key) VALUES ($1, $2, $3, 'Việc', 'open', $4)`, [orgId, randomUUID(), user, `k${i}`]);
      }
    });
    for (const user of [users.readded, users.gone]) await app.execute('kernel.member.remove', { userId: user }, { actor: asMfa(users.owner), orgId });
    // The removals, 31 days back, so both are due. The audit trail is append-only, so its trigger is set aside here.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '31 days' WHERE org_id = $1 AND command = 'kernel.member.remove'`, [orgId]);
      await c.query('COMMIT');
    });
    for (const key of ['readded', 'gone'] as const) {
      const { acceptPath } = await app.execute<{ acceptPath: string }>('kernel.member.invite.create', { email: `${key}@notes-purge-readd.test`, role: 'member' }, { actor: asMfa(users.owner), orgId });
      tokens[key] = acceptPath.split('#')[1] as string;
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps the notes of a member re-added while the purge waits', async () => {
    expect(await items(users.readded)).toBe(2);
    // A gate holds the membership lock so the two can be lined up: the re-add asks for it first, the purge second.
    // Lock waiters are served in order, so the re-add commits its membership before the purge gets the lock.
    const gate = await connect(adminUrl);
    let purge: Awaited<ReturnType<typeof startPurge>> | undefined;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT crove_kernel.membership_lock($1::uuid, $2::uuid)', [orgId, users.readded]);
      const readd = accept(users.readded, tokens.readded);
      void readd.catch(() => {});
      await lockWaiters(1);
      purge = await startPurge(users.readded);
      void purge.result.catch(() => {});
      await lockWaiters(2);
      await gate.query('COMMIT');
      await readd;
      // The purge got the lock after the re-add committed: it sees the member and removes nothing.
      expect(await purge.result).toBe(0);
      await purge.c.query('COMMIT');
    } finally {
      await gate.end();
      await purge?.c.end();
    }
    expect(await isMember(users.readded)).toBe(true);
    expect(await items(users.readded)).toBe(2);
  });

  it('makes a re-add wait for a purge already running, then join after it', async () => {
    expect(await items(users.gone)).toBe(2);
    const purge = await startPurge(users.gone);
    try {
      // The purge has removed the note and the to-do and holds the lock, not yet committed.
      expect(await purge.result).toBe(2);
      // kernel.member.invite.accept (invite_accept) takes the same lock before its insert: it waits for the purge.
      const readd = accept(users.gone, tokens.gone);
      void readd.catch(() => {});
      expect(await stillWaiting(readd)).toBe(true);
      await lockWaiters(1);
      await purge.c.query('COMMIT');
      await readd;
    } finally {
      await purge.c.end();
    }
    expect(await isMember(users.gone)).toBe(true);
    expect(await items(users.gone)).toBe(0);
  });

  it('lets no login role take the membership lock itself', async () => {
    // A role that could hold it could stall purges or hold back invite accepts; only the definers' owner calls it.
    const rows = await admin(
      async (c) =>
        (
          await c.query<{ role: string; can: boolean; definer: boolean }>(
            `SELECT r.role, pg_catalog.has_function_privilege(r.role, 'crove_kernel.membership_lock(uuid, uuid)', 'EXECUTE') AS can,
                    (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_kernel.membership_lock(uuid, uuid)'::regprocedure) AS definer
             FROM pg_catalog.unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) AS r(role)
             WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname = r.role)`,
          )
        ).rows,
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect(r, r.role).toMatchObject({ can: false, definer: false });
  });

  it('reads the purge delay through audit_event_member_remove_idx (#1757)', async () => {
    // The two audit reads of the delay, as member_items_purge and former_members_due run them. The planner is kept off
    // a sequential scan, which this small table would otherwise get, so the plan shows which index it picks.
    // Ids written in (both are UUIDs the test made), so EXPLAIN plans the statement as the definers' plpgsql does.
    const org = `'${orgId}'::uuid`;
    const user = `'${users.gone}'::uuid`;
    const reads = {
      member_items_purge: `SELECT 1 FROM crove_kernel.audit_event a
        WHERE a.org_id = ${org} AND a.occurred_at > now() - interval '30 days'
          AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = ${user}`,
      former_members_due: `SELECT 1 FROM crove_kernel.audit_event a
        WHERE a.org_id = ${org} AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = ${user}`,
    };
    const plans = await admin(async (c) => {
      await c.query('ANALYZE crove_kernel.audit_event');
      await c.query('BEGIN');
      await c.query('SET LOCAL enable_seqscan = off');
      const out: Record<string, string> = {};
      for (const [name, query] of Object.entries(reads)) {
        const { rows } = await c.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query}`);
        out[name] = rows.map((r) => r['QUERY PLAN']).join('\n');
      }
      await c.query('ROLLBACK');
      return out;
    });
    // Printed for the pull request's evidence.
    console.log(`[notes-purge-readd] plans:\n${Object.entries(plans).map(([name, plan]) => `${name}:\n${plan}`).join('\n')}`);
    for (const [name, plan] of Object.entries(plans)) expect(plan, name).toContain('audit_event_member_remove_idx');
  });
});
