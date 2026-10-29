// Onboarding by tax code (issue #324) on a real PostgreSQL 17, through the HTTP API the app calls: the org's address
// (owners and admins set it, it is stored on one line and audited, the column refuses what the command refuses), the
// public tax registry lookup (off without TAX_CODE_LOOKUP_URL, any signed-in user with it, nothing written), and the
// flow the onboarding form runs: create the org, then set its tax code and address.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { DomainError, Runtime, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import type { TaxCodeLookup } from '../src/tax-lookup.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-onboarding-0123456789';
const ISSUER = 'crove-auth';
// A fake tax code (see the MST fixture guard).
const TAX_CODE = '0101234564';

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('onboarding by tax code (#324)', () => {
  const dbName = `crove_test_onboarding_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  let appWithoutLookup: ReturnType<typeof createHttpApp>;
  const lookups: string[] = [];
  const owner: Account = { subject: randomUUID(), email: 'owner@onboarding.test', session: randomUUID(), userId: '' };
  const admin: Account = { subject: randomUUID(), email: 'admin@onboarding.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@onboarding.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };

  // Stands in for the provider: one known tax code.
  const fakeRegistry: TaxCodeLookup = {
    async lookup(taxCode, requester) {
      expect(requester).toMatch(/^[0-9a-f-]{36}$/);
      lookups.push(taxCode);
      if (taxCode.replace(/\D/g, '') !== TAX_CODE) throw new DomainError('TAX_CODE_NOT_FOUND', 404, 'not found');
      return { taxCode: TAX_CODE, name: 'CÔNG TY TNHH KHÁCH HÀNG MỘT', address: 'Số 1 Phố Huế, Hà Nội' };
    },
  };

  async function asAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
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

  async function rpc(path: string, token: string | null, input: unknown, slug: string | null = org.slug, target = app) {
    const response = await target.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  const setAddress = async (address: string | null, who: Account = owner) => rpc('org/setAddress', await tokenFor(who), { address });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const deps = { config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    app = createHttpApp({ ...deps, taxLookup: fakeRegistry });
    appWithoutLookup = createHttpApp(deps);

    for (const who of [owner, admin, member]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Kế toán', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    for (const [who, role] of [
      [admin, 'admin'],
      [member, 'member'],
    ] as const) {
      const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role });
      expect(invite.status).toBe(200);
      expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets owners and admins set the address on one line, audits the change, and shows it to every member', async () => {
    expect((await rpc('org/get', await tokenFor(member), undefined)).body).toMatchObject({ address: null });
    expect(await setAddress('  Số 1 Phố Huế,\n  Quận Hai Bà Trưng,\tHà Nội ')).toMatchObject({ status: 200, body: { address: 'Số 1 Phố Huế, Quận Hai Bà Trưng, Hà Nội' } });
    expect(await setAddress('Tầng 2, Số 1 Phố Huế, Hà Nội', admin)).toMatchObject({ status: 200 });
    expect((await rpc('org/get', await tokenFor(member), undefined)).body).toMatchObject({ address: 'Tầng 2, Số 1 Phố Huế, Hà Nội' });
    const audit = await asAdmin(
      async (c) =>
        (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.set_address' AND outcome = 'ok' ORDER BY occurred_at`, [org.orgId]))
          .rows,
    );
    expect(audit.map((r) => r.detail)).toEqual([
      { previous: null, address: { redacted: 'contact' }, changed: true },
      { previous: { redacted: 'contact' }, address: { redacted: 'contact' }, changed: true },
    ]);
    const activity = await asAdmin(async (c) => (await c.query(`SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND kind = 'org.address_changed'`, [org.orgId])).rows);
    expect(activity).toHaveLength(2);
  });

  it('refuses members and viewers, control characters and addresses longer than 500 characters; null or blank clears it', async () => {
    expect(await setAddress('Somewhere else', member)).toMatchObject({ status: 403 });
    expect(await setAddress('Số 1\u0007 Phố Huế')).toMatchObject({ status: 422, body: { code: 'INVALID_ADDRESS' } });
    expect(await setAddress('A'.repeat(501))).toMatchObject({ status: 422, body: { code: 'INVALID_ADDRESS' } });
    expect(await setAddress('A'.repeat(500))).toMatchObject({ status: 200 });
    expect(await setAddress('   ')).toMatchObject({ status: 200, body: { address: null } });
    expect(await setAddress(null)).toMatchObject({ status: 200, body: { address: null } });
  });

  it('holds the same rules in the column, whoever writes it', async () => {
    for (const value of ['two\nlines', ' padded ', '', 'B'.repeat(501), 'bell\u0007']) {
      await expect(
        asAdmin((c) => c.query('UPDATE crove_kernel.tenant SET address = $2 WHERE org_id = $1', [org.orgId, value])),
        JSON.stringify(value),
      ).rejects.toThrow(/tenant_address_shape/);
    }
  });

  it('looks up a tax code for any signed-in user, with or without an org, and writes nothing', async () => {
    const before = await asAdmin(async (c) => Number((await c.query('SELECT count(*) AS n FROM crove_kernel.audit_event')).rows[0].n));
    expect(await rpc('taxRegistry/lookup', await tokenFor(member), { taxCode: ' 0101.234.564 ' }, null)).toMatchObject({
      status: 200,
      body: { taxCode: TAX_CODE, name: 'CÔNG TY TNHH KHÁCH HÀNG MỘT', address: 'Số 1 Phố Huế, Hà Nội' },
    });
    expect(await rpc('taxRegistry/lookup', await tokenFor(member), { taxCode: '0309876546' })).toMatchObject({ status: 404, body: { code: 'TAX_CODE_NOT_FOUND' } });
    expect(lookups).toEqual([' 0101.234.564 '.trim(), '0309876546']);
    expect(await rpc('taxRegistry/lookup', null, { taxCode: TAX_CODE }, null)).toMatchObject({ status: 401 });
    const after = await asAdmin(async (c) => Number((await c.query('SELECT count(*) AS n FROM crove_kernel.audit_event')).rows[0].n));
    expect(after).toBe(before);
  });

  it('answers TAX_LOOKUP_DISABLED when the server has no lookup', async () => {
    expect(await rpc('taxRegistry/lookup', await tokenFor(owner), { taxCode: TAX_CODE }, null, appWithoutLookup)).toMatchObject({
      status: 404,
      body: { code: 'TAX_LOOKUP_DISABLED' },
    });
  });

  it('runs the onboarding form: a new org, then its tax code and address, by the user who created it', async () => {
    const found = await rpc('taxRegistry/lookup', await tokenFor(admin), { taxCode: TAX_CODE }, null);
    const created = await rpc('org/create', await tokenFor(admin), { name: found.body.name, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    const slug = String(created.body.slug);
    expect((await rpc('org/setTaxCode', await tokenFor(admin), { taxCode: found.body.taxCode }, slug)).status).toBe(200);
    expect((await rpc('org/setAddress', await tokenFor(admin), { address: found.body.address }, slug)).status).toBe(200);
    expect((await rpc('org/get', await tokenFor(admin), undefined, slug)).body).toMatchObject({
      name: 'CÔNG TY TNHH KHÁCH HÀNG MỘT',
      role: 'owner',
      taxCode: TAX_CODE,
      address: 'Số 1 Phố Huế, Hà Nội',
    });
    // The first org is untouched.
    expect((await rpc('org/get', await tokenFor(owner), undefined)).body).toMatchObject({ taxCode: null, address: null });
  });
});
