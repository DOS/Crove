// Invite-only sign-up (#350) on a real PostgreSQL 17: crove_kernel.signup_invite_valid() is a pinned definer only
// crove_app may execute, and it admits an email only while some org holds an invite for exactly that address that is
// pending, unexpired, in an active org, from an inviter who may still grant its role. Revoked, accepted and expired
// invites, a demoted inviter, a closed org, other spellings of the address and input not in the stored form all
// answer false. Part of the invariant suite: CI runs this file from the base branch on protected-path PRs
// (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FN = 'crove_kernel.signup_invite_valid(text)';
const suite = ADMIN ? describe : describe.skip;

type Created = { inviteId: string; acceptPath: string };

suite('invite-only sign-up check (#350)', () => {
  const dbName = `crove_test_signupinv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
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

  const valid = async (email: string | null) => (await pool.query<{ ok: boolean }>(`SELECT ${FN.replace('(text)', '($1)')} AS ok`, [email])).rows[0]?.ok;
  const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}@signup.test`;

  async function person(email = unique('person')) {
    return { id: await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email, name: null }), email };
  }
  async function org() {
    const owner = await person();
    const { orgId } = await createOrg(runtime, asUser(owner.id), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }
  const invite = (orgId: string, inviter: string, email: string, role: 'admin' | 'member' | 'viewer' = 'member') =>
    runtime.execute<Created>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });

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
    runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is a definer with the pinned search_path that only crove_app may execute', async () => {
    const rows = await admin(async (c) => {
      const def = await c.query<{ prosecdef: boolean; proconfig: string[] }>(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure`, [FN]);
      const roles = await c.query<{ role: string; can: boolean }>(
        `SELECT r.rolname AS role, has_function_privilege(r.oid, $1::regprocedure, 'EXECUTE') AS can
         FROM pg_roles r WHERE r.rolname LIKE 'crove\\_%' ORDER BY 1`,
        [FN],
      );
      const pub = await c.query<{ acl: string[] | null }>(`SELECT proacl::text[] AS acl FROM pg_proc WHERE oid = $1::regprocedure`, [FN]);
      return { def: def.rows[0], roles: roles.rows, acl: pub.rows[0]?.acl ?? [] };
    });
    expect(rows.def).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'] });
    expect(rows.roles.filter((r) => r.can).map((r) => r.role)).toEqual(['crove_app']);
    // No grant to PUBLIC (an ACL entry with an empty grantee).
    expect(rows.acl.some((entry) => entry.startsWith('='))).toBe(false);
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    const worker = new pg.Client({ connectionString: workerUrl.toString() });
    await worker.connect();
    try {
      await expect(worker.query(`SELECT crove_kernel.signup_invite_valid('a@b.test')`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await worker.end();
    }
  });

  it('admits exactly the invited address while its invite is pending, and nothing else', async () => {
    const { orgId, owner } = await org();
    const email = unique('invited');
    expect(await valid(email)).toBe(false);
    await invite(orgId, owner.id, email);
    expect(await valid(email)).toBe(true);
    // Only the stored form: other spellings, plus-addressed variants and padding are not the invited address.
    const [local, domain] = email.split('@') as [string, string];
    for (const other of [email.toUpperCase(), ` ${email}`, `${local}+x@${domain}`, `${local}@sub.${domain}`, `x${email}`, '', 'a@', null]) {
      expect(await valid(other)).toBe(false);
    }
  });

  it('answers false once the invite is revoked, accepted or expired', async () => {
    const { orgId, owner } = await org();
    const revoked = unique('revoked');
    const created = await invite(orgId, owner.id, revoked);
    await runtime.execute('kernel.member.invite.revoke', { inviteId: created.inviteId }, { actor: asUser(owner.id), orgId });
    expect(await valid(revoked)).toBe(false);

    const joiner = await person(unique('joiner'));
    const toAccept = await invite(orgId, owner.id, joiner.email);
    expect(await valid(joiner.email)).toBe(true);
    const token = toAccept.acceptPath.slice(toAccept.acceptPath.indexOf('#') + 1);
    await runtime.executeOrgless('kernel.member.invite.accept', { token }, { actor: asUser(joiner.id) });
    expect(await valid(joiner.email)).toBe(false);

    const expired = unique('expired');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by, created_at, expires_at)
         VALUES ($1, $2, 'member', $3, now() - interval '8 days', now() - interval '1 day')`,
        [orgId, expired, owner.id],
      ),
    );
    expect(await valid(expired)).toBe(false);
  });

  it('answers false when the inviter may no longer grant the role, or the org is closed', async () => {
    const { orgId, owner } = await org();
    const inviter = await person();
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, inviter.id]));
    const byAdmin = unique('by-admin');
    await invite(orgId, inviter.id, byAdmin);
    const adminInvite = unique('admin-role');
    await invite(orgId, owner.id, adminInvite, 'admin');
    expect(await valid(byAdmin)).toBe(true);
    expect(await valid(adminInvite)).toBe(true);
    // An admin invite from an admin (the commands never create one; written here behind their back) does not count.
    const adminByAdmin = unique('admin-by-admin');
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by) VALUES ($1, $2, 'admin', $3)`, [orgId, adminByAdmin, inviter.id]),
    );
    expect(await valid(adminByAdmin)).toBe(false);
    // Demoted behind the commands' back (they revoke such invites themselves): the check is the backstop.
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, inviter.id]));
    expect(await valid(byAdmin)).toBe(false);

    const other = await org();
    const inClosed = unique('closed');
    await invite(other.orgId, other.owner.id, inClosed);
    expect(await valid(inClosed)).toBe(true);
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`, [other.orgId]));
    expect(await valid(inClosed)).toBe(false);
  });
});
