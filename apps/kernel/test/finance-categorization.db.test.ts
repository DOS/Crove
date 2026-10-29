// Learned per-line account rules (issue #1399) on a real PostgreSQL 17, through the HTTP API where a user acts: an
// approver changes a line's account and approves, which writes the vendor's rule with its provenance in the audited
// command; the next invoice of the vendor is proposed by that rule per line (a month in the description does not
// matter) and the line says which rule chose it; vendor rules come before the vendor default, which comes before rules
// for every vendor; Settings lists rules with provenance, owners and admins add keyword rules and remove any rule, and
// nothing crosses orgs. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
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
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-account-rules-0123456789';
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

interface Line {
  lineNo: number;
  description: string;
  debitAccount: string;
  reason: string;
  accountRule?: { source: string; ruleId?: string; scope?: string; matchKind?: string };
}

const suite = ADMIN ? describe : describe.skip;

suite('learned account rules with provenance (#1399)', () => {
  const dbName = `crove_test_account_rules_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@account-rules.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@account-rules.test', session: randomUUID(), userId: '' };
  const other: Account = { subject: randomUUID(), email: 'other@account-rules.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let orgB = { slug: '', orgId: '' };

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

  async function rpc(path: string, who: Account, input: unknown, slug: string | null = org.slug, options: { mfa?: boolean } = {}) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who, options)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  // The fixture invoice under a new number, with its internet line dated in `month` (the fixture says 9/2026).
  const invoice = (number: string, month = '9/2026') =>
    new TextEncoder().encode(
      FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('tháng 9/2026', `tháng ${month}`),
    );

  async function propose(number: string, month?: string) {
    const bytes = invoice(number, month);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(org.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: `hd-${number}.xml`, contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    const proposal = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, fileId);
    return String(proposal.proposalId);
  }

  const detail = async (id: string) => (await rpc('inbox/get', owner, { id })).body as { revision: number; payload: { lines: Line[] } };
  const lineOf = (lines: Line[], prefix: string) => {
    const line = lines.find((l) => l.description.startsWith(prefix));
    if (!line) throw new Error(`no line ${prefix}`);
    return line;
  };

  const approve = (id: string, revision: number) =>
    runtime.execute<{ documentId: string; journalEntryId: string }>('kernel.proposal.approve', { acceptUnverifiedSignature: true, id, revision }, {
      actor: asMfa(owner.userId),
      orgId: org.orgId,
      idempotencyKey: randomUUID(),
    });

  // Changes the accounts of the lines named by their description's start, then approves the new revision.
  async function editAndApprove(id: string, accounts: Record<string, string>) {
    const before = await detail(id);
    const lineAccounts = Object.entries(accounts).map(([prefix, debitAccount]) => ({ lineNo: lineOf(before.payload.lines, prefix).lineNo, debitAccount }));
    const edited = await rpc('inbox/edit', owner, { id, revision: before.revision, lineAccounts, idempotencyKey: randomUUID() });
    expect(edited).toMatchObject({ status: 200, body: { changed: true } });
    const revised = await detail(id);
    for (const { lineNo } of lineAccounts) {
      expect(revised.payload.lines.find((l) => l.lineNo === lineNo)?.accountRule).toEqual({ source: 'user' });
    }
    return approve(id, revised.revision);
  }

  const rules = async () =>
    admin(async (c) =>
      (
        await c.query<{ vendor: boolean; match_kind: string; match_text: string; label: string | null; debit_account: string; confirmed_by: string | null; source_document_id: string | null }>(
          `SELECT vendor_party_id IS NOT NULL AS vendor, match_kind, match_text, label, debit_account, confirmed_by, source_document_id
             FROM crove_finance.categorization_rule WHERE org_id = $1 ORDER BY match_text`,
          [org.orgId],
        )
      ).rows,
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
    const appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    const db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db, sessions = false) =>
      new Runtime(target, { manifests: TEST_MANIFESTS, ...sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {} }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    runtime = register(db, true);
    workerRuntime = register(createDb(workerPool));
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, member, other]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Công ty Quy tắc', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const createdB = await rpc('org/create', other, { name: 'Công ty Khác', idempotencyKey: randomUUID() }, null);
    orgB = { slug: String(createdB.body?.slug), orgId: String(createdB.body?.orgId) };
    const invite = await rpc('org/invite', owner, { email: member.email, role: 'member' }, org.slug, { mfa: true });
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', member, { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
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

  let firstDocument = '';

  it('proposes the first invoice by the built-in keywords and learns nothing from an approval as proposed', async () => {
    const id = await propose('9101');
    const { payload } = await detail(id);
    expect(lineOf(payload.lines, 'Cước dịch vụ internet')).toMatchObject({ debitAccount: '6422', accountRule: { source: 'builtin' } });
    expect(lineOf(payload.lines, 'Phí quảng cáo')).toMatchObject({ debitAccount: '6421', accountRule: { source: 'builtin' } });
    // Changing the internet line to prepaid costs (242) teaches the vendor's rule for that item when approved.
    const recorded = await editAndApprove(id, { 'Cước dịch vụ internet': '242' });
    firstDocument = recorded.documentId;
    expect(await rules()).toEqual([
      {
        vendor: true,
        match_kind: 'description',
        match_text: 'cuoc dich vu internet thang',
        label: 'Cước dịch vụ internet tháng 9/2026',
        debit_account: '242',
        confirmed_by: owner.userId,
        source_document_id: firstDocument,
      },
    ]);
    // In the audited command that recorded the invoice.
    const audit = await admin(async (c) =>
      (await c.query<{ detail: { learned_rules: Array<{ lineNo: number; account: string; created: boolean }> } }>(
        `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.purchase.record' AND outcome = 'ok' AND detail ? 'learned_rules'`,
        [org.orgId],
      )).rows,
    );
    expect(audit).toEqual([{ detail: expect.objectContaining({ learned_rules: [expect.objectContaining({ lineNo: 1, account: '242', created: true })] }) }]);
  });

  it('proposes the next invoice per line: the learned rule for the same item, whatever its month, and the vendor default for the rest', async () => {
    const id = await propose('9102', '10/2026');
    const { payload } = await detail(id);
    const internet = lineOf(payload.lines, 'Cước dịch vụ internet');
    expect(internet).toMatchObject({ debitAccount: '242', accountRule: { source: 'learned', scope: 'vendor', matchKind: 'description' } });
    expect(internet.reason).toContain('quy tắc đã học');
    // The vendor default is the account of the largest line of the first invoice (242 too); the ad line follows it.
    expect(lineOf(payload.lines, 'Phí quảng cáo')).toMatchObject({ debitAccount: '242', accountRule: { source: 'vendor_default' } });
    // The approver puts the ad line back on 6421: a second rule for this vendor, and the first one is untouched.
    await editAndApprove(id, { 'Phí quảng cáo': '6421' });
    expect((await rules()).map((r) => [r.match_text, r.debit_account])).toEqual([
      ['cuoc dich vu internet thang', '242'],
      ['phi quang cao facebook', '6421'],
    ]);

    // A vendor that sells both: each line now goes where it was approved.
    const third = await propose('9103', '11/2026');
    const lines = (await detail(third)).payload.lines;
    expect(lineOf(lines, 'Cước dịch vụ internet').debitAccount).toBe('242');
    expect(lineOf(lines, 'Phí quảng cáo')).toMatchObject({ debitAccount: '6421', accountRule: { source: 'learned', scope: 'vendor' } });
  });

  it('updates a rule when an approver changes its account again, with the new provenance', async () => {
    const id = await propose('9104');
    const recorded = await editAndApprove(id, { 'Cước dịch vụ internet': '6422' });
    const internet = (await rules()).find((r) => r.match_text === 'cuoc dich vu internet thang');
    expect(internet).toMatchObject({ debit_account: '6422', source_document_id: recorded.documentId, confirmed_by: owner.userId });
    expect((await rules()).length).toBe(2);
  });

  it('lists the rules in Settings with their provenance, for every role', async () => {
    const list = await rpc('accountRules/list', member, undefined);
    expect(list.status).toBe(200);
    const byText = new Map((list.body as Array<{ matchText: string }>).map((r) => [r.matchText, r]));
    expect(byText.get('phi quang cao facebook')).toMatchObject({
      matchKind: 'description',
      label: 'Phí quảng cáo Facebook',
      accountCode: '6421',
      vendor: { name: expect.any(String) },
      confirmedBy: owner.email,
      sourceDocument: { number: '9102', invoiceDate: expect.any(String) },
    });
    // Another org sees none of them.
    expect((await rpc('accountRules/list', other, undefined, orgB.slug)).body).toEqual([]);
  });

  it('lets owners and admins add a keyword rule for every vendor, which applies after the vendor default', async () => {
    const add = (input: Record<string, unknown>, who = owner) => rpc('accountRules/create', who, input);
    expect(await add({ keyword: 'Chiết khấu', accountCode: '6422' }, member)).toMatchObject({ status: 403 });
    expect(await add({ keyword: '!!', accountCode: '6422' })).toMatchObject({ status: 422, body: { code: 'RULE_TEXT_TOO_SHORT' } });
    expect(await add({ keyword: 'chiết khấu', accountCode: '5111' })).toMatchObject({ status: 422, body: { code: 'REVENUE_ACCOUNT_ON_PURCHASE' } });
    expect(await add({ keyword: 'chiết khấu', accountCode: '9999' })).toMatchObject({ status: 422, body: { code: 'UNKNOWN_ACCOUNT' } });
    const created = await add({ keyword: 'Chiết khấu', accountCode: '6422' });
    expect(created).toMatchObject({ status: 200, body: { id: expect.any(String) } });
    // The same words, with other marks and case, are the same rule.
    expect(await add({ keyword: 'CHIET KHAU', accountCode: '642' })).toMatchObject({ status: 409, body: { code: 'RULE_EXISTS' } });
    expect((await rules()).find((r) => r.match_kind === 'keyword')).toMatchObject({ vendor: false, match_text: 'chiet khau', label: 'Chiết khấu', confirmed_by: owner.userId, source_document_id: null });

    // The vendor default still comes first for this vendor; without it, the keyword rule proposes the discount line.
    let lines = (await detail(await propose('9105'))).payload.lines;
    expect(lineOf(lines, 'Chiết khấu')).toMatchObject({ accountRule: { source: 'vendor_default' } });
    const [vendor] = (await rpc('parties/list', owner, {})).body as Array<{ id: string }>;
    expect(await rpc('parties/setDefaultAccount', owner, { partyId: vendor?.id, accountCode: null })).toMatchObject({ status: 200 });
    lines = (await detail(await propose('9106'))).payload.lines;
    expect(lineOf(lines, 'Chiết khấu')).toMatchObject({ debitAccount: '6422', accountRule: { source: 'learned', scope: 'org', matchKind: 'keyword' } });
    expect(lineOf(lines, 'Chiết khấu').reason).toContain('Chiết khấu');
  });

  it('removes a rule through the audited command, for owners and admins of its org only', async () => {
    const list = (await rpc('accountRules/list', owner, undefined)).body as Array<{ id: string; matchText: string }>;
    const ads = list.find((r) => r.matchText === 'phi quang cao facebook');
    expect(ads).toBeDefined();
    expect(await rpc('accountRules/remove', member, { id: ads?.id })).toMatchObject({ status: 403 });
    expect(await rpc('accountRules/remove', other, { id: ads?.id }, orgB.slug)).toMatchObject({ status: 404, body: { code: 'RULE_NOT_FOUND' } });
    expect(await rpc('accountRules/remove', owner, { id: ads?.id })).toMatchObject({ status: 200, body: { id: ads?.id } });
    expect(await rpc('accountRules/remove', owner, { id: ads?.id })).toMatchObject({ status: 404, body: { code: 'RULE_NOT_FOUND' } });
    const audit = await admin(async (c) =>
      (await c.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.categorization_rule.remove' AND outcome = 'ok'`,
        [org.orgId],
      )).rows,
    );
    expect(audit).toEqual([{ detail: expect.objectContaining({ ruleId: ads?.id, matchText: 'phi quang cao facebook', accountCode: '6421' }) }]);
    // With the rule gone and no vendor default, the ad line is proposed by the built-in keywords again.
    const lines = (await detail(await propose('9107'))).payload.lines;
    expect(lineOf(lines, 'Phí quảng cáo')).toMatchObject({ debitAccount: '6421', accountRule: { source: 'builtin' } });
  });

  it('keeps the rule text in normalized form and the rows inside their org at the database', async () => {
    // The CHECK refuses text that is not normalized, whoever writes it.
    await expect(
      admin((c) => c.query(`INSERT INTO crove_finance.categorization_rule (org_id, match_kind, match_text, debit_account) VALUES ($1, 'keyword', 'Chiết khấu', '6422')`, [org.orgId])),
    ).rejects.toThrow(/categorization_rule_match_text_check/);
    // An account outside the chart is refused like every other account reference.
    await expect(
      admin((c) => c.query(`INSERT INTO crove_finance.categorization_rule (org_id, match_kind, match_text, debit_account) VALUES ($1, 'keyword', 'abc', '9999')`, [org.orgId])),
    ).rejects.toThrow(/not in the chart of accounts/);
    // What a rule matches never changes in place for the tenant role.
    const client = new pg.Client({ connectionString: new URL(adminUrl).toString() });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE crove_tenant');
      await expect(client.query(`UPDATE crove_finance.categorization_rule SET match_text = 'x y'`)).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });
});
