// The AI agents API (ADR-0029, issue #258) on a real PostgreSQL 17: the chart, template install, agents, budgets,
// the "Stop AI" kill switch and tasks through /api/rpc, with the role, step-up (R3) and idempotency rules of each
// route. A template of a module the deployment leaves out answers MODULE_DISABLED. The agent and run rules themselves
// are in test/agents.db.test.ts and test/invariant/agents.db.test.ts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-agents-api-0123456789';
const ISSUER = 'crove-auth';
const TEMPLATE = 'finance.chief_accountant';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

type Who = 'owner' | 'admin' | 'member' | 'viewer';

suite('AI agents through the API (ADR-0029, #258)', () => {
  const dbName = `crove_test_agents_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool;
  let apps: Record<'full' | 'kernelOnly', ReturnType<typeof createHttpApp>>;
  const accounts = Object.fromEntries(
    (['owner', 'admin', 'member', 'viewer'] as const).map((who) => [who, { subject: randomUUID(), email: `${who}@agents-api.test`, session: randomUUID(), userId: '' }]),
  ) as Record<Who, Account>;
  let slug = '';
  let orgId = '';
  let adminUrl = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Who, options: { mfa?: boolean } = {}) {
    const account = accounts[who];
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: account.email, session_id: account.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(account.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, who: Who, input: unknown, options: { mfa?: boolean; org?: string | null; app?: keyof typeof apps } = {}) {
    const org = options.org === undefined ? slug : options.org;
    const response = await apps[options.app ?? 'full'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who, { mfa: options.mfa ?? false })}`,
        'content-type': 'application/json',
        ...(org ? { 'x-crove-org': org } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    const db = createDb(pool);
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const options = { sessions: createSessionStatusSource('off'), stepUp: 'required' as const };
    const full = new Runtime(db, options).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    // A deployment without finance (CROVE_MODULES=kernel) on the same database.
    const kernelOnly = new Runtime(db, { ...options, absentModules: ['finance'] }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const make = (runtime: Runtime) => createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    apps = { full: make(full), kernelOnly: make(kernelOnly) };

    for (const who of Object.keys(accounts) as Who[]) {
      const me = await rpc('me/get', who, undefined, { org: null });
      expect(me.status).toBe(200);
      accounts[who].userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', 'owner', { name: 'Công ty Tác tử', idempotencyKey: randomUUID() }, { org: null });
    expect(created.status).toBe(200);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    for (const who of ['admin', 'member', 'viewer'] as const) {
      const invite = await rpc('org/invite', 'owner', { email: accounts[who].email, role: who }, { mfa: true });
      expect(invite.status).toBe(200);
      const accepted = await rpc('invites/accept', who, { token: String(invite.body?.acceptPath).split('#')[1] }, { org: null });
      expect(accepted.status).toBe(200);
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  let agentId = '';
  let agentPosition = '';
  let memberPosition = '';
  let taskId = '';

  it('lists the templates with whether their module is enabled', async () => {
    for (const who of Object.keys(accounts) as Who[]) {
      const listed = await rpc('chart/templates', who, undefined);
      expect(listed.status, who).toBe(200);
      expect(listed.body).toContainEqual(expect.objectContaining({ key: TEMPLATE, module: 'finance', moduleEnabled: true }));
    }
    const off = await rpc('chart/templates', 'owner', undefined, { app: 'kernelOnly' });
    expect(off.body).toContainEqual(expect.objectContaining({ key: TEMPLATE, moduleEnabled: false }));
  });

  it('installs a template: owner with fresh MFA only, replayed by its key, MODULE_DISABLED without the module', async () => {
    const input = { templateKey: TEMPLATE, displayName: 'Kế toán trưởng AI', idempotencyKey: randomUUID() };
    for (const who of ['admin', 'member', 'viewer'] as const) {
      expect(await rpc('chart/installTemplate', who, { ...input, idempotencyKey: randomUUID() }, { mfa: true }), who).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    }
    expect(await rpc('chart/installTemplate', 'owner', input)).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    const disabled = await rpc('chart/installTemplate', 'owner', { ...input, idempotencyKey: randomUUID() }, { mfa: true, app: 'kernelOnly' });
    expect(disabled).toMatchObject({ status: 409, body: { code: 'MODULE_DISABLED', data: { module: 'finance' } } });

    const installed = await rpc('chart/installTemplate', 'owner', input, { mfa: true });
    expect(installed.status).toBe(200);
    agentId = String(installed.body.agentId);
    agentPosition = String(installed.body.positionId);
    expect((await rpc('chart/installTemplate', 'owner', input, { mfa: true })).body).toEqual(installed.body);

    // Every member reads the chart; the agent-held position is labelled as AI.
    for (const who of Object.keys(accounts) as Who[]) {
      const chart = await rpc('chart/get', who, undefined);
      expect(chart.status, who).toBe(200);
      expect(chart.body.positions).toContainEqual(
        expect.objectContaining({ id: agentPosition, holder: expect.objectContaining({ type: 'agent', agentId, name: 'Kế toán trưởng AI', ai: true }) }),
      );
      expect(chart.body.root).toEqual([expect.objectContaining({ userId: accounts.owner.userId })]);
    }
  });

  it('creates, assigns and updates positions: owner with fresh MFA only', async () => {
    const input = { title: 'Kế toán viên', module: 'finance', roleKey: 'finance.accountant', reportsTo: agentPosition, idempotencyKey: randomUUID() };
    expect(await rpc('chart/createPosition', 'admin', input, { mfa: true })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('chart/createPosition', 'owner', input)).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    const created = await rpc('chart/createPosition', 'owner', input, { mfa: true });
    expect(created.status).toBe(200);
    memberPosition = String(created.body.positionId);
    expect((await rpc('chart/createPosition', 'owner', input, { mfa: true })).body).toEqual(created.body);

    const assign = { id: memberPosition, holder: { type: 'user', userId: accounts.member.userId }, idempotencyKey: randomUUID() };
    expect(await rpc('chart/assign', 'member', assign, { mfa: true })).toMatchObject({ status: 403 });
    expect(await rpc('chart/assign', 'owner', assign, { mfa: true })).toMatchObject({ status: 200, body: { positionId: memberPosition } });
    // An agent goes only to a position of its template's role key.
    const wrongRole = await rpc('chart/assign', 'owner', { id: memberPosition, holder: { type: 'agent', agentId }, idempotencyKey: randomUUID() }, { mfa: true });
    expect(wrongRole).toMatchObject({ status: 422, body: { code: 'AGENT_ROLE_MISMATCH' } });

    const renamed = await rpc('chart/updatePosition', 'owner', { id: memberPosition, title: 'Kế toán tổng hợp', idempotencyKey: randomUUID() }, { mfa: true });
    expect(renamed.status).toBe(200);
    const chart = await rpc('chart/get', 'viewer', undefined);
    expect(chart.body.positions).toContainEqual(
      expect.objectContaining({ id: memberPosition, title: 'Kế toán tổng hợp', reportsTo: agentPosition, holder: expect.objectContaining({ type: 'user', userId: accounts.member.userId, ai: false }) }),
    );
  });

  it('changes an agent: owner with fresh MFA only', async () => {
    const input = { id: agentId, maxRisk: 'R0', dailyRunCap: 10, idempotencyKey: randomUUID() };
    expect(await rpc('agents/update', 'admin', input, { mfa: true })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('agents/update', 'owner', input)).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect(await rpc('agents/update', 'owner', input, { mfa: true })).toMatchObject({ status: 200, body: { agentId } });
    expect(await rpc('agents/update', 'owner', { id: agentId, status: 'paused', idempotencyKey: randomUUID() }, { mfa: true })).toMatchObject({ status: 200 });
    const chart = await rpc('chart/get', 'member', undefined);
    expect(chart.body.agents).toContainEqual(expect.objectContaining({ id: agentId, maxRisk: 'R0', dailyRunCap: 10, status: 'paused' }));
    expect(await rpc('agents/update', 'owner', { id: agentId, status: 'active', idempotencyKey: randomUUID() }, { mfa: true })).toMatchObject({ status: 200 });
  });

  it('sets and lists budgets: owners set them, owners and admins read them', async () => {
    const input = { scope: 'org', target: '*', monthlyLimit: '150.5', idempotencyKey: randomUUID() };
    expect(await rpc('agents/setBudget', 'admin', input, { mfa: true })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('agents/setBudget', 'owner', input)).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    const set = await rpc('agents/setBudget', 'owner', input, { mfa: true });
    expect(set.status).toBe(200);
    expect((await rpc('agents/setBudget', 'owner', input, { mfa: true })).body).toEqual(set.body);
    expect(await rpc('agents/setBudget', 'owner', { scope: 'org', target: 'all', monthlyLimit: '1', idempotencyKey: randomUUID() }, { mfa: true })).toMatchObject({
      status: 422,
      body: { code: 'INVALID_TARGET' },
    });
    // Money is a decimal string on the wire, never a number.
    expect((await rpc('agents/setBudget', 'owner', { ...input, monthlyLimit: 150.5, idempotencyKey: randomUUID() }, { mfa: true })).status).toBe(400);
    for (const who of ['owner', 'admin'] as const) {
      const listed = await rpc('agents/budgets', who, undefined);
      expect(listed.status, who).toBe(200);
      expect(listed.body).toEqual([expect.objectContaining({ id: set.body.budgetId, scope: 'org', target: '*', monthlyLimit: '150.500000', spent: '0', hardStop: true })]);
    }
    for (const who of ['member', 'viewer'] as const) expect((await rpc('agents/budgets', who, undefined)).status, who).toBe(403);
  });

  it('counts the AI run costs of this month per budget scope, exactly', async () => {
    // Runs the worker would have recorded: this month in two modules, and one last month that no budget counts.
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.ai_run (org_id, agent_id, module, status, cost, started_at, expires_at, finished_at) VALUES
           ($1, $2, 'finance', 'succeeded', 10.25, now(), now() + interval '1 minute', now()),
           ($1, $2, 'crm', 'succeeded', 1.5, now(), now() + interval '1 minute', now()),
           ($1, $2, 'finance', 'succeeded', 99, now() - interval '40 days', now() - interval '40 days' + interval '1 minute', now() - interval '40 days')`,
        [orgId, agentId],
      ),
    );
    for (const budget of [
      { scope: 'module', target: 'finance', monthlyLimit: '10.25' },
      { scope: 'agent', target: agentId, monthlyLimit: '50' },
    ]) {
      expect((await rpc('agents/setBudget', 'owner', { ...budget, warnPercent: 50, idempotencyKey: randomUUID() }, { mfa: true })).status).toBe(200);
    }
    const listed = await rpc('agents/budgets', 'admin', undefined);
    const spent = Object.fromEntries((listed.body as Array<{ scope: string; spent: string }>).map((b) => [b.scope, b.spent]));
    expect(spent).toEqual({ org: '11.750000', module: '10.250000', agent: '11.750000' });
  });

  it('stops AI for owners and admins without a second factor; only the owner with fresh MFA turns it back on', async () => {
    const input = { scope: 'org', target: '*', reason: 'Kiểm tra', idempotencyKey: randomUUID() };
    for (const who of ['member', 'viewer'] as const) expect(await rpc('agents/stop', who, { ...input, idempotencyKey: randomUUID() }), who).toMatchObject({ status: 403 });
    const stopped = await rpc('agents/stop', 'admin', input);
    expect(stopped.status).toBe(200);
    const killSwitchId = String(stopped.body.killSwitchId);
    expect((await rpc('agents/stop', 'admin', input)).body).toEqual(stopped.body);
    // Engaging a switch that is already on returns it.
    expect((await rpc('agents/stop', 'owner', { ...input, idempotencyKey: randomUUID() })).body).toMatchObject({ killSwitchId });
    expect((await rpc('chart/get', 'viewer', undefined)).body.killSwitches).toEqual([expect.objectContaining({ id: killSwitchId, scope: 'org', target: '*', reason: 'Kiểm tra' })]);

    const release = { id: killSwitchId, idempotencyKey: randomUUID() };
    expect(await rpc('agents/release', 'admin', release, { mfa: true })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('agents/release', 'owner', release)).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect(await rpc('agents/release', 'owner', release, { mfa: true })).toMatchObject({ status: 200, body: { ok: true } });
    expect(await rpc('agents/release', 'owner', release, { mfa: true })).toMatchObject({ status: 200, body: { ok: true } });
    expect(await rpc('agents/release', 'owner', { ...release, idempotencyKey: randomUUID() }, { mfa: true })).toMatchObject({ status: 404 });
    expect((await rpc('chart/get', 'viewer', undefined)).body.killSwitches).toEqual([]);
  });

  it('creates, lists, comments on and closes tasks: members write, every member reads', async () => {
    const input = { title: 'Đối chiếu công nợ tháng 10', description: 'Xem lại các hóa đơn còn treo', assigneePositionId: memberPosition, idempotencyKey: randomUUID() };
    expect(await rpc('tasks/create', 'viewer', input)).toMatchObject({ status: 403 });
    const created = await rpc('tasks/create', 'admin', input);
    expect(created.status).toBe(200);
    taskId = String(created.body.taskId);
    expect((await rpc('tasks/create', 'admin', input)).body).toEqual(created.body);

    for (const who of Object.keys(accounts) as Who[]) {
      const listed = await rpc('tasks/list', who, {});
      expect(listed.status, who).toBe(200);
      expect(listed.body).toContainEqual(expect.objectContaining({ id: taskId, title: input.title, status: 'todo', assigneePositionId: memberPosition, tainted: false }));
    }
    // The member holds the position, so the task is theirs; the owner's own list also has the chart's root tasks.
    expect((await rpc('tasks/list', 'member', { mine: true })).body.map((t: { id: string }) => t.id)).toEqual([taskId]);
    expect((await rpc('tasks/list', 'viewer', { mine: true })).body).toEqual([]);
    expect((await rpc('tasks/list', 'viewer', { positionId: memberPosition, status: ['todo'] })).body.map((t: { id: string }) => t.id)).toEqual([taskId]);

    const comment = { id: taskId, body: 'Đã xem 3 hóa đơn', idempotencyKey: randomUUID() };
    expect(await rpc('tasks/comment', 'viewer', comment)).toMatchObject({ status: 403 });
    const commented = await rpc('tasks/comment', 'member', comment);
    expect(commented.status).toBe(200);
    expect((await rpc('tasks/comment', 'member', comment)).body).toEqual(commented.body);

    const closing = { id: taskId, status: 'done', idempotencyKey: randomUUID() };
    expect(await rpc('tasks/setStatus', 'viewer', closing)).toMatchObject({ status: 403 });
    expect(await rpc('tasks/setStatus', 'member', closing)).toMatchObject({ status: 200, body: { taskId, status: 'done' } });

    const detail = await rpc('tasks/get', 'viewer', { id: taskId });
    expect(detail.status).toBe(200);
    expect(detail.body.task).toMatchObject({ id: taskId, status: 'done', description: input.description, checkedOut: false });
    expect(detail.body.comments).toEqual([expect.objectContaining({ id: commented.body.commentId, body: comment.body, authorType: 'user', authorId: accounts.member.userId })]);
    expect(detail.body.proposal).toBeNull();
    expect(await rpc('tasks/get', 'viewer', { id: randomUUID() })).toMatchObject({ status: 404, body: { code: 'TASK_NOT_FOUND' } });

    // A key replayed with other input is refused, never answered with the first result.
    expect(await rpc('tasks/create', 'admin', { ...input, title: 'Việc khác' })).toMatchObject({ status: 422, body: { code: 'IDEMPOTENCY_MISMATCH' } });
    // People see the newest tasks first.
    const newer = await rpc('tasks/create', 'member', { title: 'Việc mới hơn', assigneePositionId: null, idempotencyKey: randomUUID() });
    expect(newer.status).toBe(200);
    expect((await rpc('tasks/list', 'viewer', {})).body.map((t: { id: string }) => t.id)).toEqual([newer.body.taskId, taskId]);
  });

  it('never reaches the chart, agents, kill switches or tasks of another org', async () => {
    // The viewer of this org owns another one.
    const other = await rpc('org/create', 'viewer', { name: 'Công ty Khác', idempotencyKey: randomUUID() }, { org: null });
    expect(other.status).toBe(200);
    const org = String(other.body.slug);
    const killed = await rpc('agents/stop', 'owner', { scope: 'org', target: '*', idempotencyKey: randomUUID() });
    expect(killed.status).toBe(200);
    expect(await rpc('tasks/get', 'viewer', { id: taskId }, { org })).toMatchObject({ status: 404, body: { code: 'TASK_NOT_FOUND' } });
    expect(await rpc('agents/release', 'viewer', { id: killed.body.killSwitchId, idempotencyKey: randomUUID() }, { org, mfa: true })).toMatchObject({ status: 404 });
    expect(await rpc('agents/update', 'viewer', { id: agentId, maxRisk: 'R2', idempotencyKey: randomUUID() }, { org, mfa: true })).toMatchObject({
      status: 404,
      body: { code: 'AGENT_NOT_FOUND' },
    });
    expect(await rpc('chart/assign', 'viewer', { id: memberPosition, holder: null, idempotencyKey: randomUUID() }, { org, mfa: true })).toMatchObject({
      status: 404,
      body: { code: 'POSITION_NOT_FOUND' },
    });
    expect(await rpc('tasks/comment', 'viewer', { id: taskId, body: 'x', idempotencyKey: randomUUID() }, { org })).toMatchObject({ status: 404 });
    const theirs = await rpc('chart/get', 'viewer', undefined, { org });
    expect(theirs.body).toMatchObject({ positions: [], agents: [], killSwitches: [] });
    expect((await rpc('tasks/list', 'viewer', {}, { org })).body).toEqual([]);
    expect((await rpc('agents/budgets', 'viewer', undefined, { org })).body).toEqual([]);
  });
});
