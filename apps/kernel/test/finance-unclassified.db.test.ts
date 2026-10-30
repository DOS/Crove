// SPDX-License-Identifier: AGPL-3.0-only
// Invoice lines no account rule matches (#2091) on a real PostgreSQL 17, through the HTTP API where a user acts: such a
// line is proposed unclassified (a placeholder account, a warning check naming it) instead of the old silent 6422, the
// Inbox list counts the lines so its "Chưa phân loại" filter lists exactly those proposals, approving one is refused
// until a reviewer picks the account, and once picked the line is classified and its rule is learned like any chosen
// account (#1399). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
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
const SECRET = 'test-only-jwt-secret-for-unclassified-0123456789';
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
interface Check {
  id: string;
  status: string;
  code?: string;
  params?: Record<string, string>;
}

const suite = ADMIN ? describe : describe.skip;

suite('unclassified invoice lines (#2091)', () => {
  const dbName = `crove_test_unclassified_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@unclassified.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@unclassified.test', session: randomUUID(), userId: '' };
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
  // `ads` is the description of the advertising line (the fixture says 'Phí quảng cáo Facebook', which a built-in keyword
  // matches); a text no keyword matches makes that line unclassified.
  const invoice = (number: string, ads = 'Phí quảng cáo Facebook') =>
    new TextEncoder().encode(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('Phí quảng cáo Facebook', ads));

  async function propose(number: string, ads?: string) {
    const bytes = invoice(number, ads);
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

  const detail = async (id: string) => (await rpc('inbox/get', owner, { id })).body as { revision: number; unclassifiedLines: number; payload: { lines: Line[]; checks: Check[] } };
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
      new Runtime(target, { manifests: TEST_MANIFESTS, ...(sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {}) }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    runtime = register(db, true);
    workerRuntime = register(createDb(workerPool));
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, member]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Công ty Chưa phân loại', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
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

  // Approving as the owner under MFA, as the categorization tests do; the XML fixture's signature is not verified.
  const refused = (id: string, revision: number) => expect(approve(id, revision)).rejects.toMatchObject({ code: 'ACCOUNT_UNCLASSIFIED', status: 422 });

  const pendingList = async () =>
    (await rpc('inbox/list', owner, { status: 'pending' })).body as Array<{ id: string; unclassifiedLines: number; warnChecks: number }>;

  let unclassified = '';
  let classified = '';

  it('proposes a line no rule matches as unclassified with a warning check, and keeps the rest as before', async () => {
    unclassified = await propose('9301', 'Khoản không rõ');
    classified = await propose('9302');
    const { payload, unclassifiedLines } = await detail(unclassified);
    expect(unclassifiedLines).toBe(1);
    expect(lineOf(payload.lines, 'Khoản không rõ')).toMatchObject({ debitAccount: '000', accountRule: { source: 'unclassified' } });
    // The other lines are exactly what the built-in keywords gave them, and none fell back to 6422 by guess.
    expect(lineOf(payload.lines, 'Cước dịch vụ internet')).toMatchObject({ debitAccount: '6422', accountRule: { source: 'builtin' } });
    expect(payload.checks.find((c) => c.id === 'accounts')).toMatchObject({ status: 'warn', code: 'accounts.unclassified', params: { count: '1', lines: '2' } });
    const other = await detail(classified);
    expect(other.unclassifiedLines).toBe(0);
    expect(other.payload.checks.some((c) => c.id === 'accounts')).toBe(false);
  });

  it('counts the unclassified lines in the Inbox list, so the filter lists exactly those proposals', async () => {
    const items = await pendingList();
    expect(items.filter((i) => i.unclassifiedLines > 0).map((i) => [i.id, i.unclassifiedLines])).toEqual([[unclassified, 1]]);
    expect(items.find((i) => i.id === classified)?.unclassifiedLines).toBe(0);
    // The warning counts among the proposal's warnings too.
    expect(items.find((i) => i.id === unclassified)?.warnChecks).toBeGreaterThan(0);
  });

  it('refuses to approve it while a line is unclassified', async () => {
    const { revision } = await detail(unclassified);
    await refused(unclassified, revision);
    // Nothing was recorded: the proposal is still pending.
    expect((await pendingList()).some((i) => i.id === unclassified)).toBe(true);
  });

  it('classifies the line once a reviewer picks its account, clears the warning, and learns the rule', async () => {
    const before = await detail(unclassified);
    const lineNo = lineOf(before.payload.lines, 'Khoản không rõ').lineNo;
    const edited = await rpc('inbox/edit', owner, { id: unclassified, revision: before.revision, lineAccounts: [{ lineNo, debitAccount: '6421' }], idempotencyKey: randomUUID() });
    expect(edited).toMatchObject({ status: 200, body: { changed: true } });
    const revised = await detail(unclassified);
    expect(revised.unclassifiedLines).toBe(0);
    expect(lineOf(revised.payload.lines, 'Khoản không rõ')).toMatchObject({ debitAccount: '6421', accountRule: { source: 'user' } });
    expect(revised.payload.checks.find((c) => c.id === 'accounts')).toMatchObject({ status: 'pass', code: 'accounts.classified' });
    expect((await pendingList()).find((i) => i.id === unclassified)?.unclassifiedLines).toBe(0);
    await expect(approve(unclassified, revised.revision)).resolves.toMatchObject({ documentId: expect.any(String) });
    const learned = await admin(async (c) =>
      (await c.query<{ match_text: string; debit_account: string }>(`SELECT match_text, debit_account FROM crove_finance.categorization_rule WHERE org_id = $1 AND match_text = 'khoan khong ro'`, [org.orgId])).rows,
    );
    expect(learned).toEqual([{ match_text: 'khoan khong ro', debit_account: '6421' }]);
  });

  // The fixture's line 3 is a declared discount ("Chiết khấu thương mại"): it keeps its built-in 6422, so the invoice is
  // approvable as proposed.
  it('approves an invoice whose only non-keyword line is a declared discount, as proposed', async () => {
    const { payload, unclassifiedLines, revision } = await detail(classified);
    expect(unclassifiedLines).toBe(0);
    expect(lineOf(payload.lines, 'Chiết khấu')).toMatchObject({ debitAccount: '6422', accountRule: { source: 'builtin' } });
    await expect(approve(classified, revision)).resolves.toMatchObject({ documentId: expect.any(String) });
  });

  it('proposes the same item by the learned rule next time, classified', async () => {
    const id = await propose('9303', 'Khoản không rõ');
    const { payload, unclassifiedLines } = await detail(id);
    expect(unclassifiedLines).toBe(0);
    expect(lineOf(payload.lines, 'Khoản không rõ')).toMatchObject({ debitAccount: '6421', accountRule: { source: 'learned' } });
    expect(payload.checks.some((c) => c.id === 'accounts')).toBe(false);
  });
});
