// Customers (issue #670), on a real PostgreSQL 17, through the HTTP API where a user would act: the customers of the
// org's sales invoices with their tax code, receivable on 131 (a receipt and a voided sale included) and latest invoice,
// searched by name and tax code, a page at a time; vendors left out; corrections of a party's name, tax code and email
// by owners and admins only, audited, with a tax code kept to one party; and nothing of one org read or changed from
// another.
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
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url)).toString('utf8');
const SECRET = 'test-only-jwt-secret-for-customers-0123456789';
const ISSUER = 'crove-auth';
// The fixture's seller (the org here) and buyer, and a second buyer and a vendor: fake tax codes, see the MST fixture
// guard.
const SELLER_TAX_CODE = '0101234564';
const BUYER = 'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU';
const BUYER_TAX_CODE = '0309876546';
const OTHER_BUYER = 'Công ty TNHH Khách Hàng Thứ Hai';
const OTHER_TAX_CODE = '0312345678';
const VENDOR_TAX_CODE = '0108888887';

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

interface CustomerRow {
  id: string;
  name: string;
  taxCode: string | null;
  email: string | null;
  invoiceCount: number;
  lastInvoiceDate: string | null;
  receivable: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('customers (#670)', () => {
  const dbName = `crove_test_customers_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@customers.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@customers.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let other = { slug: '', orgId: '' };

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

  const customers = async (input: Record<string, unknown> = {}, who: Account = viewer, slug = org.slug) => rpc('parties/customers', await tokenFor(who), input, slug);
  const update = async (input: Record<string, unknown>, who: Account = owner, slug = org.slug) => rpc('parties/update', await tokenFor(who), input, slug);

  // The fixture under another number and date, sold to another buyer, or bought from a vendor (the org is the buyer).
  const invoice = (number: string, options: { date?: string; buyer?: { name: string; taxCode: string | null }; vendorTaxCode?: string } = {}) => {
    let xml = FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`);
    if (options.date) xml = xml.replace('<NLap>2026-09-15</NLap>', `<NLap>${options.date}</NLap>`);
    if (options.buyer) {
      xml = xml.replace(BUYER, options.buyer.name).replace(`<MST>${BUYER_TAX_CODE}</MST>`, options.buyer.taxCode ? `<MST>${options.buyer.taxCode}</MST>` : '');
    }
    if (options.vendorTaxCode) {
      xml = xml.replace(`<MST>${SELLER_TAX_CODE}</MST>`, `<MST>${options.vendorTaxCode}</MST>`).replace(`<MST>${BUYER_TAX_CODE}</MST>`, `<MST>${SELLER_TAX_CODE}</MST>`);
    }
    return new TextEncoder().encode(xml);
  };

