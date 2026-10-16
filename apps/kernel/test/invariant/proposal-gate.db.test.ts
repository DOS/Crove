// Proposal gate follow-ups (#161 from #88) on a real PostgreSQL 17:
// - a reviser (access 'proposal_revision') runs only from the proposal edit command, on a pending proposal of the
//   command it revises; no other command, nor a reviser nested in a reviser, reaches it;
// - every proposal command and the proposal query refuse another org's proposal id exactly like an id that does not
//   exist, whatever that proposal's state, so a foreign id reveals nothing;
// - co-owners: four-eyes (P10) and the owner_override liveness rule hold when an org has more than one owner;
// - a co-owner's demotion racing an owner_override approval: whichever takes the member rows first wins, and the
//   approval never acts on an owner role that a committed demotion took away.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import { createExtractClient } from '@crove/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { PROPOSAL_EDIT_COMMAND, Runtime, defineCommand, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('./fixtures/einvoice-basic.xml', import.meta.url));

const extractApp = createExtractApp({ concurrency: 2 });
const extract = createExtractClient({ url: 'http://crove-extract.test', fetch: async (input, init) => extractApp.fetch(new Request(input, init)) });

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
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

type Role = 'owner' | 'admin' | 'member' | 'viewer';
type Line = { lineNo: number; debitAccount: string };
type Detail = { revision: number; status: string; canApprove: boolean; approveReason: string; payload: { lines: Line[] } };
type Refusal = { code: string | undefined; status: number | undefined; message: string | undefined; details: unknown };

const suite = ADMIN ? describe : describe.skip;

