// The assisted sync from the tax portal (#325), on a real PostgreSQL 17, through the HTTP API, against the fake portal
// (e2e/fake-tax-portal) on a local port: never the real portal. The CAPTCHA, the login, the list recorded through the
// same command and checks as an uploaded list, the XML downloads stored as this user's uploads (deduplicated, never
// fetched twice for a list), a second sync of the same answer, the sealed values bound to the user, org and period, the
// roles, the guard after repeated wrong passwords, the feature switch, and the password, the CAPTCHA answer and the
// portal's token nowhere in the database or the stored files.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { CredentialVault, EgressError, Runtime, guardedRequest, parseVaultKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { PORTAL_WRONG_PASSWORD_LIMIT, financeCommands, financeQueries, importPortalList } from '@crove/mod-finance';
import type { ExtractClient } from '@crove/extract-contract';
import { FAKE_CAPTCHA_ANSWER, FAKE_PORTAL_PASSWORD, startFakeTaxPortal, type FakePortal } from '../../../e2e/fake-tax-portal/server.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createPortalSync } from '../src/portal-sync.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TaxPortalError, createTaxPortalClient } from '../src/tax-portal.ts';
import { TEST_MANIFESTS } from './manifests.ts';

// What the person reads for PORTAL_LIST_TOO_LARGE, whatever cap stopped the list (#1938).
const TOO_LARGE = 'Danh sách của kỳ này quá lớn để lấy một lần; hãy xuất danh sách Excel từ cổng thuế rồi tải lên';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-portal-sync-0123456789';
const ISSUER = 'crove-auth';
const BUYER = '0309876546';
const PERIOD = '2026-09';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
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

// A synced list is read without the sandbox; any call to it is a bug.
const NO_SANDBOX: ExtractClient = {
  extract: () => {
    throw new Error('a synced list never goes to the sandbox');
  },
} as unknown as ExtractClient;

const suite = ADMIN ? describe : describe.skip;

