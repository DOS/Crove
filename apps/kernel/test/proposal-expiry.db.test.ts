// Proposal expiry on PostgreSQL 17 (#876): an org's expiry (off by default, after the owners' escalation), the worker's
// sweep moving a pending proposal past it to 'expired' (audited, an activity entry and nothing else, no mail) only once
// its owners were told and had the escalation window, expired proposals never approved, the scan and the command for
// the worker alone, an expiry racing a rejection, and the author asking for an expired proposal again, from a request
// or from a file's reading, once, by nobody else. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import { createExtractClient } from '@crove/extract-contract';
import { createOrg, kernelCommands, kernelQueries, sweepProposalNudges, upsertIdentity, type ProposalPolicy } from '@crove/kernel';
import type { JournalVoucherRequest } from '@crove/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const extractApp = createExtractApp({ concurrency: 2 });
const extract = createExtractClient({ url: 'http://crove-extract.test', fetch: async (input, init) => extractApp.fetch(new Request(input, init)) });

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

type Detail = {
  status: string;
  revision: number;
  expiredAfterDays: number | null;
  canApprove: boolean;
  approveReason: string;
  canResubmit: boolean;
  resubmittedAs: string | null;
  resubmittedFrom: string | null;
};

suite('proposal expiry on PostgreSQL (#876)', () => {
  const dbName = `crove_test_proposal_expiry_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let worker: Runtime;
  const store = new MemoryStore();
  let invoiceNo = 8760;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@expiry.test`, name: null });

  type Org = { orgId: string; owner: string; admin: string; member: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const adminUser = await person('admin');
    const member = await person('member');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, adminUser, member]));
    return { orgId, owner, admin: adminUser, member };
  }

  // A pending purchase proposal that has waited `days`, approvable by the owner and the admin.
  async function rawProposal(o: Org, days: number, extra: { status?: string; command?: string; authors?: unknown } = {}): Promise<string> {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.proposal (org_id, id, kind, command, status, title, payload, eligible_approvers, authors, created_at)
         VALUES ($1, $2, 'purchase', $3, $4, $5, '{}', $6, $7, now() - make_interval(days => $8))`,
        [o.orgId, id, extra.command ?? 'finance.purchase.record', extra.status ?? 'pending', `Hóa đơn ${id.slice(0, 6)}`, [o.owner, o.admin], JSON.stringify(extra.authors ?? []), days],
      ),
    );
    return id;
  }

  const save = (o: Org, user: string, policy: ProposalPolicy) => rt.execute<ProposalPolicy>('kernel.proposal_policy.save', policy, { actor: asUser(user), orgId: o.orgId });
  const sweep = () => sweepProposalNudges({ runtime: worker, workerDb });
  // Waited `days`, and its owners were told as long ago: past every window.
  const age = (id: string, days: number) =>
    admin((c) => c.query('UPDATE crove_kernel.proposal SET created_at = now() - make_interval(days => $2), escalated_at = now() - make_interval(days => $2) WHERE id = $1', [id, days]));
  const view = (o: Org, user: string, id: string) => rt.query<Detail>('kernel.inbox.get', { id }, { actor: asUser(user), orgId: o.orgId });
  const resubmit = (o: Org, user: string, id: string) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.resubmit', { id }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const approve = async (o: Org, user: string, id: string) =>
    rt.execute<{ journalEntryId: string }>('kernel.proposal.approve', { id, revision: (await view(o, user, id)).revision, acceptUnverifiedSignature: true }, { actor: asMfa(user), orgId: o.orgId });
  const row = (id: string) =>
    admin(async (c) => (await c.query<Record<string, unknown>>('SELECT * FROM crove_kernel.proposal WHERE id = $1', [id])).rows[0] as Record<string, unknown>);

  type Counts = { mail: number; events: number; proposals: number; activity: number; audit: number };
  // What the org holds that the expiry must not touch, and what it must write.
  async function counts(orgId: string) {
    return admin(async (c) => {
      const { rows } = await c.query<Counts>(
        `SELECT (SELECT count(*)::int FROM crove_kernel.mail_message WHERE org_id = $1) AS mail,
                (SELECT count(*)::int FROM crove_kernel.outbox_event WHERE org_id = $1) AS events,
                (SELECT count(*)::int FROM crove_kernel.proposal WHERE org_id = $1) AS proposals,
                (SELECT count(*)::int FROM crove_kernel.activity WHERE org_id = $1) AS activity,
                (SELECT count(*)::int FROM crove_kernel.audit_event WHERE org_id = $1) AS audit`,
        [orgId],
      );
      return rows[0] as Counts;
    });
  }

  async function expiryAudit(proposalId: string) {
    return admin(async (c) => {
      const { rows } = await c.query<{ actor_type: string; outcome: string; detail: Record<string, unknown> }>(
        "SELECT actor_type, outcome, detail FROM crove_kernel.audit_event WHERE command = 'kernel.proposal.expire' AND target_id = $1 ORDER BY occurred_at, id",
        [proposalId],
      );
      return rows;
    });
  }

  // A proposal read from an invoice the uploader supplied (the uploader is an author).
  async function fileProposal(o: Org, uploader: string): Promise<{ proposalId: string; fileId: string }> {
    invoiceNo += 1;
    const bytes = new TextEncoder().encode(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${invoiceNo}</SHDon>`));
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(uploader), orgId: o.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-16' }, o.orgId, fileId);
    if (!proposalId) throw new Error('no proposal');
    return { proposalId, fileId };
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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    rt = new Runtime(db).register(registry);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
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

  it('keeps expiry off by default, and when set, after the owners are told and within its bounds', async () => {
    const o = await org();
    expect(await rt.query<ProposalPolicy>('kernel.proposal_policy.get', {}, { actor: asUser(o.member), orgId: o.orgId })).toEqual({
      remindAfterDays: null,
      escalateAfterDays: null,
      expireAfterDays: null,
    });
    const order = { code: 'PROPOSAL_EXPIRY_ORDER', status: 422 };
    await expect(save(o, o.owner, { remindAfterDays: 2, escalateAfterDays: null, expireAfterDays: 14 })).rejects.toMatchObject(order);
    await expect(save(o, o.owner, { remindAfterDays: 2, escalateAfterDays: 7, expireAfterDays: 7 })).rejects.toMatchObject(order);
    await expect(save(o, o.owner, { remindAfterDays: 2, escalateAfterDays: 7, expireAfterDays: 91 })).rejects.toThrow();
    await expect(save(o, o.member, { remindAfterDays: 2, escalateAfterDays: 7, expireAfterDays: 14 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await save(o, o.admin, { remindAfterDays: 2, escalateAfterDays: 7, expireAfterDays: 14 })).toEqual({ remindAfterDays: 2, escalateAfterDays: 7, expireAfterDays: 14 });
    const audit = await admin(async (c) =>
      (await c.query<{ detail: { previous: ProposalPolicy; policy: ProposalPolicy } }>(
        "SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.proposal_policy.save' AND outcome = 'ok'",
        [o.orgId],
      )).rows,
    );
    expect(audit.map((a) => a.detail.policy.expireAfterDays)).toEqual([14]);
    // The database holds every writer to the same rules.
    for (const [escalate, expire] of [
      [null, 14],
      [7, 7],
      [7, 1],
      [7, 91],
    ] as const) {
      await expect(
        admin((c) => c.query('UPDATE crove_kernel.proposal_policy SET escalate_after_days = $2, expire_after_days = $3 WHERE org_id = $1', [o.orgId, escalate, expire])),
        `${escalate} ${expire}`,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('expires a pending proposal past the expiry once: audited, an activity entry, nothing else and no mail', async () => {
    const o = await org();
    await save(o, o.owner, { remindAfterDays: 1, escalateAfterDays: 2, expireAfterDays: 3 });
    // Reminded and escalated earlier, as the policy says: its approvers and owners were mailed already.
    const id = await rawProposal(o, 4);
    await admin((c) => c.query("UPDATE crove_kernel.proposal SET reminded_at = now() - interval '3 days', escalated_at = now() - interval '2 days' WHERE id = $1", [id]));
    const before = await row(id);
    const counted = await counts(o.orgId);

    expect(await sweep()).toBeGreaterThanOrEqual(1);
    const after = await row(id);
    expect(after).toMatchObject({ status: 'expired', decided_by: null, decided_by_agent: null, decision_note: null, revision: 1 });
    expect(after.decided_at).not.toBeNull();
    // Nothing else of the proposal changed.
    const { status: _s, decided_at: _d, ...rest } = after;
    const { status: _bs, decided_at: _bd, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    // One audit row by the system, one activity entry, no mail and no event.
    expect(await counts(o.orgId)).toEqual({ ...counted, activity: counted.activity + 1, audit: counted.audit + 1 });
    expect(await expiryAudit(id)).toEqual([{ actor_type: 'system', outcome: 'ok', detail: expect.objectContaining({ days: 4, expire_after_days: 3, revision: 1 }) }]);
    const activity = await admin(async (c) => (await c.query<{ kind: string; summary: string }>("SELECT kind, summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2 AND kind = 'proposal.expired'", [o.orgId, id])).rows);
    expect(activity).toEqual([{ kind: 'proposal.expired', summary: expect.stringMatching(/^Hết hạn sau 4 ngày chờ duyệt: Hóa đơn /) }]);

    // Later passes write nothing more, and nobody is mailed again.
    await sweep();
    await sweep();
    expect(await expiryAudit(id)).toHaveLength(1);
    expect(await counts(o.orgId)).toEqual({ ...counted, activity: counted.activity + 1, audit: counted.audit + 1 });

    // The Inbox lists it under its state, with its reason; it can no longer be approved.
    const listed = await rt.query<Array<{ id: string; expiredAfterDays: number | null }>>('kernel.inbox.list', { status: 'expired' }, { actor: asUser(o.member), orgId: o.orgId });
    expect(listed).toEqual([expect.objectContaining({ id, expiredAfterDays: 4 })]);
    expect(await view(o, o.admin, id)).toMatchObject({ status: 'expired', expiredAfterDays: 4, canApprove: false, approveReason: 'not_pending' });
    await expect(approve(o, o.admin, id)).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED', status: 409 });
  });

  it('escalates an old backlog first when expiry is turned on, and expires it only after the escalation window', async () => {
    const o = await org();
    const late = await rawProposal(o, 30);
    const waiting = await rawProposal(o, 3);
    const decided = await rawProposal(o, 30, { status: 'rejected' });
    const none = await org();
    const unset = await rawProposal(none, 60);
    // The org turns expiry on while proposals of 30 days wait, never escalated.
    await save(o, o.owner, { remindAfterDays: 1, escalateAfterDays: 2, expireAfterDays: 5 });
    const mails = (id: string, stage: string) =>
      admin(async (c) => (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM crove_kernel.mail_message WHERE source_id = $1 AND payload->>'stage' = $2", [id, stage])).rows[0]?.n);
    await sweep();
    // Nothing expires: the owners are told first.
    expect((await row(late)).status).toBe('pending');
    expect((await row(late)).escalated_at).not.toBeNull();
    expect(await mails(late, 'escalate')).toBe(1);
    expect(await expiryAudit(late)).toEqual([]);
    expect((await row(waiting)).status).toBe('pending');
    expect((await row(decided)).status).toBe('rejected');
    expect((await row(unset)).status).toBe('pending');
    // Two days after the owners' mail it still waits: they have the three days between escalation and expiry.
    await admin((c) => c.query("UPDATE crove_kernel.proposal SET escalated_at = now() - interval '2 days' WHERE id = $1", [late]));
    await sweep();
    expect((await row(late)).status).toBe('pending');
    await admin((c) => c.query("UPDATE crove_kernel.proposal SET escalated_at = now() - interval '3 days' WHERE id = $1", [late]));
    await sweep();
    expect((await row(late)).status).toBe('expired');
    expect(await mails(late, 'escalate')).toBe(1);
    // The younger one was reminded, and its owners told, and it is not expired.
    expect(await mails(waiting, 'remind')).toBeGreaterThan(0);
    expect(await expiryAudit(waiting)).toEqual([]);
  });

  it('lets an expiry and a rejection race on the row lock: exactly one of them decides the proposal', async () => {
    const o = await org();
    await save(o, o.owner, { remindAfterDays: null, escalateAfterDays: 2, expireAfterDays: 3 });
    const system = { actor: { type: 'system' as const, component: 'test' }, orgId: o.orgId };
    for (let i = 0; i < 6; i++) {
      const id = await rawProposal(o, 10);
      await age(id, 10);
      const [expired, rejected] = await Promise.allSettled([
        worker.execute<{ expired: boolean }>('kernel.proposal.expire', { proposalId: id }, system),
        rt.execute('kernel.proposal.reject', { id }, { actor: asUser(o.admin), orgId: o.orgId }),
      ]);
      const status = (await row(id)).status;
      if (status === 'expired') {
        expect(expired).toMatchObject({ status: 'fulfilled', value: { expired: true } });
        expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'PROPOSAL_EXPIRED' } });
      } else {
        expect(status).toBe('rejected');
        expect(rejected.status).toBe('fulfilled');
        expect(expired).toMatchObject({ status: 'fulfilled', value: { expired: false } });
        // The runtime still audits the command it ran; the row records no expiry.
        expect((await expiryAudit(id)).map((a) => a.detail.days)).toEqual([undefined]);
      }
    }
  });

  it('lets only the worker run the scan and the command', async () => {
    for (const [role, allowed] of [
      ['crove_worker', true],
      ['crove_app', false],
      ['crove_tenant', false],
      ['crove_definer_tenant', false],
    ] as const) {
      const can = await admin(async (c) => (await c.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'crove_kernel.proposal_expiries_due(int)', 'EXECUTE') AS ok", [role])).rows[0]?.ok);
      expect(can, role).toBe(allowed);
    }
    await expect(pool.query('SELECT * FROM crove_kernel.proposal_expiries_due(10)')).rejects.toMatchObject({ code: '42501' });
    const o = await org();
    await save(o, o.owner, { remindAfterDays: null, escalateAfterDays: 2, expireAfterDays: 3 });
    const id = await rawProposal(o, 10);
    await expect(rt.execute('kernel.proposal.expire', { proposalId: id }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toThrow();
    expect((await row(id)).status).toBe('pending');
    // The command checks again: a proposal not yet due stays pending.
    const young = await rawProposal(o, 1);
    expect(await worker.execute('kernel.proposal.expire', { proposalId: young }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId })).toEqual({ expired: false });
    expect((await row(young)).status).toBe('pending');
  });

  it('lets the author ask again for an expired request, through the preparer, once', async () => {
    const o = await org();
    await save(o, o.owner, { remindAfterDays: null, escalateAfterDays: 2, expireAfterDays: 3 });
    const input: JournalVoucherRequest = {
      date: '2026-10-31',
      description: 'Trích trước chi phí điện tháng 10',
      lines: [
        { account: '6422', debit: '1500000', credit: '0' },
        { account: '3388', debit: '0', credit: '1500000' },
      ],
    };
    const { proposalId: id } = await rt.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      { command: 'finance.journal_voucher.record', input },
      { actor: asUser(o.member), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    // Not expired yet: nothing to ask again for.
    await expect(resubmit(o, o.member, id)).rejects.toMatchObject({ code: 'PROPOSAL_NOT_EXPIRED', status: 409 });
    await age(id, 4);
    await sweep();
    expect((await row(id)).status).toBe('expired');
    await expect(approve(o, o.owner, id)).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED' });

    // Only its author may ask again; the Inbox says so.
    expect(await view(o, o.member, id)).toMatchObject({ canResubmit: true, resubmittedAs: null });
    expect(await view(o, o.owner, id)).toMatchObject({ canResubmit: false });
    await expect(resubmit(o, o.owner, id)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const { proposalId: again } = await resubmit(o, o.member, id);
    expect(again).not.toBe(id);
    const fresh = await row(again);
    expect(fresh).toMatchObject({ status: 'pending', command: 'finance.journal_voucher.record', revision: 1, resubmitted_from: id, title: (await row(id)).title });
    expect(fresh.request_input).toEqual(input);
    expect(fresh.authors).toEqual([{ type: 'user', id: o.member }]);
    expect((await row(id)).status).toBe('expired');
    expect(await view(o, o.member, id)).toMatchObject({ canResubmit: false, resubmittedAs: again });
    expect(await view(o, o.member, again)).toMatchObject({ status: 'pending', resubmittedFrom: id });
    await expect(resubmit(o, o.member, id)).rejects.toMatchObject({ code: 'PROPOSAL_RESUBMITTED', status: 409, details: { proposalId: again } });
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE command = 'kernel.proposal.resubmit' AND outcome = 'ok' AND target_id = $1", [id])).rows);
    expect(audit).toEqual([{ detail: expect.objectContaining({ proposal_id: again, resubmitted_from: id, source: 'request' }) }]);

    // The new proposal is approved like any other: four-eyes keeps the member from it, the owner posts it.
    await expect(approve(o, o.member, again)).rejects.toMatchObject({ status: 403 });
    await approve(o, o.owner, again);
    expect((await row(again)).status).toBe('executed');
  });

  it("asks again for an expired file proposal from the same reading, only while it is the file's newest", async () => {
    const o = await org();
    await save(o, o.owner, { remindAfterDays: null, escalateAfterDays: 2, expireAfterDays: 3 });
    const { proposalId: id } = await fileProposal(o, o.owner);
    await age(id, 5);
    await sweep();
    expect((await row(id)).status).toBe('expired');
    // The uploader is its author; another member is not.
    await expect(resubmit(o, o.member, id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await view(o, o.owner, id)).toMatchObject({ canResubmit: true });
    const { proposalId: again } = await resubmit(o, o.owner, id);
    const [before, fresh] = [await row(id), await row(again)];
    expect(fresh).toMatchObject({ status: 'pending', source_file_id: before.source_file_id, extraction_id: before.extraction_id, tainted: true, resubmitted_from: id });
    expect(fresh.payload).toEqual(before.payload);
    expect(fresh.authors).toEqual(before.authors);
    // The uploader asked for it again, so the admin approves it.
    await approve(o, o.admin, again);
    expect((await row(again)).status).toBe('executed');

    // An older expired proposal of a file that has a newer one is not asked for again.
    const second = await fileProposal(o, o.owner);
    await age(second.proposalId, 5);
    await sweep();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, source_file_id, eligible_approvers, authors)
         SELECT org_id, kind, command, title, payload, source_file_id, eligible_approvers, authors FROM crove_kernel.proposal WHERE id = $1`,
        [second.proposalId],
      ),
    );
    await expect(resubmit(o, o.owner, second.proposalId)).rejects.toMatchObject({ code: 'PROPOSAL_SUPERSEDED', status: 409 });
    expect(await view(o, o.owner, second.proposalId)).toMatchObject({ canResubmit: false });
  });

  it('refuses to ask again for an expired request that kept no request, or whose authors cannot be read', async () => {
    const o = await org();
    const id = await rawProposal(o, 10, { status: 'expired', command: 'finance.journal_voucher.record', authors: [{ type: 'user', id: o.member }] });
    await expect(resubmit(o, o.member, id)).rejects.toMatchObject({ code: 'NOT_RESUBMITTABLE', status: 422 });
    expect(await view(o, o.member, id)).toMatchObject({ canResubmit: false });
    // Authors that cannot be read fail closed (four-eyes needs them): nobody may ask again, the original author neither.
    const unreadable = await rawProposal(o, 10, { status: 'expired', command: 'finance.journal_voucher.record', authors: [{ type: 'robot', id: o.member }] });
    await admin((c) => c.query(`UPDATE crove_kernel.proposal SET request_input = '{}' WHERE id = $1`, [unreadable]));
    for (const user of [o.member, o.admin, o.owner]) {
      await expect(resubmit(o, user, unreadable)).rejects.toMatchObject({ code: 'NOT_RESUBMITTABLE', status: 422 });
      expect(await view(o, user, unreadable)).toMatchObject({ canResubmit: false });
    }
    const forwarded = await rawProposal(o, 10, { status: 'expired', authors: [{ type: 'robot' }] });
    await expect(resubmit(o, o.member, forwarded)).rejects.toMatchObject({ code: 'NOT_RESUBMITTABLE' });
  });

  it('asks again exactly once under concurrency, and never for another org, a viewer, or a file being read again', async () => {
    const o = await org();
    await save(o, o.owner, { remindAfterDays: null, escalateAfterDays: 2, expireAfterDays: 3 });
    const { proposalId: id, fileId } = await fileProposal(o, o.owner);
    await age(id, 5);
    await sweep();
    expect((await row(id)).status).toBe('expired');

    // Another org's owner and a viewer of this org are refused; nothing is made.
    const other = await org();
    await expect(resubmit(other, other.owner, id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [o.orgId, viewer]));
    await expect(resubmit(o, viewer, id)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // While the file is being read again, it waits for the reading.
    await rt.execute('kernel.file.reextract', { fileId }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
    await expect(resubmit(o, o.owner, id)).rejects.toMatchObject({ code: 'EXTRACTION_PENDING', status: 409 });
    expect(await view(o, o.owner, id)).toMatchObject({ canResubmit: false });
    await admin((c) => c.query("UPDATE crove_kernel.extraction SET status = 'failed', completed_at = now() WHERE file_id = $1 AND status = 'pending'", [fileId]));

    // Three requests at once: one proposal, the others refused.
    const results = await Promise.allSettled([resubmit(o, o.owner, id), resubmit(o, o.owner, id), resubmit(o, o.owner, id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) expect(r.reason).toMatchObject({ code: 'PROPOSAL_RESUBMITTED' });
    const made = await admin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.proposal WHERE resubmitted_from = $1', [id])).rows[0]?.n);
    expect(made).toBe(1);
  });
});