suite('proposal gate follow-ups on PostgreSQL (#161)', () => {
  const dbName = `crove_test_gate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  let invoiceNo = 3000;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // An org whose first person is its owner; the others join by invite with the given role (co-owners are
  // promoted by the owner through kernel.member.change_role, the only path to a second owner).
  async function orgWith(name: string, roles: Role[]) {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(db, { issuer: 'test', subject: `owner-${tag}`, email: `owner-${tag}@example.com`, name: null });
    const orgId = (await createOrg(runtime, asUser(owner), `${name} ${tag}`)).orgId;
    const people: string[] = [];
    for (const [i, role] of roles.entries()) {
      const email = `${role}${i}-${tag}@example.com`;
      const person = await upsertIdentity(db, { issuer: 'test', subject: `${role}${i}-${tag}`, email, name: null });
      const invited = role === 'owner' ? 'admin' : role;
      const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role: invited }, { actor: asMfa(owner), orgId });
      await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(person) });
      if (role === 'owner') await runtime.execute('kernel.member.change_role', { userId: person, role: 'owner' }, { actor: asMfa(owner), orgId });
      people.push(person);
    }
    return { orgId, owner, people };
  }

  // A purchase proposal read from an invoice the uploader supplied (the uploader is an author).
  async function proposeIn(orgId: string, uploader: string): Promise<string> {
    invoiceNo += 1;
    const bytes = new TextEncoder().encode(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${invoiceNo}</SHDon>`));
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    await store.put(storageKey, bytes);
    // The generation a file reference carries (ADR-0013): memory has no versions, so the content address.
    const generation = `content:${sha256}`;
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(uploader), orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-16' }, orgId, fileId);
    if (!proposalId) throw new Error('no proposal');
    return proposalId;
  }

  const view = (orgId: string, userId: string, id: string) => runtime.query<Detail>('kernel.inbox.get', { id }, { actor: asUser(userId), orgId });
  const approveAs = (orgId: string, userId: string, id: string, revision: number) =>
    runtime.execute<{ journalEntryId: string }>('kernel.proposal.approve', { id, revision }, { actor: asMfa(userId), orgId });

  // A new revision authored by the editor: the first line moves to another expense account.
  async function editAs(orgId: string, userId: string, id: string): Promise<number> {
    const detail = await view(orgId, userId, id);
    const line = detail.payload.lines[0] as Line;
    const lineAccounts = [{ lineNo: line.lineNo, debitAccount: line.debitAccount === '6421' ? '6422' : '6421' }];
    const { revision } = await runtime.execute<{ revision: number }>(
      'kernel.proposal.edit',
      { id, revision: detail.revision, lineAccounts },
      { actor: asUser(userId), orgId },
    );
    return revision;
  }

  const proposalRow = (id: string) =>
    withAdmin(async (a) => (await a.query<{ status: string; revision: number }>('SELECT status, revision FROM crove_kernel.proposal WHERE id = $1', [id])).rows[0]);
  const documents = (id: string) =>
    withAdmin(async (a) => (await a.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_finance.purchase_document WHERE proposal_id = $1', [id])).rows[0]?.n);
  const roleOf = (orgId: string, userId: string) =>
    withAdmin(async (a) => (await a.query<{ role: string }>('SELECT role FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rows[0]?.role);

  async function approvalAudit(proposalId: string) {
    return withAdmin(async (admin) => {
      const { rows } = await admin.query<{ actor_id: string; outcome: string; detail: Record<string, unknown> }>(
        `SELECT actor_id, outcome, detail FROM crove_kernel.audit_event
         WHERE command = 'kernel.proposal.approve' AND target_id = $1 ORDER BY occurred_at, id`,
        [proposalId],
      );
      return rows;
    });
  }

  async function refusal(promise: Promise<unknown>): Promise<Refusal> {
    try {
      await promise;
    } catch (error) {
      const e = error as Refusal;
      return { code: e.code, status: e.status, message: e.message, details: e.details };
    }
    throw new Error('expected a refusal');
  }

  // Waits until `count` backends of this database wait on a lock.
  async function waitForLockWaiters(count: number) {
    for (let i = 0; i < 200; i++) {
      const waiting = await withAdmin(async (c) => {
        const { rows } = await c.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'", [dbName]);
        return Number(rows[0]?.n ?? 0);
      });
      if (waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the racing commands never waited on the lock');
  }

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const register = (target: Db) =>
      new Runtime(target).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    runtime = register(db);
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 4 });
    workerRuntime = register(createDb(workerPool));
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('refuses to register a reviser that names no command it revises, and `revises` on any other command', () => {
    const reviser = { name: 'finance.test_reviser', input: z.object({}), risk: 'R1' as const, handler: async () => ({}) };
    expect(() => new Runtime(db).register({ commands: [defineCommand({ ...reviser, access: 'proposal_revision' })] })).toThrow(/names the command it revises/);
    expect(() => new Runtime(db).register({ commands: [defineCommand({ ...reviser, access: 'proposal_revision', revises: '' })] })).toThrow(
      /names the command it revises/,
    );
    expect(() => new Runtime(db).register({ commands: [defineCommand({ ...reviser, access: ['owner'], revises: 'finance.purchase.record' })] })).toThrow(
      /only a reviser does/,
    );
    expect(() =>
      new Runtime(db).register({ commands: [defineCommand({ ...reviser, access: 'proposal_revision', revises: 'finance.purchase.record' })] }),
    ).not.toThrow();
  });

  it('runs a reviser only from the proposal edit command, on a pending proposal of the command it revises (#161)', async () => {
    const { orgId, owner, people } = await orgWith('Reviser binding', ['admin']);
    const admin = people[0] as string;
    const other = await orgWith('Reviser binding other', []);
    const id = await proposeIn(orgId, owner);
    const foreign = await proposeIn(other.orgId, other.owner);
    const { payload } = await view(orgId, owner, id);
    const line = payload.lines[0] as Line;
    const reviserInput = { payload, lineAccounts: [{ lineNo: line.lineNo, debitAccount: line.debitAccount === '6421' ? '6422' : '6421' }] };

    // A command with a bug: it runs the reviser on a pending proposal it does not edit.
    const rogue = defineCommand({
      name: 'kernel.test_rogue_revise',
      input: z.object({ proposalId: z.uuid() }),
      risk: 'R1',
      access: ['owner', 'admin', 'member'],
      handler: async (ctx, input) => ctx.run('finance.purchase.revise', reviserInput, { proposalId: input.proposalId }),
    });
    // A reviser that runs another reviser (it inherits the proposal id).
    const nested = defineCommand({
      name: 'finance.test_nested_revise',
      input: z.object({}),
      risk: 'R1',
      access: 'proposal_revision',
      revises: 'finance.purchase.record',
      handler: async (ctx) => ctx.run('finance.purchase.revise', reviserInput),
    });
    // Stands in for the edit command (the same name, so the runtime treats it as the editor), to drive the reviser
    // with proposals the real edit would refuse before reaching it. It writes nothing.
    const editor = defineCommand({
      name: PROPOSAL_EDIT_COMMAND,
      input: z.object({ proposalId: z.uuid(), reviser: z.string() }),
      risk: 'R1',
      access: ['owner', 'admin', 'member'],
      handler: async (ctx, input) => ctx.run(input.reviser, input.reviser === 'finance.purchase.revise' ? reviserInput : {}, { proposalId: input.proposalId }),
    });
    const gated = new Runtime(db).register({ commands: [...kernelCommands.filter((c) => c.name !== PROPOSAL_EDIT_COMMAND), ...financeCommands, rogue, nested, editor] });
    const refused = { code: 'FORBIDDEN', status: 403, details: { rule: 'proposal_state' } };
    const runEditor = (proposalId: string, reviser = 'finance.purchase.revise') =>
      gated.execute<{ changed: boolean }>(PROPOSAL_EDIT_COMMAND, { proposalId, reviser }, { actor: asUser(admin), orgId });
    const setCommand = (command: string) => withAdmin((a) => a.query('UPDATE crove_kernel.proposal SET command = $2 WHERE id = $1', [id, command]));

    // Control: the editor runs the reviser on a pending proposal of the command it revises.
    await expect(runEditor(id)).resolves.toMatchObject({ changed: true });
    // Any other command is refused, the proposal being pending does not make it an edit.
    await expect(gated.execute('kernel.test_rogue_revise', { proposalId: id }, { actor: asUser(admin), orgId })).rejects.toMatchObject(refused);
    // So is a reviser nested in a reviser, even inside an edit.
    await expect(runEditor(id, 'finance.test_nested_revise')).rejects.toMatchObject(refused);
    // A proposal of another command is not this reviser's to revise.
    await setCommand('finance.journal.reverse');
    await expect(runEditor(id)).rejects.toMatchObject(refused);
    await setCommand('finance.purchase.record');
    // Another org's pending proposal is refused exactly like an id that does not exist.
    const foreignRefusal = await refusal(runEditor(foreign));
    expect(foreignRefusal).toMatchObject(refused);
    expect(await refusal(runEditor(randomUUID()))).toEqual(foreignRefusal);
    // Called directly, a reviser is refused outright.
    await expect(gated.execute('finance.purchase.revise', reviserInput, { actor: asUser(admin), orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await withAdmin(async (a) => {
      const { rows } = await a.query<{ command: string; outcome: string; detail: { code?: string; rule?: string } }>(
        `SELECT command, outcome, detail FROM crove_kernel.audit_event
         WHERE org_id = $1 AND command IN ('kernel.test_rogue_revise', $2) AND outcome <> 'ok' ORDER BY occurred_at, id`,
        [orgId, PROPOSAL_EDIT_COMMAND],
      );
      expect(rows.map((r) => r.command)).toEqual(['kernel.test_rogue_revise', PROPOSAL_EDIT_COMMAND, PROPOSAL_EDIT_COMMAND, PROPOSAL_EDIT_COMMAND, PROPOSAL_EDIT_COMMAND]);
      expect(rows.every((r) => r.outcome === 'denied' && r.detail.code === 'FORBIDDEN' && r.detail.rule === 'proposal_state')).toBe(true);
    });

    // The real edit still revises (the reviser computes, the edit writes the revision), and nothing above wrote one.
    expect(await proposalRow(id)).toEqual({ status: 'pending', revision: 1 });
    expect(await editAs(orgId, admin, id)).toBe(2);
    expect(await proposalRow(foreign)).toEqual({ status: 'pending', revision: 1 });
    // Once decided, the proposal is no reviser's either.
    await approveAs(orgId, owner, id, 2);
    expect(await proposalRow(id)).toMatchObject({ status: 'executed' });
    await expect(runEditor(id)).rejects.toMatchObject(refused);
  });

  it("refuses another org's proposal id in every proposal command and query, exactly like an unknown id (#161)", async () => {
    const a = await orgWith('Cross org A', ['admin']);
    const b = await orgWith('Cross org B', ['admin']);
    const bAdmin = b.people[0] as string;
    const own = await proposeIn(a.orgId, a.owner);
    // Org B's proposals in every state a proposal can be committed in.
    const pending = await proposeIn(b.orgId, b.owner);
    const executed = await proposeIn(b.orgId, b.owner);
    await approveAs(b.orgId, bAdmin, executed, 1);
    const rejected = await proposeIn(b.orgId, b.owner);
    await runtime.execute('kernel.proposal.reject', { id: rejected }, { actor: asUser(bAdmin), orgId: b.orgId });
    const failed = await proposeIn(b.orgId, b.owner);
    await withAdmin((c) => c.query("UPDATE crove_kernel.proposal SET status = 'failed' WHERE id = $1", [failed]));
    const before = await Promise.all([pending, executed, rejected, failed].map(proposalRow));

    // A command with a bug in org A that runs a proposal's command, with valid input, for whatever proposal id it is given.
    const { payload: purchase } = await view(a.orgId, a.owner, own);
    const reversal = { entryId: randomUUID(), entryDate: '2026-10-16', reason: 'test' };
    const rogue = defineCommand({
      name: 'kernel.test_rogue_record',
      input: z.object({ proposalId: z.uuid(), command: z.string() }),
      risk: 'R1',
      access: ['owner', 'admin', 'member'],
      handler: async (ctx, input) =>
        ctx.run(input.command, { payload: input.command === 'finance.purchase.record' ? purchase : reversal, acceptFailedChecks: true }, { proposalId: input.proposalId }),
    });
    const gated = new Runtime(db).register({ commands: [...kernelCommands, ...financeCommands, rogue] });
    const lineAccounts = [{ lineNo: 1, debitAccount: '6421' }];
    const owner = a.owner;
    // The refusal an unknown id gets from each, pinned so an attempt that starts failing for another reason (input,
    // step-up) cannot pass by refusing every id alike. The proposal commands and the query find no row (404); the
    // runtime gate refuses (proposal_state). For access 'proposal' the gate also needs executed_command_id to be the
    // calling command, which no other org's row can be, so those two rows pin the outcome rather than the org filter;
    // the reviser binding test covers the org filter with another org's pending proposal of the right command.
    const notFound = { code: 'NOT_FOUND', status: 404 };
    const gate = { code: 'FORBIDDEN', status: 403, details: { rule: 'proposal_state' } };
    const attempts: Array<[string, Record<string, unknown>, (id: string) => Promise<unknown>]> = [
      ['kernel.proposal.edit', notFound, (id) => runtime.execute('kernel.proposal.edit', { id, revision: 1, lineAccounts }, { actor: asUser(owner), orgId: a.orgId })],
      ['kernel.proposal.approve', notFound, (id) => runtime.execute('kernel.proposal.approve', { id, revision: 1 }, { actor: asMfa(owner), orgId: a.orgId })],
      ['kernel.proposal.reject', notFound, (id) => runtime.execute('kernel.proposal.reject', { id }, { actor: asUser(owner), orgId: a.orgId })],
      ['kernel.inbox.get', notFound, (id) => runtime.query('kernel.inbox.get', { id }, { actor: asUser(owner), orgId: a.orgId })],
      [
        'finance.purchase.record (gate)',
        gate,
        (id) => gated.execute('kernel.test_rogue_record', { proposalId: id, command: 'finance.purchase.record' }, { actor: asUser(owner), orgId: a.orgId }),
      ],
      [
        'finance.journal.reverse (gate)',
        gate,
        (id) => gated.execute('kernel.test_rogue_record', { proposalId: id, command: 'finance.journal.reverse' }, { actor: asUser(owner), orgId: a.orgId }),
      ],
    ];
    for (const [name, expected, attempt] of attempts) {
      const unknown = await refusal(attempt(randomUUID()));
      expect(unknown, name).toMatchObject(expected);
      for (const id of [pending, executed, rejected, failed]) {
        expect(await refusal(attempt(id)), `${name} with org B's proposal`).toEqual(unknown);
      }
    }

    // Org B's proposals are untouched, org B's audit has nothing from org A's owner, and org A's list never shows them.
    expect(await Promise.all([pending, executed, rejected, failed].map(proposalRow))).toEqual(before);
    await withAdmin(async (c) => {
      const { rows } = await c.query('SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND actor_id = $2', [b.orgId, a.owner]);
      expect(rows).toHaveLength(0);
    });
    const list = await runtime.query<Array<{ id: string }>>('kernel.inbox.list', {}, { actor: asUser(a.owner), orgId: a.orgId });
    expect(list.map((p) => p.id)).toEqual([own]);
    // Org A's own proposal still works for org A.
    expect(await view(a.orgId, a.owner, own)).toMatchObject({ status: 'pending', approveReason: 'four_eyes' });
  });

  it('keeps four-eyes with co-owners, and lets either co-owner approve only when every eligible approver is an author', async () => {
    // Two owners and nobody else eligible.
    const duo = await orgWith('Co-owners', ['owner', 'member']);
    const [coOwner, member] = duo.people as [string, string];

    // The owner uploaded: the co-owner is an eligible approver who is not an author, so four-eyes holds for the owner.
    const first = await proposeIn(duo.orgId, duo.owner);
    expect(await view(duo.orgId, duo.owner, first)).toMatchObject({ canApprove: false, approveReason: 'four_eyes' });
    await expect(approveAs(duo.orgId, duo.owner, first, 1)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED', status: 403 });
    expect(await view(duo.orgId, coOwner, first)).toMatchObject({ canApprove: true, approveReason: 'ok' });
    await approveAs(duo.orgId, coOwner, first, 1);
    expect((await approvalAudit(first)).at(-1)).toMatchObject({
      actor_id: coOwner,
      outcome: 'ok',
      detail: { policy: { P12: 'pass', P10: 'pass' }, eligible_approvers: 2, self_approved: false },
    });

    // A member's upload is no owner's work: either owner approves it without a flag.
    const byMember = await proposeIn(duo.orgId, member);
    await approveAs(duo.orgId, duo.owner, byMember, 1);
    expect((await approvalAudit(byMember)).at(-1)).toMatchObject({ actor_id: duo.owner, outcome: 'ok', detail: { policy: { P10: 'pass' }, self_approved: false } });

    // The owner uploaded and the co-owner edited: every eligible approver is an author, and both are owners, so
    // either may approve, flagged owner_override.
    for (const approver of [duo.owner, coOwner]) {
      const id = await proposeIn(duo.orgId, duo.owner);
      expect(await editAs(duo.orgId, coOwner, id)).toBe(2);
      for (const person of [duo.owner, coOwner]) expect(await view(duo.orgId, person, id)).toMatchObject({ canApprove: true, approveReason: 'ok' });
      await approveAs(duo.orgId, approver, id, 2);
      expect((await approvalAudit(id)).at(-1)).toMatchObject({
        actor_id: approver,
        outcome: 'ok',
        detail: { revision: 2, policy: { P12: 'pass', P10: 'owner_override' }, eligible_approvers: 2, self_approved: true },
      });
      expect(await documents(id)).toBe(1);
    }

    // Two owners who both wrote it and an admin who did not: four-eyes holds for both owners, the admin approves.
    const trio = await orgWith('Co-owners and admin', ['owner', 'admin']);
    const [trioCoOwner, trioAdmin] = trio.people as [string, string];
    const id = await proposeIn(trio.orgId, trio.owner);
    await editAs(trio.orgId, trioCoOwner, id);
    for (const person of [trio.owner, trioCoOwner]) {
      expect(await view(trio.orgId, person, id)).toMatchObject({ canApprove: false, approveReason: 'four_eyes' });
      await expect(approveAs(trio.orgId, person, id, 2)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    }
    await approveAs(trio.orgId, trioAdmin, id, 2);
    expect((await approvalAudit(id)).at(-1)).toMatchObject({
      actor_id: trioAdmin,
      outcome: 'ok',
      detail: { policy: { P10: 'pass' }, eligible_approvers: 3, self_approved: false },
    });
  });

  // An owner approves with owner_override while a co-owner demotes them to admin. The approval locks the snapshot
  // members' rows (FOR SHARE) and the demotion locks the owners' rows (FOR UPDATE), so they run one after the other.
  // A separate connection holds the owner rows so both are certainly in flight together, and queues them in a known
  // order: the one that waits first takes the rows first.
  it('a co-owner demotion racing an owner_override approval: the first to lock wins, never a stale owner role (#161)', async () => {
    for (const first of ['demotion', 'approval'] as const) {
      const { orgId, owner, people } = await orgWith(`Override race ${first}`, ['owner']);
      const coOwner = people[0] as string;
      const id = await proposeIn(orgId, owner);
      expect(await editAs(orgId, coOwner, id)).toBe(2);
      expect(await view(orgId, owner, id)).toMatchObject({ canApprove: true, approveReason: 'ok' });

      const demote = () => runtime.execute('kernel.member.change_role', { userId: owner, role: 'admin' }, { actor: asMfa(coOwner), orgId });
      const approve = () => approveAs(orgId, owner, id, 2);
      const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
      const holder = new pg.Client({ connectionString: adminUrl });
      // A failure below must not leave the owner rows locked (the racers would hang) or crash the run when the
      // database is dropped under the holder.
      holder.on('error', () => {});
      await holder.connect();
      let firstRun: ReturnType<typeof settle<unknown>>;
      let secondRun: ReturnType<typeof settle<unknown>>;
      try {
        await holder.query('BEGIN');
        await holder.query("SELECT 1 FROM crove_kernel.tenant_member WHERE org_id = $1 AND role = 'owner' ORDER BY user_id FOR UPDATE", [orgId]);
        firstRun = settle<unknown>(first === 'demotion' ? demote() : approve());
        await waitForLockWaiters(1);
        secondRun = settle<unknown>(first === 'demotion' ? approve() : demote());
        await waitForLockWaiters(2);
      } finally {
        await holder.query('COMMIT').catch(() => {});
        await holder.end().catch(() => {});
      }
      const [demotion, approval] = first === 'demotion' ? [await firstRun, await secondRun] : [await secondRun, await firstRun];

      // The demotion succeeds either way: it does not depend on the proposal.
      expect(demotion.ok).toBe(true);
      expect(await roleOf(orgId, owner)).toBe('admin');
      if (first === 'demotion') {
        // The approval waited for the demotion and saw it: an admin may not override four-eyes, although the
        // approver entered the org as an owner. Nothing was posted and the proposal stays pending.
        expect(approval.ok).toBe(false);
        expect(approval.ok ? null : approval.error).toMatchObject({ code: 'FOUR_EYES_REQUIRED', status: 403 });
        expect(await documents(id)).toBe(0);
        expect(await proposalRow(id)).toEqual({ status: 'pending', revision: 2 });
        expect((await approvalAudit(id)).at(-1)).toMatchObject({ actor_id: owner, outcome: 'denied', detail: { code: 'FOUR_EYES_REQUIRED', rule: 'P10' } });
        // The remaining owner is an author too, so they may now approve, flagged.
        await approveAs(orgId, coOwner, id, 2);
        expect((await approvalAudit(id)).at(-1)).toMatchObject({ actor_id: coOwner, outcome: 'ok', detail: { policy: { P10: 'owner_override' } } });
      } else {
        // The approval held the member rows first: it decided on the owner role it held until it committed, and the
        // demotion waited for it.
        expect(approval.ok).toBe(true);
        expect((await approvalAudit(id)).at(-1)).toMatchObject({
          actor_id: owner,
          outcome: 'ok',
          detail: { policy: { P10: 'owner_override' }, self_approved: true, eligible_approvers: 2 },
        });
      }
      expect(await documents(id)).toBe(1);
      expect(await proposalRow(id)).toMatchObject({ status: 'executed' });
      await withAdmin(async (c) => {
        const { rows } = await c.query<{ detail: Record<string, unknown> }>(
          "SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member.change_role' AND outcome = 'ok' AND detail->>'target_user' = $2",
          [orgId, owner],
        );
        expect(rows.map((r) => r.detail)).toContainEqual(expect.objectContaining({ role: 'admin', previous_role: 'owner', changed: true }));
      });
    }
  });
});
