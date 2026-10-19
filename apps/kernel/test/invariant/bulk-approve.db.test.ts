// Bulk approval (issue #315) on a real PostgreSQL 17:
// - a batch never approves an item the caller could not approve alone: each item gets the same P12 eligibility and
//   P10 four-eyes decision, and the same refusal code, as kernel.proposal.approve on that item by itself, and only
//   the approved items are posted, each with its own approval audit row;
// - a stale or missing step-up (P11) refuses the whole batch before any item, a step-up that goes stale between two
//   items commits nothing, and a role that may not approve, or an AI agent, gets nothing approved either;
// - only listed per-proposal codes refuse one item; any other refusal aborts the whole batch;
// - a refused item gets its own denied/failed audit row (#429), the row a refused approval of it alone gets, linked
//   to the batch, and an aborted batch leaves no item rows; ctx.tryRun records only a refusal of a command it ran.
//   The row comes from a snapshot nobody can change after the catch; refusals about the actor, session, run or
//   request are never recovered; one tryRun at a time; and ctx.audit cannot set the runtime's keys of an ok row.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import { createExtractClient } from '@crove/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, fileKey, sha256Hex, type BlobStore, type CommandDef } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { sql } from 'kysely';
import { z } from 'zod';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('./fixtures/einvoice-basic.xml', import.meta.url));
const SESSION = '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c15';

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

type Role = 'admin' | 'member';
type Result = { id: string; outcome: 'approved' | 'refused'; code?: string; rule?: string | null };

const suite = ADMIN ? describe : describe.skip;

