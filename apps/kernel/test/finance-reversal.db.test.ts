// Reversal from the API and what happens to a reversed purchase document (issue #165), on a real PostgreSQL 17,
// through the HTTP API where a user would act: asking for a reversal (inbox.request, with an idempotency key), the
// reversal proposal in the Inbox, approving it, the reversal link both ways in the journal, and the purchase document
// voided by the reversal, so the same supplier invoice can be recorded again while a duplicate of a document still in
// force is refused. The ledger rules of reversals themselves are in test/invariant/ledger-reversal.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { money, sum } from '@crove/l10n-vn';
import { extractAndPropose, financeCommands, financeQueries, purchaseRows, type PurchaseVoucher } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-reversals-0123456789';
const ISSUER = 'crove-auth';
// Lines with this memo are invisible to every tenant role (a stand-in for legal-entity policies, as in #76).
const HIDDEN = 'outside-legal-entity-scope-165';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  // Memory has no object versions: the generation is the content address (ADR-0013).
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

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('journal reversal through the API, and voided purchase documents (#165)', () => {
  const dbName = `crove_test_reversal_ui_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@reversal-ui.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@reversal-ui.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };

  // The HTTP app's runtime checks sessions (in 'off' mode), so direct calls carry a session id too.
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: owner.session });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: owner.session,
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, slug: string | null = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  // The fixture invoice under another number (and optional extra bytes, so the file is new but the invoice is not).
  const invoice = (number: string, salt = '') =>
    new TextEncoder().encode(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`) + salt);

  async function ingest(bytes: Uint8Array) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    return fileId;
  }

  const read = (fileId: string, version?: number) =>
    extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId, version);

  const approve = (id: string, revision = 1, extra: Record<string, unknown> = {}) =>
    runtime.execute<{ documentId?: string; journalEntryId: string; voidedDocumentId?: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id, revision, ...extra },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

  beforeAll(async () => {
    extract = inProcessExtract();
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
    appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db, sessions = false) =>
      new Runtime(target, { manifests: TEST_MANIFESTS, ...(sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {}) }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    runtime = register(db, true);
    workerRuntime = register(createDb(workerPool));
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, viewer]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Đảo bút toán', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: viewer.email, role: 'viewer' });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(viewer), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
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

  // Shared by the tests below, in order.
  let fileId = '';
  let firstProposal = '';
  let firstDocument = '';
  let firstEntry = '';
  let reversalEntry = '';
  let secondDocument = '';

  it('refuses a second document of an invoice that is recorded and in force', async () => {
    fileId = await ingest(invoice('7001'));
    const proposal = await read(fileId);
    firstProposal = String(proposal.proposalId);
    const recorded = await approve(firstProposal);
    firstDocument = String(recorded.documentId);
    firstEntry = recorded.journalEntryId;

    // The same invoice in another file: flagged by the duplicate check, and refused on approval even when confirmed.
    const copy = await read(await ingest(invoice('7001', '\n')));
    const detail = await rpc('inbox/get', await tokenFor(owner), { id: copy.proposalId });
    expect(detail.body?.payload?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'duplicate', status: 'fail' })]));
    await expect(approve(String(copy.proposalId), 1, { acceptFailedChecks: true })).rejects.toMatchObject({ code: 'DUPLICATE_INVOICE', status: 409 });
    await runtime.execute('kernel.proposal.reject', { id: copy.proposalId }, { actor: asUser(owner.userId), orgId: org.orgId });
    // The copy's file carries its proposal's rejection (#2009); the app shows it on a file read as proposed, while a
    // file marked as a duplicate keeps its duplicate chip.
    const recent = (await rpc('files/recent', await tokenFor(owner), undefined)).body as Array<{ proposalId: string | null; proposalStatus: string | null }>;
    expect(recent.find((f) => f.proposalId === copy.proposalId)).toMatchObject({ proposalStatus: 'rejected' });

    // The file of a recorded invoice is not read again.
    await expect(
      runtime.execute('kernel.file.reextract', { fileId }, { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_DECIDED' });
    expect((await rpc('inbox/get', await tokenFor(owner), { id: firstProposal })).body).toMatchObject({ voided: false, canReextract: false });
  });

  // #878: the exports a document went out in, for its history; the entry is dated 15 September 2026.
  const download = async (path: string) => {
    const response = await app.request(path, { headers: { authorization: `Bearer ${await tokenFor(viewer)}`, 'x-crove-org': org.slug } });
    expect(response.status, path).toBe(200);
    await response.arrayBuffer();
  };
  const exportsOf = async (documentId: string) => (await rpc('documents/exports', await tokenFor(viewer), { documentId })).body as any[];

  it('names the exports whose range and format took the document in, and never guesses at older ones (#878)', async () => {
    await download('/api/export/journal.xlsx?from=2026-09-01&to=2026-09-30');
    await download('/api/export/misa/purchases.xlsx?from=2026-09-01&to=2026-09-30');
    // Not this document: a sales file, and a range that ends before its date.
    await download('/api/export/misa/sales.xlsx?from=2026-09-01&to=2026-09-30');
    await download('/api/export/journal.xlsx?to=2026-08-31');
    // An export recorded before #878 has no range: left out.
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, 'user', $2, 'finance.journal.export', gen_random_uuid(), 'ok', repeat('a', 64), '{"entries": 1}')`,
        [org.orgId, viewer.userId],
      ),
    );
    const found = await exportsOf(firstDocument);
    expect(found).toEqual([
      { id: expect.any(String), at: expect.any(String), format: 'journal', from: '2026-09-01', to: '2026-09-30', actorName: viewer.email },
      { id: expect.any(String), at: expect.any(String), format: 'misa_sme_purchases', from: '2026-09-01', to: '2026-09-30', actorName: viewer.email },
    ]);
    // An open-ended export takes every date.
    await download('/api/export/journal.xlsx');
    expect((await exportsOf(firstDocument)).at(-1)).toMatchObject({ format: 'journal', from: null, to: null });
    expect(await rpc('documents/exports', await tokenFor(viewer), { documentId: randomUUID() })).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  });

  it('asks for a reversal through the API, once per idempotency key, and only as a member', async () => {
    const key = randomUUID();
    const input = { entryId: firstEntry, entryDate: '2026-10-15', reason: 'Ghi nhầm tài khoản chi phí' };
    const asked = await rpc('inbox/request', await tokenFor(owner), { command: 'finance.journal.reverse', input, idempotencyKey: key });
    expect(asked).toMatchObject({ status: 200, body: { proposalId: expect.any(String) } });
    const proposalId = String(asked.body.proposalId);
    // A retry with the same key returns the first proposal; the same key for another request is refused.
    expect((await rpc('inbox/request', await tokenFor(owner), { command: 'finance.journal.reverse', input, idempotencyKey: key })).body).toEqual({ proposalId });
    expect(
      (await rpc('inbox/request', await tokenFor(owner), { command: 'finance.journal.reverse', input: { ...input, reason: 'Khác' }, idempotencyKey: key })).body,
    ).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    // Another request for the same entry while this one is pending is refused, and names the pending proposal (#254).
    expect(
      await rpc('inbox/request', await tokenFor(owner), { command: 'finance.journal.reverse', input: { ...input, reason: 'Lần hai' }, idempotencyKey: randomUUID() }),
    ).toMatchObject({ status: 409, body: { code: 'REVERSAL_PENDING', data: { proposalId } } });
    // A viewer may not ask; a reason is required; only reversals can be asked for.
    expect(await rpc('inbox/request', await tokenFor(viewer), { command: 'finance.journal.reverse', input, idempotencyKey: randomUUID() })).toMatchObject({
      status: 403,
      body: { code: 'FORBIDDEN' },
    });
    expect((await rpc('inbox/request', await tokenFor(owner), { command: 'finance.journal.reverse', input: { ...input, reason: '  ' }, idempotencyKey: randomUUID() })).status).toBe(400);
    expect((await rpc('inbox/request', await tokenFor(owner), { command: 'finance.purchase.record', input, idempotencyKey: randomUUID() })).status).toBe(400);

    // The Inbox shows a reversal card, not an empty purchase.
    const card = await rpc('inbox/get', await tokenFor(owner), { id: proposalId });
    expect(card.body).toMatchObject({
      kind: 'finance.journal_reversal',
      title: expect.stringContaining('(hủy chứng từ mua)'),
      payload: null,
      reversal: input,
      result: null,
      canApprove: true,
      voided: false,
    });
    const listed = await rpc('inbox/list', await tokenFor(owner), { status: 'pending' });
    expect(listed.body).toEqual([expect.objectContaining({ id: proposalId, kind: 'finance.journal_reversal', sellerName: null, total: null })]);
    expect((await rpc('journal/get', await tokenFor(viewer), { id: firstEntry })).body).toMatchObject({
      id: firstEntry,
      reverses: null,
      reversedBy: null,
      // The journal shows the pending request instead of offering another (#204).
      pendingReversalId: proposalId,
      document: { id: firstDocument, voided: false },
    });

    // Approving posts the mirror entry and voids the purchase document; it needs fresh MFA (R3).
    expect((await rpc('inbox/approve', await tokenFor(owner), { acceptUnverifiedSignature: true, id: proposalId, revision: 1, idempotencyKey: randomUUID() })).body).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { acceptUnverifiedSignature: true, id: proposalId, revision: 1, idempotencyKey: randomUUID() });
    expect(approved).toMatchObject({ status: 200, body: { journalEntryId: expect.any(String), reversedEntryId: firstEntry, voidedDocumentId: firstDocument } });
    reversalEntry = String(approved.body.journalEntryId);
    expect((await rpc('inbox/get', await tokenFor(owner), { id: proposalId })).body).toMatchObject({
      status: 'executed',
      result: { journalEntryId: reversalEntry, reversedEntryId: firstEntry, voidedDocumentId: firstDocument },
    });
  });

  it('shows the reversal link both ways and the voided document', async () => {
    const journal = await rpc('journal/list', await tokenFor(viewer), {});
    const byId = new Map<string, any>((journal.body as any[]).map((e) => [e.id, e]));
    expect(byId.get(firstEntry)).toMatchObject({
      reverses: null,
      reversedBy: { id: reversalEntry, entryDate: '2026-10-15' },
      pendingReversalId: null,
      document: { voided: true },
    });
    expect(byId.get(reversalEntry)).toMatchObject({ reverses: { id: firstEntry, entryDate: '2026-09-15' }, reversedBy: null, sourceType: 'kernel.proposal' });
    expect(byId.get(reversalEntry)).not.toHaveProperty('document');

    const documents = await rpc('documents/list', await tokenFor(viewer), {});
    expect(documents.body).toEqual([
      expect.objectContaining({
        id: firstDocument,
        voided: { reversalEntryId: reversalEntry, reason: 'Ghi nhầm tài khoản chi phí', voidedAt: expect.any(String) },
        replacesDocumentId: null,
      }),
    ]);
    const [row] = await admin(async (c) => (await c.query('SELECT document_id, reversal_entry_id, reason, voided_by FROM crove_finance.purchase_document_void WHERE org_id = $1', [org.orgId])).rows);
    expect(row).toEqual({ document_id: firstDocument, reversal_entry_id: reversalEntry, reason: 'Ghi nhầm tài khoản chi phí', voided_by: owner.userId });
    const [audit] = await admin(
      async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.journal.reverse' AND outcome = 'ok'`, [org.orgId])).rows,
    );
    expect(audit?.detail).toMatchObject({ reversed_entry_id: firstEntry, reversal_entry_id: reversalEntry, voided_document_id: firstDocument });
  });

  it('shows the document\'s history to every member: received, proposed, approved, recorded and voided (#672)', async () => {
    const timeline = await rpc('inbox/timeline', await tokenFor(viewer), { id: firstProposal });
    expect(timeline.status).toBe(200);
    const items = timeline.body.items as any[];
    const kinds = items.map((i) => i.kind);
    // Entries of one transaction share its time, so only the order across transactions is fixed.
    expect(kinds.slice(0, 2)).toEqual(['file.received', 'proposal.created']);
    expect(kinds.slice(2, 4).sort()).toEqual(['proposal.approved', 'purchase.recorded']);
    expect(kinds.slice(4).sort()).toEqual(['journal_entry.reversed', 'purchase.voided']);
    expect(items.map((i) => i.at)).toEqual(items.map((i) => i.at).sort());
    expect(items.find((i) => i.kind === 'proposal.approved')).toMatchObject({ recordType: 'kernel.proposal', actorType: 'user', actorName: owner.email });
    expect(items.find((i) => i.kind === 'purchase.voided')).toMatchObject({ recordType: 'finance.purchase_document', summary: expect.stringContaining('Hủy chứng từ mua') });
    expect(timeline.body.more).toBe(false);
    // The copy that was refused as a duplicate shows its rejection.
    const rejected = await rpc('inbox/list', await tokenFor(owner), { status: 'rejected' });
    const copy = (rejected.body as any[])[0];
    const copyTimeline = await rpc('inbox/timeline', await tokenFor(owner), { id: copy.id });
    expect((copyTimeline.body.items as any[]).map((i) => i.kind)).toEqual(['file.received', 'proposal.created', 'proposal.rejected']);
    expect(await rpc('inbox/timeline', await tokenFor(owner), { id: randomUUID() })).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    // After the void a MISA file leaves the document out, while the journal still holds its entry (#878).
    const before = (await exportsOf(firstDocument)).length;
    await download('/api/export/misa/purchases.xlsx?from=2026-09-01&to=2026-09-30');
    await download('/api/export/journal.xlsx?from=2026-09-01&to=2026-09-30');
    const after = await exportsOf(firstDocument);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ format: 'journal', from: '2026-09-01', to: '2026-09-30' });
  });

  it('records the same invoice again from its file after the void, with the corrected accounts', async () => {
    expect((await rpc('inbox/get', await tokenFor(owner), { id: firstProposal })).body).toMatchObject({ voided: true, canReextract: true });
    const files = await rpc('files/recent', await tokenFor(owner), undefined);
    // The file's proposal was posted (#2009): the Inbox shows the file as posted, not as waiting.
    expect((files.body as any[]).find((f) => f.id === fileId)).toMatchObject({ proposalStatus: 'executed', canReextract: true });

    const { version } = await runtime.execute<{ version: number }>(
      'kernel.file.reextract',
      { fileId },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { proposalId } = await read(fileId, version);
    expect(proposalId).toBeTruthy();
    expect(proposalId).not.toBe(firstProposal);
    const fresh = await rpc('inbox/get', await tokenFor(owner), { id: proposalId });
    // The voided document and the proposal that recorded it are not duplicates any more.
    expect(fresh.body?.duplicateOf).toBeNull();
    const checks: Array<{ id: string }> = fresh.body?.payload?.checks ?? [];
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.map((c) => c.id)).not.toContain('duplicate');

    const line = fresh.body?.payload?.lines?.[0] as { lineNo: number; debitAccount: string };
    const corrected = line.debitAccount === '156' ? '153' : '156';
    const edited = await runtime.execute<{ revision: number }>(
      'kernel.proposal.edit',
      { id: proposalId, revision: 1, lineAccounts: [{ lineNo: line.lineNo, debitAccount: corrected }] },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const recorded = await approve(String(proposalId), edited.revision);
    secondDocument = String(recorded.documentId);

    const [doc] = await admin(async (c) => (await c.query('SELECT replaces_document_id FROM crove_finance.purchase_document WHERE id = $1', [secondDocument])).rows);
    expect(doc).toEqual({ replaces_document_id: firstDocument });
    const entry = await rpc('journal/get', await tokenFor(owner), { id: recorded.journalEntryId });
    expect(entry.body?.lines?.map((l: { accountCode: string }) => l.accountCode)).toContain(corrected);
    const documents = await rpc('documents/list', await tokenFor(owner), {});
    expect((documents.body as any[]).find((d) => d.id === secondDocument)).toMatchObject({ voided: null, replacesDocumentId: firstDocument });

    // The new document is in force: the same invoice again is a duplicate.
    const copy = await read(await ingest(invoice('7001', '\n\n')));
    await expect(approve(String(copy.proposalId), 1, { acceptFailedChecks: true })).rejects.toMatchObject({ code: 'DUPLICATE_INVOICE', status: 409 });
  });

  it('exports the documents in force, not the voided one, as MISA SME purchase vouchers (#317)', async () => {
    const vouchers = await runtime.query<PurchaseVoucher[]>('finance.vouchers.purchases', {}, { actor: asUser(viewer.userId), orgId: org.orgId });
    // The voided first document is left out; the replacement is there with its corrected accounts.
    expect(vouchers).toHaveLength(1);
    const [voucher] = vouchers;
    const [doc] = await admin(
      async (c) =>
        (await c.query(`SELECT subtotal::text, vat_amount::text, invoice_number, invoice_date::text FROM crove_finance.purchase_document WHERE id = $1`, [secondDocument]))
          .rows,
    );
    const [entry] = await admin(
      async (c) =>
        (await c.query(`SELECT id, entry_date::text FROM crove_finance.journal_entry WHERE source_type = 'finance.purchase_document' AND source_id = $1`, [secondDocument])).rows,
    );
    expect(voucher).toMatchObject({ entryId: entry.id, entryDate: entry.entry_date, invoice: { number: doc.invoice_number, date: doc.invoice_date } });
    // A multi-line invoice is one row per line; the rows carry the document's amounts and VAT exactly.
    const rows = purchaseRows(voucher as PurchaseVoucher);
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => r.voucherNo)).size).toBe(1);
    expect(sum(rows.map((r) => r.line.amount)).eq(money(doc.subtotal))).toBe(true);
    expect(sum(rows.map((r) => r.vatAmount)).eq(money(doc.vat_amount))).toBe(true);
    expect(rows.map((r) => r.vat.code)).toEqual(rows.map(() => '10'));
    // Outside the date range: nothing.
    expect(await runtime.query('finance.vouchers.purchases', { to: '2000-01-01' }, { actor: asUser(viewer.userId), orgId: org.orgId })).toEqual([]);

    // The download, for a viewer like the journal export, and its audit row (counts only, with the format).
    const response = await app.request('/api/export/misa/purchases.xlsx', {
      headers: { authorization: `Bearer ${await tokenFor(viewer)}`, 'x-crove-org': org.slug },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe('PK');
    const audits = await admin(
      async (c) =>
        (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.journal.export' AND outcome = 'ok'`, [org.orgId])).rows,
    );
    expect(audits.map((a) => a.detail)).toContainEqual({ entries: 1, format: 'misa_sme_purchases', from: null, to: null, stockLines: 'excluded' });
  });

  it('holds every writer to the void and replacement rules', async () => {
    await admin(async (c) => {
      // Runs the statements in one transaction, always rolled back; returns the error, or null.
      const refused = async (statement: string, params: unknown[], before: Array<[string, unknown[]]> = []) => {
        await c.query('BEGIN');
        try {
          for (const [text, values] of before) await c.query(text, values);
          await c.query(statement, params);
          return null;
        } catch (error) {
          const e = error as { code?: string; constraint?: string; message: string };
          return { code: e.code, constraint: e.constraint, message: e.message };
        } finally {
          await c.query('ROLLBACK');
        }
      };
      const voidRow = `INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'x')`;
      // A void must name the reversal of the document's own entry: not a reversal of another entry, nor the entry.
      const other = randomUUID();
      const otherReversal = randomUUID();
      const entry = `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, reverses_entry_id)
                     VALUES ($1, $2, '2026-10-15', 'test', 'test', gen_random_uuid(), $3)`;
      expect(
        await refused(voidRow, [org.orgId, secondDocument, otherReversal], [
          [entry, [org.orgId, other, null]],
          [entry, [org.orgId, otherReversal, other]],
        ]),
      ).toMatchObject({ code: '23514', message: expect.stringMatching(/must name the reversal/) });
      expect(await refused(voidRow, [org.orgId, secondDocument, firstEntry])).toMatchObject({ code: '23514' });
      // One void per document, and voids are append-only.
      expect(await refused(voidRow, [org.orgId, firstDocument, reversalEntry])).toMatchObject({ code: '23505' });
      expect(await refused(`UPDATE crove_finance.purchase_document_void SET reason = 'y' WHERE org_id = $1`, [org.orgId])).toMatchObject({ code: '42501' });
      expect(await refused(`DELETE FROM crove_finance.purchase_document_void WHERE org_id = $1`, [org.orgId])).toMatchObject({ code: '42501' });

      const docRow = `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, replaces_document_id)
                      SELECT org_id, party_id, invoice_series, $3, invoice_date, subtotal, vat_amount, total, $4::uuid
                      FROM crove_finance.purchase_document WHERE org_id = $1 AND id = $2`;
      // Another document of the same invoice that replaces nothing, or a voided document already replaced: refused.
      expect(await refused(docRow, [org.orgId, secondDocument, '7001', null])).toMatchObject({ code: '23505', constraint: 'purchase_document_purchase_invoice_uq' });
      expect(await refused(docRow, [org.orgId, secondDocument, '7001', firstDocument])).toMatchObject({ code: '23505', constraint: 'purchase_document_replaces_uq' });
      // Replacing a document in force, or a voided document of another invoice: refused.
      expect(await refused(docRow, [org.orgId, secondDocument, '7001', secondDocument])).toMatchObject({ code: '23514', message: expect.stringMatching(/only a voided document/) });
      expect(await refused(docRow, [org.orgId, secondDocument, '7002', firstDocument])).toMatchObject({ code: '23514' });
      // Another invoice that replaces nothing is an ordinary first document.
      expect(await refused(docRow, [org.orgId, secondDocument, '7003', null])).toBeNull();
    });
  });

  it('commits a reversal of a purchase entry only with the void of its document, for every writer (#204)', async () => {
    // The entry of the second document, which is in force, and the mirror of its lines.
    const { entry, lines } = await admin(async (c) => {
      const found = await c.query<{ id: string }>(
        `SELECT id FROM crove_finance.journal_entry WHERE org_id = $1 AND source_type = 'finance.purchase_document' AND source_id = $2`,
        [org.orgId, secondDocument],
      );
      const id = found.rows[0]?.id ?? '';
      const rows = await c.query<{ line_no: number; account_code: string; debit: string; credit: string; party_id: string | null; memo: string | null }>(
        `SELECT line_no, account_code, debit::text, credit::text, party_id, memo FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY line_no`,
        [org.orgId, id],
      );
      return { entry: id, lines: rows.rows };
    });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const mirror = lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
    const unvoided = /must void purchase document/;

    // The API login role in the owner's context, calling the posting function with p_reverses_entry_id and writing no
    // void: the mirror is exact, but the commit is refused.
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org.orgId, contextToken(owner.userId, org.orgId)]);
      await client.query(`SELECT crove_finance.post_journal_entry('2026-10-16'::date, 'Đảo trực tiếp', 'test', $1::uuid, $2::jsonb, $3::uuid)`, [
        randomUUID(),
        JSON.stringify(mirror),
        entry,
      ]);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(unvoided) });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }

    // A superuser writing the rows directly is held to the same rule: refused at commit without the void, and when
    // the check is run early before the void is written; accepted with the void (rolled back, so the document stays
    // in force).
    await admin(async (c) => {
      const attempt = async (options: { void: boolean; early: boolean; commit: boolean }) => {
        await c.query('BEGIN');
        try {
          const reversal = randomUUID();
          await c.query(
            `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, reverses_entry_id)
             VALUES ($1, $2, '2026-10-16', 'Đảo trực tiếp', 'test', gen_random_uuid(), $3)`,
            [org.orgId, reversal, entry],
          );
          for (const l of mirror) {
            await c.query(
              `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, memo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [org.orgId, reversal, l.line_no, l.account_code, l.debit, l.credit, l.party_id, l.memo],
            );
          }
          if (options.early) await c.query('SET CONSTRAINTS crove_finance.journal_entry_reversal_voids IMMEDIATE');
          if (options.void) {
            await c.query(`INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'x')`, [
              org.orgId,
              secondDocument,
              reversal,
            ]);
          }
          if (options.commit) {
            await c.query('COMMIT');
          } else {
            await c.query('SET CONSTRAINTS ALL IMMEDIATE');
            await c.query('ROLLBACK');
          }
          return null;
        } catch (error) {
          await c.query('ROLLBACK').catch(() => {});
          return error;
        }
      };
      expect(await attempt({ void: false, early: false, commit: true })).toMatchObject({ code: '23514', message: expect.stringMatching(unvoided) });
      expect(await attempt({ void: true, early: true, commit: true })).toMatchObject({ code: '23514', message: expect.stringMatching(unvoided) });
      expect(await attempt({ void: true, early: false, commit: false })).toBeNull();
    });

    // Nothing was committed: the entry has no reversal and its document is still in force.
    const documents = await rpc('documents/list', await tokenFor(owner), {});
    expect((documents.body as any[]).find((d) => d.id === secondDocument)).toMatchObject({ voided: null });
    expect((await rpc('journal/get', await tokenFor(owner), { id: entry })).body).toMatchObject({ reversedBy: null });
  });

  it('explains a reversal the approver cannot see in full', async () => {
    await admin((c) =>
      c.query(`CREATE POLICY crove_test_le_scope_165 ON crove_finance.journal_line AS RESTRICTIVE FOR SELECT TO crove_tenant
               USING (memo IS DISTINCT FROM '${HIDDEN}')`),
    );
    // Posts an entry as the API login role in the owner's context.
    const post = async (lines: Array<Record<string, unknown>>) => {
      const client = new pg.Client({ connectionString: appUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org.orgId, contextToken(owner.userId, org.orgId)]);
        const { rows } = await client.query<{ id: string }>(
          `SELECT crove_finance.post_journal_entry('2026-10-01'::date, 'Có dòng ngoài phạm vi', 'test', $1::uuid, $2::jsonb) AS id`,
          [randomUUID(), JSON.stringify(lines)],
        );
        await client.query('COMMIT');
        return rows[0]?.id ?? '';
      } finally {
        await client.end();
      }
    };
    // Hidden lines that balance each other (the visible mirror balances but is not the whole entry), and a hidden VAT
    // line (the visible mirror does not even balance): both get the same plain explanation.
    const entries = [
      await post([
        { line_no: 1, account_code: '6422', debit: '100', credit: '0', memo: 'Văn phòng phẩm' },
        { line_no: 2, account_code: '331', debit: '0', credit: '100', memo: null },
        { line_no: 3, account_code: '6422', debit: '30', credit: '0', memo: HIDDEN },
        { line_no: 4, account_code: '331', debit: '0', credit: '30', memo: HIDDEN },
      ]),
      await post([
        { line_no: 1, account_code: '6422', debit: '100', credit: '0', memo: 'Văn phòng phẩm' },
        { line_no: 2, account_code: '1331', debit: '10', credit: '0', memo: HIDDEN },
        { line_no: 3, account_code: '331', debit: '0', credit: '110', memo: null },
      ]),
    ];
    for (const entryId of entries) {
      const asked = await rpc('inbox/request', await tokenFor(owner), {
        command: 'finance.journal.reverse',
        input: { entryId, entryDate: '2026-10-15', reason: 'Sai' },
        idempotencyKey: randomUUID(),
      });
      expect(asked.status).toBe(200);
      const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { acceptUnverifiedSignature: true, id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() });
      expect(approved).toMatchObject({
        status: 422,
        body: { code: 'INVALID', data: { reason: 'partial_mirror' }, message: expect.stringContaining('không được xem tất cả các dòng') },
      });
      // Nothing was posted and the proposal is still pending.
      expect((await rpc('inbox/get', await tokenFor(owner), { id: asked.body.proposalId })).body).toMatchObject({ status: 'pending' });
    }
  });

  it('voids, when the migration runs, the documents of purchase entries reversed before it', async () => {
    const migration = readFileSync(new URL('../../../supabase/migrations/20261018000000_crove_finance_purchase_document_void.sql', import.meta.url), 'utf8');
    const document = randomUUID();
    const entry = randomUUID();
    const reversal = randomUUID();
    await admin(async (c) => {
      // A purchase entry and its reversal, written as they were before voids existed (no void row). The rule that such
      // a reversal commits only with its void (20261018150000) came later, so it is switched off for this legacy write.
      await c.query('BEGIN');
      await c.query('ALTER TABLE crove_finance.journal_entry DISABLE TRIGGER journal_entry_reversal_voids');
      await c.query(
        `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total)
         SELECT org_id, $2, party_id, '7900', '2026-10-01', 100, 10, 110 FROM crove_finance.purchase_document WHERE org_id = $1 LIMIT 1`,
        [org.orgId, document],
      );
      const insertEntry = `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, reverses_entry_id)
                           VALUES ($1, $2, '2026-10-02', $3, $4, $5, $6)`;
      await c.query(insertEntry, [org.orgId, entry, 'HĐ 7900', 'finance.purchase_document', document, null]);
      await c.query(insertEntry, [org.orgId, reversal, 'Đảo bút toán (lý do: cũ)', 'kernel.proposal', randomUUID(), entry]);
      const line = `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)`;
      await c.query(line, [org.orgId, entry, 1, '6422', 110, 0]);
      await c.query(line, [org.orgId, entry, 2, '331', 0, 110]);
      await c.query(line, [org.orgId, reversal, 1, '6422', 0, 110]);
      await c.query(line, [org.orgId, reversal, 2, '331', 110, 0]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('ALTER TABLE crove_finance.journal_entry ENABLE TRIGGER journal_entry_reversal_voids');
      await c.query('COMMIT');
      // Applying the migration again backfills the void, once.
      for (let run = 0; run < 2; run += 1) {
        await c.query('BEGIN');
        await c.query(migration);
        await c.query('COMMIT');
      }
      const { rows } = await c.query('SELECT reversal_entry_id, reason, voided_by FROM crove_finance.purchase_document_void WHERE org_id = $1 AND document_id = $2', [
        org.orgId,
        document,
      ]);
      expect(rows).toEqual([{ reversal_entry_id: reversal, reason: 'Đảo bút toán (lý do: cũ)', voided_by: null }]);
    });
  });
});
