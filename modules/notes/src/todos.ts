// A member's own to-dos (issue #1673, plan docs/plan/notes.md §3.2, §3.5, §3.8 and step N4, ADR-0037). A to-do is
// always private: the database's row policies show it to its owner alone, so every query here reads only the caller's
// own, and another member's to-do answers TODO_NOT_FOUND as if it did not exist, for an owner or admin of the org too.
// Agents run none of these (no command declares `agent`), and the system context reads none (its definers count).
//
// Audit rows are anchored in the WORM stream and outlive an erasure, so a command's audit facts carry ids, the due day
// and changed field names, and a marker for the text (auditValue), never the title, details or steps. Command results
// carry ids and the revision only, since idempotency rows keep them.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  auditValue,
  todoAutoReminder,
  todoDueInstant,
  todoLocalTime,
  todoStanding,
  zTodoCreate,
  zTodoList,
  zTodoRef,
  zTodoReorder,
  zTodoUpdate,
  type Todo,
  type TodoCount,
  type TodoReminder,
  type TodoStatus,
  type TodoStep,
  type TodoSummary,
  type TodoWritten,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { notesManifest } from './manifest.ts';
import { REBALANCE_AT, keyBetween, spreadKeys } from './sort-key.ts';

// Owners, admins and members keep to-dos; viewers write none (notes.md §3.5). They run the reads, where the row
// policies show them none but their own: a member made a viewer still reads what they wrote.
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const TODO = notesManifest.tables.crove_notes.todo;

const SUMMARY = [
  'id',
  'title',
  'checklist',
  'status',
  'due_on',
  'due_at',
  'time_zone',
  'remind_at',
  'sort_key',
  'task_id',
  'revision',
  'created_at',
  'updated_at',
  'done_at',
  'deleted_at',
] as const;

interface SummaryRow {
  id: string;
  title: string;
  checklist: unknown;
  status: TodoStatus;
  due_on: string | null;
  due_at: Date | string | null;
  time_zone: string;
  remind_at: Date | string | null;
  sort_key: string;
  task_id: string | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  done_at: Date | string | null;
  deleted_at: Date | string | null;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const steps = (checklist: unknown): TodoStep[] => (Array.isArray(checklist) ? (checklist as TodoStep[]) : []);

function summary(r: SummaryRow, now: Date): TodoSummary {
  const dueAt = r.due_at === null ? null : new Date(r.due_at);
  const list = steps(r.checklist);
  const standing = r.status === 'open' && r.deleted_at === null ? todoStanding({ dueOn: r.due_on, dueAt, timeZone: r.time_zone }, now) : null;
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    dueOn: r.due_on,
    dueAt: dueAt?.toISOString() ?? null,
    dueTime: dueAt ? todoLocalTime(dueAt, r.time_zone) : null,
    timeZone: r.time_zone,
    remindAt: iso(r.remind_at),
    group: standing?.group ?? null,
    overdue: standing?.overdue ?? false,
    steps: { done: list.filter((s) => s.done).length, total: list.length },
    taskId: r.task_id,
    revision: r.revision,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    doneAt: iso(r.done_at),
    deletedAt: iso(r.deleted_at),
  };
}

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const notFound = () => new DomainError('TODO_NOT_FOUND', 404, 'Không tìm thấy việc này');

