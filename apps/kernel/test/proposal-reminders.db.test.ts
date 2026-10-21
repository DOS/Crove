// Proposal reminders and escalation on PostgreSQL 17 (#676): an org's policy (owners and admins set it, escalation
// after the reminder), the worker's sweep reminding the people who may approve a pending proposal once and telling the
// owners once, four-eyes respected, decided proposals and orgs without a policy left alone, and the scan only the
// worker may run. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, sweepProposalNudges, upsertIdentity, type ProposalPolicy } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('proposal reminders on PostgreSQL (#676)', () => {
  const dbName = `crove_test_proposal_remind_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@remind.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; member: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const adminUser = await person('admin');
    const member = await person('member');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, adminUser, member]));
    return { orgId, owner, admin: adminUser, member };
  }

  // A pending purchase proposal that has waited `days`, approvable by the owner and the admin, with these authors.
  async function proposal(o: Org, days: number, authors: { type: 'user'; id: string }[] = [], status = 'pending'): Promise<string> {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.proposal (org_id, id, kind, command, status, title, payload, eligible_approvers, authors, created_at)
         VALUES ($1, $2, 'purchase', 'finance.purchase.record', $3, $4, '{}', $5, $6, now() - make_interval(days => $7))`,
        [o.orgId, id, status, `Hóa đơn ${id.slice(0, 6)}`, [o.owner, o.admin], JSON.stringify(authors), days],
      ),
    );
    return id;
  }

  const save = (o: Org, user: string, policy: ProposalPolicy) => rt.execute<ProposalPolicy>('kernel.proposal_policy.save', policy, { actor: asUser(user), orgId: o.orgId });

  async function mails(proposalId: string) {
    return admin(async (c) => {
      const { rows } = await c.query<{ to_address: string; template_key: string; payload: { stage: string; path: string; days: number }; status: string }>(
        "SELECT to_address, template_key, payload, status FROM crove_kernel.mail_message WHERE source = 'kernel.proposal.remind' AND source_id = $1 ORDER BY to_address",
        [proposalId],
      );
      return rows;
    });
  }

  const emailOf = (userId: string) => admin(async (c) => (await c.query<{ email: string }>('SELECT email FROM crove_kernel.user_account WHERE id = $1', [userId])).rows[0]?.email);
  const stamps = (proposalId: string) =>
    admin(async (c) => (await c.query<{ reminded_at: Date | null; escalated_at: Date | null }>('SELECT reminded_at, escalated_at FROM crove_kernel.proposal WHERE id = $1', [proposalId])).rows[0]);

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(db).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb).register(registry);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const sweep = () => sweepProposalNudges({ runtime: worker, workerDb });

  it('lets owners and admins set the policy, everyone read it, and keeps escalation after the reminder', async () => {
    const o = await org();
    const read = (user: string) => rt.query<ProposalPolicy>('kernel.proposal_policy.get', {}, { actor: asUser(user), orgId: o.orgId });
    expect(await read(o.member)).toEqual({ remindAfterDays: null, escalateAfterDays: null });
    await expect(save(o, o.member, { remindAfterDays: 2, escalateAfterDays: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(save(o, o.admin, { remindAfterDays: 5, escalateAfterDays: 5 })).rejects.toMatchObject({ code: 'PROPOSAL_POLICY_ORDER' });
    expect(await save(o, o.admin, { remindAfterDays: 2, escalateAfterDays: 5 })).toEqual({ remindAfterDays: 2, escalateAfterDays: 5 });
    expect(await save(o, o.owner, { remindAfterDays: 3, escalateAfterDays: null })).toEqual({ remindAfterDays: 3, escalateAfterDays: null });
    expect(await read(o.member)).toEqual({ remindAfterDays: 3, escalateAfterDays: null });
    const rows = await admin(async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.proposal_policy WHERE org_id = $1', [o.orgId])).rows[0]);
    expect(rows).toEqual({ n: 1 });
    const audit = await admin(async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.proposal_policy.save' AND outcome = 'ok'", [o.orgId])).rows[0]);
    expect(audit?.n).toBe(2);
  });

  it('reminds the approvers once, then tells the owners once, and never a decided proposal', async () => {
    const o = await org();
    await save(o, o.owner, { remindAfterDays: 2, escalateAfterDays: 5 });
    const fresh = await proposal(o, 1);
    const waiting = await proposal(o, 3);
    const decided = await proposal(o, 9, [], 'rejected');
    expect(await sweep()).toBeGreaterThanOrEqual(1);

    const reminded = await mails(waiting);
    expect(reminded.map((m) => m.to_address)).toEqual([await emailOf(o.admin), await emailOf(o.owner)].sort());
    for (const m of reminded) {
      expect(m).toMatchObject({ template_key: 'kernel.proposal.reminder', status: 'queued', payload: { stage: 'remind', days: 3 } });
      expect(m.payload.path).toMatch(new RegExp(`^/o/[a-z0-9-]+/inbox/${waiting}$`));
    }
    expect((await stamps(waiting))?.reminded_at).not.toBeNull();
    expect((await stamps(waiting))?.escalated_at).toBeNull();
    expect(await mails(fresh)).toEqual([]);
    expect(await mails(decided)).toEqual([]);

    // A second pass sends nothing more.
    await sweep();
    expect(await mails(waiting)).toHaveLength(2);

    // Two more days: the owners are told, once.
    await admin((c) => c.query("UPDATE crove_kernel.proposal SET created_at = created_at - interval '3 days' WHERE id = $1", [waiting]));
    await sweep();
    await sweep();
    const all = await mails(waiting);
    expect(all.filter((m) => m.payload.stage === 'escalate').map((m) => m.to_address)).toEqual([await emailOf(o.owner)]);
    expect(all).toHaveLength(3);
    const audit = await admin(async (c) =>
      (await c.query<{ detail: { stages: string[] } }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.proposal.remind' AND outcome = 'ok' ORDER BY occurred_at, id", [o.orgId])).rows,
    );
    expect(audit.map((a) => a.detail.stages)).toEqual([['remind'], ['escalate']]);
  });

  it('does both stages of a proposal that waited past both, and skips an approver four-eyes stops', async () => {
    const o = await org();
    await save(o, o.owner, { remindAfterDays: 1, escalateAfterDays: 2 });
    // The admin wrote this revision: with two eligible approvers, only the owner may approve it.
    const id = await proposal(o, 4, [{ type: 'user', id: o.admin }]);
    await sweep();
    const sent = await mails(id);
    const owner = await emailOf(o.owner);
    expect(sent.map((m) => `${m.payload.stage} ${m.to_address}`).sort()).toEqual([`escalate ${owner}`, `remind ${owner}`]);
    const s = await stamps(id);
    expect(s?.reminded_at).not.toBeNull();
    expect(s?.escalated_at).not.toBeNull();
  });

  it('leaves orgs without a policy, or with reminders off, alone', async () => {
    const none = await org();
    const off = await org();
    await save(off, off.owner, { remindAfterDays: null, escalateAfterDays: null });
    const a = await proposal(none, 30);
    const b = await proposal(off, 30);
    await sweep();
    expect(await mails(a)).toEqual([]);
    expect(await mails(b)).toEqual([]);
    expect((await stamps(a))?.reminded_at).toBeNull();
  });

  it('lets only the worker run the scan', async () => {
    for (const [role, allowed] of [
      ['crove_worker', true],
      ['crove_app', false],
      ['crove_tenant', false],
      ['crove_definer_tenant', false],
    ] as const) {
      const can = await admin(async (c) => (await c.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'crove_kernel.proposal_nudges_due(int)', 'EXECUTE') AS ok", [role])).rows[0]?.ok);
      expect(can, role).toBe(allowed);
    }
    await expect(pool.query('SELECT * FROM crove_kernel.proposal_nudges_due(10)')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the remind command to people', async () => {
    const o = await org();
    const id = await proposal(o, 10);
    await expect(rt.execute('kernel.proposal.remind', { proposalId: id }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toThrow();
    expect(await mails(id)).toEqual([]);
  });

  it('keeps the policy within its bounds', async () => {
    const o = await org();
    await expect(save(o, o.owner, { remindAfterDays: 0, escalateAfterDays: null })).rejects.toThrow();
    await expect(save(o, o.owner, { remindAfterDays: null, escalateAfterDays: 61 })).rejects.toThrow();
  });
});
