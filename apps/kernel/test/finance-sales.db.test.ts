// Sales (output) e-invoices (issue #313), on a real PostgreSQL 17, through the HTTP API where a user would act: the
// org's tax code in Settings, an invoice whose seller is the org read as a sale (a customer party and Dr 131, Cr 511,
// Cr 3331), duplicates refused, the sale in the documents list, the journal, the VAT working's output side and the MISA
// sales export, and purchases kept apart from sales everywhere.
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
import { extractAndPropose, financeCommands, financeQueries, salesRows, type PurchaseVoucher, type SalesVoucher } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url)).toString('utf8');
const SECRET = 'test-only-jwt-secret-for-sales-0123456789abc';
const ISSUER = 'crove-auth';
// The fixture's seller and buyer (fake tax codes, see the MST fixture guard). The org is the seller in this suite.
const SELLER_TAX_CODE = '0101234564';
const BUYER_TAX_CODE = '0309876546';

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

suite('sales e-invoices (#313)', () => {
  const dbName = `crove_test_sales_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const owner: Account = { subject: randomUUID(), email: 'owner@sales.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@sales.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };

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

  // The fixture under another number; `purchase` swaps seller and buyer, so the org buys from the fixture's buyer.
  const invoice = (number: string, options: { salt?: string; purchase?: boolean } = {}) => {
    let xml = FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`);
    if (options.purchase) {
      xml = xml.replace(`<MST>${SELLER_TAX_CODE}</MST>`, '<MST>__SELLER__</MST>').replace(`<MST>${BUYER_TAX_CODE}</MST>`, `<MST>${SELLER_TAX_CODE}</MST>`);
      xml = xml.replace('<MST>__SELLER__</MST>', `<MST>${BUYER_TAX_CODE}</MST>`);
    }
    return new TextEncoder().encode(xml + (options.salt ?? ''));
  };

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

  const read = async (bytes: Uint8Array) =>
    String(
      (await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, await ingest(bytes))).proposalId,
    );

  const approve = (id: string, extra: Record<string, unknown> = {}) =>
    runtime.execute<{ documentId: string; journalEntryId: string }>(
      'kernel.proposal.approve',
      { id, revision: 1, ...extra },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

  const setTaxCode = async (taxCode: string | null, who: Account = owner) => rpc('org/setTaxCode', await tokenFor(who), { taxCode });

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

    for (const who of [owner, viewer]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Bán hàng', idempotencyKey: randomUUID() }, null);
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

  it('records an invoice as a purchase while the org has no tax code', async () => {
    expect((await rpc('org/get', await tokenFor(owner), undefined)).body).toMatchObject({ taxCode: null });
    const proposalId = await read(invoice('5000'));
    const detail = await rpc('inbox/get', await tokenFor(owner), { id: proposalId });
    expect(detail.body.payload.direction).toBeUndefined();
    expect(detail.body).toMatchObject({ direction: 'purchase', buyerName: null });
    await runtime.execute('kernel.proposal.reject', { id: proposalId }, { actor: asUser(owner.userId), orgId: org.orgId });
  });

  it('lets owners and admins set the tax code, normalized and audited, and refuses an invalid one', async () => {
    expect(await setTaxCode('0101234564', viewer)).toMatchObject({ status: 403 });
    expect(await setTaxCode('12345')).toMatchObject({ status: 422, body: { code: 'INVALID_TAX_CODE' } });
    expect(await setTaxCode(' 0101.234.564 ')).toMatchObject({ status: 200, body: { taxCode: SELLER_TAX_CODE } });
    expect((await rpc('org/get', await tokenFor(viewer), undefined)).body).toMatchObject({ taxCode: SELLER_TAX_CODE });
    const audits = await admin(
      async (c) =>
        (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.set_tax_code' AND outcome = 'ok'`, [org.orgId])).rows,
    );
    expect(audits.map((a) => a.detail)).toContainEqual({ previous: null, taxCode: SELLER_TAX_CODE });
    // The database holds the same shape for every writer.
    await expect(admin((c) => c.query(`UPDATE crove_kernel.tenant SET tax_code = 'MST-1' WHERE org_id = $1`, [org.orgId]))).rejects.toMatchObject({ code: '23514' });
  });

  let saleProposal = '';
  let saleDocument = '';
  let saleEntry = '';

  it('reads an invoice the org issued as a sale: the buyer is the customer, Dr 131, Cr 511, Cr 3331', async () => {
    saleProposal = await read(invoice('5001'));
    const list = await rpc('inbox/list', await tokenFor(owner), { status: 'pending' });
    expect(list.body.find((i: { id: string }) => i.id === saleProposal)).toMatchObject({
      direction: 'sale',
      sellerName: 'CÔNG TY TNHH DỊCH VỤ MẪU',
      buyerName: 'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU',
      title: 'HĐ bán C26TAB-5001 CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU',
    });
    const detail = await rpc('inbox/get', await tokenFor(owner), { id: saleProposal });
    expect(detail.body.payload).toMatchObject({ direction: 'sale', buyer: { taxCode: BUYER_TAX_CODE } });
    expect(detail.body.payload.lines.map((l: { debitAccount: string }) => l.debitAccount)).toEqual(['511', '511', '511']);
    expect(detail.body.payload.journal.map((j: { accountCode: string; debit: string; credit: string }) => [j.accountCode, j.debit, j.credit])).toEqual([
      ['131', '1980000', '0'],
      ['511', '0', '1800000'],
      ['3331', '0', '180000'],
    ]);

    const recorded = await approve(saleProposal);
    saleDocument = recorded.documentId;
    saleEntry = recorded.journalEntryId;
    const [doc] = await admin(
      async (c) =>
        (
          await c.query(
            `SELECT d.direction, p.name, p.tax_code FROM crove_finance.purchase_document d JOIN crove_kernel.party p ON p.org_id = d.org_id AND p.id = d.party_id WHERE d.id = $1`,
            [saleDocument],
          )
        ).rows,
    );
    expect(doc).toEqual({ direction: 'sale', name: 'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU', tax_code: BUYER_TAX_CODE });
    const lines = await admin(
      async (c) => (await c.query(`SELECT debit_account, credit_account FROM crove_finance.purchase_line WHERE document_id = $1 ORDER BY line_no`, [saleDocument])).rows,
    );
    expect(lines).toEqual(lines.map(() => ({ debit_account: null, credit_account: '511' })));
    // The receivable carries the customer; no vendor default is remembered for a customer.
    const journal = await admin(
      async (c) =>
        (await c.query(`SELECT account_code, debit::text, credit::text, party_id FROM crove_finance.journal_line WHERE entry_id = $1 ORDER BY line_no`, [saleEntry])).rows,
    );
    expect(journal.map((l) => [l.account_code, money(l.debit).toFixed(), money(l.credit).toFixed(), l.party_id !== null])).toEqual([
      ['131', '1980000', '0', true],
      ['511', '0', '1800000', false],
      ['3331', '0', '180000', false],
    ]);
    expect((await admin((c) => c.query(`SELECT 1 FROM crove_finance.vendor_account_rule WHERE org_id = $1`, [org.orgId]))).rowCount).toBe(0);
  });

  it('refuses a duplicate sale, whoever the customer is named', async () => {
    const copy = await read(invoice('5001', { salt: '\n' }));
    const detail = await rpc('inbox/get', await tokenFor(owner), { id: copy });
    expect(detail.body.payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'duplicate', status: 'fail' })]));
    // The checks keep their code and parameters (#677) through kernel.extraction.record, in the proposal and the run.
    expect(detail.body.payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'duplicate', code: 'duplicate.found' }),
        expect.objectContaining({ id: 'issue_date', code: 'issue_date.ok', params: { date: expect.any(String) } }),
      ]),
    );
    const [run] = await admin(
      async (c) =>
        (await c.query(`SELECT r.checks FROM crove_kernel.extraction r JOIN crove_kernel.proposal p ON p.org_id = r.org_id AND p.source_file_id = r.file_id WHERE p.id = $1`, [copy])).rows,
    );
    expect(run?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'duplicate.found' })]));
    await expect(approve(copy, { acceptFailedChecks: true })).rejects.toMatchObject({ code: 'DUPLICATE_INVOICE', status: 409 });
    await runtime.execute('kernel.proposal.reject', { id: copy }, { actor: asUser(owner.userId), orgId: org.orgId });
    // The same series and number issued to someone else (here a customer with no tax code) is still the same invoice.
    const renamed = new TextEncoder().encode(
      FIXTURE.replace('<SHDon>1234</SHDon>', '<SHDon>5001</SHDon>').replace('CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU', 'Khách lẻ').replace(`<MST>${BUYER_TAX_CODE}</MST>`, ''),
    );
    const other = await read(renamed);
    await expect(approve(other, { acceptFailedChecks: true })).rejects.toMatchObject({ code: 'DUPLICATE_INVOICE', status: 409 });
    await runtime.execute('kernel.proposal.reject', { id: other }, { actor: asUser(owner.userId), orgId: org.orgId });
  });

  let purchaseDocument = '';

  it('keeps a purchase with the same series and number apart from the sale', async () => {
    // The fixture's buyer sells to the org: a purchase, its own invoice numbering.
    const proposalId = await read(invoice('5001', { purchase: true }));
    const detail = await rpc('inbox/get', await tokenFor(owner), { id: proposalId });
    expect(detail.body).toMatchObject({ direction: 'purchase' });
    expect(detail.body.payload.checks.find((c: { id: string }) => c.id === 'duplicate')).toBeUndefined();
    purchaseDocument = (await approve(proposalId)).documentId;

    const docs = await rpc('documents/list', await tokenFor(viewer), {});
    expect(docs.body.map((d: { id: string; direction: string }) => [d.id, d.direction])).toEqual(
      expect.arrayContaining([
        [saleDocument, 'sale'],
        [purchaseDocument, 'purchase'],
      ]),
    );
    // The journal shows the sale's document and its direction.
    expect((await rpc('journal/get', await tokenFor(viewer), { id: saleEntry })).body.document).toMatchObject({ id: saleDocument, direction: 'sale' });
    // Vendors: the supplier of the purchase, not a customer that never sold to the org. Here the fixture's buyer is
    // both (it bought from the org and sold to it), so it is listed with its one purchase.
    const vendors = await rpc('parties/list', await tokenFor(viewer), {});
    expect(vendors.body).toEqual([expect.objectContaining({ taxCode: BUYER_TAX_CODE, documentCount: 1 })]);
  });

  it('fills the output side of the VAT working with sales and keeps them out of the input side', async () => {
    const report = await rpc('vat/period', await tokenFor(viewer), { period: '2026-09' });
    expect(report.status).toBe(200);
    expect(report.body.output).toMatchObject({ available: true, documents: [expect.objectContaining({ id: saleDocument, partyTaxCode: BUYER_TAX_CODE })] });
    expect(report.body.input.documents.map((d: { id: string }) => d.id)).toEqual([purchaseDocument]);
    const indicator = (code: string) => report.body.indicators.find((i: { code: string }) => i.code === code)?.amount;
    expect([indicator('32'), indicator('33'), indicator('23'), indicator('24')]).toEqual(['1800000', '180000', '1800000', '180000']);
  });

  it('exports the sales vouchers for MISA, and only purchases in the purchase export', async () => {
    const sales = await runtime.query<SalesVoucher[]>('finance.vouchers.sales', {}, { actor: asUser(viewer.userId), orgId: org.orgId });
    expect(sales.map((v) => v.entryId)).toEqual([saleEntry]);
    expect(sales[0]).toMatchObject({ customer: { taxCode: BUYER_TAX_CODE }, receivableAccount: '131', vatAccount: '3331' });
    const rows = salesRows(sales[0] as SalesVoucher);
    expect(rows.map((r) => r.line.revenueAccount)).toEqual(['511', '511', '511']);
    expect(sum(rows.map((r) => r.vatAmount)).eq(money('180000'))).toBe(true);
    const purchases = await runtime.query<PurchaseVoucher[]>('finance.vouchers.purchases', {}, { actor: asUser(viewer.userId), orgId: org.orgId });
    expect(purchases.map((v) => v.invoice.number)).toEqual(['5001']);
    expect(purchases[0]?.vendor.taxCode).toBe(BUYER_TAX_CODE);

    const response = await app.request('/api/export/misa/sales.xlsx', { headers: { authorization: `Bearer ${await tokenFor(viewer)}`, 'x-crove-org': org.slug } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('crove-misa-ban-hang-');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe('PK');
    const audits = await admin(
      async (c) =>
        (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.journal.export' AND outcome = 'ok'`, [org.orgId])).rows,
    );
    expect(audits.map((a) => a.detail)).toContainEqual({ entries: 1, format: 'misa_sme_sales' });
  });

  it('books an invoice on the side the tax code says when it is approved', async () => {
    // A sale proposal whose org tax code changed before approval is refused.
    const sale = await read(invoice('5002'));
    expect(await setTaxCode('0312345678')).toMatchObject({ status: 200 });
    await expect(approve(sale)).rejects.toMatchObject({ code: 'NOT_OWN_SALE', status: 422 });
    // A purchase proposal raised before the org set its tax code, for an invoice the org issued, is refused too.
    expect(await setTaxCode(null)).toMatchObject({ status: 200, body: { taxCode: null } });
    const purchase = await read(invoice('5003'));
    expect((await rpc('inbox/get', await tokenFor(owner), { id: purchase })).body).toMatchObject({ direction: 'purchase' });
    expect(await setTaxCode(SELLER_TAX_CODE)).toMatchObject({ status: 200 });
    await expect(approve(purchase)).rejects.toMatchObject({ code: 'OWN_INVOICE', status: 422 });
    // With the tax code back, the sale records.
    await expect(approve(sale)).resolves.toMatchObject({ documentId: expect.any(String) });
  });

  it('refuses only the stale sale of a bulk approval and approves the rest', async () => {
    const sale = await read(invoice('5004'));
    const purchase = await read(invoice('5004', { purchase: true }));
    expect(await setTaxCode('0312345678')).toMatchObject({ status: 200 });
    try {
      const { results } = await runtime.execute<{ results: Array<{ id: string; outcome: string; code?: string }> }>(
        'kernel.proposal.approve_many',
        { items: [{ id: sale, revision: 1 }, { id: purchase, revision: 1 }] },
        { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
      );
      expect(results).toEqual([
        expect.objectContaining({ id: sale, outcome: 'refused', code: 'NOT_OWN_SALE' }),
        expect.objectContaining({ id: purchase, outcome: 'approved' }),
      ]);
    } finally {
      expect(await setTaxCode(SELLER_TAX_CODE)).toMatchObject({ status: 200 });
    }
    await runtime.execute('kernel.proposal.reject', { id: sale }, { actor: asUser(owner.userId), orgId: org.orgId });
  });

  it('holds every writer to one account per line, the one of its document direction', async () => {
    await admin(async (c) => {
      const refused = async (statement: string, params: unknown[]) => {
        await c.query('BEGIN');
        try {
          await c.query(statement, params);
          return null;
        } catch (error) {
          return (error as { code?: string }).code ?? 'error';
        } finally {
          await c.query('ROLLBACK');
        }
      };
      const insertLine = `INSERT INTO crove_finance.purchase_line (org_id, document_id, line_no, description, amount, debit_account, credit_account) VALUES ($1, $2, 99, 'x', 1, $3, $4)`;
      expect(await refused(insertLine, [org.orgId, saleDocument, '6422', null])).toBe('23514');
      expect(await refused(insertLine, [org.orgId, purchaseDocument, null, '511'])).toBe('23514');
      expect(await refused(insertLine, [org.orgId, saleDocument, '6422', '511'])).toBe('23514');
      // A revenue code (#430) the chart does not have.
      expect(await refused(insertLine, [org.orgId, saleDocument, null, '5199'])).toBe('23503');
      expect(await refused(`UPDATE crove_finance.purchase_document SET direction = 'purchase' WHERE id = $1`, [saleDocument])).not.toBeNull();
    });
  });

  it('credits a sale line only to a revenue account and never debits a purchase line to one, for every writer (#430)', async () => {
    const insertLine = `INSERT INTO crove_finance.purchase_line (org_id, document_id, line_no, description, amount, debit_account, credit_account) VALUES ($1, $2, 99, 'x', 1, $3, $4)`;
    // Each statement in its own transaction, rolled back: as the superuser, and as crove_app in the owner's context of
    // the org (crove_tenant, row security on), which writes the accepted rows too, so a refusal is the trigger's.
    const outcome = async (c: pg.Client, enter: boolean, params: unknown[]) => {
      await c.query('BEGIN');
      try {
        if (enter) await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, org.orgId]);
        await c.query(insertLine, params);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'error';
      } finally {
        await c.query('ROLLBACK');
      }
    };
    for (const [url, enter] of [
      [adminUrl, false],
      [appUrl, true],
    ] as const) {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        const where = enter ? 'as crove_tenant' : 'as the superuser';
        for (const account of ['511', '5113', '515', '711', '3387']) expect(await outcome(c, enter, [org.orgId, saleDocument, null, account]), `${where}: sale on ${account}`).toBeNull();
        for (const account of ['6422', '131', '3331', '338']) expect(await outcome(c, enter, [org.orgId, saleDocument, null, account]), `${where}: sale on ${account}`).toBe('23514');
        for (const account of ['511', '5113', '711', '3387']) expect(await outcome(c, enter, [org.orgId, purchaseDocument, account, null]), `${where}: purchase on ${account}`).toBe('23514');
        expect(await outcome(c, enter, [org.orgId, purchaseDocument, '6422', null]), `${where}: purchase on 6422`).toBeNull();
        // One account per line, the one of the document's direction, holds for crove_tenant as for the superuser.
        expect(await outcome(c, enter, [org.orgId, saleDocument, '6422', null]), `${where}: sale with a debit account`).toBe('23514');
        expect(await outcome(c, enter, [org.orgId, purchaseDocument, null, '511']), `${where}: purchase with a credit account`).toBe('23514');
        expect(await outcome(c, enter, [org.orgId, saleDocument, '6422', '511']), `${where}: both accounts`).toBe('23514');
      } finally {
        await c.end();
      }
    }
  });

  it('answers a non-revenue account on a sale line, and a revenue account on a purchase line, with the line (#430)', async () => {
    const sale = await read(invoice('5010'));
    const purchase = await read(invoice('5010', { purchase: true }));
    const edit = async (id: string, debitAccount: string, revision = 1) =>
      rpc('inbox/edit', await tokenFor(owner), { id, revision, lineAccounts: [{ lineNo: 2, debitAccount }], idempotencyKey: randomUUID() });
    expect(await edit(sale, '6422')).toMatchObject({ status: 422, body: { code: 'NOT_REVENUE_ACCOUNT' } });
    expect(await edit(purchase, '511')).toMatchObject({ status: 422, body: { code: 'REVENUE_ACCOUNT_ON_PURCHASE' } });
    expect(await edit(purchase, '5113.DV')).toMatchObject({ status: 422, body: { code: 'REVENUE_ACCOUNT_ON_PURCHASE' } });
    expect(await edit(sale, '5113')).toMatchObject({ status: 200 });
    // A stored revision with a wrong account (written past the edit, here by the superuser) is refused when approved.
    await admin((c) => c.query(`UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{lines,0,debitAccount}', '"511"') WHERE org_id = $1 AND id = $2`, [org.orgId, purchase]));
    await expect(approve(purchase)).rejects.toMatchObject({ code: 'REVENUE_ACCOUNT_ON_PURCHASE', status: 422 });
    for (const id of [sale, purchase]) await runtime.execute('kernel.proposal.reject', { id }, { actor: asUser(owner.userId), orgId: org.orgId });
  });

  it('voids a sale by reversing its entry, and records the invoice again in its place', async () => {
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.journal.reverse',
      input: { entryId: saleEntry, entryDate: '2026-10-15', reason: 'Ghi nhầm doanh thu' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    expect(await approve(String(asked.body.proposalId))).toMatchObject({ voidedDocumentId: saleDocument });
    // The voided sale is no longer a duplicate: the same invoice records again and names the document it replaces.
    const again = await approve(await read(invoice('5001', { salt: '\n\n' })));
    const [row] = await admin(
      async (c) => (await c.query(`SELECT direction, replaces_document_id FROM crove_finance.purchase_document WHERE id = $1`, [again.documentId])).rows,
    );
    expect(row).toEqual({ direction: 'sale', replaces_document_id: saleDocument });
    // A purchase document cannot stand in for a voided sale, nor a sale for a purchase.
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await expect(
          c.query(
            `INSERT INTO crove_finance.purchase_document (org_id, direction, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, replaces_document_id)
             SELECT org_id, 'purchase', party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, id FROM crove_finance.purchase_document WHERE id = $1`,
            [saleDocument],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });
  it('reads an invoice from a branch of the org as a sale and keeps the branch code, and a branch of a supplier as a purchase (#686)', async () => {
    const branch = `${SELLER_TAX_CODE}-001`;
    const fromBranch = new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', '<SHDon>6001</SHDon>').replace(`<MST>${SELLER_TAX_CODE}</MST>`, `<MST>${branch}</MST>`));
    const sale = await read(fromBranch);
    const saleDetail = await rpc('inbox/get', await tokenFor(owner), { id: sale });
    expect(saleDetail.body).toMatchObject({ direction: 'sale' });
    expect(saleDetail.body.payload).toMatchObject({ direction: 'sale', seller: { taxCode: branch }, buyer: { taxCode: BUYER_TAX_CODE } });
    expect(saleDetail.body.payload.journal.map((j: { accountCode: string }) => j.accountCode)).toEqual(['131', '511', '3331']);
    const recorded = await approve(sale);
    const [doc] = await admin(async (c) => (await c.query(`SELECT direction FROM crove_finance.purchase_document WHERE id = $1`, [recorded.documentId])).rows);
    expect(doc).toEqual({ direction: 'sale' });

    // A supplier's branch selling to the org: still a purchase, and approved as one.
    const supplierBranch = `${BUYER_TAX_CODE}-002`;
    const purchaseXml = new TextDecoder().decode(invoice('6002', { purchase: true })).replace(`<MST>${BUYER_TAX_CODE}</MST>`, `<MST>${supplierBranch}</MST>`);
    const purchase = await read(new TextEncoder().encode(purchaseXml));
    const purchaseDetail = await rpc('inbox/get', await tokenFor(owner), { id: purchase });
    expect(purchaseDetail.body).toMatchObject({ direction: 'purchase' });
    expect(purchaseDetail.body.payload).toMatchObject({ seller: { taxCode: supplierBranch } });
    await expect(approve(purchase)).resolves.toMatchObject({ documentId: expect.any(String) });
  });
});