// The caller's to-do (row policies: their own only), with its details, locked for a change when `lock` is set.
async function load(ctx: Pick<QueryContext, 'trx' | 'orgId'>, todoId: string, lock: boolean): Promise<SummaryRow & { details: string | null }> {
  let q = ctx.trx.selectFrom('crove_notes.todo').select([...SUMMARY, 'details']).where('org_id', '=', ctx.orgId).where('id', '=', todoId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

function assertNotInTrash(row: SummaryRow): void {
  if (row.deleted_at !== null) throw new DomainError('TODO_IN_TRASH', 409, 'Việc này đang ở thùng rác; hãy khôi phục trước');
}

// The due day and time as stored: the time becomes an instant on that day in the to-do's time zone.
function due(input: { dueOn: string | null; dueTime: string | null; timeZone: string }): { due_on: string | null; due_at: Date | null; time_zone: string } {
  return {
    due_on: input.dueOn,
    due_at: input.dueOn !== null && input.dueTime !== null ? todoDueInstant(input.dueOn, input.dueTime, input.timeZone) : null,
    time_zone: input.timeZone,
  };
}

// When the reminder is due (notes.md §3.8): the automatic one only while it is ahead, so a to-do written for today
// after 8:00 is not reminded at once; a picked time must be ahead.
function remindAt(reminder: TodoReminder, at: { due_on: string | null; due_at: Date | null; time_zone: string }, now: Date): Date | null {
  if (reminder === 'off') return null;
  if (reminder === 'auto') {
    const auto = todoAutoReminder({ dueOn: at.due_on, dueAt: at.due_at, timeZone: at.time_zone });
    return auto !== null && auto.getTime() > now.getTime() ? auto : null;
  }
  const picked = new Date(reminder.at);
  if (picked.getTime() <= now.getTime()) throw new DomainError('TODO_REMINDER_PAST', 400, 'Giờ nhắc đã qua; hãy chọn một giờ sắp tới');
  return picked;
}

// How a reminder is told in the audit: its kind and time, never the to-do's text.
const reminderKind = (reminder: TodoReminder) => (typeof reminder === 'string' ? reminder : 'custom');

// The text as stored: empty details are none, and the steps are JSON for the jsonb column.
const detailsOf = (details: string): string | null => (details.trim() === '' ? null : details);
const checklistOf = (checklist: readonly TodoStep[]): string => JSON.stringify(checklist.map((s) => ({ text: s.text, done: s.done })));

const written = (row: Pick<SummaryRow, 'id' | 'revision'>): TodoWritten => ({ todoId: row.id, revision: row.revision });
const target = (input: { todoId: string }) => ({ type: 'notes.todo', id: input.todoId });

// The caller's keys in order, ties by id; the moved to-do itself left out.
async function ownKeys(ctx: CommandContext, except: string | null): Promise<Array<{ id: string; sort_key: string }>> {
  let q = ctx.trx.selectFrom('crove_notes.todo').select(['id', 'sort_key']).where('org_id', '=', ctx.orgId);
  if (except !== null) q = q.where('id', '<>', except);
  return q.orderBy('sort_key').orderBy('id').execute();
}

// Fresh, evenly spread keys for the caller's whole list, in its current order (keys grown long, or two equal).
async function rebalance(ctx: CommandContext, rows: ReadonlyArray<{ id: string }>): Promise<Map<string, string>> {
  const keys = spreadKeys(rows.length);
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    // One statement for the whole list; the update policy still limits it to the caller's own rows.
    await sql`UPDATE crove_notes.todo AS t SET sort_key = v.key
      FROM unnest(${ids}::uuid[], ${keys}::text[]) AS v(id, key)
      WHERE t.org_id = ${ctx.orgId}::uuid AND t.id = v.id`.execute(ctx.trx);
  }
  return new Map(ids.map((id, i) => [id, keys[i] as string]));
}

// A key between two neighbors of the caller's list (by index in `rows`, -1 or rows.length for an end), giving the list
// fresh keys first when the two are equal or the new key would grow long.
async function placeBetween(ctx: CommandContext, rows: Array<{ id: string; sort_key: string }>, lo: number, hi: number): Promise<string> {
  const keyAt = (i: number) => (i < 0 || i >= rows.length ? null : (rows[i] as { sort_key: string }).sort_key);
  const a = keyAt(lo);
  const b = keyAt(hi);
  if (a === null || b === null || a < b) {
    const key = keyBetween(a, b);
    // A key that ends in '0' from elsewhere can leave no room the byte order agrees with; fresh keys then.
    if (key.length <= REBALANCE_AT && (a === null || a < key) && (b === null || key < b)) return key;
  }
  const fresh = await rebalance(ctx, rows);
  const freshAt = (i: number) => (i < 0 || i >= rows.length ? null : (fresh.get((rows[i] as { id: string }).id) as string));
  return keyBetween(freshAt(lo), freshAt(hi));
}

export const todoCreate = defineCommand({
  name: 'notes.todo.create',
  input: zTodoCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<TodoWritten> => {
    const userId = userOf(ctx.actor);
    // A new to-do goes first in the caller's list.
    const rows = await ownKeys(ctx, null);
    const sortKey = await placeBetween(ctx, rows, -1, 0);
    const when = due(input);
    const remind = remindAt(input.reminder, when, ctx.now);
    const row = await ctx.trx
      .insertInto('crove_notes.todo')
      .values({
        org_id: ctx.orgId,
        owner_user_id: userId,
        title: input.title,
        details: detailsOf(input.details),
        checklist: checklistOf(input.checklist),
        ...when,
        remind_at: remind,
        sort_key: sortKey,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      todoId: row.id,
      title: auditValue(TODO, 'title', input.title),
      details: auditValue(TODO, 'details', detailsOf(input.details)),
      checklist: auditValue(TODO, 'checklist', input.checklist.length > 0 ? input.checklist : null),
      dueOn: input.dueOn,
      dueTime: input.dueTime !== null,
      timeZone: input.timeZone,
      reminder: reminderKind(input.reminder),
      remindAt: remind?.toISOString() ?? null,
    });
    return written(row);
  },
});

export const todoUpdate = defineCommand({
  name: 'notes.todo.update',
  input: zTodoUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<TodoWritten> => {
    userOf(ctx.actor);
    const before = await load(ctx, input.todoId, true);
    assertNotInTrash(before);
    if (before.revision !== input.revision) {
      throw new DomainError('TODO_REVISION_CONFLICT', 409, 'Việc này vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', { revision: before.revision });
    }
    const next = due(input);
    const details = detailsOf(input.details);
    const checklist = checklistOf(input.checklist);
    const beforeDueAt = before.due_at === null ? null : new Date(before.due_at).getTime();
    const dueMoved = before.due_on !== next.due_on || beforeDueAt !== (next.due_at?.getTime() ?? null) || before.time_zone !== next.time_zone;
    const beforeRemind = before.remind_at === null ? null : new Date(before.remind_at);
    // Without a reminder in the input it stays, unless it was the automatic one of the old due day and time, or there
    // was none for want of a due day: it then follows the new ones.
    const wasAuto =
      beforeRemind === null
        ? before.due_on === null
        : beforeRemind.getTime() === todoAutoReminder({ dueOn: before.due_on, dueAt: beforeDueAt === null ? null : new Date(beforeDueAt), timeZone: before.time_zone })?.getTime();
    const remind = input.reminder !== undefined ? remindAt(input.reminder, next, ctx.now) : dueMoved && wasAuto ? remindAt('auto', next, ctx.now) : beforeRemind;
    const changed = [
      ...(before.title !== input.title ? ['title'] : []),
      ...(before.details !== details ? ['details'] : []),
      ...(JSON.stringify(steps(before.checklist)) !== checklist ? ['checklist'] : []),
      ...(before.due_on !== next.due_on || beforeDueAt !== (next.due_at?.getTime() ?? null) ? ['due'] : []),
      ...(before.time_zone !== next.time_zone ? ['timeZone'] : []),
      ...((beforeRemind?.getTime() ?? null) !== (remind?.getTime() ?? null) ? ['reminder'] : []),
    ];
    const row = await ctx.trx
      .updateTable('crove_notes.todo')
      // A new reminder time clears reminded_at (the b_remind_reset trigger), so it is sent again.
      .set({ title: input.title, details, checklist, ...next, remind_at: remind, revision: before.revision + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.todoId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({ todoId: row.id, revision: row.revision, changed, dueOn: next.due_on, remindAt: remind?.toISOString() ?? null });
    return written(row);
  },
});

// Done and open again: the owner's, outside the trash. A to-do handed over or cancelled stays as it is.
function statusCommand(name: string, from: TodoStatus, to: TodoStatus) {
  return defineCommand({
    name,
    input: zTodoRef,
    risk: 'R1',
    sideEffect: 'internal',
    access: WRITERS,
    target,
    handler: async (ctx, input): Promise<TodoWritten> => {
      userOf(ctx.actor);
      const before = await load(ctx, input.todoId, true);
      assertNotInTrash(before);
      if (before.status === to) return written(before);
      if (before.status !== from) throw new DomainError('TODO_NOT_CHANGEABLE', 409, 'Việc này đã được giao hoặc đã hủy');
      const row = await ctx.trx
        .updateTable('crove_notes.todo')
        .set({ status: to, done_at: to === 'done' ? ctx.now : null, revision: before.revision + 1, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.todoId)
        .returning(['id', 'revision'])
        .executeTakeFirstOrThrow();
      ctx.audit({ todoId: row.id, revision: row.revision, status: to, previousStatus: before.status });
      return written(row);
    },
  });
}

export const todoComplete = statusCommand('notes.todo.complete', 'open', 'done');
export const todoReopen = statusCommand('notes.todo.reopen', 'done', 'open');

// Moves a to-do right before or after another of the caller's. The anchor is read through the row policies, so it is
// the caller's own; only the moved to-do's key changes, unless the list needs fresh keys.
export const todoReorder = defineCommand({
  name: 'notes.todo.reorder',
  input: zTodoReorder,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<TodoWritten> => {
    userOf(ctx.actor);
    const moved = await load(ctx, input.todoId, true);
    assertNotInTrash(moved);
    const rows = await ownKeys(ctx, input.todoId);
    const at = rows.findIndex((r) => r.id === input.anchorId);
    if (at < 0) throw notFound();
    const key = input.place === 'before' ? await placeBetween(ctx, rows, at - 1, at) : await placeBetween(ctx, rows, at, at + 1);
    await ctx.trx.updateTable('crove_notes.todo').set({ sort_key: key }).where('org_id', '=', ctx.orgId).where('id', '=', input.todoId).execute();
    ctx.audit({ todoId: input.todoId, place: input.place, anchorId: input.anchorId });
    return written(moved);
  },
});

// To the trash, which the daily job empties after TODO_TRASH_DAYS, and back.
function trashCommand(name: string, toTrash: boolean) {
  return defineCommand({
    name,
    input: zTodoRef,
    risk: 'R1',
    sideEffect: 'internal',
    access: WRITERS,
    target,
    handler: async (ctx, input): Promise<TodoWritten> => {
      userOf(ctx.actor);
      const before = await load(ctx, input.todoId, true);
      if ((before.deleted_at !== null) === toTrash) return written(before);
      await ctx.trx
        .updateTable('crove_notes.todo')
        .set({ deleted_at: toTrash ? ctx.now : null, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.todoId)
        .execute();
      ctx.audit({ todoId: input.todoId, changed: ['deletedAt'] });
      return written(before);
    },
  });
}

export const todoDelete = trashCommand('notes.todo.delete', true);
export const todoRestore = trashCommand('notes.todo.restore', false);

export const todoList = defineQuery({
  name: 'notes.todo.list',
  input: zTodoList,
  access: READERS,
  handler: async (ctx, input): Promise<TodoSummary[]> => {
    userOf(ctx.actor);
    let q = ctx.trx.selectFrom('crove_notes.todo').select(SUMMARY).where('org_id', '=', ctx.orgId);
    // Words typed without Vietnamese marks find them ("hoa don" finds "hóa đơn"), each as a prefix.
    if (input.q !== undefined) q = q.where(sql<boolean>`search @@ crove_kernel.search_query(${input.q})`);
    if (input.view === 'trash') q = q.where('deleted_at', 'is not', null).orderBy('deleted_at', 'desc');
    else {
      q = q.where('deleted_at', 'is', null);
      q = input.view === 'open' ? q.where('status', '=', 'open').orderBy('sort_key') : q.where('status', '<>', 'open').orderBy(sql`coalesce(done_at, updated_at)`, 'desc');
    }
    const rows = await q.orderBy('id').limit(input.limit).execute();
    const now = new Date();
    return rows.map((r) => summary(r, now));
  },
});

export const todoGet = defineQuery({
  name: 'notes.todo.get',
  input: zTodoRef,
  access: READERS,
  handler: async (ctx, input): Promise<Todo> => {
    userOf(ctx.actor);
    const row = await load(ctx, input.todoId, false);
    return { ...summary(row, new Date()), details: row.details ?? '', checklist: steps(row.checklist).map((s) => ({ text: s.text, done: s.done })) };
  },
});

// How many to-dos each member has, for an owner or admin before removing one (ADR-0037 §4): a count from
// crove_notes.todo_counts(), which checks the caller's role itself, never the text.
export const todoCounts = defineQuery({
  name: 'notes.todo.counts',
  input: z.strictObject({}),
  access: MANAGERS,
  handler: async (ctx): Promise<TodoCount[]> => {
    const { rows } = await sql<{ owner_user_id: string; todos: string }>`SELECT owner_user_id, todos FROM crove_notes.todo_counts()`.execute(ctx.trx);
    return rows.map((r) => ({ userId: r.owner_user_id, todos: Number(r.todos) }));
  },
});

export const todoCommands = [todoCreate, todoUpdate, todoComplete, todoReopen, todoReorder, todoDelete, todoRestore];
export const todoQueries = [todoList, todoGet, todoCounts];