suite('assisted tax portal sync (#325)', () => {
  const dbName = `crove_test_portal_sync_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  let appOff: ReturnType<typeof createHttpApp>;
  // An API with its own portal client and limits, for the budget and deadline tests.
  let appWith: (options: { limits?: Parameters<typeof createPortalSync>[0]['limits']; stepMs?: number; client?: ReturnType<typeof createTaxPortalClient> }) => ReturnType<typeof createHttpApp>;
  let portal: FakePortal;
  const store = new MemoryStore();
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const owner: Account = { subject: randomUUID(), email: 'owner@portal-sync.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@portal-sync.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@portal-sync.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@portal-sync.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let guarded = { slug: '', orgId: '' };
  let untaxed = { slug: '', orgId: '' };

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

  async function rpc(path: string, who: Account, input: unknown, slug: string | null = org.slug, target = app) {
    const response = await target.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who, { mfa: path.startsWith('org/invite') })}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  async function login(who: Account, slug: string, password = FAKE_PORTAL_PASSWORD, period = PERIOD) {
    const captcha = await rpc('portalSync/captcha', who, { period }, slug);
    expect(captcha.status, JSON.stringify(captcha.body)).toBe(200);
    return rpc('portalSync/login', who, { period, challenge: captcha.body.challenge, captcha: FAKE_CAPTCHA_ANSWER, password, consent: true }, slug);
  }

  async function invite(target: { slug: string }, who: Account, role: 'member' | 'viewer') {
    const invited = await rpc('org/invite', owner, { email: who.email, role }, target.slug);
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    expect((await rpc('invites/accept', who, { token: String(invited.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
  }

  beforeAll(async () => {
    portal = await startFakeTaxPortal();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = (() => {
      const url = new URL(adminUrl);
      url.username = 'crove_app';
      url.password = 'test-app-pw';
      return url.toString();
    })();
    pool = createPool({ connectionString: appUrl, max: 4 });
    const db: Db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registry);
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    workerRuntime = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const client = createTaxPortalClient({ baseUrl: portal.url, gapMs: 0, sleep: async () => {} });
    // Generous in-process limits, so the database's own guard is what the wrong-password test meets.
    const generous = { loginPerUser: 50, loginPerOrg: 50, captchaPerUser: 100, captchaPerOrg: 100, listPerOrg: 100, captchaPerProcess: 1000, loginPerProcess: 1000, listPerProcess: 1000 };
    const portalSync = createPortalSync({ runtime, store, broker: vault, client, limits: generous });
    const authenticate = createAuthenticator(config, db);
    app = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false, portalSync });
    appWith = (options) =>
      createHttpApp({
        config,
        runtime,
        store,
        authenticate,
        pool,
        aiEnabled: false,
        portalSync: createPortalSync({ runtime, store, broker: vault, client: options.client ?? client, limits: { ...generous, ...options.limits }, ...(options.stepMs ? { stepMs: options.stepMs } : {}) }),
      });
    appOff = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false });

    for (const who of [owner, member, viewer, outsider]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const make = async (name: string, taxCode: string | null) => {
      const created = await rpc('org/create', owner, { name, idempotencyKey: randomUUID() }, null);
      expect(created.status).toBe(200);
      const made = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
      if (taxCode) expect((await rpc('org/setTaxCode', owner, { taxCode }, made.slug)).status).toBe(200);
      return made;
    };
    org = await make('Công ty Người Mua Mẫu', BUYER);
    guarded = await make('Công ty Mật Khẩu Sai', '0302712573');
    untaxed = await make('Công ty Chưa Có MST', null);
    await invite(org, member, 'member');
    await invite(org, viewer, 'viewer');
    await invite(guarded, member, 'member');
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    await portal?.close();
    if (ADMIN) {
      const root = new pg.Client({ connectionString: ADMIN });
      await root.connect();
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await root.end();
    }
  });

  it('tells the app whether the deployment turned the sync on', async () => {
    expect(((await (await app.request('/api/config')).json()) as { taxPortalSync?: boolean }).taxPortalSync).toBe(true);
    expect(((await (await appOff.request('/api/config')).json()) as { taxPortalSync?: boolean }).taxPortalSync).toBe(false);
    const off = await rpc('portalSync/captcha', owner, { period: PERIOD }, org.slug, appOff);
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('PORTAL_SYNC_DISABLED');
  });

  it('records the period list and downloads the missing XML as the member, once', async () => {
    const captchas = portal.state.requests.filter((r) => r.path === '/api/captcha').length;
    const captcha = await rpc('portalSync/captcha', member, { period: PERIOD });
    expect(captcha.status, JSON.stringify(captcha.body)).toBe(200);
    expect(captcha.body.username).toBe(BUYER);
    expect(captcha.body.image).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(portal.state.requests.filter((r) => r.path === '/api/captcha').length).toBe(captchas + 1);
    const logged = await rpc('portalSync/login', member, { period: PERIOD, challenge: captcha.body.challenge, captcha: FAKE_CAPTCHA_ANSWER, password: FAKE_PORTAL_PASSWORD, consent: true });
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    // The portal got the org's tax code as the user name; the answer is a sealed envelope, not the token.
    expect(JSON.parse(portal.state.loginBodies.at(-1) as string)).toMatchObject({ username: BUYER, cvalue: FAKE_CAPTCHA_ANSWER });
    expect(logged.body.session).not.toContain(portal.state.tokens.at(-1));

    const list = await rpc('portalSync/fetchList', member, { period: PERIOD, session: logged.body.session });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toMatchObject({ unchanged: false, rows: 5, skipped: 0, ownSales: 0, otherBuyers: 0, withXml: 3 });
    // Filed, not recorded: the worker records it, with the same command as an uploaded list.
    const waiting = await rpc('portalSync/fetchXml', member, { period: PERIOD, session: logged.body.session, listId: list.body.listId });
    expect(waiting.body).toEqual({ downloaded: 0, duplicates: 0, failed: 0, remaining: 0, done: false, waiting: true });
    const requested = await admin((c) => c.query<{ n: string }>("SELECT count(*)::text AS n FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.portal_list.import_requested'", [org.orgId]));
    expect(requested.rows[0]?.n).toBe('1');
    expect(await importPortalList({ runtime: workerRuntime, store, extract: NO_SANDBOX }, org.orgId, list.body.listId)).toEqual({ rows: 5 });
    const reconciled = await rpc('portalList/reconcile', member, { period: PERIOD });
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.lists).toHaveLength(1);
    expect(reconciled.body.lists[0]).toMatchObject({ id: list.body.listId, status: 'done', rowCount: 5 });
    expect(reconciled.body.summary).toMatchObject({ portalInvoices: 5, missing: 5 });

    const xml = await rpc('portalSync/fetchXml', member, { period: PERIOD, session: logged.body.session, listId: list.body.listId });
    expect(xml.status, JSON.stringify(xml.body)).toBe(200);
    expect(xml.body).toEqual({ downloaded: 3, duplicates: 0, failed: 0, remaining: 0, done: true, waiting: false });
    expect(portal.state.xmlDownloads).toBe(3);
    // Stored as the member's uploads: the worker reads them like any upload (and opens the ZIP in the sandbox).
    const files = await admin((c) => c.query<{ content_type: string; source: string; created_by: string; filename: string }>("SELECT content_type, source, created_by, filename FROM crove_kernel.file WHERE org_id = $1 ORDER BY filename", [org.orgId]));
    expect(files.rows.filter((f) => f.source === 'upload').map((f) => [f.content_type, f.created_by])).toEqual([
      ['application/zip', member.userId],
      ['application/zip', member.userId],
      ['application/zip', member.userId],
    ]);
    expect(files.rows.filter((f) => f.source === 'import').map((f) => f.content_type)).toEqual(['application/json']);
    const events = await admin((c) => c.query<{ n: string }>("SELECT count(*)::text AS n FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.file.ingested'", [org.orgId]));
    expect(Number(events.rows[0]?.n)).toBe(3);

    // The same answer again: no new list, nothing downloaded twice.
    const again = await rpc('portalSync/fetchList', member, { period: PERIOD, session: logged.body.session });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ listId: list.body.listId, unchanged: true, withXml: 3 });
    const more = await rpc('portalSync/fetchXml', member, { period: PERIOD, session: logged.body.session, listId: list.body.listId });
    expect(more.body).toEqual({ downloaded: 0, duplicates: 0, failed: 0, remaining: 0, done: true, waiting: false });
    expect(portal.state.xmlDownloads).toBe(3);

    // Every call is in the ledger with its outcome class; the audit rows name the member.
    const calls = await admin((c) => c.query<{ step: string; state: string; n: string }>("SELECT step, state, count(*)::text AS n FROM crove_kernel.external_call WHERE org_id = $1 AND target = 'gdt_einvoice' GROUP BY step, state ORDER BY step, state", [org.orgId]));
    expect(calls.rows).toEqual([
      { step: 'captcha', state: 'succeeded', n: '1' },
      { step: 'list', state: 'succeeded', n: '2' },
      { step: 'login', state: 'succeeded', n: '1' },
      { step: 'xml', state: 'succeeded', n: '3' },
    ]);
    const audit = await admin((c) => c.query<{ command: string; detail: unknown }>("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.portal_sync.%' AND command <> 'finance.portal_sync.call_end' ORDER BY occurred_at", [org.orgId]));
    expect(audit.rows.map((r) => r.command)).toContain('finance.portal_sync.list');
    expect(JSON.stringify(audit.rows)).toContain('"consent":true');
  });

  it('keeps the password, the CAPTCHA answer and the portal token out of every table and stored file', async () => {
    const secrets = [FAKE_PORTAL_PASSWORD, ...portal.state.tokens];
    const found = await admin(async (c) => {
      const tables = await c.query<{ schema: string; name: string }>(
        "SELECT n.nspname AS schema, c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND (n.nspname LIKE 'crove%' OR n.nspname = 'pgboss')",
      );
      const hits: string[] = [];
      for (const t of tables.rows) {
        for (const secret of secrets) {
          const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${pg.escapeIdentifier(t.schema)}.${pg.escapeIdentifier(t.name)} x WHERE x::text LIKE $1`, [`%${secret}%`]);
          if (Number(r.rows[0]?.n) > 0) hits.push(`${t.schema}.${t.name}`);
        }
      }
      return hits;
    });
    expect(found).toEqual([]);
    for (const bytes of store.blobs.values()) {
      const text = Buffer.from(bytes).toString('utf8');
      for (const secret of secrets) expect(text.includes(secret)).toBe(false);
    }
    // The CAPTCHA answer was sent to the portal, and is in no audit row.
    const audit = await admin((c) => c.query<{ detail: unknown }>('SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1', [org.orgId]));
    expect(JSON.stringify(audit.rows)).not.toContain(FAKE_CAPTCHA_ANSWER);
  });

  it('binds the sealed challenge and session to the user, the org and the period', async () => {
    const logged = await login(owner, org.slug);
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const session = logged.body.session as string;
    // Another member, another period, another org, or a damaged envelope: refused before any portal call.
    const requests = portal.state.requests.length;
    expect((await rpc('portalSync/fetchList', member, { period: PERIOD, session })).body.code).toBe('PORTAL_SESSION_INVALID');
    expect((await rpc('portalSync/fetchList', owner, { period: '2026-10', session })).body.code).toBe('PORTAL_SESSION_INVALID');
    expect((await rpc('portalSync/fetchList', owner, { period: PERIOD, session }, guarded.slug)).body.code).toBe('PORTAL_SESSION_INVALID');
    expect((await rpc('portalSync/fetchList', owner, { period: PERIOD, session: `${session.slice(0, -4)}AAAA` })).body.code).toBe('PORTAL_SESSION_INVALID');
    expect(portal.state.requests.length).toBe(requests);
    const captcha = await rpc('portalSync/captcha', owner, { period: PERIOD });
    const stolen = await rpc('portalSync/login', member, { period: PERIOD, challenge: captcha.body.challenge, captcha: FAKE_CAPTCHA_ANSWER, password: FAKE_PORTAL_PASSWORD, consent: true });
    expect(stolen.status).toBe(400);
    expect(stolen.body.code).toBe('PORTAL_CHALLENGE_INVALID');
  });

  it('lets owners, admins and members run it, nobody else', async () => {
    const asViewer = await rpc('portalSync/captcha', viewer, { period: PERIOD });
    expect(asViewer.status).toBe(403);
    const asOutsider = await rpc('portalSync/captcha', outsider, { period: PERIOD });
    expect(asOutsider.status).toBe(403);
    expect(asOutsider.body.code).toBe('NOT_A_MEMBER');
    const noTaxCode = await rpc('portalSync/captcha', owner, { period: PERIOD }, untaxed.slug);
    expect(noTaxCode.status).toBe(409);
    expect(noTaxCode.body.code).toBe('TAX_CODE_REQUIRED');
    const noConsent = await rpc('portalSync/login', owner, { period: PERIOD, challenge: 'k1-0000000000000000.AAAAAAAAAAAAAAAA', captcha: 'X', password: 'x' });
    expect(noConsent.status).toBe(400);
  });

  it('tells a wrong CAPTCHA and a wrong password apart, and stops logging in before the portal locks the account', async () => {
    const wrongCaptcha = await (async () => {
      const captcha = await rpc('portalSync/captcha', owner, { period: PERIOD }, guarded.slug);
      return rpc('portalSync/login', owner, { period: PERIOD, challenge: captcha.body.challenge, captcha: 'NOPE', password: FAKE_PORTAL_PASSWORD, consent: true }, guarded.slug);
    })();
    expect(wrongCaptcha.status).toBe(422);
    expect(wrongCaptcha.body.code).toBe('PORTAL_WRONG_CAPTCHA');
    for (let i = 0; i < PORTAL_WRONG_PASSWORD_LIMIT; i++) {
      const wrong = await login(i % 2 === 0 ? owner : member, guarded.slug, 'not-the-password');
      expect(wrong.status).toBe(422);
      expect(wrong.body.code).toBe('PORTAL_WRONG_PASSWORD');
      expect(JSON.stringify(wrong.body)).not.toContain('not-the-password');
    }
    const logins = portal.state.logins.length;
    const guardedLogin = await login(member, guarded.slug);
    expect(guardedLogin.status).toBe(429);
    expect(guardedLogin.body.code).toBe('PORTAL_PASSWORD_GUARD');
    // Refused before the portal saw it.
    expect(portal.state.logins.length).toBe(logins);
    const failed = await admin((c) => c.query<{ error_code: string; error_kind: string }>("SELECT error_code, error_kind FROM crove_kernel.external_call WHERE org_id = $1 AND step = 'login' ORDER BY started_at", [guarded.orgId]));
    expect(failed.rows).toEqual([
      { error_code: 'WRONG_CAPTCHA', error_kind: 'bad_request' },
      { error_code: 'WRONG_PASSWORD', error_kind: 'permission' },
      { error_code: 'WRONG_PASSWORD', error_kind: 'permission' },
      { error_code: 'WRONG_PASSWORD', error_kind: 'permission' },
    ]);
  });

  it('tries an XML download again after the portal failed to answer it', async () => {
    const period = '2026-08';
    const logged = await login(owner, org.slug, FAKE_PORTAL_PASSWORD, period);
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const list = await rpc('portalSync/fetchList', owner, { period, session: logged.body.session });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    await importPortalList({ runtime: workerRuntime, store, extract: NO_SANDBOX }, org.orgId, list.body.listId);
    portal.options.outage = { status: 503, body: 'down', contentType: 'text/plain' };
    try {
      const down = await rpc('portalSync/fetchXml', owner, { period, session: logged.body.session, listId: list.body.listId });
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('PORTAL_UNAVAILABLE');
    } finally {
      portal.options.outage = null;
    }
    const open = await admin((c) => c.query<{ state: string; error_code: string }>("SELECT state, error_code FROM crove_kernel.external_call WHERE org_id = $1 AND step = 'xml' AND key LIKE $2", [org.orgId, `%:${list.body.listId}:%`]));
    expect(open.rows).toEqual([{ state: 'ambiguous', error_code: 'UNAVAILABLE' }]);
    const again = await rpc('portalSync/fetchXml', owner, { period, session: logged.body.session, listId: list.body.listId });
    expect(again.body).toEqual({ downloaded: 3, duplicates: 0, failed: 0, remaining: 0, done: true, waiting: false });
    const calls = await admin((c) => c.query<{ state: string; calls: number }>("SELECT state, calls FROM crove_kernel.external_call WHERE org_id = $1 AND step = 'xml' AND key LIKE $2 ORDER BY calls DESC", [org.orgId, `%:${list.body.listId}:%`]));
    expect(calls.rows.map((r) => [r.state, r.calls])).toEqual([
      ['succeeded', 2],
      ['succeeded', 1],
      ['succeeded', 1],
    ]);
  });

  it('counts logins whose outcome it could not read toward the guard (fails closed)', async () => {
    const created = await rpc('org/create', owner, { name: 'Công ty Cổng Lỗi', idempotencyKey: randomUUID() }, null);
    const flaky = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    expect((await rpc('org/setTaxCode', owner, { taxCode: '0100109108' }, flaky.slug)).status).toBe(200);
    portal.options.outage = { status: 503, body: 'down', contentType: 'text/plain', path: '/api/security-taxpayer/authenticate' };
    try {
      for (let i = 0; i < PORTAL_WRONG_PASSWORD_LIMIT; i++) {
        const unknown = await login(owner, flaky.slug);
        expect(unknown.body.code).toBe('PORTAL_UNAVAILABLE');
      }
    } finally {
      portal.options.outage = null;
    }
    const logins = portal.state.loginBodies.length;
    const refused = await login(owner, flaky.slug);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('PORTAL_PASSWORD_GUARD');
    expect(portal.state.loginBodies.length).toBe(logins);
  });

  it('lets a second member sync the same portal answer: same file, same list', async () => {
    const period = '2026-07';
    const first = await login(owner, org.slug, FAKE_PORTAL_PASSWORD, period);
    const listed = await rpc('portalSync/fetchList', owner, { period, session: first.body.session });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.unchanged).toBe(false);
    const second = await login(member, org.slug, FAKE_PORTAL_PASSWORD, period);
    const again = await rpc('portalSync/fetchList', member, { period, session: second.body.session });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ listId: listed.body.listId, unchanged: true });
  });

  it('spends no budget on calls it refuses, and keeps CAPTCHAs from using up the logins', async () => {
    const tight = appWith({ limits: { captchaPerProcess: 2, loginPerProcess: 2 } });
    for (let i = 0; i < 5; i++) {
      const refused = await rpc('portalSync/captcha', viewer, { period: PERIOD }, org.slug, tight);
      expect(refused.status).toBe(403);
    }
    // The owner still gets the process's two CAPTCHAs, and a login after them.
    const one = await rpc('portalSync/captcha', owner, { period: PERIOD }, org.slug, tight);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const two = await rpc('portalSync/captcha', owner, { period: PERIOD }, org.slug, tight);
    expect(two.status).toBe(200);
    const third = await rpc('portalSync/captcha', owner, { period: PERIOD }, org.slug, tight);
    expect(third.status).toBe(429);
    const logged = await rpc('portalSync/login', owner, { period: PERIOD, challenge: two.body.challenge, captcha: FAKE_CAPTCHA_ANSWER, password: FAKE_PORTAL_PASSWORD, consent: true }, org.slug, tight);
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
  });

  it('stops a step at its deadline, resumably, whatever the portal does', async () => {
    // A portal whose list endpoints take 1.5 seconds per page; the step has 1 second in all.
    const slowRequest: typeof guardedRequest = async (url, request, options) => {
      if (url.includes('/query/') || url.includes('/sco-query/')) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1500, options.timeoutMs)));
        if (options.timeoutMs < 1500) throw new EgressError('timeout', 'took too long');
      }
      return guardedRequest(url, request, options);
    };
    const slow = createTaxPortalClient({ baseUrl: portal.url, gapMs: 0, sleep: async () => {}, request: slowRequest });
    const slowApp = appWith({ client: slow, stepMs: 1000 });
    const period = '2026-06';
    const captcha = await rpc('portalSync/captcha', owner, { period }, org.slug, slowApp);
    const logged = await rpc('portalSync/login', owner, { period, challenge: captcha.body.challenge, captcha: FAKE_CAPTCHA_ANSWER, password: FAKE_PORTAL_PASSWORD, consent: true }, org.slug, slowApp);
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const started = Date.now();
    const list = await rpc('portalSync/fetchList', owner, { period, session: logged.body.session }, org.slug, slowApp);
    expect(list.status).toBe(503);
    expect(list.body.code).toBe('PORTAL_STEP_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(10_000);
    // Nothing was filed, and the call stays open to be made again.
    const call = await admin((c) => c.query<{ state: string; error_code: string }>("SELECT state, error_code FROM crove_kernel.external_call WHERE org_id = $1 AND step = 'list' ORDER BY started_at DESC LIMIT 1", [org.orgId]));
    expect(call.rows[0]).toEqual({ state: 'ambiguous', error_code: 'TOO_SLOW' });
  });

  it('binds the session to the tax code it was opened with', async () => {
    const ok = await login(owner, org.slug, FAKE_PORTAL_PASSWORD, '2026-05');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await rpc('org/setTaxCode', owner, { taxCode: '0302712574' })).status).toBe(200);
    try {
      const refused = await rpc('portalSync/fetchList', owner, { period: '2026-05', session: ok.body.session });
      expect(refused.body.code).toBe('PORTAL_SESSION_INVALID');
    } finally {
      expect((await rpc('org/setTaxCode', owner, { taxCode: BUYER })).status).toBe(200);
    }
  });

  // The finance domain refuses the list with its own error (domain/ stays pure, #1680); the API's answer is the same as
  // when the domain threw the runtime's DomainError: 422, the code and the domain's message, and nothing is filed.
  it('answers a list too large 422 PORTAL_LIST_TOO_LARGE with the finance message, filing nothing', async () => {
    const real = createTaxPortalClient({ baseUrl: portal.url, gapMs: 0, sleep: async () => {} });
    const huge: ReturnType<typeof createTaxPortalClient> = {
      ...real,
      async purchaseInvoices(token, from, to, step) {
        const answers = await real.purchaseInvoices(token, from, to, step);
        const first = answers.find((a) => a.rows.length > 0);
        if (!first) throw new Error('the fake portal answered no invoice');
        const sample = first.rows[0] as Record<string, unknown>;
        return [{ query: first.query, rows: Array.from({ length: 20_001 }, (_, i) => ({ ...sample, shdon: String(i + 1) })) }];
      },
    };
    const hugeApp = appWith({ client: huge });
    const files = async () => Number((await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.file WHERE org_id = $1', [org.orgId]))).rows[0]?.n);
    const before = await files();
    const captcha = await rpc('portalSync/captcha', owner, { period: PERIOD }, org.slug, hugeApp);
    const logged = await rpc('portalSync/login', owner, { period: PERIOD, challenge: captcha.body.challenge, captcha: FAKE_CAPTCHA_ANSWER, password: FAKE_PORTAL_PASSWORD, consent: true }, org.slug, hugeApp);
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const refused = await rpc('portalSync/fetchList', owner, { period: PERIOD, session: logged.body.session }, org.slug, hugeApp);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toMatchObject({ code: 'PORTAL_LIST_TOO_LARGE', message: TOO_LARGE });
    expect(await files()).toBe(before);
  });

  // The portal client's own cap (rows, pages or bytes of one answer) answers the same code with the same message as the
  // finance domain's refusal above: the person does the same either way (#1938).
  it("answers the portal client's cap with the same code and message, filing nothing", async () => {
    const real = createTaxPortalClient({ baseUrl: portal.url, gapMs: 0, sleep: async () => {} });
    const capped: ReturnType<typeof createTaxPortalClient> = {
      ...real,
      async purchaseInvoices() {
        throw new TaxPortalError('TOO_LARGE');
      },
    };
    const cappedApp = appWith({ client: capped });
    const files = async () => Number((await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.file WHERE org_id = $1', [org.orgId]))).rows[0]?.n);
    const before = await files();
    const captcha = await rpc('portalSync/captcha', owner, { period: PERIOD }, org.slug, cappedApp);
    const logged = await rpc('portalSync/login', owner, { period: PERIOD, challenge: captcha.body.challenge, captcha: FAKE_CAPTCHA_ANSWER, password: FAKE_PORTAL_PASSWORD, consent: true }, org.slug, cappedApp);
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const refused = await rpc('portalSync/fetchList', owner, { period: PERIOD, session: logged.body.session }, org.slug, cappedApp);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toMatchObject({ code: 'PORTAL_LIST_TOO_LARGE', message: TOO_LARGE });
    expect(await files()).toBe(before);
  });

  it('says the portal is down, without its words', async () => {
    portal.options.outage = { status: 503, body: 'Service Unavailable: upstream secret detail', contentType: 'text/plain' };
    try {
      const down = await rpc('portalSync/captcha', owner, { period: PERIOD });
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('PORTAL_UNAVAILABLE');
      expect(JSON.stringify(down.body)).not.toContain('upstream secret detail');
    } finally {
      portal.options.outage = null;
    }
  });
});
