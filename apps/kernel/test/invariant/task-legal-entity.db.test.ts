// Tasks and task comments per legal entity (#1762, plan §4.6 RLS, Phase 1 exit criterion 2, kernel tables included) on
// PostgreSQL 17, as the real login roles: the API role (crove_app) for users, the worker role (crove_worker) for system
// and agent actors.
//   - A task about a record of one entity (its source_ref names a proposal or a finance record) takes that entity, a
//     delegated or escalated task its parent's; any other task stays org-level. A comment goes with its task.
//   - A member limited to one entity lists, opens and comments on no task of another entity, and still sees the
//     org-level ones; an agent limited to one entity sees the same.
//   - Tasks written before 20261104060000 are stamped the same way, and the review and escalation titles that copied a
//     proposal's title before #1756 take the neutral wording.
// Part of the invariant suite: keep it self-contained (package code under test, no helpers from outside
// test/invariant/). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type AgentActor } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { enterUser } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const THIS_VERSION = '20261104060000';
const TEMPLATE = 'finance.chief_accountant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

interface TaskRow {
  id: string;
  title: string;
}

suite('tasks and task comments per legal entity on PostgreSQL (#1762)', () => {
  const dbName = `crove_test_task_le_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let before = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let owner = '';
  let accountantA = '';
  let accountantB = '';
  let orgId = '';
  let defaultEntity = '';
  let branch = '';
  // Written before the migration.
  const legacy = { review: '', escalation: '', delegation: '', defaultReview: '', orgTask: '', general: '' };

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

  // Runs SQL as crove_app inside a member's context, always rolled back.
  async function asMember<T>(userId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, userId, orgId);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  function connect() {
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      // No context token key: the database starts at a version before enter_user_context (#1822).
      return new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, contextTokenKey: null }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    };
    app = runtimeFor(appUrl);
    worker = runtimeFor(workerUrl);
  }

  // An agent installed from the template with the given scope, holding its own top-level position, with a live run
  // started through a task that wakes it.
  async function liveAgent(leScope: string[]) {
    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: TEMPLATE, leScope },
      { actor: asMfa(owner), orgId },
    );
    const { taskId } = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
    if (!started.runId) throw new Error('no run');
    const actor: AgentActor = { type: 'agent', agentId, runId: started.runId };
    return { actor, agentId, positionId, taskId };
  }

  const entityOf = (taskId: string) =>
    admin(async (c) => (await c.query<{ e: string | null }>('SELECT legal_entity_id AS e FROM crove_kernel.task WHERE id = $1', [taskId])).rows[0]?.e);

  const listed = async (actor: ReturnType<typeof asUser> | AgentActor, runtime = app) =>
    (await runtime.query<{ tasks: TaskRow[] }>('kernel.task.list', {}, { actor, orgId })).tasks.map((t) => t.id);

  // A proposal of the entity, as the database owner writes it (the Inbox's flows are proposal-legal-entity's).
  const proposalOf = (c: pg.Client, entity: string, title: string) =>
    c
      .query<{ id: string }>(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors, legal_entity_id)
         VALUES ($1, 't1762', 't1762.prop', $3, '{}', ARRAY[$2::uuid], '[]', $4) RETURNING id`,
        [orgId, owner, title, entity],
      )
      .then((r) => r.rows[0]?.id as string);

  const insertTask = (c: pg.Client, values: Record<string, unknown>) => {
    const columns = Object.keys(values);
    return c
      .query<{ id: string }>(
        `INSERT INTO crove_kernel.task (org_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [orgId, ...Object.values(values)],
      )
      .then((r) => r.rows[0]?.id as string);
  };
  const ref = (id: string) => JSON.stringify({ type: 'kernel.proposal', id });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    // The database as it was before this migration.
    before = mkdtempSync(join(tmpdir(), 'crove-task-le-before-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < THIS_VERSION)) {
      copyFileSync(join(MIGRATIONS, name), join(before, name));
    }
    await migrate({ adminUrl, dir: before });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    connect();

    const db = createDb(pools[0] as pg.Pool);
    const person = (name: string) => upsertIdentity(db, { issuer: 't1762', subject: randomUUID(), email: `${name}@t1762.test`, name: null });
    owner = await person('owner');
    accountantA = await person('accountant-a');
    accountantB = await person('accountant-b');
    ({ orgId } = await createOrg(app, asUser(owner), 'T1762'));
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
      for (const [user, entity] of [
        [accountantA, defaultEntity],
        [accountantB, branch],
      ] as const) {
        await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, user]);
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
          orgId,
          user,
          entity,
          owner,
        ]);
      }
      // Tasks as the kernel and the chief accountant agent wrote them before #1756 and this migration.
      const ofBranch = await proposalOf(c, branch, 'Hoá đơn chi nhánh');
      const ofDefault = await proposalOf(c, defaultEntity, 'Hoá đơn trụ sở');
      const old = '2026-10-01T00:00:00Z';
      legacy.review = await insertTask(c, {
        title: 'Rà soát đề xuất: Hoá đơn chi nhánh',
        kind: 'proposal_review',
        source: 'event',
        source_ref: ref(ofBranch),
        created_by_type: 'system',
        updated_at: old,
      });
      legacy.escalation = await insertTask(c, {
        title: 'Duyệt đề xuất: Hoá đơn chi nhánh',
        description: 'Kết quả kiểm tra đề xuất "Hoá đơn chi nhánh": 1 đạt, 0 cảnh báo, 0 không đạt.',
        kind: 'escalation',
        parent_task_id: legacy.review,
        source: 'event',
        source_ref: ref(ofBranch),
        created_by_type: 'agent',
      });
      // A delegation names no record: it inherits its parent's entity, two levels down.
      legacy.delegation = await insertTask(c, { title: 'Kiểm tra chứng từ gốc', kind: 'delegation', parent_task_id: legacy.escalation, source: 'event', created_by_type: 'agent' });
      legacy.defaultReview = await insertTask(c, {
        title: 'Rà soát đề xuất: Hoá đơn trụ sở',
        kind: 'proposal_review',
        source: 'event',
        source_ref: ref(ofDefault),
        created_by_type: 'system',
      });
      legacy.orgTask = await insertTask(c, { title: 'Việc chung', source: 'human', created_by_type: 'user' });
      // A person's own task worded like a review keeps its title.
      legacy.general = await insertTask(c, { title: 'Rà soát đề xuất: ngân sách quý', source: 'human', created_by_type: 'user' });
      await c.query(`INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'Kết quả kiểm tra đề xuất "Hoá đơn chi nhánh"', 'agent')`, [
        orgId,
        legacy.review,
      ]);
    });

    await migrate({ adminUrl, dir: MIGRATIONS });
    // Connections opened before the migration may hold plans of the tables as they were.
    for (const pool of pools.splice(0)) await pool.end();
    connect();
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (before) rmSync(before, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('stamps the tasks written before the migration and takes the proposal title out of their titles', async () => {
    expect(await entityOf(legacy.review)).toBe(branch);
    expect(await entityOf(legacy.escalation)).toBe(branch);
    expect(await entityOf(legacy.delegation)).toBe(branch);
    expect(await entityOf(legacy.defaultReview)).toBe(defaultEntity);
    expect(await entityOf(legacy.orgTask)).toBeNull();
    expect(await entityOf(legacy.general)).toBeNull();
    const rows = await admin(async (c) =>
      Object.fromEntries(
        (
          await c.query<{ id: string; title: string; kept: boolean }>(
            `SELECT id, title, updated_at = '2026-10-01T00:00:00Z'::timestamptz AS kept FROM crove_kernel.task WHERE org_id = $1`,
            [orgId],
          )
        ).rows.map(
          (r) => [r.id, r],
        ),
      ),
    );
    expect(rows[legacy.review]?.title).toBe('Rà soát đề xuất chờ duyệt');
    expect(rows[legacy.defaultReview]?.title).toBe('Rà soát đề xuất chờ duyệt');
    expect(rows[legacy.escalation]?.title).toBe('Duyệt đề xuất đã rà soát');
    expect(rows[legacy.general]?.title).toBe('Rà soát đề xuất: ngân sách quý');
    // The backfill keeps the tasks' order: updated_at is untouched.
    expect(rows[legacy.review]?.kept).toBe(true);
  });

  it('shows a member limited to one entity no task or comment of another entity, and every org-level task', async () => {
    const seenByA = await listed(asUser(accountantA));
    expect(seenByA).toEqual(expect.arrayContaining([legacy.defaultReview, legacy.orgTask, legacy.general]));
    for (const id of [legacy.review, legacy.escalation, legacy.delegation]) expect(seenByA).not.toContain(id);
    const seenByB = await listed(asUser(accountantB));
    expect(seenByB).toEqual(expect.arrayContaining([legacy.review, legacy.escalation, legacy.delegation, legacy.orgTask]));
    expect(seenByB).not.toContain(legacy.defaultReview);
    expect(await listed(asUser(owner))).toEqual(expect.arrayContaining(Object.values(legacy)));

    await expect(app.query('kernel.task.get', { id: legacy.review }, { actor: asUser(accountantA), orgId })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    const opened = await app.query<{ comments: unknown[] }>('kernel.task.get', { id: legacy.review }, { actor: asUser(accountantB), orgId });
    expect(opened.comments).toHaveLength(1);
    await expect(app.execute('kernel.task.comment', { id: legacy.review, body: 'Không phải của tôi' }, { actor: asUser(accountantA), orgId })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await app.execute('kernel.task.comment', { id: legacy.orgTask, body: 'Đã xem' }, { actor: asUser(accountantA), orgId });

    // In SQL: no comment of the branch's task is read or written in A's context; the org-level task's are.
    await asMember(accountantA, async (c) => {
      const read = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.task_comment WHERE task_id = ANY($1::uuid[])', [[legacy.review, legacy.orgTask]]);
      expect(read.rows[0]?.n).toBe(1);
      await expect(
        c.query(`INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'x', 'user')`, [orgId, legacy.review]),
      ).rejects.toMatchObject({ code: '42501' });
    });
    // A task named in another entity, or a child of a task it cannot read, is refused.
    await asMember(accountantA, async (c) => {
      await c.query('SAVEPOINT s');
      await expect(insertTask(c, { title: 'Chi nhánh', source: 'human', created_by_type: 'user', legal_entity_id: branch })).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expect(insertTask(c, { title: 'Con', source: 'human', created_by_type: 'user', parent_task_id: legacy.review })).rejects.toThrow(/LEGAL_ENTITY_MISMATCH/);
    });
  });

  it('keeps the entity of a task once written, and refuses one that differs from its record', async () => {
    await expect(admin((c) => c.query('UPDATE crove_kernel.task SET legal_entity_id = $2 WHERE id = $1', [legacy.review, defaultEntity]))).rejects.toThrow(/LEGAL_ENTITY_IMMUTABLE/);
    await expect(admin((c) => c.query('UPDATE crove_kernel.task SET legal_entity_id = $2 WHERE id = $1', [legacy.orgTask, branch]))).rejects.toThrow(/LEGAL_ENTITY_IMMUTABLE/);
    const proposal = await admin(async (c) =>
      (await c.query<{ id: string }>(`SELECT source_ref->>'id' AS id FROM crove_kernel.task WHERE id = $1`, [legacy.review])).rows[0]?.id as string,
    );
    await expect(
      admin((c) => insertTask(c, { title: 'Sai', kind: 'proposal_review', source: 'event', source_ref: ref(proposal), created_by_type: 'system', legal_entity_id: defaultEntity })),
    ).rejects.toThrow(/LEGAL_ENTITY_MISMATCH/);
    // A record the writer cannot read: a writer limited to one entity stamps its own, one limited to several is refused.
    const single = await asMember(accountantA, (c) =>
      c
        .query<{ e: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, source_ref, created_by_type) VALUES ($1, 'Về chi nhánh', 'human', $2, 'user') RETURNING legal_entity_id AS e`,
          [orgId, ref(proposal)],
        )
        .then((r) => r.rows[0]?.e),
    );
    expect(single).toBe(defaultEntity);
    const accountantC = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 't1762', subject: randomUUID(), email: 'accountant-c@t1762.test', name: null });
    await admin(async (c) => {
      const second = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh 2', 'branch', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, accountantC]);
      for (const entity of [defaultEntity, second]) {
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
          orgId,
          accountantC,
          entity,
          owner,
        ]);
      }
    });
    await asMember(accountantC, async (c) => {
      expect((await c.query<{ s: string[] }>('SELECT crove_kernel.ctx_le_scope() AS s')).rows[0]?.s).toHaveLength(2);
      await expect(insertTask(c, { title: 'Về chi nhánh', source: 'human', source_ref: ref(proposal), created_by_type: 'user' })).rejects.toThrow(/LEGAL_ENTITY_MISMATCH/);
    });
    // A person's task stays org-level.
    const { taskId } = await app.execute<{ taskId: string }>('kernel.task.create', { title: 'Việc mới', assigneePositionId: null }, { actor: asUser(accountantB), orgId });
    expect(await entityOf(taskId)).toBeNull();
  });

  it("gives an agent's review task, its comment and its escalation the proposal's entity, and shows an agent only its entities' tasks", async () => {
    const agentB = await liveAgent([branch]);
    const agentA = await liveAgent([defaultEntity]);
    const voucher = {
      command: 'finance.journal_voucher.record',
      input: {
        date: '2026-10-05',
        description: 'Trích trước tiền điện',
        lines: [
          { account: '6422', debit: '450000', credit: '0' },
          { account: '3388', debit: '0', credit: '450000' },
        ],
        legalEntityId: branch,
      },
    };
    const { proposalId } = await app.execute<{ proposalId: string }>('kernel.proposal.request', voucher, { actor: asUser(accountantB), orgId, idempotencyKey: randomUUID() });
    const eventId = await admin(
      async (c) =>
        (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.proposal.created' AND payload->>'proposalId' = $2`, [orgId, proposalId]))
          .rows[0]?.id as string,
    );
    await worker.execute('kernel.agent.dispatch_event', { eventId }, { actor: SYSTEM, orgId });
    const review = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(`SELECT id FROM crove_kernel.task WHERE org_id = $1 AND kind = 'proposal_review' AND assignee_position_id = $2 AND source_ref->>'id' = $3`, [
            orgId,
            agentB.positionId,
            proposalId,
          ])
        ).rows[0]?.id as string,
    );
    expect(review).toBeTruthy();
    expect(await entityOf(review)).toBe(branch);

    // The agent limited to the branch reviews it and escalates; the escalation takes the review task's entity.
    const as = { actor: agentB.actor, orgId };
    expect(await listed(agentB.actor, worker)).toEqual(expect.arrayContaining([review, agentB.taskId]));
    const { fence } = await worker.execute<{ fence: string }>('kernel.task.checkout', { id: review }, as);
    await worker.execute('kernel.task.comment', { id: review, fence, body: 'Kết quả kiểm tra đề xuất: 1 đạt, 0 cảnh báo, 0 không đạt.' }, as);
    const { taskId: escalation } = await worker.execute<{ taskId: string }>('kernel.task.escalate', { id: review, fence, title: 'Duyệt đề xuất đã rà soát', reason: 'Không thấy lỗi chặn' }, as);
    expect(await entityOf(escalation)).toBe(branch);

    // The member limited to the default entity sees neither, nor the comment; the branch's member sees all three.
    const seenByA = await listed(asUser(accountantA));
    expect(seenByA).not.toContain(review);
    expect(seenByA).not.toContain(escalation);
    await expect(app.query('kernel.task.get', { id: review }, { actor: asUser(accountantA), orgId })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    const opened = await app.query<{ comments: unknown[] }>('kernel.task.get', { id: review }, { actor: asUser(accountantB), orgId });
    expect(opened.comments).toHaveLength(1);
    expect(await listed(asUser(accountantB))).toEqual(expect.arrayContaining([review, escalation]));

    // The agent limited to the default entity: a task of its position about the branch's records is out of its sight;
    // its org-level tasks are not.
    const hidden = await admin((c) =>
      insertTask(c, { title: 'Việc của chi nhánh', kind: 'proposal_review', assignee_position_id: agentA.positionId, source: 'event', source_ref: ref(proposalId), created_by_type: 'system' }),
    );
    expect(await entityOf(hidden)).toBe(branch);
    const seenByAgentA = await listed(agentA.actor, worker);
    expect(seenByAgentA).toContain(agentA.taskId);
    expect(seenByAgentA).not.toContain(hidden);
    await expect(worker.execute('kernel.task.checkout', { id: hidden }, { actor: agentA.actor, orgId })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });
});
