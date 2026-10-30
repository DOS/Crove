// Members' notes through the runtime on PostgreSQL 17 (issue #1671, plan docs/plan/notes.md step N2): a member writes a
// private note on a client and a shared one; other members read the shared one only; the audit rows keep markers, not
// text; only the author edits, owners and admins pin a shared note; search finds words typed without marks; the trash
// and a former member's private notes are emptied by the system; the org export carries the shared note and a count of
// the private one. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Note, NoteRecordPanel, NoteSummary, NoteWritten, NotesExport, TodoWritten } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { sweepNotesFormerMembers } from '../src/notes-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'notes' };
const PRIVATE_TITLE = 'Mật khẩu cổng ngân hàng';
const PRIVATE_BODY = 'Hỏi kế toán trưởng trước ngày 5';
const SHARED_TITLE = 'Giám đốc chỉ nghe máy sau 15h';
const suite = ADMIN ? describe : describe.skip;

suite('notes on PostgreSQL (#1671)', () => {
  const dbName = `crove_test_notes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
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

  // A fresh org: an owner, two members (the author and another) and a viewer, and a client party.
  async function org() {
    const tag = randomUUID().slice(0, 8);
    const user = (name: string) => upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'notes', subject: `${name}-${tag}`, email: `${name}-${tag}@notes.test`, name: null });
    const owner = await user('owner');
    const author = await user('author');
    const other = await user('other');
    const viewer = await user('viewer');
    const { orgId } = await createOrg(app, asUser(owner), `Ghi chú ${tag}`);
    const party = randomUUID();
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, author, other, viewer]);
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $2, 'Công ty Khách')`, [orgId, party]);
    });
    const exec = <O>(userId: string, name: string, input: unknown = {}) => app.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => app.query<O>(name, input, { actor: asUser(userId), orgId });
    const list = (userId: string, view: string) => query<NoteSummary[]>(userId, 'notes.note.list', { view }).then((rows) => rows.map((r) => r.id));
    return { orgId, owner, author, other, viewer, party, exec, query, list };
  }

  // The newest kernel.member.removed event of a user in an org.
  const removalEvent = (orgId: string, userId: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.member.removed' AND payload ->> 'userId' = $2 ORDER BY id DESC LIMIT 1`,
            [orgId, userId],
          )
        ).rows[0]?.id as string,
    );

  // Moves a user's recorded removals from an org 31 days back, as if the purge delay had passed (#1733). The audit
  // trail is append-only, so its trigger is set aside for this one statement.
  const ageRemovals = (orgId: string, userId: string) =>
    admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '31 days' WHERE org_id = $1 AND command = 'kernel.member.remove' AND target_id = $2`, [
        orgId,
        userId,
      ]);
      await c.query('COMMIT');
    });

  // The author's private note and shared note, both on the client.
  async function written(o: Awaited<ReturnType<typeof org>>) {
    const link = { targetType: 'kernel.party', targetId: o.party };
    const priv = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: PRIVATE_TITLE, body: PRIVATE_BODY, tags: ['Ngân hàng'], link });
    const shared = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: SHARED_TITLE, visibility: 'org', link });
    return { priv: priv.noteId, shared: shared.noteId };
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
    const runtimeFor = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      return new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...notesCommands], queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries] });
    };
    app = runtimeFor('crove_app', 'test-app-pw');
    worker = runtimeFor('crove_worker', 'test-worker-pw');
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets a member write a private note on a client and a shared one, and shows others the shared one only', async () => {
    const o = await org();
    const n = await written(o);
    expect((await o.list(o.author, 'mine')).sort()).toEqual([n.priv, n.shared].sort());
    for (const reader of [o.other, o.owner]) {
      expect(await o.list(reader, 'shared'), reader).toEqual([n.shared]);
      expect(await o.list(reader, 'mine'), reader).toEqual([]);
      await expect(o.query(reader, 'notes.note.get', { noteId: n.priv })).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND', status: 404 });
      const panel = await o.query<NoteRecordPanel>(reader, 'notes.record.panel', { targetType: 'kernel.party', targetId: o.party });
      expect(panel.latest.map((x) => x.id), reader).toEqual([n.shared]);
    }
    const mine = await o.query<Note>(o.author, 'notes.note.get', { noteId: n.priv });
    expect(mine).toMatchObject({ title: PRIVATE_TITLE, body: PRIVATE_BODY, tags: ['ngân hàng'], visibility: 'private', mine: true, links: [{ targetType: 'kernel.party', targetId: o.party }] });
    const panel = await o.query<NoteRecordPanel>(o.author, 'notes.record.panel', { targetType: 'kernel.party', targetId: o.party });
    expect(panel.latest.map((x) => x.id).sort()).toEqual([n.priv, n.shared].sort());
    // Viewers read no note but their own, and write none.
    expect(await o.list(o.viewer, 'shared')).toEqual([]);
    await expect(o.exec(o.viewer, 'notes.note.create', { title: 'Ghi chú' })).rejects.toMatchObject({ status: 403 });
    // A party's timeline shows the shared note with a fixed summary, never the private one or a title.
    const activity = await admin((c) => c.query<{ summary: string }>(`SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2`, [o.orgId, o.party]));
    expect(activity.rows).toEqual([{ summary: 'Thêm ghi chú' }]);
  });

  it('keeps markers, not text, in the audit rows', async () => {
    const o = await org();
    const n = await written(o);
    await o.exec(o.author, 'notes.note.update', { noteId: n.priv, revision: 1, title: `${PRIVATE_TITLE} mới`, body: `${PRIVATE_BODY} nữa`, tags: [] });
    const rows = await admin((c) =>
      c.query<{ command: string; detail: Record<string, unknown> }>(`SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'notes.%' ORDER BY occurred_at, id`, [o.orgId]),
    );
    expect(rows.rows.map((r) => r.command)).toEqual(['notes.note.create', 'notes.note.create', 'notes.note.update']);
    expect(rows.rows[0]?.detail).toMatchObject({ noteId: n.priv, visibility: 'private', title: { redacted: 'pii' }, tags: { redacted: 'pii' } });
    expect(rows.rows[2]?.detail).toMatchObject({ noteId: n.priv, revision: 2, changed: ['title', 'body', 'tags'] });
    const text = JSON.stringify(rows.rows);
    for (const secret of [PRIVATE_TITLE, PRIVATE_BODY, SHARED_TITLE, 'ngân hàng']) expect(text).not.toContain(secret);
    // Which record a private note is about stays out too, adding and removing a link included; a shared note's link
    // names its record.
    const linkId = (await o.query<Note>(o.author, 'notes.note.get', { noteId: n.priv })).links[0]?.id;
    await o.exec(o.author, 'notes.link.remove', { linkId });
    await o.exec(o.author, 'notes.link.add', { noteId: n.priv, targetType: 'kernel.party', targetId: o.party });
    const audits = await admin((c) =>
      c.query<{ command: string; detail: Record<string, unknown> }>(
        `SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'notes.%' AND detail ->> 'noteId' = $2 ORDER BY occurred_at, id`,
        [o.orgId, n.priv],
      ),
    );
    expect(audits.rows.map((r) => r.command)).toEqual(['notes.note.create', 'notes.note.update', 'notes.link.remove', 'notes.link.add']);
    expect(JSON.stringify(audits.rows)).not.toContain(o.party);
    expect(audits.rows.filter((r) => r.command !== 'notes.note.update').map((r) => r.detail.target)).toEqual(['private', 'private', 'private']);
    expect(JSON.stringify(rows.rows[1]?.detail)).toContain(o.party);
  });

  it('lets only the author edit, refuses a stale revision, and lets owners and admins pin a shared note', async () => {
    const o = await org();
    const n = await written(o);
    const edit = (userId: string, revision: number) => o.exec<NoteWritten>(userId, 'notes.note.update', { noteId: n.shared, revision, title: 'Sửa', body: '', tags: [] });
    expect(await edit(o.author, 1)).toEqual({ noteId: n.shared, revision: 2 });
    await expect(edit(o.author, 1)).rejects.toMatchObject({ code: 'NOTE_REVISION_CONFLICT', status: 409 });
    await expect(edit(o.owner, 2)).rejects.toMatchObject({ code: 'NOTE_AUTHOR_ONLY', status: 403 });
    await expect(o.exec(o.other, 'notes.note.pin', { noteId: n.shared })).rejects.toMatchObject({ code: 'NOTE_AUTHOR_ONLY', status: 403 });
    await o.exec(o.owner, 'notes.note.pin', { noteId: n.shared });
    expect(await o.list(o.other, 'pinned')).toEqual([n.shared]);
    // The private note: the owner cannot even find it, and the author's pin does not touch the revision.
    await expect(o.exec(o.owner, 'notes.note.pin', { noteId: n.priv })).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    expect(await o.exec(o.author, 'notes.note.pin', { noteId: n.priv })).toEqual({ noteId: n.priv, revision: 1 });
    // Only the author links it, and only to a record of the org.
    await expect(o.exec(o.other, 'notes.link.add', { noteId: n.shared, targetType: 'kernel.party', targetId: o.party })).rejects.toMatchObject({ code: 'NOTE_AUTHOR_ONLY' });
    await expect(o.exec(o.author, 'notes.link.add', { noteId: n.shared, targetType: 'kernel.party', targetId: o.party })).rejects.toMatchObject({ code: 'NOTE_LINK_EXISTS' });
    await expect(o.exec(o.author, 'notes.link.add', { noteId: n.shared, targetType: 'kernel.party', targetId: randomUUID() })).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND' });
    // Owners and admins pin a shared note but neither change its visibility nor its links.
    await expect(o.exec(o.owner, 'notes.note.set_visibility', { noteId: n.shared, visibility: 'private' })).rejects.toMatchObject({ code: 'NOTE_AUTHOR_ONLY' });
    const linkId = (await o.query<Note>(o.owner, 'notes.note.get', { noteId: n.shared })).links[0]?.id;
    await expect(o.exec(o.owner, 'notes.link.remove', { linkId })).rejects.toMatchObject({ code: 'NOTE_AUTHOR_ONLY' });
    // Making the private note shared shows it to the others.
    await o.exec(o.author, 'notes.note.set_visibility', { noteId: n.priv, visibility: 'org' });
    expect((await o.list(o.other, 'shared')).sort()).toEqual([n.priv, n.shared].sort());
  });

  it('keeps a member who becomes a viewer reading their own notes, and nothing else', async () => {
    const o = await org();
    const n = await written(o);
    const other = await o.exec<NoteWritten>(o.other, 'notes.note.create', { title: 'Của người khác', visibility: 'org' });
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.author]));
    expect((await o.list(o.author, 'mine')).sort()).toEqual([n.priv, n.shared].sort());
    expect(await o.list(o.author, 'shared')).toEqual([n.shared]);
    await expect(o.query(o.author, 'notes.note.get', { noteId: other.noteId })).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    await expect(o.exec(o.author, 'notes.note.pin', { noteId: n.priv })).rejects.toMatchObject({ status: 403 });
  });

  it('finds notes by words typed without marks, within what the caller may read', async () => {
    const o = await org();
    const n = await written(o);
    const search = (userId: string, q: string) => o.query<NoteSummary[]>(userId, 'notes.note.search', { q }).then((rows) => rows.map((r) => r.id));
    expect(await search(o.other, 'giam doc')).toEqual([n.shared]);
    expect(await search(o.other, 'mat khau')).toEqual([]);
    expect(await search(o.author, 'mat khau')).toEqual([n.priv]);
    expect(await search(o.author, 'ngan')).toEqual([n.priv]);
  });

  it('moves a note to the trash, restores it, and lets the system empty the trash after 30 days', async () => {
    const o = await org();
    const n = await written(o);
    await o.exec(o.author, 'notes.note.delete', { noteId: n.priv });
    expect(await o.list(o.author, 'trash')).toEqual([n.priv]);
    await expect(o.exec(o.author, 'notes.note.update', { noteId: n.priv, revision: 1, title: 'x', body: '', tags: [] })).rejects.toMatchObject({ code: 'NOTE_IN_TRASH' });
    await o.exec(o.author, 'notes.note.restore', { noteId: n.priv });
    expect(await o.list(o.author, 'trash')).toEqual([]);
    await o.exec(o.author, 'notes.note.delete', { noteId: n.priv });
    expect(await worker.execute('notes.trash.empty', {}, { actor: SYSTEM, orgId: o.orgId })).toEqual({ removed: 0 });
    await admin((c) => c.query(`UPDATE crove_notes.note SET deleted_at = now() - interval '31 days' WHERE org_id = $1 AND id = $2`, [o.orgId, n.priv]));
    expect(await worker.execute('notes.trash.empty', {}, { actor: SYSTEM, orgId: o.orgId })).toEqual({ removed: 1 });
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_notes.note WHERE id = $1', [n.priv])).rowCount)).toBe(0);
    // A member runs neither system command.
    await expect(o.exec(o.owner, 'notes.trash.empty')).rejects.toMatchObject({ status: 403 });
  });

  it('exports the shared note and a count of the private one', async () => {
    const o = await org();
    const n = await written(o);
    const lines: Record<string, string[]> = {};
    for (const table of ['notes.note', 'notes.link', 'notes.private_count']) {
      await worker.stream('kernel.org.export.snapshot', { table }, { actor: SYSTEM, orgId: o.orgId }, async (batch) => {
        const b = batch as { table: string; lines: string[] };
        lines[b.table] = [...(lines[b.table] ?? []), ...b.lines];
      });
    }
    const notes = (lines['notes.note'] ?? []).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(notes.map((x) => x.id)).toEqual([n.shared]);
    expect(notes[0]).not.toHaveProperty('search');
    expect(lines['notes.link']).toHaveLength(1);
    expect((lines['notes.private_count'] ?? []).map((l) => JSON.parse(l))).toEqual([{ org_id: o.orgId, author_user_id: o.author, notes: 1 }]);
    expect(JSON.stringify(lines)).not.toContain(PRIVATE_TITLE);
    // An owner counts private notes per member before removing one; a member does not.
    expect(await o.query(o.owner, 'notes.private_counts')).toEqual([{ userId: o.author, notes: 1 }]);
    await expect(o.query(o.other, 'notes.private_counts')).rejects.toMatchObject({ status: 403 });
  });

  it("downloads the caller's own notes and to-dos, whole, and nothing of anyone else's (#1678)", async () => {
    const o = await org();
    const n = await written(o);
    await o.exec<NoteWritten>(o.other, 'notes.note.create', { title: 'Của người khác', visibility: 'org' });
    await o.exec(o.author, 'notes.note.delete', { noteId: n.shared });
    const todo = await o.exec<TodoWritten>(o.author, 'notes.todo.create', { title: 'Gọi lại khách', details: 'Hỏi hóa đơn', checklist: [{ text: 'Tìm số', done: false }] });
    await o.exec<TodoWritten>(o.other, 'notes.todo.create', { title: 'Việc của người khác' });
    const mine = await o.query<NotesExport>(o.author, 'notes.mine.export');
    // Private and shared, in the trash too, with their text, tags and links.
    expect(mine.notes.map((x) => x.id).sort()).toEqual([n.priv, n.shared].sort());
    expect(mine.notes.find((x) => x.id === n.priv)).toMatchObject({
      visibility: 'private',
      title: PRIVATE_TITLE,
      body: PRIVATE_BODY,
      tags: ['ngân hàng'],
      deletedAt: null,
      links: [{ targetType: 'kernel.party', targetId: o.party }],
    });
    expect(mine.notes.find((x) => x.id === n.shared)?.deletedAt).not.toBeNull();
    expect(mine.todos).toEqual([
      expect.objectContaining({ id: todo.todoId, title: 'Gọi lại khách', details: 'Hỏi hóa đơn', checklist: [{ text: 'Tìm số', done: false }], status: 'open' }),
    ]);
    expect(mine.truncated).toBe(false);
    // An owner reads the shared notes but downloads only their own: none here.
    expect(await o.query<NotesExport>(o.owner, 'notes.mine.export')).toMatchObject({ notes: [], todos: [] });
    // A member who became a viewer still takes what they wrote.
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [o.orgId, o.author]));
    expect((await o.query<NotesExport>(o.author, 'notes.mine.export')).notes).toHaveLength(2);
  });

  it("hides a removed member's private notes and removes them with the system's purge, keeping the shared ones", async () => {
    const o = await org();
    const n = await written(o);
    await app.execute('kernel.member.remove', { userId: o.author }, { actor: asMfa(o.owner), orgId: o.orgId });
    // The author can no longer enter the org; the owner still reads the shared note, never the private one.
    await expect(o.list(o.author, 'mine')).rejects.toMatchObject({ status: 403 });
    expect(await o.list(o.owner, 'shared')).toEqual([n.shared]);
    const eventId = await removalEvent(o.orgId, o.author);
    // Run before the 30 days are over (a job started early, a system command), it removes nothing (#1733).
    expect(await worker.execute('notes.member_items.purge', { userId: o.author, eventId }, { actor: SYSTEM, orgId: o.orgId })).toEqual({ removed: 0 });
    await ageRemovals(o.orgId, o.author);
    expect(await worker.execute('notes.member_items.purge', { userId: o.author, eventId }, { actor: SYSTEM, orgId: o.orgId })).toEqual({ removed: 1 });
    const left = await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_notes.note WHERE org_id = $1', [o.orgId]));
    expect(left.rows.map((r) => r.id)).toEqual([n.shared]);
    // Back in the org before the purge: nothing is removed.
    const p = await org();
    const m = await written(p);
    await app.execute('kernel.member.remove', { userId: p.author }, { actor: asMfa(p.owner), orgId: p.orgId });
    const first = await removalEvent(p.orgId, p.author);
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [p.orgId, p.author]));
    expect(await worker.execute('notes.member_items.purge', { userId: p.author, eventId: first }, { actor: SYSTEM, orgId: p.orgId })).toEqual({ removed: 0 });
    expect((await p.list(p.author, 'mine')).sort()).toEqual([m.priv, m.shared].sort());
    // Removed again: the first removal's job leaves the notes to the second's, 30 days after it.
    await app.execute('kernel.member.remove', { userId: p.author }, { actor: asMfa(p.owner), orgId: p.orgId });
    const second = await removalEvent(p.orgId, p.author);
    expect(second).not.toBe(first);
    await ageRemovals(p.orgId, p.author);
    expect(await worker.execute('notes.member_items.purge', { userId: p.author, eventId: first }, { actor: SYSTEM, orgId: p.orgId })).toEqual({ removed: 0 });
    expect(await worker.execute('notes.member_items.purge', { userId: p.author, eventId: second }, { actor: SYSTEM, orgId: p.orgId })).toEqual({ removed: 1 });
  });

  it("sweeps a former member whose removal queued no purge, once 30 days have passed (#1733)", async () => {
    const o = await org();
    const n = await written(o);
    await app.execute('kernel.member.remove', { userId: o.author }, { actor: asMfa(o.owner), orgId: o.orgId });
    const workerDb = createDb(pools[1] as pg.Pool);
    const notesOf = () => admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_notes.note WHERE org_id = $1 ORDER BY id', [o.orgId])).rows.map((r) => r.id));
    // Removed today: neither the sweep nor the command without an event purges yet.
    await sweepNotesFormerMembers({ runtime: worker, workerDb });
    expect(await worker.execute('notes.member_items.purge', { userId: o.author }, { actor: SYSTEM, orgId: o.orgId })).toEqual({ removed: 0 });
    expect(await notesOf()).toEqual([n.priv, n.shared].sort());
    await ageRemovals(o.orgId, o.author);
    expect(await sweepNotesFormerMembers({ runtime: worker, workerDb })).toBeGreaterThanOrEqual(1);
    expect(await notesOf()).toEqual([n.shared]);
    // A member of the org is never swept.
    const kept = await o.exec<NoteWritten>(o.other, 'notes.note.create', { title: PRIVATE_TITLE });
    await sweepNotesFormerMembers({ runtime: worker, workerDb });
    expect(await notesOf()).toEqual([kept.noteId, n.shared].sort());
    // Nor one whose membership ended with no removal in the audit trail (an SQL delete): no date to count from, so the
    // sweep keeps their items (fails closed).
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.other]));
    await sweepNotesFormerMembers({ runtime: worker, workerDb });
    expect(await notesOf()).toEqual([kept.noteId, n.shared].sort());
  });
});
