// A to-do handed over as a team task, and My work, through the runtime on PostgreSQL 17 (issue #1674, plan
// docs/plan/notes.md step N5): the task belongs to the chosen position, every member reads it, its source_ref is
// `notes.todo` and set by the kernel; the to-do becomes handed_over with the task's id; an archived position is refused
// and nothing changes; only the owner hands their own open to-do over; the audit row and events keep markers and ids,
// not text; kernel.task.create's public input still sets no source_ref; My work lists my open to-dos and the open tasks
// of the positions I hold. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { MyWork, TodoHandedOver, TodoSummary, TodoWritten } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const TITLE = 'Nộp tờ khai thuế GTGT quý 3';
const DETAILS = 'Riêng tư: khách nợ lương nhân viên';
const STEP = 'Xin bảng kê hóa đơn';
const TEAM_TITLE = 'Nộp tờ khai GTGT quý 3 cho khách';
const TEAM_TEXT = 'Lấy bảng kê từ khách trước ngày 20';
const suite = ADMIN ? describe : describe.skip;

interface TaskView {
  id: string;
  title: string;
  assigneePositionId: string | null;
  source: string;
  sourceRef: unknown;
  due: string | null;
  tainted: boolean;
}

suite('to-do hand-over and My work on PostgreSQL (#1674)', () => {
  const dbName = `crove_test_notes_hand_over_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
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

  // A fresh org: its owner, the member who hands over, another member and a viewer; a position the other member holds,
  // one the member holds and an archived one.
  async function org() {
    const tag = randomUUID().slice(0, 8);
    const user = (name: string) => upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'hand-over', subject: `${name}-${tag}`, email: `${name}-${tag}@hand-over.test`, name: null });
    const owner = await user('owner');
    const mine = await user('mine');
    const other = await user('other');
    const viewer = await user('viewer');
    const { orgId } = await createOrg(app, asUser(owner), `Giao việc ${tag}`);
    const positions = await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, mine, other, viewer]);
      const add = async (title: string, holder: string | null, status: string) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.position (org_id, title, module, role_key, holder_user_id, status) VALUES ($1, $2, 'kernel', 'staff', $3, $4) RETURNING id`,
            [orgId, title, holder, status],
          )
        ).rows[0]?.id as string;
      return { team: await add('Kế toán thuế', other, 'active'), own: await add('Kế toán tổng hợp', mine, 'active'), archived: await add('Vị trí cũ', other, 'archived') };
    });
    const exec = <O>(userId: string, name: string, input: unknown = {}) => app.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => app.query<O>(name, input, { actor: asUser(userId), orgId });
    return { orgId, owner, mine, other, viewer, positions, exec, query };
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    app = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...notesCommands], queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries] });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('hands a to-do over as a task of the chosen position, which the team reads, with a notes.todo source_ref', async () => {
    const o = await org();
    const { todoId } = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', {
      title: TITLE,
      details: DETAILS,
      checklist: [{ text: STEP, done: false }],
      dueOn: '2026-11-20',
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    const handed = await o.exec<TodoHandedOver>(o.mine, 'notes.todo.hand_over', { todoId, revision: 1, positionId: o.positions.team, title: TEAM_TITLE, description: TEAM_TEXT });
    expect(handed).toMatchObject({ todoId, revision: 2 });

    // The task carries the confirmed text only, belongs to the position and is due at the end of the to-do's day.
    for (const reader of [o.other, o.owner, o.viewer, o.mine]) {
      const { task } = await o.query<{ task: TaskView & { description: string | null } }>(reader, 'kernel.task.get', { id: handed.taskId });
      expect(task).toMatchObject({
        title: TEAM_TITLE,
        description: TEAM_TEXT,
        assigneePositionId: o.positions.team,
        source: 'human',
        sourceRef: { type: 'notes.todo', id: todoId },
        due: '2026-11-20T16:59:00.000Z',
        tainted: false,
      });
    }
    const row = await admin((c) => c.query(`SELECT title, description, source_ref FROM crove_kernel.task WHERE id = $1`, [handed.taskId]));
    for (const secret of [TITLE, DETAILS, STEP]) expect(JSON.stringify(row.rows)).not.toContain(secret);

    // The to-do is handed over, out of the open list, and names its task.
    const done = await o.query<TodoSummary[]>(o.mine, 'notes.todo.list', { view: 'done' });
    expect(done.map((t) => [t.id, t.status, t.taskId])).toEqual([[todoId, 'handed_over', handed.taskId]]);
    expect(await o.query<TodoSummary[]>(o.mine, 'notes.todo.list', { view: 'open' })).toEqual([]);
    // A handed-over to-do is neither completed nor handed over again.
    await expect(o.exec(o.mine, 'notes.todo.complete', { todoId })).rejects.toMatchObject({ code: 'TODO_NOT_CHANGEABLE', status: 409 });
    await expect(
      o.exec(o.mine, 'notes.todo.hand_over', { todoId, revision: 2, positionId: o.positions.team, title: TEAM_TITLE, description: '' }),
    ).rejects.toMatchObject({ code: 'TODO_NOT_CHANGEABLE', status: 409 });

    // The holder of the position sees it in My work, with its position.
    const work = await o.query<MyWork>(o.other, 'notes.my_work', { timeZone: 'Asia/Ho_Chi_Minh' });
    expect(work.tasks.map((t) => [t.id, t.positionId])).toEqual([[handed.taskId, o.positions.team]]);

    // The audit row and the events keep ids and markers, never the to-do's or the task's text.
    const audit = await admin((c) =>
      c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'notes.todo.hand_over' AND outcome = 'ok'`, [o.orgId]),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.detail).toMatchObject({ todoId, taskId: handed.taskId, positionId: o.positions.team, title: { redacted: 'pii' }, description: { redacted: 'pii' } });
    // The kernel's nested command writes its own row, with ids only.
    const all = await admin((c) => c.query<{ command: string; detail: unknown }>(`SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1`, [o.orgId]));
    expect(all.rows.find((r) => r.command === 'kernel.task.create_from_todo')?.detail).toMatchObject({ taskId: handed.taskId, todoId });
    for (const secret of [TITLE, DETAILS, STEP, TEAM_TEXT]) expect(JSON.stringify(all.rows)).not.toContain(secret);
    const events = await admin((c) => c.query<{ type: string; payload: unknown }>(`SELECT type, payload FROM crove_kernel.outbox_event WHERE org_id = $1`, [o.orgId]));
    expect(events.rows.map((e) => e.type)).toEqual(expect.arrayContaining(['notes.todo.handed_over', 'kernel.task.created']));
    for (const secret of [TITLE, DETAILS, STEP, TEAM_TITLE, TEAM_TEXT]) {
      expect(JSON.stringify(audit.rows)).not.toContain(secret);
      expect(JSON.stringify(events.rows)).not.toContain(secret);
    }
  });

  it('refuses an archived position, a stale revision, a to-do in the trash and another member’s to-do, changing nothing', async () => {
    const o = await org();
    const { todoId } = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: TITLE });
    const handOver = (userId: string, input: Record<string, unknown> = {}) =>
      o.exec(userId, 'notes.todo.hand_over', { todoId, revision: 1, positionId: o.positions.team, title: TEAM_TITLE, description: '', ...input });
    const tasks = () => admin((c) => c.query(`SELECT id FROM crove_kernel.task WHERE org_id = $1`, [o.orgId])).then((r) => r.rowCount);

    await expect(handOver(o.mine, { positionId: o.positions.archived })).rejects.toMatchObject({ code: 'POSITION_ARCHIVED', status: 409 });
    await expect(handOver(o.mine, { positionId: randomUUID() })).rejects.toMatchObject({ code: 'POSITION_NOT_FOUND', status: 404 });
    await expect(handOver(o.mine, { revision: 7 })).rejects.toMatchObject({ code: 'TODO_REVISION_CONFLICT', status: 409 });
    // Nobody else hands it over: the to-do is not there for them, the org's owner included; a viewer runs no command.
    for (const caller of [o.other, o.owner]) await expect(handOver(caller)).rejects.toMatchObject({ code: 'TODO_NOT_FOUND', status: 404 });
    await expect(handOver(o.viewer)).rejects.toMatchObject({ status: 403 });
    await o.exec(o.mine, 'notes.todo.delete', { todoId });
    await expect(handOver(o.mine)).rejects.toMatchObject({ code: 'TODO_IN_TRASH', status: 409 });
    expect(await tasks()).toBe(0);
    const [todo] = (await admin((c) => c.query<{ status: string; task_id: string | null }>(`SELECT status, task_id FROM crove_notes.todo WHERE id = $1`, [todoId]))).rows;
    expect(todo).toEqual({ status: 'open', task_id: null });
  });

  it('carries a tainted to-do’s taint to its task', async () => {
    const o = await org();
    const { todoId } = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: TITLE });
    await admin((c) => c.query(`UPDATE crove_notes.todo SET tainted = true WHERE id = $1`, [todoId]));
    const handed = await o.exec<TodoHandedOver>(o.mine, 'notes.todo.hand_over', { todoId, revision: 1, positionId: o.positions.team, title: TEAM_TITLE, description: '' });
    const { task } = await o.query<{ task: TaskView }>(o.other, 'kernel.task.get', { id: handed.taskId });
    expect(task.tainted).toBe(true);
  });

  it('keeps kernel.task.create from setting a source_ref', async () => {
    const o = await org();
    const forged = { type: 'kernel.proposal', id: randomUUID() };
    const { taskId } = await o.exec<{ taskId: string }>(o.mine, 'kernel.task.create', { title: TEAM_TITLE, assigneePositionId: o.positions.team, sourceRef: forged, source_ref: forged });
    const { task } = await o.query<{ task: TaskView }>(o.mine, 'kernel.task.get', { id: taskId });
    expect(task.sourceRef).toBeNull();
  });

  it('lists my open to-dos and the open tasks of the positions I hold in My work', async () => {
    const o = await org();
    const { todoId } = await o.exec<TodoWritten>(o.mine, 'notes.todo.create', { title: TITLE });
    const theirs = await o.exec<TodoWritten>(o.other, 'notes.todo.create', { title: 'Của người khác' });
    const give = (title: string, positionId: string | null, due?: string) =>
      o.exec<{ taskId: string }>(o.owner, 'kernel.task.create', { title, assigneePositionId: positionId, ...(due ? { due } : {}) }).then((r) => r.taskId);
    const ownTask = await give('Đối chiếu công nợ', o.positions.own, '2020-01-01T00:00:00.000Z');
    const laterTask = await give('Khóa sổ tháng', o.positions.own);
    const teamTask = await give('Việc của người khác', o.positions.team);
    const rootTask = await give('Việc của chủ sở hữu', null);
    const closedTask = await give('Đã xong', o.positions.own);
    await admin((c) => c.query(`UPDATE crove_kernel.task SET status = 'done' WHERE id = $1`, [closedTask]));

    const work = await o.query<MyWork>(o.mine, 'notes.my_work', { timeZone: 'Asia/Ho_Chi_Minh' });
    expect(work.todos.map((t) => t.id)).toEqual([todoId]);
    expect(work.tasksTruncated).toBe(false);
    // Soonest first, an undated one last; never another position's, the owners' or a closed one.
    expect(work.tasks.map((t) => t.id)).toEqual([ownTask, laterTask]);
    expect(work.tasks[0]).toMatchObject({ positionId: o.positions.own, group: 'overdue', overdue: true });
    expect(work.tasks[1]).toMatchObject({ group: 'none', overdue: false });
    for (const id of [teamTask, rootTask, closedTask, theirs.todoId]) expect(JSON.stringify(work)).not.toContain(id);
    // The org's owner sees the tasks given to the owners, and none of the member's to-dos.
    const ownerWork = await o.query<MyWork>(o.owner, 'notes.my_work', {});
    expect(ownerWork.todos).toEqual([]);
    expect(ownerWork.tasks.map((t) => t.id)).toEqual([rootTask]);
  });
});
