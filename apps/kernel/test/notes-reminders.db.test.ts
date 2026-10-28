// To-do reminders and search without Vietnamese marks through the runtime on PostgreSQL 17 (issue #1675, plan
// docs/plan/notes.md §3.7, §3.8 and step N6): a to-do's reminder follows its due day and time unless the member turned
// it off or picked a time; the worker's sweep sends one notification per reminder, at its time, never for a done,
// cancelled or deleted to-do, and none of it holds the to-do's text; a member limited to a branch still sees theirs;
// "hoa don" finds "hóa đơn" in the caller's own notes and to-dos and in shared notes, never in another member's private
// ones. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { todoDueInstant, type NoteSummary, type NoteWritten, type Todo, type TodoSummary, type TodoWritten } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { sweepNotesReminders } from '../src/notes-worker.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const TITLE = 'Gọi khách xin sao kê tháng 10';
const DETAILS = 'Hỏi kế toán trưởng bên khách';
const TZ = 'Asia/Ho_Chi_Minh';
const suite = ADMIN ? describe : describe.skip;

// A day `n` days from now in Hồ Chí Minh City.
const dayAhead = (n: number) => new Date(Date.now() + 7 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

suite('to-do reminders and search on PostgreSQL (#1675)', () => {
  const dbName = `crove_test_notes_reminders_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let workerDb: Db;
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

  // A fresh org: its owner, the member whose to-dos these are, another member and a member limited to a branch.
  async function org() {
    const tag = randomUUID().slice(0, 8);
    const user = (name: string) => upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'reminders', subject: `${name}-${tag}`, email: `${name}-${tag}@reminders.test`, name: null });
    const owner = await user('owner');
    const mine = await user('mine');
    const other = await user('other');
    const limited = await user('limited');
    const { orgId } = await createOrg(app, asUser(owner), `Nhắc ${tag}`);
    const branch = await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, mine, other, limited]);
      const id = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner]))
        .rows[0]?.id as string;
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, limited, id, owner]);
      return id;
    });
    const exec = <O>(userId: string, name: string, input: unknown = {}) => app.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => app.query<O>(name, input, { actor: asUser(userId), orgId });
    const get = (userId: string, todoId: string) => query<Todo>(userId, 'notes.todo.get', { todoId });
    // The org's reminder notifications, as stored.
    const reminders = () =>
      admin(
        async (c) =>
          (
            await c.query<{ user_id: string; subject_id: string; detail: Record<string, unknown>; dedupe_key: string; legal_entity_id: string }>(
              `SELECT user_id, subject_id, detail, dedupe_key, legal_entity_id FROM crove_kernel.notification WHERE org_id = $1 AND kind = 'notes.todo_due' ORDER BY created_at, id`,
              [orgId],
            )
          ).rows,
      );
    // Moves a to-do's reminder into the past, as time passing would.
    const due = (todoId: string) => admin((c) => c.query(`UPDATE crove_notes.todo SET remind_at = now() - interval '1 minute' WHERE id = $1`, [todoId]));
    return { orgId, owner, mine, other, limited, branch, exec, query, get, reminders, due };
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
      const db = createDb(pool);
      return { db, runtime: new Runtime(db).register({ commands: [...kernelCommands, ...notesCommands], queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries] }) };
    };
    app = runtimeFor('crove_app', 'test-app-pw').runtime;
    const w = runtimeFor('crove_worker', 'test-worker-pw');
    worker = w.runtime;
    workerDb = w.db;
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reminds at 8:00 on the due day or 30 minutes before a due time, unless turned off or already past', async () => {
    const o = await org();
    const day = dayAhead(3);
    const onDay = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Có ngày', dueOn: day, timeZone: TZ });
    expect((await o.get(o.mine, onDay.todoId)).remindAt).toBe(todoDueInstant(day, '08:00', TZ).toISOString());
    const timed = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Có giờ', dueOn: day, dueTime: '14:00', timeZone: TZ });
    expect((await o.get(o.mine, timed.todoId)).remindAt).toBe(todoDueInstant(day, '13:30', TZ).toISOString());
    const off = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Không nhắc', dueOn: day, timeZone: TZ, reminder: 'off' });
    expect((await o.get(o.mine, off.todoId)).remindAt).toBeNull();
    const none = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Không hạn' });
    expect((await o.get(o.mine, none.todoId)).remindAt).toBeNull();
    // Due yesterday: 8:00 of that day has passed, so no reminder fires the moment it is written.
    const late = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Quá hạn', dueOn: dayAhead(-1), timeZone: TZ });
    expect((await o.get(o.mine, late.todoId)).remindAt).toBeNull();
    // A picked time, with or without a due day; one already past is refused.
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const picked = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Giờ tự chọn', reminder: { at } });
    expect((await o.get(o.mine, picked.todoId)).remindAt).toBe(at);
    await expect(o.exec(o.mine, 'notes.todo.create', { title: 'Giờ đã qua', reminder: { at: new Date(Date.now() - 60_000).toISOString() } })).rejects.toMatchObject({
      code: 'TODO_REMINDER_PAST',
    });
  });

  it('moves an automatic reminder with the due day, keeps a picked one, and arms a new time again', async () => {
    const o = await org();
    const edit = (todoId: string, revision: number, input: Record<string, unknown>) =>
      o.exec<TodoWritten>(o.mine, 'notes.todo.update', { todoId, revision, title: TITLE, details: '', checklist: [], dueOn: null, dueTime: null, timeZone: TZ, ...input });
    const { todoId } = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: TITLE, dueOn: dayAhead(2), timeZone: TZ });
    // Without a reminder in the input the automatic one follows the new day.
    await edit(todoId, 1, { dueOn: dayAhead(4) });
    expect((await o.get(o.mine, todoId)).remindAt).toBe(todoDueInstant(dayAhead(4), '08:00', TZ).toISOString());
    // A picked time stays when the day moves.
    const at = new Date(Date.now() + 7_200_000).toISOString();
    await edit(todoId, 2, { dueOn: dayAhead(4), reminder: { at } });
    await edit(todoId, 3, { dueOn: dayAhead(5) });
    expect((await o.get(o.mine, todoId)).remindAt).toBe(at);
    // Turned off, it stays off when the day moves.
    await edit(todoId, 4, { dueOn: dayAhead(5), reminder: 'off' });
    await edit(todoId, 5, { dueOn: dayAhead(6) });
    expect((await o.get(o.mine, todoId)).remindAt).toBeNull();
    // A sent reminder is armed again by a new time, and not by an edit that leaves it.
    await edit(todoId, 6, { dueOn: dayAhead(6), reminder: 'auto' });
    await admin((c) => c.query(`UPDATE crove_notes.todo SET reminded_at = now() WHERE id = $1`, [todoId]));
    await edit(todoId, 7, { dueOn: dayAhead(6), details: 'Thêm chi tiết' });
    const sent = await admin((c) => c.query<{ reminded_at: Date | null }>(`SELECT reminded_at FROM crove_notes.todo WHERE id = $1`, [todoId]));
    expect(sent.rows[0]?.reminded_at).not.toBeNull();
    await edit(todoId, 8, { dueOn: dayAhead(7) });
    const armed = await admin((c) => c.query<{ reminded_at: Date | null }>(`SELECT reminded_at FROM crove_notes.todo WHERE id = $1`, [todoId]));
    expect(armed.rows[0]?.reminded_at).toBeNull();
    const audit = await admin((c) => c.query<{ detail: unknown }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'notes.todo.%'`, [o.orgId]));
    const text = JSON.stringify(audit.rows);
    expect(text).toContain('"reminder"');
    for (const secret of [TITLE, 'Thêm chi tiết']) expect(text).not.toContain(secret);
  });

  it('sends one reminder at its time, never for a done, cancelled or deleted to-do, with no text', async () => {
    const o = await org();
    const add = async (userId: string, title: string) =>
      (await o.exec<TodoWritten>(userId, 'notes.todo.create', { title, details: DETAILS, dueOn: dayAhead(2), timeZone: TZ })).todoId;
    const open = await add(o.mine, TITLE);
    const done = await add(o.mine, 'Đã xong');
    const deleted = await add(o.mine, 'Đã xóa');
    const cancelled = await add(o.mine, 'Đã hủy');
    const theirs = await add(o.other, 'Việc của người khác');
    const ahead = await add(o.mine, 'Chưa tới giờ');
    for (const id of [open, done, deleted, cancelled, theirs]) await o.due(id);
    await o.exec(o.mine, 'notes.todo.complete', { todoId: done });
    await o.exec(o.mine, 'notes.todo.delete', { todoId: deleted });
    await admin((c) => c.query(`UPDATE crove_notes.todo SET status = 'cancelled' WHERE id = $1`, [cancelled]));

    await sweepNotesReminders({ runtime: worker, workerDb });
    const first = await o.reminders();
    expect(first.map((r) => [r.user_id, r.subject_id]).sort()).toEqual(
      [
        [o.mine, open],
        [o.other, theirs],
      ].sort(),
    );
    for (const r of first) expect(r.detail).toEqual({});
    // Nothing of the to-do's text anywhere the reminder wrote: the notification, the audit row, the outbox.
    const written = await admin(async (c) => [
      ...(await c.query(`SELECT * FROM crove_kernel.notification WHERE org_id = $1`, [o.orgId])).rows,
      ...(await c.query(`SELECT * FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'notes.todo.remind'`, [o.orgId])).rows,
      ...(await c.query(`SELECT * FROM crove_kernel.outbox_event WHERE org_id = $1`, [o.orgId])).rows,
    ]);
    const text = JSON.stringify(written);
    for (const secret of [TITLE, DETAILS, 'Việc của người khác']) expect(text).not.toContain(secret);
    // Once: a second pass sends nothing, and the to-do not due yet waits.
    await sweepNotesReminders({ runtime: worker, workerDb });
    expect(await o.reminders()).toHaveLength(2);
    expect((await o.reminders()).some((r) => r.subject_id === ahead)).toBe(false);
    // The owner reads theirs, and opening it shows the to-do; nobody else gets it.
    const mine = await o.query<{ items: Array<{ kind: string; subjectId: string | null; detail: Record<string, string> }> }>(o.mine, 'kernel.notification.list');
    expect(mine.items.filter((n) => n.kind === 'notes.todo_due')).toEqual([expect.objectContaining({ subjectId: open, detail: {} })]);
    const owner = await o.query<{ items: Array<{ kind: string }> }>(o.owner, 'kernel.notification.list');
    expect(owner.items.filter((n) => n.kind === 'notes.todo_due')).toEqual([]);
    // A new time reminds again; a muted kind is claimed but sends nothing.
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const current = await o.get(o.mine, open);
    await o.exec(o.mine, 'notes.todo.update', { todoId: open, revision: current.revision, title: TITLE, details: DETAILS, checklist: [], dueOn: dayAhead(2), dueTime: null, timeZone: TZ, reminder: { at: later } });
    await o.due(open);
    await sweepNotesReminders({ runtime: worker, workerDb });
    expect((await o.reminders()).filter((r) => r.subject_id === open)).toHaveLength(2);
    await o.exec(o.other, 'kernel.notification.mute', { kind: 'notes.todo_due', muted: true });
    const again = await add(o.other, 'Lần nữa');
    await o.due(again);
    await sweepNotesReminders({ runtime: worker, workerDb });
    expect((await o.reminders()).some((r) => r.subject_id === again)).toBe(false);
    const claimed = await admin((c) => c.query<{ reminded_at: Date | null }>(`SELECT reminded_at FROM crove_notes.todo WHERE id = $1`, [again]));
    expect(claimed.rows[0]?.reminded_at).not.toBeNull();
  });

  it("puts a branch-limited member's reminder under their branch, so they see it", async () => {
    const o = await org();
    const { todoId } = await o.exec<TodoWritten>(o.limited, 'notes.todo.create', { title: TITLE, dueOn: dayAhead(1), timeZone: TZ });
    await o.due(todoId);
    await sweepNotesReminders({ runtime: worker, workerDb });
    expect((await o.reminders()).map((r) => [r.user_id, r.legal_entity_id])).toEqual([[o.limited, o.branch]]);
    const seen = await o.query<{ items: Array<{ kind: string; subjectId: string | null }> }>(o.limited, 'kernel.notification.list');
    expect(seen.items.filter((n) => n.kind === 'notes.todo_due').map((n) => n.subjectId)).toEqual([todoId]);
  });

  it('finds "hoa don" in my notes and to-dos and in shared notes, never in another member\'s private ones', async () => {
    const o = await org();
    const note = (userId: string, title: string, visibility: 'private' | 'org') => o.exec<NoteWritten>(userId, 'notes.note.create', { title, body: 'Kiểm tra hóa đơn của nhà cung cấp X', visibility });
    const own = await note(o.mine, 'Ghi chú của tôi', 'private');
    const shared = await note(o.other, 'Ghi chú dùng chung', 'org');
    await note(o.other, 'Ghi chú riêng của người khác', 'private');
    const found = await o.query<NoteSummary[]>(o.mine, 'notes.note.search', { q: 'hoa don' });
    expect(found.map((n) => n.id).sort()).toEqual([own.noteId, shared.noteId].sort());
    // Typed with marks, or only the start of a word, it finds the same.
    expect((await o.query<NoteSummary[]>(o.mine, 'notes.note.search', { q: 'Hóa Đơn' })).map((n) => n.id).sort()).toEqual([own.noteId, shared.noteId].sort());
    expect((await o.query<NoteSummary[]>(o.mine, 'notes.note.search', { q: 'nha cung' })).map((n) => n.id).sort()).toEqual([own.noteId, shared.noteId].sort());
    // The other member finds theirs and the shared one, not mine.
    expect(await o.query<NoteSummary[]>(o.other, 'notes.note.search', { q: 'hoa don' })).toHaveLength(2);
    expect((await o.query<NoteSummary[]>(o.other, 'notes.note.search', { q: 'hoa don' })).some((n) => n.id === own.noteId)).toBe(false);
    // To-dos: the caller's own only, the org's owner included.
    const todo = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: 'Đối chiếu hóa đơn tháng 10' });
    await o.exec(o.other, 'notes.todo.create', { title: 'Hóa đơn của người khác' });
    expect((await o.query<TodoSummary[]>(o.mine, 'notes.todo.list', { view: 'open', q: 'hoa don' })).map((t) => t.id)).toEqual([todo.todoId]);
    expect((await o.query<TodoSummary[]>(o.owner, 'notes.todo.list', { view: 'open', q: 'hoa don' }))).toEqual([]);
    expect((await o.query<TodoSummary[]>(o.mine, 'notes.todo.list', { view: 'open', q: 'sao ke' }))).toEqual([]);
  });
});
