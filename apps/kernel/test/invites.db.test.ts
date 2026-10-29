// Member invite flows (issue #35) against a real PostgreSQL 17, through the HTTP API: what the inviter sees and what
// is recorded, the pending list, replacing and revoking, the invitee's preview and acceptance. The security
// properties (consent, email binding, single use, expiry, cross-org, database privileges) are in
// test/invariant/invites.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own
// database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { MAX_INVITES_PER_DAY, MAX_INVITES_PER_EMAIL_PER_DAY, MAX_PENDING_INVITES, kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-invites-0123456789';
const ISSUER = 'crove-auth';

const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
  name: string;
}

suite('member invite flows on PostgreSQL', () => {
  const dbName = `crove_test_invite_flows_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createHttpApp>;

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
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal: 'aal1',
      is_anonymous: false,
      user_metadata: { full_name: who.name },
      ...mfa,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, org: string | null) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: Record<string, unknown> } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> | null };
  }

  async function signIn(name: string): Promise<Account> {
    const who: Account = { subject: randomUUID(), email: `user-${randomUUID().slice(0, 8)}@flows.test`, session: randomUUID(), userId: '', name };
    const me = await rpc('me/get', await tokenFor(who), undefined, null);
    expect(me.status).toBe(200);
    who.userId = String(me.body?.userId);
    return who;
  }

  async function orgOf(owner: Account) {
    const created = await rpc('org/create', await tokenFor(owner), { name: `Công ty ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    return { slug: String(created.body?.slug), orgId: String(created.body?.orgId), name: String(created.body?.name) };
  }

  const tokenOf = (acceptPath: unknown) => String(acceptPath).split('#')[1] ?? '';
  const rows = (orgId: string, table: 'audit_event' | 'activity', where: string) =>
    admin(async (c) => (await c.query(`SELECT * FROM crove_kernel.${table} WHERE org_id = $1 AND ${where} ORDER BY id`, [orgId])).rows);

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
    db = createDb(pool);
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: kernelCommands,
      queries: kernelQueries({ inboundDomain: null }),
    });
    app = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('invites, lists, previews and accepts, recording each step', async () => {
    const owner = await signIn('Chủ');
    const invitee = await signIn('Khách');
    const org = await orgOf(owner);
    const ownerMfa = await tokenFor(owner, { mfa: true });

    const created = await rpc('org/invite', ownerMfa, { email: invitee.email, role: 'admin' }, org.slug);
    expect(created).toMatchObject({ status: 200, body: { email: invitee.email, role: 'admin', acceptPath: expect.stringMatching(/^\/-\/invite#/) } });
    const expiresAt = new Date(String(created.body?.expiresAt)).getTime();
    expect(expiresAt - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);

    const listed = await rpc('org/listInvites', await tokenFor(owner), undefined, org.slug);
    expect(listed).toMatchObject({ status: 200 });
    expect(listed.body).toEqual([
      expect.objectContaining({ id: created.body?.inviteId, email: invitee.email, role: 'admin', status: 'pending', invitedBy: 'Chủ' }),
    ]);

    const token = tokenOf(created.body?.acceptPath);
    // The header names no org for the invitee; the preview shows what they consent to.
    expect(await rpc('invites/peek', await tokenFor(invitee), { token }, null)).toMatchObject({
      status: 200,
      body: { orgName: org.name, role: 'admin', invitedBy: `Chủ (${owner.email})` },
    });
    expect((await rpc('me/get', await tokenFor(invitee), undefined, null)).body?.orgs).toEqual([]);

    const accepted = await rpc('invites/accept', await tokenFor(invitee), { token }, null);
    expect(accepted).toMatchObject({ status: 200, body: { orgId: org.orgId, slug: org.slug, role: 'admin' } });
    expect((await rpc('me/get', await tokenFor(invitee), undefined, null)).body?.orgs).toEqual([expect.objectContaining({ slug: org.slug, role: 'admin' })]);
    // Accepted invites leave the pending list.
    expect((await rpc('org/listInvites', await tokenFor(owner), undefined, org.slug)).body).toEqual([]);

    const [createAudit] = await rows(org.orgId, 'audit_event', "command = 'kernel.member.invite.create'");
    expect(createAudit).toMatchObject({ actor_id: owner.userId, outcome: 'ok', detail: { invite_id: created.body?.inviteId, role: 'admin', replaced: [], aal: 'aal2' } });
    const [acceptAudit] = await rows(org.orgId, 'audit_event', "command = 'kernel.member.invite.accept'");
    expect(acceptAudit).toMatchObject({
      actor_id: invitee.userId,
      outcome: 'ok',
      detail: {
        invite_id: created.body?.inviteId,
        invited_by: owner.userId,
        invited_role: 'admin',
        target_user: invitee.userId,
        role: 'admin',
        previous_role: null,
        already_member: false,
      },
    });
    const activity = await rows(org.orgId, 'activity', "kind IN ('invite.created', 'member.joined')");
    expect(activity.map((a) => [a.kind, a.summary])).toEqual([
      ['invite.created', 'Mời một người tham gia với vai trò quản trị'],
      ['member.joined', 'Chấp nhận lời mời và tham gia với vai trò quản trị'],
    ]);
  });

  it('replaces a pending invite for the same email, revokes, and refuses inviting a member', async () => {
    const owner = await signIn('owner');
    const member = await signIn('member');
    const org = await orgOf(owner);
    const ownerMfa = await tokenFor(owner, { mfa: true });
    const joined = await rpc('org/invite', ownerMfa, { email: member.email, role: 'member' }, org.slug);
    expect((await rpc('invites/accept', await tokenFor(member), { token: tokenOf(joined.body?.acceptPath) }, null)).status).toBe(200);
    expect(await rpc('org/invite', ownerMfa, { email: member.email.toUpperCase(), role: 'viewer' }, org.slug)).toMatchObject({
      status: 409,
      body: { code: 'ALREADY_MEMBER' },
    });

    const email = `new-${randomUUID().slice(0, 8)}@flows.test`;
    const first = await rpc('org/invite', ownerMfa, { email, role: 'viewer' }, org.slug);
    const second = await rpc('org/invite', ownerMfa, { email, role: 'member' }, org.slug);
    expect(second.body?.inviteId).not.toBe(first.body?.inviteId);
    const listed = (await rpc('org/listInvites', await tokenFor(owner), undefined, org.slug)).body as unknown as Array<{ id: string; role: string }>;
    expect(listed.map((i) => [i.id, i.role])).toEqual([[second.body?.inviteId, 'member']]);
    const audits = await rows(org.orgId, 'audit_event', "command = 'kernel.member.invite.create' AND outcome = 'ok'");
    expect(audits.at(-1)?.detail.replaced).toEqual([first.body?.inviteId]);

    expect(await rpc('org/revokeInvite', await tokenFor(owner), { inviteId: second.body?.inviteId }, org.slug)).toMatchObject({ status: 200, body: { ok: true } });
    expect((await rpc('org/listInvites', await tokenFor(owner), undefined, org.slug)).body).toEqual([]);
    expect(await rpc('org/revokeInvite', await tokenFor(owner), { inviteId: second.body?.inviteId }, org.slug)).toMatchObject({
      status: 409,
      body: { code: 'INVITE_NOT_PENDING' },
    });
    const [revokeAudit] = await rows(org.orgId, 'audit_event', "command = 'kernel.member.invite.revoke' AND outcome = 'ok'");
    expect(revokeAudit).toMatchObject({ actor_id: owner.userId, target_type: 'kernel.member_invite', target_id: second.body?.inviteId });
  });

  it('caps the pending invites of one org', async () => {
    const owner = await signIn('owner');
    const org = await orgOf(owner);
    await admin((c) =>
      c.query(
        // Created two days ago, so the daily limits (below) do not apply.
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, token_sha256, invited_by, created_at, expires_at)
         SELECT $1::uuid, 'cap-' || g || '@flows.test', 'member', encode(sha256(convert_to('cap-' || g || $1::text, 'UTF8')), 'hex'), $2::uuid,
                now() - interval '2 days', now() + interval '5 days'
         FROM generate_series(1, $3::int) g`,
        [org.orgId, owner.userId, MAX_PENDING_INVITES],
      ),
    );
    expect(await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: 'one-more@flows.test', role: 'member' }, org.slug)).toMatchObject({
      status: 429,
      body: { code: 'TOO_MANY_INVITES' },
    });
    // Replacing the invite of an email that already has one is not a new pending invite.
    expect((await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: 'cap-1@flows.test', role: 'viewer' }, org.slug)).status).toBe(200);
  });

  it('limits the invites one org creates in 24 hours, in total and per email', async () => {
    const owner = await signIn('owner');
    const org = await orgOf(owner);
    const ownerMfa = await tokenFor(owner, { mfa: true });
    const email = `again-${randomUUID().slice(0, 8)}@flows.test`;
    for (let i = 0; i < MAX_INVITES_PER_EMAIL_PER_DAY; i++) {
      expect((await rpc('org/invite', ownerMfa, { email, role: 'member' }, org.slug)).status).toBe(200);
    }
    expect(await rpc('org/invite', ownerMfa, { email, role: 'member' }, org.slug)).toMatchObject({ status: 429, body: { code: 'INVITE_RATE_LIMITED' } });

    // Revoked invites count too: revoking frees a pending slot, not the daily budget.
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, token_sha256, invited_by, status, revoked_at, revoked_by)
         SELECT $1::uuid, 'day-' || g || '@flows.test', 'member', encode(sha256(convert_to('day-' || g || $1::text, 'UTF8')), 'hex'), $2::uuid,
                'revoked', now(), $2::uuid
         FROM generate_series(1, $3::int) g`,
        [org.orgId, owner.userId, MAX_INVITES_PER_DAY - MAX_INVITES_PER_EMAIL_PER_DAY],
      ),
    );
    expect(await rpc('org/invite', ownerMfa, { email: 'fresh@flows.test', role: 'member' }, org.slug)).toMatchObject({
      status: 429,
      body: { code: 'INVITE_RATE_LIMITED' },
    });
    // Another org has its own budget.
    const other = await orgOf(owner);
    expect((await rpc('org/invite', ownerMfa, { email, role: 'member' }, other.slug)).status).toBe(200);
  });

  it('answers a stale or foreign link with a clear refusal', async () => {
    const owner = await signIn('owner');
    const invitee = await signIn('invitee');
    const other = await signIn('other');
    const org = await orgOf(owner);
    const created = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: invitee.email, role: 'viewer' }, org.slug);
    const token = tokenOf(created.body?.acceptPath);
    expect(await rpc('invites/peek', await tokenFor(other), { token }, null)).toMatchObject({ status: 403, body: { code: 'INVITE_EMAIL_MISMATCH' } });
    expect(await rpc('invites/accept', await tokenFor(other), { token }, null)).toMatchObject({ status: 403, body: { code: 'INVITE_EMAIL_MISMATCH' } });
    expect(await rpc('invites/peek', await tokenFor(invitee), { token: 'A'.repeat(43) }, null)).toMatchObject({ status: 404, body: { code: 'INVITE_NOT_FOUND' } });
    expect(await rpc('invites/accept', await tokenFor(invitee), { token: 'short' }, null)).toMatchObject({ status: 400 });
    expect((await rpc('invites/accept', await tokenFor(invitee), { token }, null)).status).toBe(200);
    expect(await rpc('invites/peek', await tokenFor(invitee), { token }, null)).toMatchObject({ status: 409, body: { code: 'INVITE_USED' } });
  });
});
