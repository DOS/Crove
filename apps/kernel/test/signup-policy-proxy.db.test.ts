// AUTH_SIGNUP_POLICY end to end through the kernel's /auth/v1 proxy (#350), on a real PostgreSQL 17 with real member
// invites, in front of a fake Supabase Auth that records what reaches it. Each mode admits exactly the sign-ups it
// should, every refusal is the same response and never reaches Supabase Auth, and sign-in and password recovery keep
// working. A sign-up for an invited address needs the invite's token from the accept link (#563), which never
// reaches Supabase Auth. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import type { InviteChecks } from '../src/auth-signup-policy.ts';
import { createHttpApp } from '../src/http.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const REFUSED = { code: 403, error_code: 'signup_not_allowed', msg: 'Email này chưa được phép đăng ký tài khoản' };

const suite = ADMIN ? describe : describe.skip;

type App = ReturnType<typeof createHttpApp>;

suite('sign-up policy through the /auth/v1 proxy (#350)', () => {
  const dbName = `crove_test_signuppolicy_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let upstream: Server;
  let upstreamUrl = '';
  // What reached the fake Supabase Auth: method, path with query, body; and every invite token header it saw.
  const reached: string[] = [];
  const leakedTokens: string[] = [];
  let seq = 0;
  // A fresh client address per call, so the email budget never mixes tests (the budget test picks its own).
  const nextClient = () => `198.51.100.${(++seq % 250) + 1}`;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '3c1f0b7e-5a2d-4e9f-8b61-0d4c2a7e9f15',
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

  function appWith(env: Record<string, string>, signupInviteChecks?: InviteChecks): App {
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused@localhost/unused',
      AUTH_JWT_SECRET: 'x'.repeat(32),
      AUTH_ISSUER: 'crove-auth',
      AUTH_UPSTREAM_URL: upstreamUrl,
      AUTH_AUTOCONFIRM: 'false',
      AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR: '1000',
      AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS: '0',
      WEB_DIST: '/nonexistent',
      ...env,
    });
    return createHttpApp({
      config,
      runtime: { installed: () => true, modules: () => ['kernel', 'finance'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool,
      aiEnabled: false,
      ...(signupInviteChecks ? { signupInviteChecks } : {}),
    });
  }

  const call = (app: App, method: string, path: string, body?: unknown, client = nextClient(), contentType = 'application/json', invite?: string) =>
    app.fetch(
      new Request(`http://localhost/auth/v1${path}`, {
        method,
        headers: { 'content-type': contentType, ...(invite === undefined ? {} : { 'x-crove-invite': invite }) },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }),
      { incoming: { socket: { remoteAddress: client } } },
    );
  const post = (app: App, path: string, body: unknown, client?: string, invite?: string) => call(app, 'POST', path, body, client, 'application/json', invite);
  // A sign-up, with the invite token from an accept link when `invite` is given (the web app's header).
  const signup = (app: App, email: unknown, client?: string, invite?: string) => post(app, '/signup', { email, password: 'pw-12345678' }, client, invite);

  async function expectMethodRefused(response: Response) {
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 403, error_code: 'signup_method_not_allowed', msg: 'Cách đăng nhập này đang tắt trên máy chủ' });
  }

  async function expectRefused(response: Response) {
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(REFUSED);
  }

  // An org whose owner invites `emails`; returns the invite ids and the tokens of their accept links by email.
  async function orgInviting(emails: string[]) {
    const db = createDb(pool);
    const ownerId = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@owners.test`, name: null });
    const { orgId } = await createOrg(runtime, asUser(ownerId), `Org ${randomUUID().slice(0, 6)}`);
    const ids = new Map<string, string>();
    const tokens = new Map<string, string>();
    for (const email of emails) {
      const created = await runtime.execute<{ inviteId: string; acceptPath: string }>(
        'kernel.member.invite.create',
        { email, role: 'member' },
        { actor: asMfa(ownerId), orgId },
      );
      ids.set(email, created.inviteId);
      tokens.set(email, created.acceptPath.split('#')[1] as string);
    }
    return { orgId, ownerId, ids, tokens };
  }

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    runtime = new Runtime(createDb(pool)).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });

    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        reached.push(`${req.method} ${req.url} ${raw}`);
        const leaked = req.headers['x-crove-invite'];
        if (leaked !== undefined) leakedTokens.push(String(leaked));
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    await pool?.end().catch(() => {});
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('invite_only', () => {
    let app: App;
    const tag = randomUUID().slice(0, 8);
    const invited = `an-${tag}@partner.test`;
    const kelvin = `kim-${tag}@partner.test`;
    const revoked = `revoked-${tag}@partner.test`;
    const expired = `expired-${tag}@partner.test`;
    // The token of each address's invite, from its accept link.
    let token: Map<string, string>;
    const EXPIRED_TOKEN = 'E'.repeat(43);

    beforeAll(async () => {
      app = appWith({ AUTH_SIGNUP_POLICY: 'invite_only' });
      const { orgId, ownerId, ids, tokens } = await orgInviting([invited, kelvin, revoked]);
      token = tokens;
      await runtime.execute('kernel.member.invite.revoke', { inviteId: ids.get(revoked) }, { actor: asUser(ownerId), orgId });
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by, created_at, expires_at, token_sha256)
           VALUES ($1, $2, 'member', $3, now() - interval '8 days', now() - interval '1 minute', encode(sha256(convert_to($4, 'UTF8')), 'hex'))`,
          [orgId, expired, ownerId, EXPIRED_TOKEN],
        ),
      );
    });

    it('forwards the sign-up of an invited email with its invite token, in any letter case, and refuses everyone else alike', async () => {
      const before = reached.length;
      const tok = token.get(invited) as string;
      expect((await signup(app, invited, undefined, tok)).status).toBe(200);
      expect((await signup(app, invited.toUpperCase(), undefined, tok)).status).toBe(200);
      expect((await signup(app, `  ${invited} `, undefined, tok)).status).toBe(200);
      expect(reached.length).toBe(before + 3);
      // The token is the proxy's: it never reaches Supabase Auth.
      expect(leakedTokens).toEqual([]);
      await expectRefused(await signup(app, revoked, undefined, token.get(revoked)));
      await expectRefused(await signup(app, expired, undefined, EXPIRED_TOKEN));

      for (const email of [
        `nobody-${tag}@partner.test`,
        revoked,
        expired,
        // Plus-addressing reaches the same inbox but is not the invited address.
        invited.replace('@', '+x@'),
        invited.replace('@', '@sub.'),
        // Unicode look-alikes: Kelvin sign for k, fullwidth a, Cyrillic a, a zero-width space.
        kelvin.replace('k', 'K'),
        invited.replace('a', 'ａ'),
        invited.replace('a', 'а'),
        invited.replace('@', '​@'),
        `${invited}\u0000`,
        42,
        null,
      ]) {
        await expectRefused(await signup(app, email, undefined, tok));
      }
      expect(reached.length).toBe(before + 3);
    });

    // #563: Supabase Auth keeps the first unconfirmed sign-up's password, so a sign-up that only names an invited
    // address would let whoever knows it create the invitee's account with their own password.
    it('refuses a sign-up for an invited email without its token, or with the token of another invite or a malformed one', async () => {
      const before = reached.length;
      const tok = token.get(invited) as string;
      await expectRefused(await signup(app, invited));
      await expectRefused(await signup(app, invited, undefined, token.get(kelvin)));
      await expectRefused(await signup(app, kelvin, undefined, tok));
      for (const bad of ['', 'x', `${tok}x`, `${tok}, ${tok}`, tok.toUpperCase() === tok ? tok.toLowerCase() : tok.toUpperCase()]) {
        await expectRefused(await signup(app, invited, undefined, bad));
      }
      // The token counts in the header only: one in the body is not read.
      await expectRefused(await post(app, '/signup', { email: invited, password: 'pw-12345678', invite: tok }));
      expect(reached.length).toBe(before);
    });

    it('reads the email the way Supabase Auth decodes it and refuses an ambiguous body', async () => {
      const before = reached.length;
      const other = `other-${tag}@partner.test`;
      const tok = token.get(invited);
      // Go matches keys ignoring case and the last one wins: two different addresses are refused.
      await expectRefused(await post(app, '/signup', { email: invited, EMAIL: other, password: 'pw-12345678' }, undefined, tok));
      await expectRefused(await post(app, '/signup', { Email: other, email: invited, password: 'pw-12345678' }, undefined, tok));
      // The same address twice is fine; a key Go does not fold into "email" (dotless i) is not the email.
      expect((await post(app, '/signup', { email: invited, EMAIL: invited.toUpperCase(), password: 'pw-12345678' }, undefined, tok)).status).toBe(200);
      expect((await post(app, '/signup', { email: invited, 'emaıl': other, password: 'pw-12345678' }, undefined, tok)).status).toBe(200);
      // Phone and anonymous sign-ups carry no email to check; a body that is not a JSON object neither.
      await expectRefused(await post(app, '/signup', { phone: '+84901234567', password: 'pw-12345678' }));
      await expectRefused(await post(app, '/signup', { email: invited, phone: '+84901234567', password: 'pw-12345678' }));
      await expectRefused(await post(app, '/signup', {}));
      await expectRefused(await post(app, '/signup', 'not json'));
      await expectRefused(await post(app, '/signup', [invited]));
      expect(reached.length).toBe(before + 2);
    });

    it('lets an email code through for existing accounts only, unless it carries the invite token of its email', async () => {
      const before = reached.length;
      const stranger = `stranger-${tag}@partner.test`;
      await expectRefused(await post(app, '/otp', { email: stranger }));
      await expectRefused(await post(app, '/otp', { email: stranger, create_user: true }));
      await expectRefused(await post(app, '/otp', { email: stranger, create_user: false, CREATE_USER: true }));
      // "create_uſer" (U+017F) is create_user to Go's decoder: true there must not slip past a false.
      await expectRefused(await post(app, '/otp', { email: stranger, create_user: false, 'create_uſer': true }));
      expect((await post(app, '/otp', { email: stranger, create_user: false })).status).toBe(200);
      expect((await post(app, '/otp', { email: stranger, 'create_uſer': false })).status).toBe(200);
      expect((await post(app, '/otp', { email: invited }, undefined, token.get(invited))).status).toBe(200);
      await expectRefused(await post(app, '/otp', { email: invited }));
      await expectRefused(await post(app, '/otp', { phone: '+84901234567' }));
      expect(reached.length).toBe(before + 3);
    });

    it('refuses the sign-in paths that could create an account it cannot check', async () => {
      const before = reached.length;
      await expectMethodRefused(await call(app, 'GET', '/authorize?provider=google'));
      await expectMethodRefused(await call(app, 'GET', '/callback?code=x&state=y'));
      await expectMethodRefused(await post(app, '/token?grant_type=id_token', { provider: 'google', id_token: 'x' }));
      await expectMethodRefused(await post(app, '/token?grant_type=web3', { chain: 'solana' }));
      await expectMethodRefused(await post(app, '/token?grant_type=password&grant_type=id_token', { email: invited, password: 'x' }));
      // Go's FormValue prefers a form-encoded body over the query string.
      await expectMethodRefused(await call(app, 'POST', '/token?grant_type=password', 'grant_type=id_token', nextClient(), 'application/x-www-form-urlencoded'));
      await expectMethodRefused(await post(app, '/token', { email: invited, password: 'x' }));
      expect(reached.length).toBe(before);
    });

    it('keeps sign-in, refresh and password recovery working for everyone', async () => {
      const before = reached.length;
      const anyone = `existing-${tag}@elsewhere.test`;
      expect((await post(app, '/token?grant_type=password', { email: anyone, password: 'pw-12345678' })).status).toBe(200);
      expect((await call(app, 'POST', '/token?grant_type=refresh_token', { refresh_token: 'r' }, nextClient(), 'application/json;charset=UTF-8')).status).toBe(200);
      expect((await post(app, '/token?grant_type=pkce', { auth_code: 'c', code_verifier: 'v' })).status).toBe(200);
      expect((await post(app, '/recover', { email: anyone })).status).toBe(200);
      expect((await call(app, 'GET', '/settings')).status).toBe(200);
      expect(reached.length).toBe(before + 5);
    });

    it('keeps the email slot of a refused sign-up, so one client cannot probe many addresses', async () => {
      const capped = appWith({ AUTH_SIGNUP_POLICY: 'invite_only', AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR: '3' });
      const client = '203.0.113.77';
      for (let n = 0; n < 3; n++) await expectRefused(await signup(capped, `probe-${n}-${tag}@partner.test`, client));
      const next = await signup(capped, invited, client, token.get(invited));
      expect(next.status).toBe(429);
      expect(await next.json()).toMatchObject({ error_code: 'over_email_send_rate_limit' });
    });

    it('answers 503 and forwards nothing when the invite check cannot answer', async () => {
      const down = async (): Promise<boolean> => {
        throw new Error('database down');
      };
      const broken = appWith({ AUTH_SIGNUP_POLICY: 'invite_only' }, { held: down, matches: down });
      const before = reached.length;
      const response = await signup(broken, invited, undefined, token.get(invited));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'AUTH_UNAVAILABLE' });
      expect(reached.length).toBe(before);
    });
  });

  describe('allowlist', () => {
    let app: App;
    const tag = randomUUID().slice(0, 8);
    const outsider = `accountant-${tag}@outside.test`;
    const insider = `staff-${tag}@corp.test`;
    let token: Map<string, string>;

    beforeAll(async () => {
      app = appWith({ AUTH_SIGNUP_POLICY: 'allowlist', AUTH_SIGNUP_ALLOWED_DOMAINS: 'Corp.test, partner.vn' });
      token = (await orgInviting([outsider, insider])).tokens;
    });

    it('forwards an email at an allowed domain, including plus-addressing, or with the token of a valid invite', async () => {
      const before = reached.length;
      for (const email of [`a-${tag}@corp.test`, `a-${tag}+billing@corp.test`, `A-${tag}@CORP.TEST`, `b-${tag}@partner.vn`]) {
        expect((await signup(app, email)).status).toBe(200);
      }
      expect((await signup(app, outsider, undefined, token.get(outsider))).status).toBe(200);
      expect((await signup(app, insider, undefined, token.get(insider))).status).toBe(200);
      expect(reached.length).toBe(before + 6);
      expect(leakedTokens).toEqual([]);
    });

    // #563: an invited address needs its link whatever its domain, or someone at the partner could sign up first as
    // the invitee.
    it('refuses an invited address without its token, at an allowed domain too', async () => {
      const before = reached.length;
      await expectRefused(await signup(app, outsider));
      await expectRefused(await signup(app, insider));
      await expectRefused(await signup(app, insider, undefined, token.get(outsider)));
      expect(reached.length).toBe(before);
    });

    it('refuses other domains, subdomains, look-alikes and uninvited outsiders alike', async () => {
      const before = reached.length;
      for (const email of [
        `a-${tag}@sub.corp.test`,
        `a-${tag}@corp.test.evil.test`,
        `a-${tag}@evilcorp.test`,
        `a-${tag}@corp.tes`,
        `a-${tag}@cоrp.test`,
        `a-${tag}@corp.test\u0000`,
        `"a@corp.test"@evil.test`,
        `a-${tag}@corp.test@evil.test`,
        `nobody-${tag}@outside.test`,
      ]) {
        await expectRefused(await signup(app, email));
      }
      expect(reached.length).toBe(before);
    });
  });

  it('open forwards every sign-up untouched and asks the database nothing', async () => {
    const never = async (): Promise<boolean> => {
      throw new Error('must not be asked');
    };
    const app = appWith({}, { held: never, matches: never });
    const before = reached.length;
    expect((await signup(app, `anyone-${randomUUID().slice(0, 8)}@anywhere.test`)).status).toBe(200);
    // Except the invite token header, which the proxy never forwards.
    expect((await signup(app, `anyone-${randomUUID().slice(0, 8)}@anywhere.test`, undefined, 'A'.repeat(43))).status).toBe(200);
    expect(leakedTokens).toEqual([]);
    expect((await post(app, '/signup', { phone: '+84901234567', password: 'pw-12345678' })).status).toBe(200);
    expect((await call(app, 'GET', '/authorize?provider=google')).status).toBe(200);
    expect(reached.length).toBe(before + 4);
  });

  it('reports the policy, never the domains, in /api/config', async () => {
    const config = await appWith({ AUTH_SIGNUP_POLICY: 'allowlist', AUTH_SIGNUP_ALLOWED_DOMAINS: 'corp.test' }).fetch(new Request('http://localhost/api/config'));
    const body = (await config.json()) as Record<string, unknown>;
    expect(body.signupPolicy).toBe('allowlist');
    expect(JSON.stringify(body)).not.toContain('corp.test');
  });
});