  async function record(bytes: Uint8Array) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId);
    return approve(String(proposalId));
  }

  const approve = (id: string) =>
    runtime.execute<{ documentId: string; journalEntryId: string }>('kernel.proposal.approve', { id, revision: 1 }, { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() });

  const byName = (rows: CustomerRow[], name: string) => rows.find((r) => r.name === name);

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

    for (const who of [owner, viewer]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    for (const [name, target] of [
      ['Công ty Bán hàng', 'org'],
      ['Công ty Khác', 'other'],
    ] as const) {
      const created = await rpc('org/create', await tokenFor(owner), { name, idempotencyKey: randomUUID() }, null);
      expect(created.status).toBe(200);
      const value = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
      if (target === 'org') org = value;
      else other = value;
    }
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: viewer.email, role: 'viewer' });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(viewer), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    expect((await rpc('org/setTaxCode', await tokenFor(owner), { taxCode: SELLER_TAX_CODE })).status).toBe(200);
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

  let buyerId = '';
  let otherBuyerId = '';
  let lateSaleEntry = '';

  it('lists the customers of sales with their tax code, receivable on 131 and latest invoice, and leaves vendors out', async () => {
    expect(await customers()).toMatchObject({ status: 200, body: { items: [], more: false } });
    await record(invoice('7001'));
    lateSaleEntry = (await record(invoice('7002', { date: '2026-10-02' }))).journalEntryId;
    await record(invoice('7003', { buyer: { name: OTHER_BUYER, taxCode: OTHER_TAX_CODE } }));
    // A purchase: its seller is a vendor, not a customer.
    await record(invoice('8001', { vendorTaxCode: VENDOR_TAX_CODE }));

    const page = await customers();
    expect(page.status).toBe(200);
    expect(page.body.more).toBe(false);
    expect(page.body.items.map((c: CustomerRow) => c.name)).toEqual([BUYER, OTHER_BUYER]);
    const buyer = byName(page.body.items, BUYER);
    expect(buyer).toMatchObject({ taxCode: BUYER_TAX_CODE, invoiceCount: 2, lastInvoiceDate: '2026-10-02', receivable: '3960000' });
    expect(byName(page.body.items, OTHER_BUYER)).toMatchObject({ taxCode: OTHER_TAX_CODE, invoiceCount: 1, lastInvoiceDate: '2026-09-15', receivable: '1980000' });
    buyerId = String(buyer?.id);
    otherBuyerId = String(byName(page.body.items, OTHER_BUYER)?.id);
    // The vendors screen keeps listing vendors only.
    const vendors = await rpc('parties/list', await tokenFor(viewer), {});
    expect(vendors.body.map((v: { taxCode: string }) => v.taxCode)).toEqual([VENDOR_TAX_CODE]);
  });

  it('counts a receipt against the receivable, and a voided sale out of the invoices and the balance', async () => {
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.voucher.record',
      input: { type: 'cash_receipt', date: '2026-10-05', cashAccount: '1111', partyId: buyerId, description: 'Thu tiền HĐ 7001', lines: [{ account: '131', amount: '500000' }] },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    await approve(String(asked.body.proposalId));
    expect(byName((await customers()).body.items, BUYER)).toMatchObject({ invoiceCount: 2, receivable: '3460000' });

    const reversal = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.journal.reverse',
      input: { entryId: lateSaleEntry, entryDate: '2026-10-06', reason: 'Lập nhầm hóa đơn' },
      idempotencyKey: randomUUID(),
    });
    expect(reversal.status).toBe(200);
    await approve(String(reversal.body.proposalId));
    expect(byName((await customers()).body.items, BUYER)).toMatchObject({ invoiceCount: 1, lastInvoiceDate: '2026-09-15', receivable: '1480000' });
  });

  it('searches by name and tax code on the server', async () => {
    const names = async (q: string) => (await customers({ q })).body.items.map((c: CustomerRow) => c.name);
    expect(await names('thứ hai')).toEqual([OTHER_BUYER]);
    expect(await names('NGƯỜI MUA')).toEqual([BUYER]);
    expect(await names('030987')).toEqual([BUYER]);
    expect(await names(VENDOR_TAX_CODE)).toEqual([]);
    expect(await names('%')).toEqual([BUYER, OTHER_BUYER]);
  });

  it('pages by name: a page starts after the last customer shown', async () => {
    // 51 more customers with a 131 line each (as an opening balance would name them), past one page of 50.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO crove_kernel.party (org_id, name) SELECT $1, 'Khách ' || lpad(g::text, 2, '0') FROM generate_series(1, 51) AS g`,
        [org.orgId],
      );
      await c.query('COMMIT');
    });
    const ids = await admin(async (c) => (await c.query(`SELECT id FROM crove_kernel.party WHERE org_id = $1 AND name LIKE 'Khách __' ORDER BY name`, [org.orgId])).rows);
    expect(ids).toHaveLength(51);
    // Lines on 131 by the superuser, balanced against 3388: enough for the list, which reads posted lines only.
    await admin(async (c) => {
      await c.query('BEGIN');
      const { rows } = await c.query(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-09-30', 'Số dư khách hàng', 'test', gen_random_uuid()) RETURNING id`,
        [org.orgId],
      );
      const entry = rows[0].id;
      let lineNo = 1;
      for (const { id } of ids) {
        await c.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, $3, '131', 1000, 0, $4)`, [
          org.orgId,
          entry,
          lineNo++,
          id,
        ]);
      }
      await c.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, '3388', 0, $4)`, [
        org.orgId,
        entry,
        lineNo,
        ids.length * 1000,
      ]);
      await c.query('COMMIT');
    });
    const first = await customers();
    expect(first.body.items).toHaveLength(50);
    expect(first.body.more).toBe(true);
    const last = first.body.items.at(-1) as CustomerRow;
    const second = await customers({ after: { name: last.name, id: last.id } });
    expect(second.body.more).toBe(false);
    const all = [...first.body.items, ...second.body.items].map((c: CustomerRow) => c.name);
    expect(all).toHaveLength(53);
    expect(new Set(all).size).toBe(53);
    expect(all.slice(0, 4)).toEqual([BUYER, OTHER_BUYER, 'Khách 01', 'Khách 02']);
    expect(all.at(-1)).toBe('Khách 51');
    expect(byName(second.body.items, 'Khách 51') ?? byName(first.body.items, 'Khách 51')).toMatchObject({ invoiceCount: 0, lastInvoiceDate: null, receivable: '1000' });
  });

  it('lets owners and admins correct a name, tax code and email, audited, and nobody else', async () => {
    expect(await update({ partyId: buyerId, name: 'Đổi tên' }, viewer)).toMatchObject({ status: 403 });
    expect(await update({ partyId: buyerId, taxCode: '12345' })).toMatchObject({ status: 422, body: { code: 'INVALID_TAX_CODE' } });
    expect(await update({ partyId: buyerId, taxCode: OTHER_TAX_CODE })).toMatchObject({ status: 409, body: { code: 'TAX_CODE_TAKEN' } });
    expect(await update({ partyId: randomUUID(), name: 'Không có' })).toMatchObject({ status: 404, body: { code: 'PARTY_NOT_FOUND' } });

    const renamed = await update({ partyId: buyerId, name: 'Công ty CP Người Mua Mẫu', taxCode: ' 0309.876.546-001 ', email: 'ketoan@nguoimua.test' });
    expect(renamed).toMatchObject({ status: 200, body: { partyId: buyerId, name: 'Công ty CP Người Mua Mẫu', taxCode: '0309876546-001', email: 'ketoan@nguoimua.test' } });
    expect(byName((await customers({ q: '0309876546-001' })).body.items, 'Công ty CP Người Mua Mẫu')).toMatchObject({ id: buyerId, email: 'ketoan@nguoimua.test', receivable: '1480000' });
    // Nothing to change: the audit row says so.
    expect(await update({ partyId: buyerId, email: 'ketoan@nguoimua.test' })).toMatchObject({ status: 200 });
    expect(await update({ partyId: otherBuyerId, email: null })).toMatchObject({ status: 200 });

    const audits = await admin(
      async (c) =>
        (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.party.update' AND outcome = 'ok' ORDER BY occurred_at, id`, [org.orgId])).rows,
    );
    expect(audits.map((a) => a.detail)).toEqual([
      { partyId: buyerId, changed: ['name', 'taxCode', 'email'], taxCode: '0309876546-001', previousTaxCode: BUYER_TAX_CODE },
      { partyId: buyerId, changed: [] },
      { partyId: otherBuyerId, changed: [] },
    ]);
    const [party] = await admin(async (c) => (await c.query(`SELECT source_trust, version, verified_by FROM crove_kernel.party WHERE id = $1`, [buyerId])).rows);
    expect(party).toEqual({ source_trust: 'user', version: 2, verified_by: owner.userId });
    // The posted documents and lines keep naming the same party.
    const docs = await rpc('documents/list', await tokenFor(viewer), {});
    expect(docs.body.filter((d: { partyId: string }) => d.partyId === buyerId).map((d: { partyName: string }) => d.partyName)).toEqual([
      'Công ty CP Người Mua Mẫu',
      'Công ty CP Người Mua Mẫu',
    ]);
  });

  it('reads and changes nothing of one org from another', async () => {
    expect(await customers({}, owner, other.slug)).toMatchObject({ status: 200, body: { items: [], more: false } });
    expect(await customers({ q: BUYER_TAX_CODE.slice(0, 6) }, owner, other.slug)).toMatchObject({ status: 200, body: { items: [] } });
    expect(await update({ partyId: buyerId, name: 'Chiếm' }, owner, other.slug)).toMatchObject({ status: 404, body: { code: 'PARTY_NOT_FOUND' } });
    // The viewer is not a member of the other org.
    expect((await customers({}, viewer, other.slug)).status).toBe(403);
    const [party] = await admin(async (c) => (await c.query(`SELECT name FROM crove_kernel.party WHERE id = $1`, [buyerId])).rows);
    expect(party?.name).toBe('Công ty CP Người Mua Mẫu');
  });
});
