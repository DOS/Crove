// Bulk approval (issue #315) on a real PostgreSQL 17:
// - a batch never approves an item the caller could not approve alone: each item gets the same P12 eligibility and
//   P10 four-eyes decision, and the same refusal code, as kernel.proposal.approve on that item by itself, and only
//   the approved items are posted, each with its own approval audit row;
// - a stale or missing step-up (P11) refuses the whole batch before any item, and a role that may not approve gets
//   nothing approved either.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import { createExtractClient } from '@crove/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';

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
});