suite('bulk approval on PostgreSQL (#315)', () => {
  const dbName = `crove_test_bulk_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  let invoiceNo = 5000;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  // A second factor `ageSeconds` ago (P11 accepts 5 minutes).
  const asMfa = (userId: string, ageSeconds = 0) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: SESSION,
    mfaAt: Math.floor(Date.now() / 1000) - ageSeconds,
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

  async function orgWith(name: string, roles: Role[]) {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(db, { issuer: 'test', subject: `owner-${tag}`, email: `owner-${tag}@example.com`, name: null });
    const orgId = (await createOrg(runtime, asUser(owner), `${name} ${tag}`)).orgId;
    const people: string[] = [];
    for (const [i, role] of roles.entries()) {
      const email = `${role}${i}-${tag}@example.com`;
      const person = await upsertIdentity(db, { issuer: 'test', subject: `${role}${i}-${tag}`, email, name: null });
      const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role }, { actor: asMfa(owner), orgId });
      await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(person) });
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
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(uploader), orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-16' }, orgId, fileId);
    if (!proposalId) throw new Error('no proposal');
    return proposalId;
  }

  // A new revision authored by the editor: the first line moves to another expense account.
  async function editAs(orgId: string, userId: string, id: string): Promise<number> {
    const detail = await runtime.query<{ revision: number; payload: { lines: Array<{ lineNo: number; debitAccount: string }> } }>(
      'kernel.inbox.get',
      { id },
      { actor: asUser(userId), orgId },
    );
    const line = detail.payload.lines[0] as { lineNo: number; debitAccount: string };
    const lineAccounts = [{ lineNo: line.lineNo, debitAccount: line.debitAccount === '6421' ? '6422' : '6421' }];
    const { revision } = await runtime.execute<{ revision: number }>('kernel.proposal.edit', { id, revision: detail.revision, lineAccounts }, { actor: asUser(userId), orgId });
    return revision;
  }

  const bulk = (orgId: string, actor: ReturnType<typeof asMfa> | ReturnType<typeof asUser>, items: Array<{ id: string; revision: number }>) =>
    runtime.execute<{ results: Result[] }>('kernel.proposal.approve_many', { items }, { actor, orgId });

  async function refusalOf(promise: Promise<unknown>): Promise<{ code: string | undefined; status: number | undefined }> {
    try {
      await promise;
    } catch (error) {
      const e = error as { code?: string; status?: number };
      return { code: e.code, status: e.status };
    }
    throw new Error('expected a refusal');
  }

  const proposalState = (id: string) =>
    withAdmin(async (a) => {
      const row = (await a.query<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE id = $1', [id])).rows[0];
      const docs = (await a.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_finance.purchase_document WHERE proposal_id = $1', [id])).rows[0];
      const approvals = await a.query<{ actor_id: string; outcome: string; detail: Record<string, unknown> }>(
        "SELECT actor_id, outcome, detail FROM crove_kernel.audit_event WHERE command = 'kernel.proposal.approve' AND target_id = $1 AND outcome = 'ok'",
        [id],
      );
      return { status: row?.status, documents: docs?.n ?? 0, approvals: approvals.rows };
    });

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

  it('never approves an item the caller could not approve alone, and approves the rest, each on its own audit row', async () => {
    const { orgId, owner, people } = await orgWith('Bulk', ['admin', 'member']);
    const [admin, member] = people as [string, string];
    const other = await orgWith('Bulk other', []);
    // The admin uploaded `own`: with the owner also eligible, four-eyes (P10) refuses the admin.
    const own = await proposeIn(orgId, admin);
    const fine = await proposeIn(orgId, owner);
    // Edited since the caller saw revision 1.
    const edited = await proposeIn(orgId, owner);
    expect(await editAs(orgId, owner, edited)).toBe(2);
    const foreign = await proposeIn(other.orgId, other.owner);
    const items = [
      { id: own, revision: 1 },
      { id: fine, revision: 1 },
      { id: edited, revision: 1 },
      { id: foreign, revision: 1 },
    ];

    // A member may not approve, so a member's batch approves nothing.
    expect(await refusalOf(bulk(orgId, asMfa(member), items))).toEqual({ code: 'FORBIDDEN', status: 403 });
    for (const id of [own, fine, edited]) expect((await proposalState(id)).status).toBe('pending');

    const { results } = await bulk(orgId, asMfa(admin), items);
    expect(results.map((r) => [r.id, r.outcome, r.code ?? null])).toEqual([
      [own, 'refused', 'FOUR_EYES_REQUIRED'],
      [fine, 'approved', null],
      [edited, 'refused', 'STALE_REVISION'],
      // Another org's proposal reads like one that does not exist.
      [foreign, 'refused', 'NOT_FOUND'],
    ]);
    expect(results[0]).toMatchObject({ rule: 'P10' });

    // Only the approved item is posted, with its own approval row; the refused ones are untouched.
    expect(await proposalState(fine)).toMatchObject({ status: 'executed', documents: 1, approvals: [expect.objectContaining({ actor_id: admin })] });
    for (const id of [own, edited]) expect(await proposalState(id)).toEqual({ status: 'pending', documents: 0, approvals: [] });
    expect(await proposalState(foreign)).toEqual({ status: 'pending', documents: 0, approvals: [] });

    // Alone, each refused item gets the same answer, so the batch is never more permissive.
    expect(await refusalOf(runtime.execute('kernel.proposal.approve', { id: own, revision: 1 }, { actor: asMfa(admin), orgId }))).toEqual({
      code: 'FOUR_EYES_REQUIRED',
      status: 403,
    });
    expect(await refusalOf(runtime.execute('kernel.proposal.approve', { id: edited, revision: 1 }, { actor: asMfa(admin), orgId }))).toEqual({
      code: 'STALE_REVISION',
      status: 409,
    });
    expect(await refusalOf(runtime.execute('kernel.proposal.approve', { id: foreign, revision: 1 }, { actor: asMfa(admin), orgId }))).toEqual({
      code: 'NOT_FOUND',
      status: 404,
    });

    // The batch's own audit row lists every item's outcome.
    const batch = await withAdmin(
      async (a) =>
        (
          await a.query<{ outcome: string; detail: { approved: number; refused: number; items: Array<{ id: string; outcome: string; code?: string }> } }>(
            "SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.proposal.approve_many' AND outcome = 'ok'",
            [orgId],
          )
        ).rows,
    );
    expect(batch).toHaveLength(1);
    expect(batch[0]?.detail).toMatchObject({ approved: 1, refused: 3 });
    expect(batch[0]?.detail.items.map((i) => [i.id, i.outcome, i.code ?? null])).toEqual(results.map((r) => [r.id, r.outcome, r.code ?? null]));

    // A proposal approved already is decided: a second batch refuses it.
    const again = await bulk(orgId, asMfa(owner), [{ id: fine, revision: 1 }]);
    expect(again.results).toEqual([{ id: fine, outcome: 'refused', code: 'PROPOSAL_DECIDED', rule: null }]);
  });

  it('refuses the whole batch when the step-up is stale or missing (P11)', async () => {
    const { orgId, owner, people } = await orgWith('Bulk step-up', ['admin']);
    const admin = people[0] as string;
    const a = await proposeIn(orgId, owner);
    const b = await proposeIn(orgId, owner);
    const items = [
      { id: a, revision: 1 },
      { id: b, revision: 1 },
    ];
    // Ten minutes after the second factor, and with no second factor at all.
    expect(await refusalOf(bulk(orgId, asMfa(admin, 600), items))).toEqual({ code: 'STEP_UP_REQUIRED', status: 403 });
    expect(await refusalOf(bulk(orgId, asUser(admin), items))).toEqual({ code: 'STEP_UP_REQUIRED', status: 403 });
    for (const id of [a, b]) expect(await proposalState(id)).toEqual({ status: 'pending', documents: 0, approvals: [] });

    // One fresh step-up covers the batch; each approval records the assurance it used.
    const { results } = await bulk(orgId, asMfa(admin, 30), items);
    expect(results.map((r) => r.outcome)).toEqual(['approved', 'approved']);
    for (const id of [a, b]) {
      const state = await proposalState(id);
      expect(state).toMatchObject({ status: 'executed', documents: 1 });
      expect(state.approvals).toEqual([expect.objectContaining({ actor_id: admin, detail: expect.objectContaining({ aal: 'aal2', sessionId: SESSION }) })]);
    }
  });

  it('commits nothing when the step-up goes stale between two items (P11)', async () => {
    const { orgId, owner, people } = await orgWith('Bulk stale midway', ['admin']);
    const admin = people[0] as string;
    const items = [
      { id: await proposeIn(orgId, owner), revision: 1 },
      { id: await proposeIn(orgId, owner), revision: 1 },
    ];
    // The clock moves past the 5-minute window right after the first item is posted.
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    const skewing = ([...kernelCommands, ...financeCommands] as CommandDef<unknown, unknown>[]).map(
      (def): CommandDef<unknown, unknown> =>
        def.name === 'finance.purchase.record'
          ? {
              ...def,
              handler: async (ctx, input) => {
                const out = await def.handler(ctx, input);
                skewMs = 400_000;
                return out;
              },
            }
          : def,
    );
    const clocked = new Runtime(db).register({ commands: skewing, queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
    try {
      expect(await refusalOf(clocked.execute('kernel.proposal.approve_many', { items }, { actor: asMfa(admin, 30), orgId }))).toEqual({
        code: 'STEP_UP_REQUIRED',
        status: 403,
      });
      // The first item really was posted inside the batch before the clock moved.
      expect(skewMs).toBe(400_000);
    } finally {
      now.mockRestore();
    }
    for (const { id } of items) expect(await proposalState(id)).toEqual({ status: 'pending', documents: 0, approvals: [] });
  });

  it('aborts the whole batch on a refusal that is not a per-proposal code', async () => {
    const { orgId, owner } = await orgWith('Bulk abort', []);
    const fine = await proposeIn(orgId, owner);
    const odd = await proposeIn(orgId, owner);
    // A proposal of a command the kernel does not approve: approving it alone is FORBIDDEN (403), which is not an
    // item refusal, so the batch posts nothing, not even the proposal that would pass alone.
    await withAdmin(async (a) => {
      await a.query('SET session_replication_role = replica');
      await a.query("UPDATE crove_kernel.proposal SET command = 'test.unsupported' WHERE id = $1", [odd]);
    });
    const items = [
      { id: fine, revision: 1 },
      { id: odd, revision: 1 },
    ];
    expect(await refusalOf(bulk(orgId, asMfa(owner), items))).toEqual({ code: 'FORBIDDEN', status: 403 });
    expect(await proposalState(fine)).toEqual({ status: 'pending', documents: 0, approvals: [] });
    expect(await proposalState(odd)).toEqual({ status: 'pending', documents: 0, approvals: [] });
    // Alone, the good one still goes through.
    expect((await bulk(orgId, asMfa(owner), [{ id: fine, revision: 1 }])).results).toEqual([expect.objectContaining({ id: fine, outcome: 'approved' })]);
  });

  it('refuses an AI agent, which never approves (P05)', async () => {
    const { orgId, owner } = await orgWith('Bulk agent', []);
    const id = await proposeIn(orgId, owner);
    const { agentId, positionId } = await runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(owner), orgId },
    );
    await runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const started = await workerRuntime.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, {
      actor: { type: 'system', component: 'kernel.agent' },
      orgId,
    });
    if (!started.runId) throw new Error('no run');
    const agent = { type: 'agent' as const, agentId, runId: started.runId };
    expect(await refusalOf(runtime.execute('kernel.proposal.approve_many', { items: [{ id, revision: 1 }] }, { actor: agent, orgId }))).toEqual({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(await proposalState(id)).toEqual({ status: 'pending', documents: 0, approvals: [] });
  });

  // Audit rows of `command` in the org, oldest first.
  const auditRows = (orgId: string, command: string) =>
    withAdmin(
      async (a) =>
        (
          await a.query<{
            actor_type: string;
            actor_id: string | null;
            command_id: string;
            outcome: string;
            target_type: string | null;
            target_id: string | null;
            input_sha256: string;
            proposal_id: string | null;
            detail: Record<string, unknown>;
          }>(
            'SELECT actor_type, actor_id, command_id, outcome, target_type, target_id, input_sha256, proposal_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id',
            [orgId, command],
          )
        ).rows,
    );

  it('gives each refused item its own audit row, the one a refused approval of it alone gets, linked to the batch (#429)', async () => {
    const { orgId, owner, people } = await orgWith('Bulk audit', ['admin']);
    const admin = people[0] as string;
    const other = await orgWith('Bulk audit other', []);
    const own = await proposeIn(orgId, admin);
    const fine = await proposeIn(orgId, owner);
    const edited = await proposeIn(orgId, owner);
    expect(await editAs(orgId, owner, edited)).toBe(2);
    const foreign = await proposeIn(other.orgId, other.owner);
    const actor = asMfa(admin);
    const { results } = await bulk(orgId, actor, [
      { id: own, revision: 1 },
      { id: fine, revision: 1 },
      { id: edited, revision: 1 },
      { id: foreign, revision: 1 },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['refused', 'approved', 'refused', 'refused']);
    const [batch] = await auditRows(orgId, 'kernel.proposal.approve_many');
    expect(batch?.outcome).toBe('ok');
    const inBatch = await auditRows(orgId, 'kernel.proposal.approve');
    const link = { parentCommand: 'kernel.proposal.approve_many', parentCommandId: batch?.command_id };
    const session = { aal: 'aal2', sessionId: SESSION, mfaAt: actor.mfaAt };
    const rowsOf = (id: string) => inBatch.filter((r) => r.target_id === id);
    // 403 is denied; 409 and 404 are failed, as for a refused top-level command.
    for (const [id, outcome, code, rule] of [
      [own, 'denied', 'FOUR_EYES_REQUIRED', 'P10'],
      [edited, 'failed', 'STALE_REVISION', null],
      [foreign, 'failed', 'NOT_FOUND', null],
    ] as const) {
      const rows = rowsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_type: 'user', actor_id: admin, outcome, target_type: 'kernel.proposal', target_id: id, proposal_id: null });
      expect(rows[0]?.detail).toEqual({ code, ...(rule ? { rule } : {}), ...session, ...link });
      expect(rows[0]?.command_id).not.toBe(batch?.command_id);
    }
    // The approved item has its own ok row only, and that row carries no link.
    expect(rowsOf(fine).map((r) => r.outcome)).toEqual(['ok']);
    expect(rowsOf(fine)[0]?.detail).not.toHaveProperty('parentCommandId');

    // The same approval alone, refused, writes the same row but for the link.
    for (const id of [own, edited, foreign]) {
      await refusalOf(runtime.execute('kernel.proposal.approve', { id, revision: 1 }, { actor, orgId }));
      const [nested, alone] = (await auditRows(orgId, 'kernel.proposal.approve')).filter((r) => r.target_id === id);
      expect(alone).toBeDefined();
      const { parentCommand, parentCommandId, ...nestedDetail } = nested?.detail ?? {};
      expect([parentCommand, parentCommandId]).toEqual([link.parentCommand, link.parentCommandId]);
      expect(alone?.detail).toEqual(nestedDetail);
      for (const key of ['actor_type', 'actor_id', 'outcome', 'target_type', 'target_id', 'input_sha256', 'proposal_id'] as const) {
        expect(alone?.[key]).toEqual(nested?.[key]);
      }
    }
  });

  it('leaves no item audit rows when the whole batch aborts; the batch refusal row records it (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit abort', []);
    // The batch runs items in id order: the stale one first (refused, recorded), then one that aborts the batch.
    const [first, second] = [await proposeIn(orgId, owner), await proposeIn(orgId, owner)].sort();
    const stale = first as string;
    const odd = second as string;
    expect(await editAs(orgId, owner, stale)).toBe(2);
    await withAdmin(async (a) => {
      await a.query('SET session_replication_role = replica');
      await a.query("UPDATE crove_kernel.proposal SET command = 'test.unsupported' WHERE id = $1", [odd]);
    });
    const items = [
      { id: stale, revision: 1 },
      { id: odd, revision: 1 },
    ];
    expect(await refusalOf(bulk(orgId, asMfa(owner), items))).toEqual({ code: 'FORBIDDEN', status: 403 });
    expect((await auditRows(orgId, 'kernel.proposal.approve')).filter((r) => r.target_id === stale || r.target_id === odd)).toEqual([]);
    const batch = await auditRows(orgId, 'kernel.proposal.approve_many');
    expect(batch.map((r) => [r.outcome, r.detail.code])).toEqual([['denied', 'FORBIDDEN']]);
    expect(batch[0]?.detail).not.toHaveProperty('parentCommandId');
    // Alone, the stale item is still refused, so it would have been recorded had the batch committed.
    expect((await bulk(orgId, asMfa(owner), [{ id: stale, revision: 1 }])).results).toEqual([{ id: stale, outcome: 'refused', code: 'STALE_REVISION', rule: null }]);
    expect((await auditRows(orgId, 'kernel.proposal.approve')).filter((r) => r.target_id === stale).map((r) => r.outcome)).toEqual(['failed']);
  });

  it('records through ctx.tryRun only a refusal of a command it ran, with the runtime keys, never a forged row (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit forge', []);
    const FORGED = randomUUID();
    const zThing = z.object({ id: z.string().uuid() });
    const target = (input: { id: string }) => ({ type: 'test.thing', id: input.id });
    const refuse = defineCommand({
      name: 'test.refuse',
      input: zThing,
      risk: 'R1',
      access: ['owner'],
      target,
      handler: async () => {
        // Audit facts that try to set the keys only the runtime writes.
        throw new DomainError('NOT_FOUND', 404, 'x', { rule: 'T1' }, { audit: { note: 'kept', code: 'FORGED', parentCommand: 'forged', parentCommandId: FORGED } });
      },
    });
    const unauthenticated = defineCommand({
      name: 'test.unauthenticated',
      input: zThing,
      risk: 'R1',
      access: ['owner'],
      target,
      handler: async () => {
        throw new DomainError('UNAUTHENTICATED', 401, 'x');
      },
    });
    const fine = defineCommand({ name: 'test.fine', input: zThing, risk: 'R1', access: ['owner'], target, handler: async () => ({ done: true }) });
    const codeOf = async (attempt: Promise<unknown>) => {
      try {
        await attempt;
        return 'none';
      } catch (error) {
        return error instanceof DomainError ? error.code : 'other';
      }
    };
    const forge = defineCommand({
      name: 'test.forge',
      input: zThing,
      risk: 'R1',
      access: ['owner'],
      handler: async (ctx, input) => {
        const always = { recover: () => true };
        return {
          // A command that does not exist, an input that does not parse (a 422) and a status a refusal is never
          // audited for: thrown to the caller and nothing recorded, though `recover` accepts everything.
          missing: await codeOf(ctx.tryRun('test.missing', input, always)),
          invalid: await codeOf(ctx.tryRun('test.refuse', { id: 'not-a-uuid' }, always)),
          unauthenticated: await codeOf(ctx.tryRun('test.unauthenticated', input, always)),
          // A refusal `recover` does not accept propagates, unrecorded.
          declined: await codeOf(ctx.tryRun('test.refuse', input, { recover: () => false })),
          fine: (await ctx.tryRun('test.fine', input, always)).status,
          refused: await ctx.tryRun('test.refuse', input, always).then((r) => (r.status === 'refused' ? r.refusal.code : r.status)),
        };
      },
    });
    const forging = new Runtime(db).register({
      commands: [...kernelCommands, ...financeCommands, refuse, unauthenticated, fine, forge],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
    });
    const id = randomUUID();
    expect(await forging.execute('test.forge', { id }, { actor: asUser(owner), orgId })).toEqual({
      missing: 'COMMAND_NOT_FOUND',
      invalid: 'VALIDATION',
      unauthenticated: 'UNAUTHENTICATED',
      declined: 'NOT_FOUND',
      fine: 'ok',
      refused: 'NOT_FOUND',
    });
    const [parent] = await auditRows(orgId, 'test.forge');
    expect(parent?.outcome).toBe('ok');
    expect(await auditRows(orgId, 'test.missing')).toEqual([]);
    expect(await auditRows(orgId, 'test.unauthenticated')).toEqual([]);
    expect((await auditRows(orgId, 'test.fine')).map((r) => [r.outcome, r.target_id])).toEqual([['ok', id]]);
    // One row, for the one refusal tryRun caught and recovered: failed (404), never ok, with the runtime's keys.
    const refused = await auditRows(orgId, 'test.refuse');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ outcome: 'failed', actor_id: owner, target_type: 'test.thing', target_id: id, proposal_id: null });
    expect(refused[0]?.detail).toEqual({
      note: 'kept',
      code: 'NOT_FOUND',
      rule: 'T1',
      aal: 'aal1',
      sessionId: null,
      mfaAt: null,
      parentCommand: 'test.forge',
      parentCommandId: parent?.command_id,
    });
  });

  // Test commands for ctx.tryRun's guarantees (#429 review), run by the org's owner.
  const zThingInput = z.object({ id: z.string().uuid() });
  const thingTarget = (input: { id: string }) => ({ type: 'test.thing', id: input.id });
  const ownerCommand = <O>(name: string, handler: CommandDef<{ id: string }, O>['handler'], risk: 'R1' | 'R3' = 'R1') =>
    defineCommand({ name, input: zThingInput, risk, access: ['owner'], target: thingTarget, handler });
  const fineCommand = ownerCommand('test.fine', async () => ({ done: true }));
  const runtimeWith = (...commands: CommandDef<any, any>[]) =>
    new Runtime(db).register({
      commands: [...kernelCommands, ...financeCommands, ...commands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
    });
  // Tries every way to change a refusal; each try may throw (the copy ctx.tryRun hands out is frozen).
  const tamper = (error: DomainError) => {
    const attempts = [
      () => ((error.details as Record<string, unknown>).rule = 'P12'),
      () => ((error.audit as Record<string, unknown>).note = 'forged'),
      () => ((error as { code: string }).code = 'FORGED'),
      () => ((error as { status: number }).status = 403),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch {
        // frozen
      }
    }
  };

  it('writes the refusal row from a snapshot taken when it was caught: recover, the caller and the nested handler cannot change it (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit snapshot', []);
    let kept: DomainError | null = null;
    const mutable = ownerCommand('test.mutable', async (_ctx, input) => {
      // The nested handler changes its input, then keeps the error it throws to change it later.
      (input as { id: string }).id = randomUUID();
      kept = new DomainError('NOT_FOUND', 404, 'x', { rule: 'T1' }, { audit: { note: 'kept' } });
      throw kept;
    });
    const mutate = ownerCommand('test.mutate', async (ctx, input) => {
      const attempt = await ctx.tryRun('test.mutable', input, {
        recover: (refusal) => {
          tamper(refusal);
          return true;
        },
      });
      if (attempt.status !== 'refused') throw new Error('expected a refusal');
      tamper(attempt.refusal);
      if (kept) tamper(kept);
      const { refusal } = attempt;
      return { code: refusal.code, status: refusal.status, rule: refusal.details?.rule, note: refusal.audit?.note, frozen: Object.isFrozen(refusal) };
    });
    const id = randomUUID();
    expect(await runtimeWith(mutable, mutate).execute('test.mutate', { id }, { actor: asUser(owner), orgId })).toEqual({
      code: 'NOT_FOUND',
      status: 404,
      rule: 'T1',
      note: 'kept',
      frozen: true,
    });
    // The original error did change; the row did not.
    expect((kept as DomainError | null)?.code).toBe('FORGED');
    const [parent] = await auditRows(orgId, 'test.mutate');
    const rows = await auditRows(orgId, 'test.mutable');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'failed', target_type: 'test.thing', target_id: id, input_sha256: sha256Hex(JSON.stringify({ id })) });
    expect(rows[0]?.detail).toEqual({
      note: 'kept',
      code: 'NOT_FOUND',
      rule: 'T1',
      aal: 'aal1',
      sessionId: null,
      mfaAt: null,
      parentCommand: 'test.mutate',
      parentCommandId: parent?.command_id,
    });
  });

  it('never recovers a refusal about the actor, the session, the run or the request, whatever recover says (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit never', []);
    const zCoded = z.object({ id: z.string().uuid(), code: z.string(), status: z.union([z.literal(403), z.literal(409), z.literal(422)]) });
    const coded = defineCommand({
      name: 'test.coded',
      input: zCoded,
      risk: 'R1',
      access: ['owner'],
      target: thingTarget,
      handler: async (_ctx, input) => {
        throw new DomainError(input.code, input.status, 'x');
      },
    });
    const never: Array<[string, 403 | 409 | 422]> = [
      ['STEP_UP_REQUIRED', 403],
      ['NOT_A_MEMBER', 403],
      ['USER_DISABLED', 403],
      ['KILL_SWITCH_ON', 403],
      ['AGENT_FORBIDDEN', 403],
      ['AGENT_SOMETHING_NEW', 409],
      ['SESSION_REVOKED_IN_ORG', 403],
      ['RETRY', 409],
      ['LEASE_LOST', 409],
      ['IDEMPOTENCY_MISMATCH', 422],
      ['BUDGET_EXHAUSTED', 409],
      ['ORG_CLOSED', 409],
    ];
    let asked = 0;
    const probe = ownerCommand('test.never', async (ctx, input) => {
      const thrown: string[] = [];
      for (const [code, status] of never) {
        try {
          await ctx.tryRun('test.coded', { id: input.id, code, status }, {
            recover: () => {
              asked += 1;
              return true;
            },
          });
          thrown.push('recovered');
        } catch (error) {
          thrown.push(error instanceof DomainError ? error.code : 'other');
        }
      }
      // An item refusal is still recovered.
      const item = await ctx.tryRun('test.coded', { id: input.id, code: 'NOT_ELIGIBLE', status: 403 }, { recover: () => true });
      return { thrown, item: item.status };
    });
    const id = randomUUID();
    expect(await runtimeWith(coded, probe).execute('test.never', { id }, { actor: asUser(owner), orgId })).toEqual({
      thrown: never.map(([code]) => code),
      item: 'refused',
    });
    expect(asked).toBe(0);
    expect((await auditRows(orgId, 'test.coded')).map((r) => [r.outcome, r.detail.code])).toEqual([['denied', 'NOT_ELIGIBLE']]);
  });

  it('rolls the nested command back on every path but success, also when the caller catches and goes on (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit discard', []);
    const zWrite = z.object({ id: z.string().uuid(), fail: z.enum(['declined', 'never', 'sql']) });
    const writesThenFails = defineCommand({
      name: 'test.writes_then_fails',
      input: zWrite,
      risk: 'R1',
      access: ['owner'],
      target: thingTarget,
      handler: async (ctx, input) => {
        await ctx.activity('test.thing', input.id, 'test.written', 'written before the failure');
        if (input.fail === 'sql') await sql`SELECT 1 / 0`.execute(ctx.trx);
        throw new DomainError(input.fail === 'never' ? 'STEP_UP_REQUIRED' : 'NOT_ELIGIBLE', 403, 'x');
      },
    });
    const caller = ownerCommand('test.catches', async (ctx, input) => {
      const thrown: string[] = [];
      for (const fail of ['declined', 'never', 'sql'] as const) {
        try {
          await ctx.tryRun('test.writes_then_fails', { id: input.id, fail }, { recover: () => fail !== 'declined' });
        } catch (error) {
          thrown.push(error instanceof DomainError ? error.code : String((error as { code?: unknown }).code));
        }
      }
      // The transaction is still usable after the database error.
      const { rows } = await sql<{ one: number }>`SELECT 1 AS one`.execute(ctx.trx);
      return { thrown, usable: rows[0]?.one === 1 };
    });
    const id = randomUUID();
    expect(await runtimeWith(writesThenFails, caller).execute('test.catches', { id }, { actor: asUser(owner), orgId })).toEqual({
      thrown: ['NOT_ELIGIBLE', 'STEP_UP_REQUIRED', '22012'],
      usable: true,
    });
    const activity = await withAdmin(
      async (a) => (await a.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2', [orgId, id])).rows[0]?.n,
    );
    expect(activity).toBe(0);
    expect(await auditRows(orgId, 'test.writes_then_fails')).toEqual([]);
  });

  it('rolls the nested command back when recover throws (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit recover throws', []);
    const writes = ownerCommand('test.writes', async (ctx, input) => {
      await ctx.activity('test.thing', input.id, 'test.written', 'written before the refusal');
      throw new DomainError('NOT_ELIGIBLE', 403, 'x');
    });
    const caller = ownerCommand('test.recover_throws', async (ctx, input) => {
      try {
        await ctx.tryRun('test.writes', input, {
          recover: () => {
            throw new Error('recover failed');
          },
        });
        return { thrown: null };
      } catch (error) {
        return { thrown: (error as Error).message };
      }
    });
    const id = randomUUID();
    expect(await runtimeWith(writes, caller).execute('test.recover_throws', { id }, { actor: asUser(owner), orgId })).toEqual({ thrown: 'recover failed' });
    const activity = await withAdmin(
      async (a) => (await a.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2', [orgId, id])).rows[0]?.n,
    );
    expect(activity).toBe(0);
    expect(await auditRows(orgId, 'test.writes')).toEqual([]);
  });

  it('runs one tryRun at a time per command, and fails a command that returns while one runs (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit in flight', []);
    const always = { recover: () => true };
    const parallel = ownerCommand('test.parallel', async (ctx, input) => {
      const settled = await Promise.allSettled([ctx.tryRun('test.fine', input, always), ctx.tryRun('test.fine', input, always)]);
      // After an awaited one, the next one runs.
      const next = await ctx.tryRun('test.fine', input, always);
      return { settled: settled.map((s) => s.status), next: next.status };
    });
    const dangling = ownerCommand('test.dangling', async (ctx, input) => {
      void ctx.tryRun('test.fine', input, always).catch(() => undefined);
      return { returned: true };
    });
    const forking = runtimeWith(fineCommand, parallel, dangling);
    const id = randomUUID();
    expect(await forking.execute('test.parallel', { id }, { actor: asUser(owner), orgId })).toEqual({ settled: ['fulfilled', 'rejected'], next: 'ok' });
    expect((await auditRows(orgId, 'test.fine')).map((r) => r.outcome)).toEqual(['ok', 'ok']);
    expect(await refusalOf(forking.execute('test.dangling', { id }, { actor: asUser(owner), orgId }))).toEqual({ code: 'INTERNAL', status: 500 });
    expect(await auditRows(orgId, 'test.dangling')).toEqual([]);
    expect((await auditRows(orgId, 'test.fine')).map((r) => r.outcome)).toEqual(['ok', 'ok']);
  });

  it('still records a refusal whose facts have no JSON form (a cycle, a BigInt), without them, and rolls it back (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit unserializable', []);
    const cyclic: Record<string, unknown> = { note: 'cyclic' };
    cyclic.self = cyclic;
    const zKind = z.object({ id: z.string().uuid(), kind: z.enum(['cycle', 'bigint']) });
    const odd = defineCommand({
      name: 'test.odd_facts',
      input: zKind,
      risk: 'R1',
      access: ['owner'],
      target: thingTarget,
      handler: async (ctx, input) => {
        await ctx.activity('test.thing', input.id, 'test.written', 'written before the refusal');
        const facts = input.kind === 'cycle' ? cyclic : { amount: 10n };
        throw new DomainError('NOT_ELIGIBLE', 403, 'x', { rule: 'T1', ...(input.kind === 'bigint' ? { big: 1n } : {}) }, { audit: facts });
      },
    });
    const caller = ownerCommand('test.odd_caller', async (ctx, input) => {
      const seen: unknown[] = [];
      for (const kind of ['cycle', 'bigint'] as const) {
        const attempt = await ctx.tryRun('test.odd_facts', { id: input.id, kind }, { recover: () => true });
        if (attempt.status !== 'refused') throw new Error('expected a refusal');
        seen.push({ code: attempt.refusal.code, rule: attempt.refusal.details?.rule, audit: attempt.refusal.audit ?? null });
      }
      return { seen };
    });
    const id = randomUUID();
    expect(await runtimeWith(odd, caller).execute('test.odd_caller', { id }, { actor: asUser(owner), orgId })).toEqual({
      seen: [
        { code: 'NOT_ELIGIBLE', rule: 'T1', audit: null },
        { code: 'NOT_ELIGIBLE', rule: 'T1', audit: null },
      ],
    });
    const [parent] = await auditRows(orgId, 'test.odd_caller');
    const rows = await auditRows(orgId, 'test.odd_facts');
    expect(rows.map((r) => r.detail)).toEqual(
      ['cycle', 'bigint'].map(() => ({
        code: 'NOT_ELIGIBLE',
        rule: 'T1',
        aal: 'aal1',
        sessionId: null,
        mfaAt: null,
        parentCommand: 'test.odd_caller',
        parentCommandId: parent?.command_id,
      })),
    );
    const activity = await withAdmin(
      async (a) => (await a.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2', [orgId, id])).rows[0]?.n,
    );
    expect(activity).toBe(0);
  });

  it('closes the context when the handler returns: work it left running cannot write, run or roll back (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit closed', []);
    const refuses = ownerCommand('test.late_refuses', async () => {
      throw new DomainError('NOT_ELIGIBLE', 403, 'x');
    });
    let late: Promise<string[]> = Promise.resolve([]);
    const leaves = ownerCommand('test.leaves_work', async (ctx, input) => {
      late = (async () => {
        // Starts after the handler returned, while the runtime writes this command's rows.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const refused: string[] = [];
        const calls: Array<() => Promise<unknown>> = [
          () => ctx.tryRun('test.late_refuses', input, { recover: () => true }),
          () => ctx.run('test.fine', input),
          () => ctx.activity('test.thing', input.id, 'test.late', 'late'),
          () => ctx.emit('test.late', {}),
          async () => ctx.audit({ late: true }),
        ];
        for (const call of calls) {
          try {
            await call();
            refused.push('ran');
          } catch (error) {
            refused.push(/after the handler returned/.test((error as Error).message) ? 'closed' : 'other');
          }
        }
        return refused;
      })();
      return { returned: true };
    });
    const id = randomUUID();
    expect(await runtimeWith(fineCommand, refuses, leaves).execute('test.leaves_work', { id }, { actor: asUser(owner), orgId })).toEqual({ returned: true });
    expect(await late).toEqual(['closed', 'closed', 'closed', 'closed', 'closed']);
    // The command's own ok row committed, untouched; nothing the late work tried is there.
    expect((await auditRows(orgId, 'test.leaves_work')).map((r) => [r.outcome, r.detail])).toEqual([['ok', {}]]);
    expect(await auditRows(orgId, 'test.late_refuses')).toEqual([]);
    expect(await auditRows(orgId, 'test.fine')).toEqual([]);
  });

  it('fails a command whose handler returned while a ctx.run it started still ran, with nothing written (#429)', async () => {
    const { orgId, owner } = await orgWith('Bulk audit unawaited run', []);
    const refuses = ownerCommand('test.late_refuses', async () => {
      throw new DomainError('NOT_ELIGIBLE', 403, 'x');
    });
    // Like approve_many: a recovered refusal rolls back to its savepoint.
    const batchlike = ownerCommand('test.batchlike', async (ctx, input) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const attempt = await ctx.tryRun('test.late_refuses', input, { recover: () => true });
      return { status: attempt.status };
    });
    const fires = ownerCommand('test.fires_batch', async (ctx, input) => {
      await ctx.activity('test.thing', input.id, 'test.before', 'written before the unawaited run');
      void ctx.run('test.batchlike', input).catch(() => undefined);
      return { returned: true };
    });
    let mixed: string | null = null;
    const mixes = ownerCommand('test.mixes', async (ctx, input) => {
      const run = ctx.run('test.fine', input);
      // A tryRun never runs beside another nested command: its rollback would undo that one's writes.
      mixed = await ctx.tryRun('test.late_refuses', input, { recover: () => true }).then(
        () => 'ran',
        (error: Error) => error.message,
      );
      await run;
      return { done: true };
    });
    const forking = runtimeWith(fineCommand, refuses, batchlike, fires, mixes);
    const id = randomUUID();
    expect(await refusalOf(forking.execute('test.fires_batch', { id }, { actor: asUser(owner), orgId }))).toEqual({ code: 'INTERNAL', status: 500 });
    for (const command of ['test.fires_batch', 'test.batchlike', 'test.late_refuses']) expect(await auditRows(orgId, command)).toEqual([]);
    const activity = await withAdmin(
      async (a) => (await a.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2', [orgId, id])).rows[0]?.n,
    );
    expect(activity).toBe(0);

    expect(await forking.execute('test.mixes', { id }, { actor: asUser(owner), orgId })).toEqual({ done: true });
    expect(mixed).toMatch(/ctx\.tryRun runs only while no other nested command runs/);
    expect((await auditRows(orgId, 'test.fine')).map((r) => r.outcome)).toEqual(['ok']);
    expect(await auditRows(orgId, 'test.late_refuses')).toEqual([]);
  });

  it("keeps the runtime's keys on an ok row: ctx.audit sets no refusal link and does not replace the assurance (#429)", async () => {
    const { orgId, owner } = await orgWith('Bulk audit ok keys', []);
    const forged = ownerCommand(
      'test.ok_forge',
      async (ctx) => {
        ctx.audit({ parentCommand: 'forged', parentCommandId: randomUUID(), aal: 'aal1', sessionId: 'forged', mfaAt: 1, note: 'kept' });
        return { done: true };
      },
      'R3',
    );
    const actor = asMfa(owner);
    await runtimeWith(forged).execute('test.ok_forge', { id: randomUUID() }, { actor, orgId });
    const rows = await auditRows(orgId, 'test.ok_forge');
    expect(rows.map((r) => r.detail)).toEqual([{ note: 'kept', aal: 'aal2', sessionId: SESSION, mfaAt: actor.mfaAt }]);
  });
});
