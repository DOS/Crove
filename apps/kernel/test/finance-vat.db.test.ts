// VAT working per month or quarter (issue #316), on a real PostgreSQL 17, through the HTTP API: the period's purchase
// invoices by rate (voided documents left out), month and quarter ranges, the form 01/GTGT indicators, the empty sales
// side, the Excel export with its audit row, the roles and the org boundary; then the HTKK XML of form 01/GTGT
// (#332): refused without the org tax code, its audit row, the roles and the org boundary; then a mixed-rate invoice
// split by its own VAT table (#685), beside one without the table, estimated as before. The totals logic itself is
// unit-tested in modules/finance/test/vat-return.test.ts.
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
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const SECRET = 'test-only-jwt-secret-for-vat-working-0123456789';
const ISSUER = 'crove-auth';

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

suite('VAT working per month or quarter (#316)', () => {
  const dbName = `crove_test_vat_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@vat.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@vat.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@vat.test', session: randomUUID(), userId: '' };
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

  // The fixture invoice (1,800,000 at 10%, VAT 180,000) under another number and date.
  const invoice = (number: string, date: string) =>
    new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('<NLap>2026-09-15</NLap>', `<NLap>${date}</NLap>`));

  // Uploads, reads and approves one invoice; returns its document and journal entry.
  async function record(number: string, date: string, bytes = invoice(number, date)) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-17' }, org.orgId, fileId);
    return runtime.execute<{ documentId: string; journalEntryId: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id: proposalId, revision: 1 },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
  }

  const exportFile = async (token: string, period: string, slug = org.slug) =>
    app.request(`/api/export/vat.xlsx?${new URLSearchParams({ period })}`, { headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug } });

  const exportAudits = () =>
    admin(async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.vat.export' AND outcome = 'ok' ORDER BY occurred_at`, [org.orgId])).rows);

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
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Tờ khai GTGT', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: viewer.email, role: 'viewer' });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(viewer), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherOrg = { slug: String(other.body?.slug), orgId: String(other.body?.orgId) };

    // September: two invoices, one of them voided by reversing its entry. August: one. October: one.
    await record('9001', '2026-09-15');
    const voided = await record('9002', '2026-09-20');
    await record('8001', '2026-08-20');
    await record('1001', '2026-10-02');
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.journal.reverse',
      input: { entryId: voided.journalEntryId, entryDate: '2026-09-30', reason: 'Hóa đơn ghi nhầm' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { acceptUnverifiedSignature: true, id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() });
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

  it('lists the month of purchase invoices by rate, without voided documents, and fills the indicators', async () => {
    const report = await rpc('vat/period', await tokenFor(viewer), { period: '2026-09' });
    expect(report.status).toBe(200);
    expect(report.body.period).toEqual({ period: '2026-09', kind: 'month', from: '2026-09-01', to: '2026-09-30' });
    expect(report.body.input.documents).toEqual([
      expect.objectContaining({
        number: '9001',
        issueDate: '2026-09-15',
        partyTaxCode: '0101234564',
        subtotal: '1800000',
        vatAmount: '180000',
        total: '1980000',
        rates: [{ rate: '10', taxable: '1800000', vat: '180000' }],
        warnings: [],
      }),
    ]);
    expect(report.body.input.totals).toMatchObject({ taxable: '1800000', vat: '180000', documents: 1 });
    // No org tax code, so no way to tell sales apart (#313): the output side is not available.
    expect(report.body.output).toMatchObject({ available: false, documents: [], totals: { taxable: '0', vat: '0', documents: 0 } });
    const indicators = new Map((report.body.indicators as Array<{ code: string; amount: string }>).map((i) => [i.code, i.amount]));
    expect(indicators.get('23')).toBe('1800000');
    expect(indicators.get('24')).toBe('180000');
    expect(indicators.get('32')).toBe('0');
  });

  it('covers the three months of a quarter and nothing outside it', async () => {
    const quarter = await rpc('vat/period', await tokenFor(owner), { period: '2026-Q3' });
    expect(quarter.body.period).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect((quarter.body.input.documents as Array<{ number: string }>).map((d) => d.number)).toEqual(['8001', '9001']);
    expect(quarter.body.input.totals).toMatchObject({ taxable: '3600000', vat: '360000', documents: 2 });
    const october = await rpc('vat/period', await tokenFor(owner), { period: '2026-10' });
    expect((october.body.input.documents as Array<{ number: string }>).map((d) => d.number)).toEqual(['1001']);
    expect((await rpc('vat/period', await tokenFor(owner), { period: '2026-07' })).body.input.documents).toEqual([]);
  });

  it('refuses a malformed period', async () => {
    // 400 here and 422 on the export route below: the RPC handler checks its input against the oRPC contract before
    // any query runs (BAD_REQUEST), while the export route hands the query string to the runtime, whose own input check
    // refuses it as VALIDATION (422). Both refuse the same periods.
    for (const period of ['2026-13', '2026-Q5', '2026-9', '']) {
      expect((await rpc('vat/period', await tokenFor(owner), { period })).status, period).toBe(400);
    }
  });

  it('keeps each org to its own invoices', async () => {
    const own = await rpc('vat/period', await tokenFor(outsider), { period: '2026-09' }, otherOrg.slug);
    expect(own).toMatchObject({ status: 200, body: { input: { documents: [] } } });
    const foreign = await rpc('vat/period', await tokenFor(outsider), { period: '2026-09' }, org.slug);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.body?.input).toBeUndefined();
    expect((await exportFile(await tokenFor(outsider), '2026-09')).status).toBeGreaterThanOrEqual(400);
  });

  it('exports the period to Excel and records the export, for a viewer too', async () => {
    const response = await exportFile(await tokenFor(viewer), '2026-Q3');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="crove-gtgt-2026-Q3-${org.slug}.xlsx"; filename*=UTF-8''crove-gtgt-2026-Q3-${org.slug}.xlsx`);
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // An xlsx file is a zip archive; its content is checked in modules/finance/test/vat-export.test.ts and the e2e.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(await exportAudits()).toEqual([{ detail: { period: '2026-Q3', documents: 2 } }]);

    // A malformed period downloads nothing and records nothing.
    expect((await exportFile(await tokenFor(owner), '2026-Q9')).status).toBe(422);
    expect(await exportAudits()).toHaveLength(1);
  });

  // The HTKK XML of form 01/GTGT (#332). These run last: they set the org's tax code, which the tests above expect
  // to be missing. The org is the fixture's buyer, so the recorded invoices stay purchases.
  const BUYER_TAX_CODE = '0309876546';
  const exportXml = async (token: string, period: string, slug = org.slug) =>
    app.request(`/api/export/vat-01gtgt.xml?${new URLSearchParams({ period })}`, { headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug } });
  const xmlAudits = async () => (await exportAudits()).filter((row: { detail: { format?: string } }) => row.detail.format === 'htkk_01gtgt_xml');
  const valueOf = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];

  it('refuses the HTKK XML while the org has no tax code, and records nothing', async () => {
    const response = await exportXml(await tokenFor(owner), '2026-09');
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'TAX_CODE_REQUIRED' });
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await xmlAudits()).toEqual([]);
  });

  it('exports the period as the HTKK XML of form 01/GTGT with the org tax code, and records the export', async () => {
    const set = await rpc('org/setTaxCode', await tokenFor(owner), { taxCode: BUYER_TAX_CODE });
    expect(set.status).toBe(200);

    const month = await exportXml(await tokenFor(viewer), '2026-09');
    expect(month.status).toBe(200);
    expect(month.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(month.headers.get('content-disposition')).toBe(`attachment; filename="crove-01gtgt-2026-09-${org.slug}.xml"; filename*=UTF-8''crove-01gtgt-2026-09-${org.slug}.xml`);
    expect(month.headers.get('cache-control')).toBe('private, no-store');
    const xml = await month.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(valueOf(xml, 'mst')).toBe(BUYER_TAX_CODE);
    expect(valueOf(xml, 'tenNNT')).toBe('Công ty Tờ khai GTGT');
    expect(valueOf(xml, 'kieuKy')).toBe('M');
    expect(valueOf(xml, 'kyKKhai')).toBe('09/2026');
    expect(valueOf(xml, 'ct23')).toBe('1800000');
    expect(valueOf(xml, 'ct24')).toBe('180000');
    expect(valueOf(xml, 'ct32')).toBe('0');

    const quarter = await exportXml(await tokenFor(owner), '2026-Q3');
    expect(quarter.status).toBe(200);
    const quarterly = await quarter.text();
    expect(valueOf(quarterly, 'kieuKy')).toBe('Q');
    expect(valueOf(quarterly, 'kyKKhai')).toBe('3/2026');
    expect(valueOf(quarterly, 'ct23')).toBe('3600000');
    expect(valueOf(quarterly, 'ct24')).toBe('360000');

    expect((await xmlAudits()).map((row: { detail: unknown }) => row.detail)).toEqual([
      { period: '2026-09', documents: 1, format: 'htkk_01gtgt_xml', carry_forward: 'none' },
      { period: '2026-Q3', documents: 2, format: 'htkk_01gtgt_xml', carry_forward: 'none' },
    ]);
    // A malformed period downloads nothing and records nothing.
    expect((await exportXml(await tokenFor(owner), '2026-13')).status).toBe(422);
    expect(await xmlAudits()).toHaveLength(2);
  });

  it('refuses an out-of-range year with a 422 and records nothing, for the XML and the Excel working', async () => {
    const owned = await tokenFor(owner);
    const xmlBefore = (await xmlAudits()).length;
    const allBefore = (await exportAudits()).length;
    for (const period of ['1999-01', '2101-Q1']) {
      expect((await exportXml(owned, period)).status, period).toBe(422);
      const xlsx = await app.request(`/api/export/vat.xlsx?${new URLSearchParams({ period })}`, { headers: { authorization: `Bearer ${owned}`, 'x-crove-org': org.slug } });
      expect(xlsx.status, period).toBe(422);
    }
    expect(await xmlAudits()).toHaveLength(xmlBefore);
    expect(await exportAudits()).toHaveLength(allBefore);
  });

  it('refuses the XML of the other period kind than the org files, keeps the Excel working open, and allows both when unset', async () => {
    const owned = await tokenFor(owner);
    const before = (await xmlAudits()).length;
    expect((await rpc('org/setVatFilingPeriod', owned, { vatFilingPeriod: 'month' }, org.slug)).status).toBe(200);
    const quarter = await exportXml(owned, '2026-Q3');
    expect(quarter.status).toBe(422);
    expect(await quarter.json()).toMatchObject({ code: 'PERIOD_KIND_MISMATCH' });
    expect(quarter.headers.get('content-disposition')).toBeNull();
    expect((await exportXml(owned, '2026-09')).status).toBe(200);
    // The Excel working is an analysis tool, not a filing: any period stays allowed.
    const xlsx = await app.request(`/api/export/vat.xlsx?period=2026-Q3`, { headers: { authorization: `Bearer ${owned}`, 'x-crove-org': org.slug } });
    expect(xlsx.status).toBe(200);

    expect((await rpc('org/setVatFilingPeriod', owned, { vatFilingPeriod: 'quarter' }, org.slug)).status).toBe(200);
    const month = await exportXml(owned, '2026-09');
    expect(month.status).toBe(422);
    expect(await month.json()).toMatchObject({ code: 'PERIOD_KIND_MISMATCH' });
    expect((await exportXml(owned, '2026-Q3')).status).toBe(200);

    expect((await rpc('org/setVatFilingPeriod', owned, { vatFilingPeriod: null }, org.slug)).status).toBe(200);
    expect((await exportXml(owned, '2026-Q3')).status).toBe(200);
    expect((await exportXml(owned, '2026-09')).status).toBe(200);
    // Only the four accepted XML exports above were recorded; the refusals and the Excel working add no XML row.
    expect(await xmlAudits()).toHaveLength(before + 4);
  });

  it('writes the org address and, when asked, [24] in [25], and records that choice (#692)', async () => {
    const owned = await tokenFor(owner);
    const before = (await xmlAudits()).length;
    const deducted = await app.request(`/api/export/vat-01gtgt.xml?${new URLSearchParams({ period: '2026-09', deductInput: '1' })}`, {
      headers: { authorization: `Bearer ${owned}`, 'x-crove-org': org.slug },
    });
    expect(deducted.status).toBe(200);
    const xml = await deducted.text();
    expect(['ct24', 'ct25', 'ct36'].map((tag) => valueOf(xml, tag))).toEqual(['180000', '180000', '-180000']);
    expect(valueOf(xml, 'ct43')).toBe('180000');
    // No address yet: an empty element, as before.
    expect(xml).toContain('<dchiNNT/>');
    // Any other value of the parameter keeps [25] at 0.
    const plain = await app.request(`/api/export/vat-01gtgt.xml?${new URLSearchParams({ period: '2026-09', deductInput: 'true' })}`, {
      headers: { authorization: `Bearer ${owned}`, 'x-crove-org': org.slug },
    });
    expect(valueOf(await plain.text(), 'ct25')).toBe('0');

    expect((await rpc('org/setAddress', owned, { address: 'Số 2 Đường Thử, Phường Bến Nghé, TP Hồ Chí Minh' }, org.slug)).status).toBe(200);
    try {
      expect(valueOf(await (await exportXml(owned, '2026-09')).text(), 'dchiNNT')).toBe('Số 2 Đường Thử, Phường Bến Nghé, TP Hồ Chí Minh');
    } finally {
      expect((await rpc('org/setAddress', owned, { address: null }, org.slug)).status).toBe(200);
    }
    expect((await xmlAudits()).slice(before).map((row: { detail: unknown }) => row.detail)).toEqual([
      { period: '2026-09', documents: 1, format: 'htkk_01gtgt_xml', deduct_input: true, carry_forward: 'none' },
      { period: '2026-09', documents: 1, format: 'htkk_01gtgt_xml', carry_forward: 'none' },
      { period: '2026-09', documents: 1, format: 'htkk_01gtgt_xml', carry_forward: 'none' },
    ]);
  });

  it('keeps the HTKK XML to members of the org', async () => {
    const before = (await xmlAudits()).length;
    const foreign = await exportXml(await tokenFor(outsider), '2026-09');
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(await foreign.text()).not.toContain(BUYER_TAX_CODE);
    // The outsider's own org has no tax code: refused too, and neither attempt is recorded in this org.
    expect((await exportXml(await tokenFor(outsider), '2026-09', otherOrg.slug)).status).toBe(422);
    expect(await xmlAudits()).toHaveLength(before);
    const unauthenticated = await app.request(`/api/export/vat-01gtgt.xml?period=2026-09`, { headers: { 'x-crove-org': org.slug } });
    expect(unauthenticated.status).toBe(401);
  });
  // A sales invoice at 5% and 10% (#685): the org (BUYER_TAX_CODE since the test above) is the seller. 5% of 1,000,001
  // and 10% of 333,333 give 50,000.05 and 33,333.3; the seller rounded the 10% VAT up, to 83,334 in all. With its VAT
  // table (THTTLTSuat) the working takes the seller's split; without it, it estimates 50,000 and 33,333 and puts the
  // missing dong on the larger taxable value (5%), flagged rate_split, as for every document recorded before #685.
  const mixedSale = (number: string, table: boolean) =>
    new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<HDon>
  <DLHDon Id="data">
    <TTChung>
      <PBan>2.1.0</PBan><THDon>HÓA ĐƠN GIÁ TRỊ GIA TĂNG</THDon><KHMSHDon>1</KHMSHDon><KHHDon>C26TBB</KHHDon>
      <SHDon>${number}</SHDon><NLap>2026-06-10</NLap><DVTTe>VND</DVTTe><TGia>1</TGia><HTTToan>TM/CK</HTTToan>
    </TTChung>
    <NDHDon>
      <NBan><Ten>CÔNG TY TỜ KHAI GTGT</Ten><MST>${BUYER_TAX_CODE}</MST><DChi>2 Đường Thử, TP Hồ Chí Minh</DChi></NBan>
      <NMua><Ten>CÔNG TY TNHH KHÁCH HÀNG MẪU</Ten><MST>0101234564</MST><DChi>1 Đường Mẫu, Hà Nội</DChi></NMua>
      <DSHHDVu>
        <HHDVu><TChat>1</TChat><STT>1</STT><THHDVu>Gạo</THHDVu><DVTinh>Kg</DVTinh><SLuong>1</SLuong><DGia>1000001</DGia><ThTien>1000001</ThTien><TSuat>5%</TSuat></HHDVu>
        <HHDVu><TChat>1</TChat><STT>2</STT><THHDVu>Dịch vụ vận chuyển</THHDVu><DVTinh>Chuyến</DVTinh><SLuong>1</SLuong><DGia>333333</DGia><ThTien>333333</ThTien><TSuat>10%</TSuat></HHDVu>
      </DSHHDVu>
      <TToan>
        ${table ? '<THTTLTSuat><LTSuat><TSuat>5%</TSuat><ThTien>1000001</ThTien><TThue>50000</TThue></LTSuat><LTSuat><TSuat>10%</TSuat><ThTien>333333</ThTien><TThue>33334</TThue></LTSuat></THTTLTSuat>' : ''}
        <TgTCThue>1333334</TgTCThue><TgTThue>83334</TgTThue><TgTTTBSo>1416668</TgTTTBSo>
      </TToan>
    </NDHDon>
  </DLHDon>
  <MCCQT Id="tax">M2-26-ABCDE-0000${number}</MCCQT>
</HDon>`);

  it('splits a mixed-rate invoice by its own VAT table, and estimates one recorded without it (#685)', async () => {
    const withTable = await record('6001', '2026-06-10', mixedSale('6001', true));
    const withoutTable = await record('6002', '2026-06-10', mixedSale('6002', false));
    const stored = await admin(async (c) => {
      const sql = `SELECT document_id, row_no, vat_rate, taxable_amount::text, vat_amount::text FROM crove_finance.purchase_tax_rate
                   WHERE org_id = $1 AND document_id = ANY($2) ORDER BY row_no`;
      return (await c.query(sql, [org.orgId, [withTable.documentId, withoutTable.documentId]])).rows;
    });
    expect(stored).toEqual([
      { document_id: withTable.documentId, row_no: 1, vat_rate: '5%', taxable_amount: '1000001.0000', vat_amount: '50000.0000' },
      { document_id: withTable.documentId, row_no: 2, vat_rate: '10%', taxable_amount: '333333.0000', vat_amount: '33334.0000' },
    ]);

    const report = await rpc('vat/period', await tokenFor(viewer), { period: '2026-06' });
    expect(report.status).toBe(200);
    expect(report.body.output.documents).toEqual([
      expect.objectContaining({
        number: '6001',
        rates: [
          { rate: '5', taxable: '1000001', vat: '50000' },
          { rate: '10', taxable: '333333', vat: '33334' },
        ],
        warnings: [],
      }),
      expect.objectContaining({
        number: '6002',
        rates: [
          { rate: '5', taxable: '1000001', vat: '50001' },
          { rate: '10', taxable: '333333', vat: '33333' },
        ],
        warnings: ['rate_split'],
      }),
    ]);
    const xml = await (await exportXml(await tokenFor(owner), '2026-06')).text();
    expect(valueOf(xml, 'ct30')).toBe('2000002');
    expect(valueOf(xml, 'ct31')).toBe('100001');
    expect(valueOf(xml, 'ct32')).toBe('666666');
    expect(valueOf(xml, 'ct33')).toBe('66667');

    // The table is written with its document only: a recorded document takes no more rows, and its rows never change.
    const refusal = (sql: string, params: unknown[]) =>
      admin((c) => c.query(sql, params).then(() => null, (error: { message: string }) => error.message));
    expect(
      await refusal(`INSERT INTO crove_finance.purchase_tax_rate (org_id, document_id, row_no, vat_rate, taxable_amount, vat_amount) VALUES ($1, $2, 9, '0%', 1, 0)`, [org.orgId, withoutTable.documentId]),
    ).toMatch(/already posted/);
    expect(await refusal(`UPDATE crove_finance.purchase_tax_rate SET vat_amount = 50001 WHERE org_id = $1 AND row_no = 1`, [org.orgId])).not.toBeNull();
    expect(await refusal(`DELETE FROM crove_finance.purchase_tax_rate WHERE org_id = $1`, [org.orgId])).not.toBeNull();
  });

  // The fixture scaled to 9,000,000 at 10% (VAT 900,000, total 9,900,000), above the 5 million VND threshold, paid as given.
  const bigPurchase = (number: string, date: string, method: string) =>
    new TextEncoder().encode(
      FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`)
        .replace('<NLap>2026-09-15</NLap>', `<NLap>${date}</NLap>`)
        .replace('<HTTToan>TM/CK</HTTToan>', `<HTTToan>${method}</HTTToan>`)
        .replace('<DGia>1000000</DGia><ThTien>1000000</ThTien>', '<DGia>5000000</DGia><ThTien>5000000</ThTien>')
        .replace('<DGia>500000</DGia><ThTien>1000000</ThTien>', '<DGia>2500000</DGia><ThTien>5000000</ThTien>')
        .replace('<ThTien>200000</ThTien>', '<ThTien>1000000</ThTien>')
        .replace('<ThTien>1800000</ThTien><TThue>180000</TThue>', '<ThTien>9000000</ThTien><TThue>900000</TThue>')
        .replace('<TgTCThue>1800000</TgTCThue>', '<TgTCThue>9000000</TgTCThue>')
        .replace('<TgTThue>180000</TgTThue>', '<TgTThue>900000</TgTThue>')
        .replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>9900000</TgTTTBSo>'),
    );

  it('flags input invoices that need proof of non-cash payment, takes the marks and suggests [25] (#917)', async () => {
    const cash = await record('5001', '2026-05-10', bigPurchase('5001', '2026-05-10', 'TM'));
    const bank = await record('5002', '2026-05-11', bigPurchase('5002', '2026-05-11', 'CK'));
    const either = await record('5003', '2026-05-12', bigPurchase('5003', '2026-05-12', 'TM/CK'));
    // 1,980,000 in total: below the threshold, whatever its payment method.
    const small = await record('5004', '2026-05-13');
    const owned = await tokenFor(owner);
    const period = async () => (await rpc('vat/period', await tokenFor(viewer), { period: '2026-05' })).body;

    const before = await period();
    expect(before.indicators.find((i: { code: string }) => i.code === '24').amount).toBe('2880000');
    expect(before.paymentChecks).toMatchObject({ vatAtRisk: '1800000', notDeductibleVat: '0', unchecked: 2, suggested25: '2880000' });
    expect(before.paymentChecks.items).toEqual([
      { documentId: cash.documentId, paymentMethod: 'TM', methodKind: 'cash', threshold: '5000000', total: '9900000', vatAmount: '900000', mark: null },
      { documentId: either.documentId, paymentMethod: 'TM/CK', methodKind: 'unknown', threshold: '5000000', total: '9900000', vatAmount: '900000', mark: null },
    ]);
    const warningsOf = (report: { input: { documents: Array<{ id: string; warnings: string[] }> } }, id: string) => report.input.documents.find((d) => d.id === id)?.warnings;
    expect(warningsOf(before, cash.documentId)).toContain('check_payment');
    expect(warningsOf(before, bank.documentId)).not.toContain('check_payment');
    expect(warningsOf(before, small.documentId)).not.toContain('check_payment');

    // Viewers only read; an invoice that needs no check, a voucher that is not a báo Nợ of the org, and a voucher on any
    // outcome but paid_by_bank are refused.
    expect((await rpc('vat/markPayment', await tokenFor(viewer), { documentId: cash.documentId, outcome: 'not_deductible' })).status).toBe(403);
    expect((await rpc('vat/markPayment', owned, { documentId: small.documentId, outcome: 'not_deductible' })).body).toMatchObject({ code: 'NOT_FLAGGED' });
    expect((await rpc('vat/markPayment', owned, { documentId: bank.documentId, outcome: 'paid_by_bank' })).body).toMatchObject({ code: 'NOT_FLAGGED' });
    expect((await rpc('vat/markPayment', owned, { documentId: cash.documentId, outcome: 'paid_by_bank', voucherId: randomUUID() })).body).toMatchObject({ code: 'VOUCHER_NOT_BANK' });
    expect((await rpc('vat/markPayment', owned, { documentId: cash.documentId, outcome: 'not_deductible', voucherId: randomUUID() })).body).toMatchObject({ code: 'VOUCHER_NOT_BANK' });
    // Another org's member cannot mark this org's invoice.
    expect((await rpc('vat/markPayment', await tokenFor(outsider), { documentId: cash.documentId, outcome: 'paid_by_bank' }, otherOrg.slug)).status).toBe(404);

    expect((await rpc('vat/markPayment', owned, { documentId: either.documentId, outcome: 'not_deductible', note: 'Trả tiền mặt' })).body).toEqual({ documentId: either.documentId, outcome: 'not_deductible' });
    // A change of mind: the latest mark wins.
    expect((await rpc('vat/markPayment', owned, { documentId: either.documentId, outcome: 'paid_by_bank' })).status).toBe(200);
    expect((await rpc('vat/markPayment', owned, { documentId: cash.documentId, outcome: 'not_deductible' })).status).toBe(200);
    const marked = await period();
    expect(marked.paymentChecks).toMatchObject({ vatAtRisk: '900000', notDeductibleVat: '900000', unchecked: 0, suggested25: '1980000' });
    expect(marked.paymentChecks.items.map((i: { mark: { outcome: string } | null }) => i.mark?.outcome)).toEqual(['not_deductible', 'paid_by_bank']);
    expect(warningsOf(marked, cash.documentId)).not.toContain('check_payment');

    // The HTKK XML takes the suggestion when asked, and the audit says so.
    const xml = await app.request(`/api/export/vat-01gtgt.xml?${new URLSearchParams({ period: '2026-05', deduct: 'suggested' })}`, {
      headers: { authorization: `Bearer ${owned}`, 'x-crove-org': org.slug },
    });
    expect(xml.status).toBe(200);
    const text = await xml.text();
    expect(['ct24', 'ct25'].map((tag) => valueOf(text, tag))).toEqual(['2880000', '1980000']);
    expect((await xmlAudits()).at(-1)?.detail).toEqual({ period: '2026-05', documents: 4, format: 'htkk_01gtgt_xml', deduct_suggested: true, carry_forward: 'none' });

    // Cleared: back to unchecked.
    expect((await rpc('vat/markPayment', owned, { documentId: cash.documentId, outcome: 'cleared' })).status).toBe(200);
    expect((await period()).paymentChecks).toMatchObject({ unchecked: 1, notDeductibleVat: '0', suggested25: '2880000' });

    // Every mark is a row and an audit event; the rows never change.
    const rows = await admin(async (c) => (await c.query(`SELECT outcome, note, marked_by FROM crove_finance.input_vat_check WHERE org_id = $1 ORDER BY created_at, id`, [org.orgId])).rows);
    expect(rows).toEqual([
      { outcome: 'not_deductible', note: 'Trả tiền mặt', marked_by: owner.userId },
      { outcome: 'paid_by_bank', note: null, marked_by: owner.userId },
      { outcome: 'not_deductible', note: null, marked_by: owner.userId },
      { outcome: 'cleared', note: null, marked_by: owner.userId },
    ]);
    const audits = await admin(async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.vat.payment_mark' AND outcome = 'ok' ORDER BY occurred_at`, [org.orgId])).rows);
    expect(audits.map((a: { detail: { outcome: string } }) => a.detail.outcome)).toEqual(['not_deductible', 'paid_by_bank', 'not_deductible', 'cleared']);
    const refusal = (sql: string, params: unknown[]) => admin((c) => c.query(sql, params).then(() => null, (error: { message: string }) => error.message));
    expect(await refusal(`UPDATE crove_finance.input_vat_check SET outcome = 'paid_by_bank' WHERE org_id = $1`, [org.orgId])).not.toBeNull();
    expect(await refusal(`DELETE FROM crove_finance.input_vat_check WHERE org_id = $1`, [org.orgId])).not.toBeNull();
  });

  // [22] carried forward from the previous filed return's [43] (#1400). Runs last: it uses May (purchases, VAT
  // 2,880,000, all suggested deductible since the clear above) and June (the two mixed-rate sales above, VAT 166,668).
  it('records the VAT return as filed with the done mark, and carries its [43] into the next [22] (#1400)', async () => {
    const owned = await tokenFor(owner);
    const period = async (p: string) => (await rpc('vat/period', await tokenFor(viewer), { period: p })).body;
    const doneMarks = () =>
      admin(async (c) => (await c.query(`SELECT period FROM crove_kernel.tax_obligation_done WHERE org_id = $1 AND obligation = 'vat_return' ORDER BY period`, [org.orgId])).rows.map((r: { period: string }) => r.period));
    const filedRows = () =>
      admin(
        async (c) =>
          (
            await c.query(
              `SELECT period, status, source, carried_in_amount::text AS c22, deductible_amount::text AS c25, carried_out_amount::text AS c43, marked_by
               FROM crove_finance.vat_return_filed WHERE org_id = $1 ORDER BY created_at, id`,
              [org.orgId],
            )
          ).rows,
      );
    const xmlWith = (params: Record<string, string>) => app.request(`/api/export/vat-01gtgt.xml?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${owned}`, 'x-crove-org': org.slug } });

    // No return filed before May: [22] stays 0, and the report says none was found.
    const may = await period('2026-05');
    expect(may.carryForward).toEqual({ amount: '0', previous: null, lookedFor: ['2026-04'] });
    expect(may.filed).toBeNull();

    // Marked done from the tax calendar: Crove's own working is recorded, [25] the suggestion, [43] by the formulas.
    expect((await rpc('org/markTaxObligation', owned, { obligation: 'vat_return', period: '2026-05', done: true })).body).toEqual({ obligation: 'vat_return', period: '2026-05', done: true });
    expect(await doneMarks()).toEqual(['2026-05']);
    expect((await period('2026-05')).filed).toMatchObject({ period: '2026-05', source: 'computed', carriedIn: '0', deductible: '2880000', carriedOut: '2880000' });

    // June starts from May's [43], on the screen and in the XML.
    expect((await period('2026-06')).carryForward).toMatchObject({ amount: '2880000', lookedFor: ['2026-05'], previous: { period: '2026-05', source: 'computed' } });
    const xml = await (await xmlWith({ period: '2026-06' })).text();
    expect(['ct22', 'ct28', 'ct36', 'ct40a', 'ct41', 'ct43'].map((tag) => valueOf(xml, tag))).toEqual(['2880000', '166668', '166668', '0', '2713332', '2713332']);
    expect((await xmlAudits()).at(-1)?.detail).toEqual({ period: '2026-06', documents: 2, format: 'htkk_01gtgt_xml', carry_forward: 'previous' });
    // The accountant may edit [22]; the audit says so, never the amount.
    const editedXml = await (await xmlWith({ period: '2026-06', carried: '100000' })).text();
    expect(['ct22', 'ct40a', 'ct43'].map((tag) => valueOf(editedXml, tag))).toEqual(['100000', '66668', '0']);
    expect((await xmlAudits()).at(-1)?.detail).toEqual({ period: '2026-06', documents: 2, format: 'htkk_01gtgt_xml', carry_forward: 'edited' });
    for (const carried of ['-1', '1.5', 'abc', '123456789012345']) {
      expect((await xmlWith({ period: '2026-06', carried })).status, carried).toBe(422);
    }

    // Marked filed on the VAT screen with the figures as filed: recorded as entered, with the done mark.
    expect((await rpc('vat/markReturn', owned, { period: '2026-06', done: true, figures: { carriedIn: '2880000', deductible: '0', carriedOut: '2713332' } })).body).toEqual({ period: '2026-06', done: true });
    expect(await doneMarks()).toEqual(['2026-05', '2026-06']);
    expect((await period('2026-07')).carryForward).toMatchObject({ amount: '2713332', lookedFor: ['2026-06', '2026-Q2'], previous: { period: '2026-06', source: 'entered' } });
    // A quarter looks for the quarter before first, then its last month (an org that changed its filing period).
    expect((await period('2026-Q3')).carryForward).toMatchObject({ amount: '2713332', lookedFor: ['2026-Q2', '2026-06'], previous: { period: '2026-06' } });
    expect((await rpc('vat/markReturn', owned, { period: '2026-Q2', done: true, figures: { carriedIn: '0', deductible: '0', carriedOut: '5000' } })).status).toBe(200);
    expect((await period('2026-Q3')).carryForward).toMatchObject({ amount: '5000', previous: { period: '2026-Q2' } });
    expect((await period('2026-07')).carryForward).toMatchObject({ amount: '2713332', previous: { period: '2026-06' } });

    // The same figures again add no row, nor does the calendar's button on a filed period; a correction adds one.
    const before = (await filedRows()).length;
    expect((await rpc('vat/markReturn', owned, { period: '2026-06', done: true, figures: { carriedIn: '2880000', deductible: '0', carriedOut: '2713332' } })).status).toBe(200);
    expect((await rpc('org/markTaxObligation', owned, { obligation: 'vat_return', period: '2026-06', done: true })).status).toBe(200);
    expect(await filedRows()).toHaveLength(before);
    expect((await rpc('vat/markReturn', owned, { period: '2026-06', done: true, figures: { carriedIn: '2880000', deductible: '0', carriedOut: '2700000' } })).status).toBe(200);
    expect((await period('2026-07')).carryForward.amount).toBe('2700000');

    // Taking the mark back (from the calendar) withdraws the return and the done mark; July falls back to Q2.
    expect((await rpc('org/markTaxObligation', owned, { obligation: 'vat_return', period: '2026-06', done: false })).body).toEqual({ obligation: 'vat_return', period: '2026-06', done: false });
    expect(await doneMarks()).toEqual(['2026-05', '2026-Q2']);
    expect((await period('2026-06')).filed).toBeNull();
    expect((await period('2026-07')).carryForward).toMatchObject({ amount: '5000', previous: { period: '2026-Q2' } });

    // Only owners and admins mark a return filed, from either screen; a withdrawal carries no figures; figures are
    // whole dong of at most 14 digits; another org's member reaches nothing here.
    expect((await rpc('vat/markReturn', await tokenFor(viewer), { period: '2026-06', done: true })).status).toBe(403);
    expect((await rpc('org/markTaxObligation', await tokenFor(viewer), { obligation: 'vat_return', period: '2026-06', done: true })).status).toBe(403);
    expect((await rpc('vat/markReturn', owned, { period: '2026-06', done: false, figures: { carriedIn: '0', deductible: '0', carriedOut: '0' } })).status).toBe(422);
    expect((await rpc('vat/markReturn', owned, { period: '2026-06', done: true, figures: { carriedIn: '0', deductible: '1.5', carriedOut: '0' } })).status).toBe(400);
    expect((await rpc('vat/markReturn', await tokenFor(outsider), { period: '2026-06', done: true })).status).toBeGreaterThanOrEqual(400);

    // Every mark is a row by the user who made it; the audit rows hold no figures.
    expect(await filedRows()).toEqual([
      { period: '2026-05', status: 'filed', source: 'computed', c22: '0.0000', c25: '2880000.0000', c43: '2880000.0000', marked_by: owner.userId },
      { period: '2026-06', status: 'filed', source: 'entered', c22: '2880000.0000', c25: '0.0000', c43: '2713332.0000', marked_by: owner.userId },
      { period: '2026-Q2', status: 'filed', source: 'entered', c22: '0.0000', c25: '0.0000', c43: '5000.0000', marked_by: owner.userId },
      { period: '2026-06', status: 'filed', source: 'entered', c22: '2880000.0000', c25: '0.0000', c43: '2700000.0000', marked_by: owner.userId },
      { period: '2026-06', status: 'withdrawn', source: null, c22: null, c25: null, c43: null, marked_by: owner.userId },
    ]);
    const audits = await admin(async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.vat.return_mark' AND outcome = 'ok' ORDER BY occurred_at`, [org.orgId])).rows);
    expect(audits.map((a: { detail: Record<string, unknown> }) => a.detail)).toContainEqual({ period: '2026-05', done: true, source: 'computed', recorded: true });
    expect(audits.map((a: { detail: Record<string, unknown> }) => a.detail)).toContainEqual({ period: '2026-06', done: false, withdrawn: true });
    expect(JSON.stringify(audits)).not.toContain('2713332');

    // History never changes, not even for the database owner.
    const refusal = (sql: string, params: unknown[]) => admin((c) => c.query(sql, params).then(() => null, (error: { message: string }) => error.message));
    expect(await refusal(`UPDATE crove_finance.vat_return_filed SET carried_out_amount = 1 WHERE org_id = $1`, [org.orgId])).not.toBeNull();
    expect(await refusal(`DELETE FROM crove_finance.vat_return_filed WHERE org_id = $1`, [org.orgId])).not.toBeNull();

    // A raw insert in a member's own context, past the command: refused for a viewer at once (and for an owner who
    // names someone else), and for an owner at commit, with no audit row of the command. Tenant roles cannot update.
    const raw = async (userId: string, markedBy: string, statement = 'INSERT') => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, org.orgId]);
        if (statement === 'INSERT') {
          await c.query(
            `INSERT INTO crove_finance.vat_return_filed (org_id, period, status, source, carried_in_amount, deductible_amount, carried_out_amount, marked_by)
             VALUES ($1, '2026-08', 'filed', 'entered', 0, 0, 999, $2)`,
            [org.orgId, markedBy],
          );
        } else {
          await c.query(`UPDATE crove_finance.vat_return_filed SET carried_out_amount = 1`);
        }
        await c.query('COMMIT');
        return null;
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        return (error as { message: string }).message;
      } finally {
        c.release();
      }
    };
    expect(await raw(viewer.userId, viewer.userId)).toBe('VAT_RETURN_FORBIDDEN');
    expect(await raw(owner.userId, viewer.userId)).toBe('VAT_RETURN_FORBIDDEN');
    expect(await raw(owner.userId, owner.userId)).toBe('VAT_RETURN_UNAUDITED');
    expect(await raw(owner.userId, owner.userId, 'UPDATE')).toMatch(/permission denied/);
    expect((await period('2026-09')).carryForward.previous).toBeNull();
  });
});
