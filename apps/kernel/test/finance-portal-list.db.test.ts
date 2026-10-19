// The tax portal's purchase-invoice list (#465), on a real PostgreSQL 17, through the HTTP API and the worker
// function: the upload with purpose import (stored, never read as a document), the import command, the read in the
// parsing sandbox, the reconciliation against booked, voided and pending purchases (missing, amount mismatch,
// cancelled, not on the portal), period scoping, removing and re-importing a list, the checks that refuse another
// company's or a sales list, roles, and the org boundary. The matching rules are unit-tested in
// modules/finance/test/portal-reconcile.test.ts and the reader in apps/extract/test/portal-list.test.ts.
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
import { extractAndPropose, financeCommands, financeQueries, importPortalList } from '@crove/mod-finance';
import { PORTAL_HEADER, buildXlsx, portalListXlsx, portalRow, type PortalInvoiceSpec } from '../../extract/test/xlsx-fixture.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const SECRET = 'test-only-jwt-secret-for-portal-list-0123456789';
const ISSUER = 'crove-auth';
// The fixture's seller and buyer.
const SELLER = '0101234564';
const BUYER = '0309876546';

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

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('tax portal purchase list (#465)', () => {
  const dbName = `crove_test_portal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@portal.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@portal.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@portal.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: owner.session });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: owner.session, mfaAt: Math.floor(Date.now() / 1000) });

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

  async function upload(token: string, name: string, bytes: Uint8Array, purpose = 'import', slug = org.slug) {
    const form = new FormData();
    form.append('file', new File([Buffer.from(bytes)], name));
    form.append('purpose', purpose);
    const response = await app.request('/api/files', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug }, body: form });
    return { status: response.status, body: (await response.json()) as any };
  }

  // The fixture invoice (1,800,000 + VAT 180,000 = 1,980,000) under another number and date.
  const invoice = (number: string, date: string) =>
    new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('<NLap>2026-09-15</NLap>', `<NLap>${date}</NLap>`));

  // Uploads and reads one invoice; approves it unless it should stay in the Inbox.
  async function receive(number: string, date: string, approve = true) {
    const bytes = invoice(number, date);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-17' }, org.orgId, fileId);
    if (!approve) return { proposalId, documentId: null, journalEntryId: null };
    const done = await runtime.execute<{ documentId: string; journalEntryId: string }>(
      'kernel.proposal.approve',
      { id: proposalId, revision: 1 },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    return { proposalId, ...done };
  }

  const spec = (number: string, date: string, extra: Partial<PortalInvoiceSpec> = {}): PortalInvoiceSpec => ({
    template: 1,
    series: 'C26TAB',
    number,
    date,
    sellerTaxCode: SELLER,
    subtotal: 1_800_000,
    vat: 180_000,
    total: 1_980_000,
    ...extra,
  });

  // Uploads a list, imports it for the period and runs the worker step.
  async function importList(invoices: PortalInvoiceSpec[], period: string) {
    const bytes = portalListXlsx(invoices);
    const uploaded = await upload(await tokenFor(owner), `ds-${period}.xlsx`, bytes);
    expect(uploaded.status).toBe(200);
    const fileId = uploaded.body.files[0].fileId as string;
    const imported = await rpc('portalList/import', await tokenFor(owner), { period, fileId });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    const listId = imported.body.listId as string;
    await importPortalList({ runtime: workerRuntime, store, extract }, org.orgId, listId);
    return { fileId, listId };
  }

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
    const appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    const db: Db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db, sessions = false) =>
      new Runtime(target, sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {}).register({
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

    for (const who of [owner, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Người Mua Mẫu', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    expect((await rpc('org/setTaxCode', await tokenFor(owner), { taxCode: BUYER })).status).toBe(200);
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: viewer.email, role: 'viewer' });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(viewer), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherOrg = { slug: String(other.body?.slug), orgId: String(other.body?.orgId) };

    // September: 9001 booked and on the portal; 9002 booked then voided (missing again); 9003 waiting in the Inbox;
    // 9004 booked with another total on the portal; 9005 booked but cancelled on the portal; 9006 booked and not on the
    // portal. October: 1001 booked (another period).
    await receive('9001', '2026-09-03');
    const voided = await receive('9002', '2026-09-05');
    await receive('9003', '2026-09-08', false);
    await receive('9004', '2026-09-10');
    await receive('9005', '2026-09-12');
    await receive('9006', '2026-09-14');
    await receive('1001', '2026-10-02');
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.journal.reverse',
      input: { entryId: voided.journalEntryId, entryDate: '2026-09-30', reason: 'Hóa đơn ghi nhầm' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() });
    expect(approved.body).toMatchObject({ voidedDocumentId: voided.documentId });
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

  it('stores an import upload as a spreadsheet that never reaches the Inbox, and refuses anything but .xlsx', async () => {
    const token = await tokenFor(owner);
    const xml = await upload(token, 'hd.xml', invoice('7777', '2026-09-01'));
    expect(xml.status).toBe(415);
    expect(xml.body.message).toMatch(/chỉ nhận tệp Excel dạng \.xlsx/);
    const xlsx = await upload(token, 'danh-sach.xlsx', portalListXlsx([spec('1', '2026-09-01')]));
    expect(xlsx.status).toBe(200);
    const fileId = xlsx.body.files[0].fileId as string;
    const row = await admin(async (c) => (await c.query('SELECT source, content_type, filename FROM crove_kernel.file WHERE id = $1', [fileId])).rows[0]);
    expect(row).toEqual({ source: 'import', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'danh-sach.xlsx' });
    const outbox = await admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM crove_kernel.outbox_event WHERE type = 'kernel.file.ingested' AND payload ->> 'fileId' = $1`, [fileId])).rows[0]);
    expect(outbox.n).toBe(0);
    const recent = await rpc('files/recent', token, undefined);
    expect(recent.body.map((f: { id: string }) => f.id)).not.toContain(fileId);
  });

  it('reconciles the period: missing, in the Inbox, amount mismatch, cancelled but booked, not on the portal', async () => {
    const { listId } = await importList(
      [
        spec('9001', '03/09/2026'),
        spec('9002', '05/09/2026'),
        spec('9003', '08/09/2026'),
        spec('9004', '10/09/2026', { total: 2_000_000 }),
        spec('9005', '12/09/2026', { status: 'Hóa đơn đã bị hủy' }),
        spec('9007', '20/09/2026', { sellerTaxCode: '0100109107', series: 'C26TXY' }),
        spec('9008', '21/09/2026', { status: 'Hóa đơn đã bị thay thế' }),
        // The same invoice twice (two overlapping exports).
        spec('9001', '03/09/2026'),
      ],
      '2026-09',
    );
    const result = await rpc('portalList/reconcile', await tokenFor(viewer), { period: '2026-09' });
    expect(result.status).toBe(200);
    expect(result.body.lists).toEqual([expect.objectContaining({ id: listId, status: 'done', rowCount: 8, listFrom: '2026-09-01', listTo: '2026-09-30', error: null })]);
    const byNumber = Object.fromEntries(
      result.body.items.map((i: any) => [i.portal?.number ?? i.crove?.number, { outcome: i.outcome, kind: i.crove?.kind ?? null, differences: i.differences, duplicateRows: i.duplicateRows }]),
    );
    expect(byNumber).toEqual({
      '9001': { outcome: 'matched', kind: 'document', differences: [], duplicateRows: 1 },
      '9002': { outcome: 'missing', kind: null, differences: [], duplicateRows: 0 },
      '9003': { outcome: 'in_inbox', kind: 'proposal', differences: [], duplicateRows: 0 },
      '9004': { outcome: 'amount_mismatch', kind: 'document', differences: ['total'], duplicateRows: 0 },
      '9005': { outcome: 'void_in_crove', kind: 'document', differences: [], duplicateRows: 0 },
      '9006': { outcome: 'not_on_portal', kind: 'document', differences: [], duplicateRows: 0 },
      '9007': { outcome: 'missing', kind: null, differences: [], duplicateRows: 0 },
      '9008': { outcome: 'void', kind: null, differences: [], duplicateRows: 0 },
    });
    expect(result.body.summary).toMatchObject({ portalInvoices: 7, matched: 1, inInbox: 1, amountMismatch: 1, missing: 2, voidInCrove: 1, void: 1, notOnPortal: 1, duplicateRows: 1 });
    // The template came from the booked document's proposal.
    expect(result.body.items.find((i: any) => i.portal?.number === '9001').crove).toMatchObject({ template: '1', series: 'C26TAB', sellerTaxCode: SELLER });
  });

  it('keeps lists and Crove-only invoices to their period', async () => {
    const october = await rpc('portalList/reconcile', await tokenFor(owner), { period: '2026-10' });
    expect(october.status).toBe(200);
    // No list for October: nothing is compared, so 1001 is not reported as missing from the portal.
    expect(october.body).toMatchObject({ lists: [], items: [], summary: { portalInvoices: 0, notOnPortal: 0 } });
    const quarter = await rpc('portalList/reconcile', await tokenFor(owner), { period: '2026-Q3' });
    expect(quarter.body.lists).toEqual([]);
    const september = await rpc('portalList/reconcile', await tokenFor(owner), { period: '2026-09' });
    expect(september.body.items.some((i: any) => i.crove?.number === '1001')).toBe(false);
  });

  it('refuses the same file twice in a period, and takes a removed list out of the reconciliation', async () => {
    const before = await rpc('portalList/reconcile', await tokenFor(owner), { period: '2026-09' });
    const [list] = before.body.lists;
    const again = await rpc('portalList/import', await tokenFor(owner), { period: '2026-09', fileId: list.fileId });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PORTAL_LIST_EXISTS');
    expect((await rpc('portalList/remove', await tokenFor(viewer), { listId: list.id })).status).toBe(403);
    expect((await rpc('portalList/remove', await tokenFor(owner), { listId: list.id })).status).toBe(200);
    expect((await rpc('portalList/remove', await tokenFor(owner), { listId: list.id })).status).toBe(404);
    const after = await rpc('portalList/reconcile', await tokenFor(owner), { period: '2026-09' });
    expect(after.body).toMatchObject({ lists: [], items: [] });
    // The same file may be imported again once its list is removed; the rows are read afresh.
    const reimported = await rpc('portalList/import', await tokenFor(owner), { period: '2026-09', fileId: list.fileId });
    expect(reimported.status).toBe(200);
    await importPortalList({ runtime: workerRuntime, store, extract }, org.orgId, reimported.body.listId);
    const restored = await rpc('portalList/reconcile', await tokenFor(owner), { period: '2026-09' });
    expect(restored.body.summary.missing).toBe(2);
    const removed = await admin(async (c) => (await c.query('SELECT removed_by FROM crove_finance.portal_invoice_list WHERE id = $1', [list.id])).rows[0]);
    expect(removed.removed_by).toBe(owner.userId);
  });

  it("records a list as failed when it is another company's, the sales list, or not a portal list", async () => {
    // Another company's purchases: the buyer column names it.
    const foreign = buildXlsx([PORTAL_HEADER, portalRow(1, { ...spec('1', '01/08/2026'), buyerTaxCode: '0100109107' })], { strings: 'inline' });
    const sales = portalListXlsx([spec('2', '02/08/2026', { sellerTaxCode: BUYER })]);
    const unknown = buildXlsx([['Mã TK', 'Tên TK'], ['111', 'Tiền mặt']]);
    const outcomes: Array<{ status: string; error: string | null }> = [];
    for (const bytes of [foreign, sales, unknown]) {
      const uploaded = await upload(await tokenFor(owner), 'ds.xlsx', bytes);
      const imported = await rpc('portalList/import', await tokenFor(owner), { period: '2026-08', fileId: uploaded.body.files[0].fileId });
      await importPortalList({ runtime: workerRuntime, store, extract }, org.orgId, imported.body.listId);
    }
    const august = await rpc('portalList/reconcile', await tokenFor(owner), { period: '2026-08' });
    for (const l of august.body.lists) outcomes.push({ status: l.status, error: l.error });
    expect(outcomes).toEqual([
      { status: 'failed', error: expect.stringContaining('mã số thuế 0100109107, không phải của công ty này (0309876546)') },
      { status: 'failed', error: expect.stringContaining('danh sách hóa đơn bán ra') },
      { status: 'failed', error: expect.stringContaining('Không nhận ra bảng danh sách hóa đơn') },
    ]);
    expect(august.body.items).toEqual([]);
  });

  it('lets only editors import, and keeps every list and file inside its org', async () => {
    const before = await rpc('portalList/reconcile', await tokenFor(owner), { period: '2026-09' });
    const fileId = before.body.lists[0].fileId as string;
    expect((await rpc('portalList/import', await tokenFor(viewer), { period: '2026-11', fileId })).status).toBe(403);
    // Another org cannot import this org's file, nor see its lists.
    const foreign = await rpc('portalList/import', await tokenFor(outsider), { period: '2026-09', fileId }, otherOrg.slug);
    expect(foreign.status).toBe(404);
    const theirs = await rpc('portalList/reconcile', await tokenFor(outsider), { period: '2026-09' }, otherOrg.slug);
    expect(theirs.body).toMatchObject({ lists: [], items: [] });
    expect((await rpc('portalList/reconcile', await tokenFor(outsider), { period: '2026-09' })).status).toBe(403);
    expect((await rpc('portalList/remove', await tokenFor(outsider), { listId: before.body.lists[0].id }, otherOrg.slug)).status).toBe(404);
    // An org without a tax code cannot import: a list could not be told apart from another company's.
    const own = await upload(await tokenFor(outsider), 'ds.xlsx', portalListXlsx([spec('1', '01/09/2026')]), 'import', otherOrg.slug);
    expect(own.status).toBe(200);
    const noTaxCode = await rpc('portalList/import', await tokenFor(outsider), { period: '2026-09', fileId: own.body.files[0].fileId }, otherOrg.slug);
    expect(noTaxCode.status).toBe(409);
    expect(noTaxCode.body.code).toBe('TAX_CODE_REQUIRED');
  });

  it('records the rows it could not read, so the period shows an incomplete comparison', async () => {
    const bytes = buildXlsx([PORTAL_HEADER, portalRow(1, spec('7001', '01/07/2026')), portalRow(2, spec('7002', '31/02/2026')), portalRow(3, { ...spec('7003', '02/07/2026'), sellerTaxCode: '12345' })], {
      strings: 'inline',
    });
    const uploaded = await upload(await tokenFor(owner), 'ds-07.xlsx', bytes);
    const imported = await rpc('portalList/import', await tokenFor(owner), { period: '2026-07', fileId: uploaded.body.files[0].fileId });
    await importPortalList({ runtime: workerRuntime, store, extract }, org.orgId, imported.body.listId);
    const july = await rpc('portalList/reconcile', await tokenFor(viewer), { period: '2026-07' });
    expect(july.body.lists).toEqual([
      expect.objectContaining({
        status: 'done',
        rowCount: 1,
        skippedCount: 2,
        skipped: [
          { rowNo: 3, reason: 'bad_date' },
          { rowNo: 4, reason: 'bad_tax_code' },
        ],
      }),
    ]);
    expect(july.body.summary.missing).toBe(1);
  });

  it('records a list once, and the database keeps an outcome and its rows from changing', async () => {
    const { lists } = (await rpc('portalList/reconcile', await tokenFor(owner), { period: '2026-09' })).body;
    const listId = lists[0].id as string;
    const again = await workerRuntime.execute<{ recorded: boolean }>(
      'finance.portal_list.record',
      { listId, status: 'failed', error: 'late' },
      { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
    );
    expect(again.recorded).toBe(false);
    await admin(async (c) => {
      await expect(c.query(`UPDATE crove_finance.portal_invoice_list SET status = 'failed', error = 'x' WHERE id = $1`, [listId])).rejects.toThrow(/already has its outcome/);
      await expect(c.query(`UPDATE crove_finance.portal_invoice_list SET period = '2026-10' WHERE id = $1`, [listId])).rejects.toThrow(/only its outcome/);
      await expect(c.query(`DELETE FROM crove_finance.portal_invoice_list WHERE id = $1`, [listId])).rejects.toThrow(/never deleted/);
      await expect(c.query(`UPDATE crove_finance.portal_invoice_row SET total = 0 WHERE list_id = $1`, [listId])).rejects.toThrow();
      await expect(
        c.query(
          `INSERT INTO crove_finance.portal_invoice_row (org_id, list_id, row_no, seller_tax_code, series, number, issue_date, status)
           VALUES ($1, $2, 999, $3, 'C26TAB', '1', '2026-09-01', 'original')`,
          [org.orgId, listId, SELLER],
        ),
      ).rejects.toThrow(/already has its outcome/);
    });
    const audits = await admin(async (c) => (await c.query(`SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.portal_list.%' AND outcome = 'ok' ORDER BY occurred_at`, [org.orgId])).rows);
    expect(audits.map((a) => a.command)).toEqual(expect.arrayContaining(['finance.portal_list.import', 'finance.portal_list.record', 'finance.portal_list.remove']));
  });
});
