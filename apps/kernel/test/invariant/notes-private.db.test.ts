// Private notes on PostgreSQL 17 (issue #1671, ADR-0037 §2, notes plan exit criterion 1): a private note is read and
// changed only in a context whose user is its author. Another member, an owner, an admin, a viewer, a member limited to
// some legal entities, an agent context and the system context read none of it and change none of it, through raw SQL
// in their own context; a shared note is read by the org's owners, admins and whole-org members and by the system
// context, and by no viewer, entity-limited member or agent. The author still reads their own notes after losing the
// whole-org scope. The definers the worker and owners use return counts, never text, and refuse every other caller; a
// forged context reaches nothing. Part of the invariant suite; it imports package code under test, never helpers from
// outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const SECRET = 'Mật khẩu cổng ngân hàng của khách';
const suite = ADMIN ? describe : describe.skip;

suite('private notes on PostgreSQL (#1671, ADR-0037)', () => {
  const dbName = `crove_test_notes_private_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let branch = '';
  const users = { owner: '', admin: '', author: '', member: '', viewer: '', limited: '' };
  // The author's private note and shared note, each linked to the org's party.
  const notes = { private: randomUUID(), shared: randomUUID(), party: randomUUID(), privateLink: randomUUID(), sharedLink: randomUUID() };
  let agent = { agentId: '', runId: '' };
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

  interface Actor {
    name: string;
    url: () => string;
    enter: (c: pg.Client) => Promise<unknown>;
  }
  const member = (name: string, userId: () => string): Actor => ({
    name,
    url: () => appUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId(), orgId]),
  });
  const system: Actor = { name: 'the system context', url: () => workerUrl, enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]) };
  const agentActor: Actor = {
    name: 'an agent context',
    url: () => workerUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]),
  };
  const author = member('the author', () => users.author);
  // Everyone but the author, with whether they read the shared note.
  const others: Array<{ actor: Actor; readsShared: boolean }> = [
    { actor: member('another member', () => users.member), readsShared: true },
    { actor: member('an owner', () => users.owner), readsShared: true },
    { actor: member('an admin', () => users.admin), readsShared: true },
    { actor: member('a viewer', () => users.viewer), readsShared: false },
    { actor: member('a member limited to a branch', () => users.limited), readsShared: false },
    { actor: agentActor, readsShared: false },
    { actor: system, readsShared: true },
  ];
  // The owner and the admin, who may change a shared note.
  const managers = () => others.slice(1, 3).map((o) => o.actor);
  const run = <T>(actor: Actor, fn: (c: pg.Client) => Promise<T>) => inContext(actor.url(), actor.enter, fn);
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }));

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
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      return { db, runtime: new Runtime(db).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] }) };
    };
    const api = runtimeFor(appUrl);
    const worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, { issuer: 'notes-private', subject: key, email: `${key}@notes-private.test`, name: null });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), 'Ghi chú riêng')).orgId;
    await admin(async (c) => {
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, users.owner]))
        .rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer'), ($1, $6, 'member')`,
        [orgId, users.admin, users.author, users.member, users.viewer, users.limited],
      );
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        users.limited,
        branch,
        users.owner,
      ]);
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $2, 'Công ty Khách')`, [orgId, notes.party]);
      await c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body, tags) VALUES
           ($1, $2, $4, 'private', $5, $5, ARRAY['riêng']), ($1, $3, $4, 'org', 'Giám đốc nghe máy sau 15h', '', ARRAY['khách'])`,
        [orgId, notes.private, notes.shared, users.author, SECRET],
      );
      await c.query(
        `INSERT INTO crove_notes.link (org_id, id, note_id, target_type, target_id, party_id, created_by) VALUES
           ($1, $2, $3, 'kernel.party', $6, $6, $7), ($1, $4, $5, 'kernel.party', $6, $6, $7)`,
        [orgId, notes.privateLink, notes.private, notes.sharedLink, notes.shared, notes.party, users.author],
      );
    });
    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    await api.runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId });
    agent = { agentId: installed.agentId, runId: started.runId as string };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shows the author both notes and their links', async () => {
    const seen = await run(author, async (c) => ({
      notes: (await c.query<{ id: string }>('SELECT id FROM crove_notes.note ORDER BY id')).rows.map((r) => r.id),
      links: (await c.query<{ id: string }>('SELECT id FROM crove_notes.link ORDER BY id')).rows.map((r) => r.id),
    }));
    expect(seen.notes).toEqual([notes.private, notes.shared].sort());
    expect(seen.links).toEqual([notes.privateLink, notes.sharedLink].sort());
  });

  it('lets no one but the author read the private note or its link, and the shared one only to whole-org members and the system', async () => {
    for (const { actor, readsShared } of others) {
      const seen = await run(actor, async (c) => ({
        notes: (await c.query<{ id: string }>('SELECT id FROM crove_notes.note')).rows.map((r) => r.id),
        byId: (await c.query('SELECT title, body, tags, search FROM crove_notes.note WHERE id = $1', [notes.private])).rowCount,
        searched: (await c.query(`SELECT id FROM crove_notes.note WHERE search @@ crove_kernel.search_query('mat khau')`)).rowCount,
        links: (await c.query<{ id: string }>('SELECT id FROM crove_notes.link')).rows.map((r) => r.id),
      }));
      expect(seen.byId, `${actor.name} reading the private note by id`).toBe(0);
      expect(seen.searched, `${actor.name} searching the private note's words`).toBe(0);
      expect(seen.notes, `${actor.name}'s notes`).toEqual(readsShared ? [notes.shared] : []);
      expect(seen.links, `${actor.name}'s links`).toEqual(readsShared ? [notes.sharedLink] : []);
    }
  });

  it('lets no one but the author change the private note, write one for the author, or touch its links', async () => {
    for (const { actor } of others) {
      const where = actor.name;
      const updated = await outcome(run(actor, (c) => c.query(`UPDATE crove_notes.note SET title = 'đổi', visibility = 'org' WHERE id = $1`, [notes.private])));
      if (updated.ok) expect(updated.value.rowCount, `${where} updating the private note`).toBe(0);
      else expect(updated, `${where} updating the private note`).toMatchObject({ code: '42501' });
      // A sweep with no WHERE clause reads no column, so no SELECT policy hides the private row from it: owners and admins
      // change the shared note alone, everyone else nothing.
      const swept = await outcome(run(actor, (c) => c.query(`UPDATE crove_notes.note SET pinned = true`)));
      if (swept.ok) expect(swept.value.rowCount, `${where} updating every note`).toBe(managers().includes(actor) ? 1 : 0);
      else expect(swept, `${where} updating every note`).toMatchObject({ code: '42501' });
      expect(await outcome(run(actor, (c) => c.query('DELETE FROM crove_notes.note WHERE id = $1', [notes.private]))), `${where} deleting the private note`).toMatchObject({ ok: false, code: '42501' });
      const forged = await outcome(
        run(actor, (c) => c.query(`INSERT INTO crove_notes.note (org_id, author_user_id, visibility, title) VALUES ($1, $2, 'private', 'giả')`, [orgId, users.author])),
      );
      expect(forged, `${where} writing a note as the author`).toMatchObject({ ok: false, code: '42501' });
      const linked = await outcome(
        run(actor, (c) =>
          c.query(`INSERT INTO crove_notes.link (org_id, note_id, target_type, target_id, party_id, created_by) VALUES ($1, $2, 'kernel.party', $3, $3, $4)`, [
            orgId,
            notes.private,
            notes.party,
            users.author,
          ]),
        ),
      );
      expect(linked, `${where} linking the private note`).toMatchObject({ ok: false, code: '42501' });
      const unlinked = await outcome(run(actor, (c) => c.query('DELETE FROM crove_notes.link')));
      if (unlinked.ok) expect(unlinked.value.rowCount, `${where} deleting every link`).toBe(0);
      else expect(unlinked, `${where} deleting every link`).toMatchObject({ code: '42501' });
    }
    const after = await admin((c) =>
      c.query<{ title: string; visibility: string; pinned: boolean }>('SELECT title, visibility, pinned FROM crove_notes.note WHERE id = $1', [notes.private]),
    );
    expect(after.rows).toEqual([{ title: SECRET, visibility: 'private', pinned: false }]);
  });

  it('lets owners and admins change a shared note but no other member, and the system context none', async () => {
    const pin = (c: pg.Client) => c.query('UPDATE crove_notes.note SET pinned = true WHERE id = $1', [notes.shared]);
    for (const { actor } of others) {
      const result = await outcome(run(actor, pin));
      const allowed = managers().includes(actor);
      if (result.ok) expect(result.value.rowCount, `${actor.name} pinning the shared note`).toBe(allowed ? 1 : 0);
      else expect(allowed, `${actor.name} pinning the shared note: ${result.message}`).toBe(false);
    }
    // Nobody but its author changes who wrote a note, not even the author.
    expect(await outcome(run(author, (c) => c.query('UPDATE crove_notes.note SET author_user_id = $2 WHERE id = $1', [notes.shared, users.member])))).toMatchObject({
      ok: false,
      code: '42501',
    });
  });

  it('keeps the author reading their own notes after their scope narrows to one entity', async () => {
    const seen = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
          orgId,
          users.author,
          branch,
          users.owner,
        ]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
      try {
        return await run(author, async (a) => (await a.query<{ id: string }>('SELECT id FROM crove_notes.note ORDER BY id')).rows.map((r) => r.id));
      } finally {
        await c.query(`DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2`, [orgId, users.author]);
      }
    });
    expect(seen).toEqual([notes.private, notes.shared].sort());
  });

  it('reaches nothing through a forged context', async () => {
    const forged = await outcome(
      run(member('another member, forging the author', () => users.member), async (c) => {
        await c.query(`SELECT set_config('crove.ctx', (current_setting('crove.ctx')::jsonb || $1::jsonb)::text, true)`, [JSON.stringify({ user: users.author })]);
        return (await c.query('SELECT id FROM crove_notes.note WHERE id = $1', [notes.private])).rowCount;
      }),
    );
    // Refused outright, or the context no longer names a user: either way the note stays out of reach.
    expect(forged.ok ? forged.value : 0).toBe(0);
  });

  it('counts private notes for owners and admins and the system context only, with no text', async () => {
    const counts = (actor: Actor) => outcome(run(actor, (c) => c.query('SELECT * FROM crove_notes.private_counts()')));
    for (const actor of [member('an owner', () => users.owner), member('an admin', () => users.admin), system]) {
      const result = await counts(actor);
      expect(result, actor.name).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.value.fields.map((f) => f.name), actor.name).toEqual(['org_id', 'author_user_id', 'notes']);
      expect(result.value.rows, actor.name).toEqual([{ org_id: orgId, author_user_id: users.author, notes: '1' }]);
    }
    for (const actor of [author, member('another member', () => users.member), member('a viewer', () => users.viewer), agentActor]) {
      expect(await counts(actor), actor.name).toMatchObject({ ok: false, code: '42501' });
    }
  });

  it('keeps the worker definers to the worker login in the system context', async () => {
    const calls: Array<[string, unknown[]]> = [
      ['SELECT * FROM crove_notes.trash_due(now(), 10)', []],
      ['SELECT crove_notes.trash_empty(now())', []],
      ['SELECT crove_notes.member_items_purge($1::uuid)', [users.author]],
    ];
    for (const [text, values] of calls) {
      for (const actor of [author, member('an owner', () => users.owner), agentActor]) {
        expect(await outcome(run(actor, (c) => c.query(text, values))), `${actor.name}: ${text}`).toMatchObject({ ok: false, code: '42501' });
      }
    }
    // The worker login outside the system context: the two that act on an org refuse.
    for (const [text, values] of calls.slice(1)) {
      expect(await outcome(inContext(workerUrl, async () => {}, (c) => c.query(text, values))), `no context: ${text}`).toMatchObject({ ok: false, code: '42501' });
    }
  });

  // Last: it removes the author from the org.
  it("removes a former member's private notes only once they are no longer a member, and keeps their shared ones", async () => {
    const purge = () => run(system, async (c) => (await c.query<{ n: string }>('SELECT crove_notes.member_items_purge($1::uuid) AS n', [users.author])).rows[0]?.n);
    expect(await purge()).toBe('0');
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.author]));
    // run() rolls back, so the purge is committed here as the worker would.
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    let purged: string | undefined;
    try {
      await c.query('BEGIN');
      await system.enter(c);
      purged = (await c.query<{ n: string }>('SELECT crove_notes.member_items_purge($1::uuid) AS n', [users.author])).rows[0]?.n;
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    expect(purged).toBe('1');
    const remaining = await admin((a) => a.query<{ id: string }>('SELECT id FROM crove_notes.note WHERE org_id = $1 ORDER BY id', [orgId]));
    expect(remaining.rows.map((r) => r.id)).toEqual([notes.shared]);
  });
});
