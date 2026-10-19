// Cash and bank vouchers (issue #327) on a real PostgreSQL 17, through the HTTP API where a user would act: entering a
// phiếu chi, phiếu thu, báo Có or báo Nợ (inbox.request), approving it like any posting (R3: owners and admins, fresh
// MFA, four-eyes), the voucher numbers per org and type, the journal entry with the party on 131 and 331, payables and
// receivables per party in the ledger reports, reversal through the existing path, and the database rules every writer
// is held to (numbering, the cash account of the type, the entry by commit, append-only, tenancy).
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
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-cash-vouchers-327';
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

const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@vouchers-327.test`, session: randomUUID(), userId: '' });
const suite = ADMIN ? describe : describe.skip;

suite('cash and bank vouchers (#327)', () => {
  const dbName = `crove_test_vouchers_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner = account('owner');
  const adminUser = account('admin');
  const member = account('member');
  const viewer = account('viewer');
  const outsider = account('outsider');
  let org = { slug: '', orgId: '' };
  let other = { slug: '', orgId: '' };
  // The vendor of the recorded purchase, a customer and the other org's party.
  let vendor = { id: '', total: '' };
  let customer = '';
  let otherParty = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: owner.session });

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

  const ask = async (who: Account, input: Record<string, unknown>, slug = org.slug) =>
    rpc('inbox/request', await tokenFor(who), { command: 'finance.voucher.record', input, idempotencyKey: randomUUID() }, slug);
  const approve = async (who: Account, id: string, slug = org.slug) =>
    rpc('inbox/approve', await tokenFor(who, { mfa: true }), { id, revision: 1, idempotencyKey: randomUUID() }, slug);
  const payment = (amount: string, extra: Record<string, unknown> = {}) => ({
    type: 'cash_payment',
    date: '2026-09-20',
    cashAccount: '1111',
    partyId: vendor.id,
    personName: 'Nguyễn Văn An',
    description: 'Trả tiền hàng HĐ 1234',
    lines: [{ account: '331', amount }],
    ...extra,
  });

  async function join(who: Account, role: string, slug: string) {
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role }, slug);
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
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
    pool = createPool({ connectionString: appUrl, max: 6 });
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

    for (const who of [owner, adminUser, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Thu Chi', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    await join(adminUser, 'admin', org.slug);
    await join(member, 'member', org.slug);
    await join(viewer, 'viewer', org.slug);
    const second = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty Khác', idempotencyKey: randomUUID() }, null);
    other = { slug: String(second.body?.slug), orgId: String(second.body?.orgId) };

    // A purchase on credit from the fixture's supplier: 331 owed to that vendor.
    const bytes = new Uint8Array(FIXTURE);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const proposal = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId);
    // The owner uploaded it, so the admin approves (four-eyes).
    const recorded = await approve(adminUser, String(proposal.proposalId));
    expect(recorded.status).toBe(200);
    const [doc] = await admin(
      async (c) => (await c.query('SELECT party_id, total::text AS total FROM crove_finance.purchase_document WHERE id = $1', [recorded.body.documentId])).rows,
    );
    vendor = { id: doc.party_id, total: doc.total.replace(/\.0+$/, '') };
    customer = randomUUID();
    otherParty = randomUUID();
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, name, tax_code) VALUES ($1, $2, 'Công ty Khách Hàng', '0312345675')`, [org.orgId, customer]);
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $2, 'Đối tác của tổ chức khác')`, [other.orgId, otherParty]);
    });
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

  let paymentEntry = '';
  let paymentVoucher = '';

  it('enters a phiếu chi as a member and shows it in the Inbox as a voucher', async () => {
    const asked = await ask(member, payment(vendor.total));
    expect(asked).toMatchObject({ status: 200, body: { proposalId: expect.any(String) } });
    const id = String(asked.body.proposalId);
    const listed = await rpc('inbox/list', await tokenFor(owner), { status: 'pending' });
    expect((listed.body as any[]).find((p) => p.id === id)).toMatchObject({
      kind: 'finance.cash_voucher',
      title: `Phiếu chi 1.980.000 đ: Trả tiền hàng HĐ 1234 (${(await vendorName()) as string})`,
      total: vendor.total,
      issueDate: '2026-09-20',
      direction: null,
      failedChecks: 0,
    });
    const detail = await rpc('inbox/get', await tokenFor(owner), { id });
    expect(detail.body).toMatchObject({
      payload: null,
      reversal: null,
      voucher: {
        type: 'cash_payment',
        cashAccount: '1111',
        party: { id: vendor.id },
        personName: 'Nguyễn Văn An',
        lines: [{ account: '331', amount: vendor.total }],
        total: vendor.total,
      },
      canApprove: true,
      canEdit: false,
    });
    // The member who entered it may not approve (only owners and admins post).
    expect((await rpc('inbox/get', await tokenFor(member), { id })).body).toMatchObject({ canApprove: false, approveReason: 'not_eligible' });

    // Approving needs a fresh second factor (R3).
    expect((await rpc('inbox/approve', await tokenFor(owner), { id, revision: 1, idempotencyKey: randomUUID() })).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const approved = await approve(owner, id);
    expect(approved).toMatchObject({ status: 200, body: { voucherId: expect.any(String), journalEntryId: expect.any(String) } });
    paymentEntry = String(approved.body.journalEntryId);
    paymentVoucher = String(approved.body.voucherId);
    // The Inbox shows the code the voucher was given (#509).
    expect((await rpc('inbox/get', await tokenFor(owner), { id })).body).toMatchObject({
      status: 'executed',
      result: { voucherId: paymentVoucher, journalEntryId: paymentEntry, voucherCode: 'PC00001' },
    });
  });

  async function vendorName() {
    const [p] = await admin(async (c) => (await c.query('SELECT name FROM crove_kernel.party WHERE id = $1', [vendor.id])).rows);
    return p.name as string;
  }

  it('numbers the voucher, posts Dr 331 for the vendor and Cr 1111, and clears the vendor in the payables', async () => {
    const vouchers = await rpc('vouchers/list', await tokenFor(viewer), {});
    expect(vouchers.body.more).toBe(false);
    expect(vouchers.body.items).toEqual([
      {
        id: paymentVoucher,
        type: 'cash_payment',
        number: 1,
        code: 'PC00001',
        date: '2026-09-20',
        cashAccount: '1111',
        party: { id: vendor.id, name: await vendorName(), taxCode: expect.any(String) },
        personName: 'Nguyễn Văn An',
        description: 'Trả tiền hàng HĐ 1234',
        amount: expect.stringMatching(/^1980000(\.0+)?$/),
        journalEntryId: paymentEntry,
        reversal: null,
        proposalId: expect.any(String),
      },
    ]);
    const entry = await rpc('journal/get', await tokenFor(viewer), { id: paymentEntry });
    expect(entry.body).toMatchObject({
      entryDate: '2026-09-20',
      description: `PC00001 Trả tiền hàng HĐ 1234 (${await vendorName()})`,
      sourceType: 'finance.cash_voucher',
      sourceId: paymentVoucher,
      voucher: { id: paymentVoucher, type: 'cash_payment', code: 'PC00001', partyName: await vendorName() },
    });
    const lines = await admin(
      async (c) =>
        (await c.query('SELECT line_no, account_code, debit::text, credit::text, party_id FROM crove_finance.journal_line WHERE entry_id = $1 ORDER BY line_no', [paymentEntry]))
          .rows,
    );
    expect(lines).toEqual([
      { line_no: 1, account_code: '331', debit: '1980000.0000', credit: '0.0000', party_id: vendor.id },
      { line_no: 2, account_code: '1111', debit: '0.0000', credit: '1980000.0000', party_id: null },
    ]);
    // The purchase raised the vendor's payable in September and the payment settled it.
    const ledger = await rpc('ledger/period', await tokenFor(viewer), { period: '2026-09' });
    const row = (ledger.body.payables.rows as any[]).find((r) => r.partyId === vendor.id);
    expect(row).toMatchObject({ opening: '0', increase: '1980000', decrease: '1980000', closing: '0' });
    expect(ledger.body.trialBalance.balanced).toBe(true);
    const [audit] = await admin(
      async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.voucher.record' AND outcome = 'ok'`, [org.orgId])).rows,
    );
    expect(audit?.detail).toMatchObject({ voucher_type: 'cash_payment', number: 1, lines: 1 });
    const approval = await admin(
      async (c) =>
        (
          await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.proposal.approve' AND outcome = 'ok' AND target_id = $2`, [
            org.orgId,
            vouchers.body.items[0].proposalId,
          ])
        ).rows,
    );
    expect(approval[0]?.detail).toMatchObject({ aal: 'aal2', policy: { P12: 'pass', P10: 'pass' } });
  });

  it('holds four-eyes: the owner who entered a phiếu thu cannot approve it while an admin can', async () => {
    const asked = await ask(owner, {
      type: 'cash_receipt',
      date: '2026-09-25',
      cashAccount: '1111',
      partyId: customer,
      description: 'Khách hàng ứng trước',
      lines: [{ account: '131', amount: '5000000' }],
    });
    const id = String(asked.body.proposalId);
    expect((await rpc('inbox/get', await tokenFor(owner), { id })).body).toMatchObject({ canApprove: false, approveReason: 'four_eyes' });
    expect((await approve(owner, id)).body).toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    const approved = await approve(adminUser, id);
    expect(approved.status).toBe(200);
    const vouchers = (await rpc('vouchers/list', await tokenFor(viewer), { type: 'cash_receipt' })).body.items as any[];
    expect(vouchers.map((v) => v.code)).toEqual(['PT00001']);
    // An advance from the customer: a credit balance of 131 for that customer.
    const ledger = await rpc('ledger/period', await tokenFor(viewer), { period: '2026-09' });
    expect((ledger.body.receivables.rows as any[]).find((r) => r.partyId === customer)).toMatchObject({ increase: '0', decrease: '5000000', closing: '-5000000' });
  });

  it('numbers each type on its own, gapless and once each when approved at the same time', async () => {
    const credit = await ask(member, {
      type: 'bank_credit',
      date: '2026-09-26',
      cashAccount: '1121',
      partyId: customer,
      description: 'Khách hàng chuyển khoản',
      lines: [{ account: '131', amount: '7000000' }],
    });
    expect((await approve(owner, String(credit.body.proposalId))).status).toBe(200);
    const asked = await Promise.all(['100000', '200000', '300000'].map((amount) => ask(member, payment(amount))));
    // A rejected voucher takes no number.
    const rejected = await ask(member, payment('999'));
    expect((await rpc('inbox/reject', await tokenFor(owner), { id: rejected.body.proposalId })).status).toBe(200);
    const results = await Promise.all(asked.map((a, i) => approve(i % 2 ? adminUser : owner, String(a.body.proposalId))));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const vouchers = (await rpc('vouchers/list', await tokenFor(viewer), {})).body.items as any[];
    expect(vouchers.filter((v) => v.type === 'cash_payment').map((v) => v.number).sort()).toEqual([1, 2, 3, 4]);
    expect(vouchers.filter((v) => v.type === 'bank_credit').map((v) => v.code)).toEqual(['BC00001']);
  });

  it('refuses vouchers that cannot be posted, before and at approval', async () => {
    const refused = async (input: Record<string, unknown>) => (await ask(member, input)).body;
    expect(await refused(payment('1000', { partyId: null }))).toMatchObject({ code: 'VOUCHER_INVALID', data: { problems: ['PARTY_REQUIRED'] } });
    expect(await refused(payment('1000', { cashAccount: '1121' }))).toMatchObject({ code: 'VOUCHER_INVALID', data: { problems: ['CASH_ACCOUNT_TYPE'] } });
    expect(await refused(payment('1000', { lines: [{ account: '1111', amount: '1000' }] }))).toMatchObject({ code: 'VOUCHER_INVALID', data: { problems: ['LINE_IS_CASH_ACCOUNT'] } });
    expect(await refused(payment('1000', { lines: [{ account: '6429', amount: '1000' }] }))).toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
    expect(await refused(payment('1000', { partyId: randomUUID() }))).toMatchObject({ code: 'PARTY_NOT_FOUND' });
    // Another org's party is not found either.
    expect(await refused(payment('1000', { partyId: otherParty }))).toMatchObject({ code: 'PARTY_NOT_FOUND' });
    expect((await ask(member, payment('0'))).status).toBe(400);
    expect((await ask(member, payment('1.5'))).status).toBe(400);
    // A viewer may not enter a voucher.
    expect(await ask(viewer, payment('1000'))).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });

    // A sub-account deactivated after the voucher was entered is refused when it is approved.
    expect((await rpc('accounts/create', await tokenFor(owner), { parentCode: '1111', code: '1111.HCM', name: 'Quỹ chi nhánh HCM' })).status).toBe(200);
    const asked = await ask(member, payment('1000', { cashAccount: '1111.HCM' }));
    expect(asked.status).toBe(200);
    expect((await rpc('accounts/update', await tokenFor(owner), { code: '1111.HCM', active: false })).status).toBe(200);
    expect((await approve(owner, String(asked.body.proposalId))).body).toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    expect((await rpc('inbox/get', await tokenFor(owner), { id: asked.body.proposalId })).body).toMatchObject({ status: 'pending' });
  });

  it('approves a voucher in a bulk approval with its own result', async () => {
    const asked = await ask(member, {
      type: 'bank_debit',
      date: '2026-09-28',
      cashAccount: '1121',
      description: 'Phí chuyển khoản tháng 9',
      lines: [{ account: '6422', amount: '22000' }],
    });
    const id = String(asked.body.proposalId);
    const result = await rpc('inbox/approveMany', await tokenFor(owner, { mfa: true }), { items: [{ id, revision: 1 }], idempotencyKey: randomUUID() });
    expect(result.body).toEqual({ results: [{ id, outcome: 'approved', journalEntryId: expect.any(String), voucherId: expect.any(String) }] });
    const vouchers = (await rpc('vouchers/list', await tokenFor(viewer), { type: 'bank_debit' })).body.items as any[];
    expect(vouchers).toEqual([expect.objectContaining({ code: 'BN00001', party: null, amount: expect.stringMatching(/^22000(\.0+)?$/) })]);
  });

  it('reverses a voucher through the existing path; it keeps its number and the payable comes back', async () => {
    const asked = await rpc('inbox/request', await tokenFor(member), {
      command: 'finance.journal.reverse',
      input: { entryId: paymentEntry, entryDate: '2026-09-30', reason: 'Chi nhầm' },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    const approved = await approve(adminUser, String(asked.body.proposalId));
    expect(approved).toMatchObject({ status: 200, body: { reversedEntryId: paymentEntry } });
    const vouchers = (await rpc('vouchers/list', await tokenFor(viewer), { type: 'cash_payment' })).body.items as any[];
    expect(vouchers.find((v) => v.id === paymentVoucher)).toMatchObject({ code: 'PC00001', reversal: { id: approved.body.journalEntryId, entryDate: '2026-09-30' } });
    const ledger = await rpc('ledger/period', await tokenFor(viewer), { period: '2026-09' });
    // 1 980 000 owed, 600 000 of it paid by the three later vouchers: the reversed 1 980 000 is owed again. The reversal
    // counts as a credit of 331 (an increase), as every reversal does in these reports (#321).
    expect((ledger.body.payables.rows as any[]).find((r) => r.partyId === vendor.id)).toMatchObject({ decrease: '2580000', increase: '3960000', closing: '1380000' });
    // A new voucher takes the next number; the reversed one is never reused.
    const next = await ask(member, payment('1000'));
    expect((await approve(owner, String(next.body.proposalId))).status).toBe(200);
    expect(((await rpc('vouchers/list', await tokenFor(viewer), { type: 'cash_payment' })).body.items as any[])[0]).toMatchObject({ code: 'PC00005' });
  });

  it('lists the parties of both sides for the voucher picker, vendors only by default', async () => {
    const vendors = (await rpc('parties/list', await tokenFor(viewer), {})).body as any[];
    expect(vendors.map((p) => p.id)).toContain(vendor.id);
    const all = (await rpc('parties/list', await tokenFor(viewer), { all: true })).body as any[];
    expect(all.map((p) => p.id)).toEqual(expect.arrayContaining([vendor.id, customer]));
    expect(all.map((p) => p.id)).not.toContain(otherParty);
  });

  it('keeps vouchers to their org', async () => {
    expect((await rpc('vouchers/list', await tokenFor(outsider), {}, other.slug)).body).toEqual({ items: [], more: false });
    expect((await rpc('vouchers/list', await tokenFor(outsider), {}, org.slug)).status).toBe(403);
    // The other org numbers from 1.
    const asked = await ask(outsider, { ...payment('1000'), partyId: otherParty }, other.slug);
    expect(asked.status).toBe(200);
    expect((await approve(outsider, String(asked.body.proposalId), other.slug)).status).toBe(200);
    expect(((await rpc('vouchers/list', await tokenFor(outsider), {}, other.slug)).body.items as any[]).map((v) => v.code)).toEqual(['PC00001']);
  });

  it('holds every writer to the numbering, the cash account, the entry and append-only', async () => {
    const asApp = async <T>(fn: (c: pg.Client) => Promise<T>) => {
      const url = new URL(adminUrl);
      url.username = 'crove_app';
      url.password = 'test-app-pw';
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner.userId, org.orgId]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    const insert = (c: pg.Client, values: Record<string, unknown>) => {
      const row = { org_id: org.orgId, voucher_type: 'cash_payment', voucher_date: '2026-09-30', cash_account: '1111', description: 'x', amount: '1', ...values };
      const cols = Object.keys(row);
      return c.query(
        `INSERT INTO crove_finance.cash_voucher (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING number`,
        Object.values(row),
      );
    };
    // The trigger gives the next number whatever the writer asks for (the command's insert never names one).
    const numbered = await asApp(async (c) => (await insert(c, { number: 1 })).rows[0].number);
    expect(numbered).toBe(6);
    // A bank account on a cash voucher, and the reverse, are refused.
    await expect(asApp((c) => insert(c, { cash_account: '1121' }))).rejects.toMatchObject({ code: '23514', constraint: 'cash_voucher_account_matches_type' });
    await expect(asApp((c) => insert(c, { voucher_type: 'bank_debit' }))).rejects.toMatchObject({ code: '23514' });
    // A voucher without its journal entry cannot commit.
    await expect(
      asApp(async (c) => {
        await insert(c, {});
        await c.query('COMMIT');
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('must be posted as a journal entry') });
    // Vouchers never change and are never deleted, even by the database owner.
    await expect(asApp((c) => c.query(`UPDATE crove_finance.cash_voucher SET amount = 1 WHERE id = $1`, [paymentVoucher]))).rejects.toMatchObject({ code: '42501' });
    await expect(admin((c) => c.query(`DELETE FROM crove_finance.cash_voucher WHERE id = $1`, [paymentVoucher]))).rejects.toThrow(/append-only/);
    // Another org's row is refused by row security.
    await expect(asApp((c) => insert(c, { org_id: other.orgId }))).rejects.toMatchObject({ code: '42501' });
    // An entry that does not move the cash account by the amount is refused at commit (as the database owner, who may
    // write the ledger directly).
    await expect(
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          const id = randomUUID();
          const entry = randomUUID();
          await c.query(
            `INSERT INTO crove_finance.cash_voucher (org_id, id, voucher_type, voucher_date, cash_account, description, amount) VALUES ($1, $2, 'cash_receipt', '2026-09-30', '1111', 'x', 100)`,
            [org.orgId, id],
          );
          await c.query(
            `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, '2026-09-30', 'x', 'finance.cash_voucher', $3)`,
            [org.orgId, entry, id],
          );
          await c.query(
            `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '1111', 90, 0), ($1, $2, 2, '711', 0, 90)`,
            [org.orgId, entry],
          );
          await c.query('COMMIT');
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
        }
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('does not move 1111 by the voucher amount') });
  });

  it('refuses at request time a voucher whose proposal could never be approved (#509)', async () => {
    // A party whose stored tax code is longer than a voucher holds (zCashVoucherProposal): the proposal would be refused
    // at approval, and abort every bulk approval it is part of, so it is never stored.
    const odd = randomUUID();
    await admin((c) => c.query(`INSERT INTO crove_kernel.party (org_id, id, name, tax_code) VALUES ($1, $2, 'Đối tác mã dài', $3)`, [org.orgId, odd, '0'.repeat(25)]));
    const count = async () =>
      Number((await admin(async (c) => (await c.query(`SELECT count(*) AS n FROM crove_kernel.proposal WHERE org_id = $1 AND kind = 'finance.cash_voucher'`, [org.orgId])).rows))[0].n);
    const before = await count();
    const refused = await ask(member, payment('1000', { partyId: odd }));
    expect(refused).toMatchObject({ status: 422, body: { code: 'VOUCHER_INVALID', data: { problems: ['PROPOSAL_INVALID'], fields: ['party.taxCode'] } } });
    expect(await count()).toBe(before);
  });

  it('approves two mixed-type bulk batches at the same time without a deadlock (#509)', async () => {
    const receipt = (amount: string) => ({
      type: 'cash_receipt',
      date: '2026-09-29',
      cashAccount: '1111',
      partyId: customer,
      description: 'Khách hàng trả nợ',
      lines: [{ account: '131', amount }],
    });
    // Entered one after another, so their ids (time-ordered) run r1 < p1 < p2 < r2. In id order the first batch would
    // take the PT numbering lock then PC, and the second PC then PT: the order that deadlocked.
    const ids: string[] = [];
    for (const input of [receipt('11000'), payment('12000', { date: '2026-09-29' }), payment('13000', { date: '2026-09-29' }), receipt('14000')]) {
      const asked = await ask(member, input);
      expect(asked.status).toBe(200);
      ids.push(String(asked.body.proposalId));
    }
    expect([...ids].sort()).toEqual(ids);
    const [r1, p1, p2, r2] = ids as [string, string, string, string];
    const batch = async (items: string[]) =>
      rpc('inbox/approveMany', await tokenFor(owner, { mfa: true }), { items: items.map((id) => ({ id, revision: 1 })), idempotencyKey: randomUUID() });
    const [first, second] = await Promise.all([batch([r1, p1]), batch([p2, r2])]);
    for (const result of [first, second]) {
      expect(result.status).toBe(200);
      expect((result.body.results as any[]).map((r) => r.outcome)).toEqual(['approved', 'approved']);
    }
    // Each type numbered once each, with no gap.
    const listed = (await rpc('vouchers/list', await tokenFor(viewer), { from: '2026-09-29', to: '2026-09-29' })).body.items as any[];
    expect(listed.filter((v) => v.type === 'cash_receipt').map((v) => v.number).sort()).toEqual([2, 3]);
    expect(listed.filter((v) => v.type === 'cash_payment')).toHaveLength(2);
  });

  it('lists vouchers a page at a time, newest first, and says when older ones follow (#509)', async () => {
    // 120 more vouchers in the other org, written as the database owner with triggers off (each would otherwise need its
    // own approved proposal and journal entry); the list reads only the voucher rows, entries are optional.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      for (let i = 0; i < 120; i += 1) {
        await c.query(
          `INSERT INTO crove_finance.cash_voucher (org_id, voucher_type, number, voucher_date, cash_account, description, amount) VALUES ($1, 'cash_payment', $2, $3, '1111', 'Chi lẻ', 1)`,
          [other.orgId, i + 2, `2026-08-${String((i % 28) + 1).padStart(2, '0')}`],
        );
      }
      await c.query('COMMIT');
    });
    const token = await tokenFor(outsider);
    const first = (await rpc('vouchers/list', token, {}, other.slug)).body;
    expect(first.items).toHaveLength(100);
    expect(first.more).toBe(true);
    const last = first.items.at(-1);
    const second = (await rpc('vouchers/list', token, { before: { date: last.date, id: last.id } }, other.slug)).body;
    expect(second).toMatchObject({ more: false });
    expect(second.items).toHaveLength(21);
    const all = [...first.items, ...second.items] as any[];
    expect(new Set(all.map((v) => v.id)).size).toBe(121);
    // Newest date first, then newest voucher first: each row comes after the one before it.
    const key = (v: any) => `${v.date}|${v.id}`;
    expect(all.map(key)).toEqual(all.map(key).sort().reverse());
    expect(all[0]).toMatchObject({ code: 'PC00001', date: '2026-09-20' });
  });
});
