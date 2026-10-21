// Bulk approval through /api/rpc (issue #315) on a real PostgreSQL 17: the route's input limits, the step-up and role
// answers, the per-item result, the idempotency replay and each proposal's own audit history (#429). The policy
// itself is pinned in test/invariant/bulk-approve.db.test.ts.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import { createExtractClient } from '@crove/extract-contract';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-bulk-approve-0123456789';
const ISSUER = 'crove-auth';
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

type Who = 'owner' | 'admin' | 'member';
interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

suite('bulk approval through the API (#315)', () => {
  const dbName = `crove_test_bulk_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  const store = new MemoryStore();
  let invoiceNo = 7000;
  let adminUrl = '';
  const accounts = Object.fromEntries(
    (['owner', 'admin', 'member'] as const).map((who) => [who, { subject: randomUUID(), email: `${who}@bulk-api.test`, session: randomUUID(), userId: '' }]),
  ) as Record<Who, Account>;
  let slug = '';
  let orgId = '';

  async function tokenFor(who: Who, mfaAgeSeconds: number | null) {
    const account = accounts[who];
    const now = Math.floor(Date.now() / 1000);
    const mfa = mfaAgeSeconds === null ? {} : { aal: 'aal2', amr: [{ method: 'totp', timestamp: now - mfaAgeSeconds }] };
    return new SignJWT({ role: 'authenticated', email: account.email, session_id: account.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(account.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, who: Who, input: unknown, options: { mfaAge?: number | null; org?: string | null } = {}) {
    const org = options.org === undefined ? slug : options.org;
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who, options.mfaAge === undefined ? null : options.mfaAge)}`,
        'content-type': 'application/json',
        ...(org ? { 'x-crove-org': org } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  async function propose(uploader: Who, inOrg: string = orgId): Promise<string> {
    const orgId = inOrg;
    invoiceNo += 1;
    const bytes = new TextEncoder().encode(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${invoiceNo}</SHDon>`));
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const actor = { type: 'user' as const, userId: accounts[uploader].userId, aal: 'aal1' as const };
    const uploads = new Runtime(createDb(pool)).register({ commands: kernelCommands, queries: [] });
    const { fileId } = await uploads.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor, orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-16' }, orgId, fileId);
    if (!proposalId) throw new Error('no proposal');
    return proposalId;
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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const db = createDb(pool);
    const defs = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    worker = new Runtime(createDb(workerPool)).register(defs);
    const config = loadConfig({
      DATABASE_URL: login('crove_app', 'test-app-pw'),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    for (const who of Object.keys(accounts) as Who[]) {
      const me = await rpc('me/get', who, undefined, { org: null });
      expect(me.status).toBe(200);
      accounts[who].userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', 'owner', { name: 'Công ty Duyệt hàng loạt', idempotencyKey: randomUUID() }, { org: null });
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    for (const who of ['admin', 'member'] as const) {
      const invite = await rpc('org/invite', 'owner', { email: accounts[who].email, role: who }, { mfaAge: 0 });
      expect(invite.status).toBe(200);
      expect((await rpc('invites/accept', who, { token: String(invite.body?.acceptPath).split('#')[1] }, { org: null })).status).toBe(200);
    }
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

  it('lists the revision each pending proposal is at', async () => {
    const id = await propose('owner');
    const listed = await rpc('inbox/list', 'member', { status: 'pending' });
    expect(listed.body).toContainEqual(expect.objectContaining({ id, revision: 1 }));
  });

  it('approves a selection under one step-up, reports each item, and replays by its key', async () => {
    const mine = await propose('admin');
    const theirs = await propose('owner');
    const second = await propose('member');
    const input = {
      items: [
        { id: mine, revision: 1, acceptUnverifiedSignature: true },
        { id: theirs, revision: 1, acceptUnverifiedSignature: true },
        { id: second, revision: 1, acceptUnverifiedSignature: true },
      ],
      idempotencyKey: randomUUID(),
    };
    expect(await rpc('inbox/approveMany', 'member', input, { mfaAge: 0 })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('inbox/approveMany', 'admin', input)).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect(await rpc('inbox/approveMany', 'admin', input, { mfaAge: 400 })).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });

    const done = await rpc('inbox/approveMany', 'admin', input, { mfaAge: 60 });
    expect(done.status).toBe(200);
    expect(done.body.results).toEqual([
      { id: mine, outcome: 'refused', code: 'FOUR_EYES_REQUIRED', rule: 'P10' },
      { id: theirs, outcome: 'approved', journalEntryId: expect.any(String), documentId: expect.any(String) },
      { id: second, outcome: 'approved', journalEntryId: expect.any(String), documentId: expect.any(String) },
    ]);
    // A retry with the same key returns the first answer and approves nothing again.
    expect((await rpc('inbox/approveMany', 'admin', input, { mfaAge: 60 })).body).toEqual(done.body);
    expect(await rpc('inbox/approveMany', 'admin', { ...input, items: input.items.slice(1) }, { mfaAge: 60 })).toMatchObject({
      status: 422,
      body: { code: 'IDEMPOTENCY_MISMATCH' },
    });
    // The owner can approve what four-eyes kept from the admin.
    const owner = await rpc('inbox/approveMany', 'owner', { items: [{ id: mine, revision: 1, acceptUnverifiedSignature: true }], idempotencyKey: randomUUID() }, { mfaAge: 0 });
    expect(owner.body.results).toEqual([expect.objectContaining({ id: mine, outcome: 'approved' })]);
  });

  it('holds an owner to four-eyes per item, and reads a proposal of another org as not found', async () => {
    const own = await propose('owner');
    const byAdmin = await propose('admin');
    // A second org of the same owner, with a pending proposal of its own.
    const other = await rpc('org/create', 'owner', { name: 'Công ty khác', idempotencyKey: randomUUID() }, { org: null });
    expect(other.status).toBe(200);
    const foreign = await propose('owner', String(other.body?.orgId));
    const done = await rpc(
      'inbox/approveMany',
      'owner',
      {
        items: [
          { id: own, revision: 1, acceptUnverifiedSignature: true },
          { id: byAdmin, revision: 1, acceptUnverifiedSignature: true },
          { id: foreign, revision: 1, acceptUnverifiedSignature: true },
        ],
        idempotencyKey: randomUUID(),
      },
      { mfaAge: 30 },
    );
    expect(done.status).toBe(200);
    expect(done.body.results).toEqual([
      // The owner uploaded it and the admin may approve it too, so four-eyes refuses the owner.
      { id: own, outcome: 'refused', code: 'FOUR_EYES_REQUIRED', rule: 'P10' },
      { id: byAdmin, outcome: 'approved', journalEntryId: expect.any(String), documentId: expect.any(String) },
      { id: foreign, outcome: 'refused', code: 'NOT_FOUND', rule: null },
    ]);
    // The other org's proposal is untouched, still pending there.
    const there = await rpc('inbox/list', 'owner', { status: 'pending' }, { org: String(other.body?.slug) });
    expect(there.body).toContainEqual(expect.objectContaining({ id: foreign }));
  });

  it("shows a refusal inside a batch in the proposal's own audit history, linked to its batch (#429)", async () => {
    const id = await propose('owner');
    // The owner uploaded it and the admin may approve it too, so four-eyes refuses the owner's batch; the admin's
    // batch then approves it.
    const refused = await rpc('inbox/approveMany', 'owner', { items: [{ id, revision: 1, acceptUnverifiedSignature: true }], idempotencyKey: randomUUID() }, { mfaAge: 0 });
    expect(refused.body.results).toEqual([{ id, outcome: 'refused', code: 'FOUR_EYES_REQUIRED', rule: 'P10' }]);
    const approved = await rpc('inbox/approveMany', 'admin', { items: [{ id, revision: 1, acceptUnverifiedSignature: true }], idempotencyKey: randomUUID() }, { mfaAge: 0 });
    expect(approved.body.results).toEqual([expect.objectContaining({ id, outcome: 'approved' })]);

    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      // The batches that listed this proposal, oldest first.
      const batches = (
        await admin.query<{ command_id: string; actor_id: string }>(
          `SELECT command_id, actor_id FROM crove_kernel.audit_event
            WHERE org_id = $1 AND command = 'kernel.proposal.approve_many' AND outcome = 'ok'
              AND detail -> 'items' @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', $2::text))
            ORDER BY id`,
          [orgId, id],
        )
      ).rows;
      expect(batches.map((b) => b.actor_id)).toEqual([accounts.owner.userId, accounts.admin.userId]);
      // "History of proposal X": its approval rows, the refusal inside the first batch included.
      const history = (
        await admin.query<{ actor_id: string; outcome: string; code: string | null; rule: string | null; parent: string | null }>(
          `SELECT actor_id, outcome, detail ->> 'code' AS code, detail ->> 'rule' AS rule, detail ->> 'parentCommandId' AS parent
             FROM crove_kernel.audit_event
            WHERE org_id = $1 AND command = 'kernel.proposal.approve' AND target_type = 'kernel.proposal' AND target_id = $2
            ORDER BY id`,
          [orgId, id],
        )
      ).rows;
      expect(history).toEqual([
        { actor_id: accounts.owner.userId, outcome: 'denied', code: 'FOUR_EYES_REQUIRED', rule: 'P10', parent: batches[0]?.command_id },
        // An approved item's row is the runtime's ok row, with no link of a refusal.
        { actor_id: accounts.admin.userId, outcome: 'ok', code: null, rule: null, parent: null },
      ]);
    } finally {
      await admin.end();
    }
  });

  it('takes 1 to 50 distinct items', async () => {
    const id = await propose('owner');
    const many = Array.from({ length: 51 }, () => ({ id: randomUUID(), revision: 1 }));
    expect((await rpc('inbox/approveMany', 'owner', { items: [], idempotencyKey: randomUUID() }, { mfaAge: 0 })).status).toBe(400);
    expect((await rpc('inbox/approveMany', 'owner', { items: many, idempotencyKey: randomUUID() }, { mfaAge: 0 })).status).toBe(400);
    // The contract refuses a repeated proposal before the command runs (the command's own schema refuses it too).
    const twice = await rpc('inbox/approveMany', 'owner', { items: [{ id, revision: 1, acceptUnverifiedSignature: true }, { id, revision: 1, acceptUnverifiedSignature: true }], idempotencyKey: randomUUID() }, { mfaAge: 0 });
    expect(twice.status).toBe(400);
  });

  it('approves an invoice whose signature is unverified only with a confirmation of that revision (#674)', async () => {
    // The fixture's signature is a placeholder, so the sandbox reports it unverified.
    const id = await propose('owner');
    const detail = await rpc('inbox/get', 'admin', { id });
    expect(detail.body).toMatchObject({ signatureStatus: 'unverified', payload: { signature: { status: 'unverified', reason: 'malformed' } } });
    const listed = await rpc('inbox/list', 'admin', { status: 'pending' });
    expect(listed.body).toContainEqual(expect.objectContaining({ id, signatureStatus: 'unverified' }));

    // One by one: refused without the confirmation, or with it set to false; a confirmation of another revision is not one.
    const approve = (input: Record<string, unknown>) => rpc('inbox/approve', 'admin', { id, revision: 1, idempotencyKey: randomUUID(), ...input }, { mfaAge: 60 });
    expect(await approve({})).toMatchObject({ status: 422, body: { code: 'SIGNATURE_UNVERIFIED' } });
    expect(await approve({ acceptUnverifiedSignature: false })).toMatchObject({ status: 422, body: { code: 'SIGNATURE_UNVERIFIED' } });
    expect(await approve({ revision: 2, acceptUnverifiedSignature: true })).toMatchObject({ status: 409, body: { code: 'STALE_REVISION' } });

    // In bulk: each item needs its own confirmation; the item without one is refused alone.
    const other = await propose('owner');
    const done = await rpc(
      'inbox/approveMany',
      'admin',
      { items: [{ id, revision: 1 }, { id: other, revision: 1, acceptUnverifiedSignature: true }], idempotencyKey: randomUUID() },
      { mfaAge: 60 },
    );
    expect(done.body.results).toEqual([
      { id, outcome: 'refused', code: 'SIGNATURE_UNVERIFIED', rule: null },
      expect.objectContaining({ id: other, outcome: 'approved' }),
    ]);
    // Confirmed, it is approved as any other invoice.
    expect(await approve({ acceptUnverifiedSignature: true })).toMatchObject({ status: 200, body: { journalEntryId: expect.any(String) } });
  });
});
