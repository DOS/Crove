// Invite mail limits (#185) on a real PostgreSQL 17: the per-org and per-(org, email) counts of the last 24 hours are
// exact under concurrency (crove_kernel.invite_mail_gate counts under a lock per org and one per recipient), a busy
// lock answers 429 instead of parking a connection, and one address gets at most the configured number of invites
// from all orgs together. That the cap reveals nothing about accounts is in test/invariant/invites.db.test.ts. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Database, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { MAX_INVITES_PER_DAY, MAX_INVITES_PER_EMAIL_PER_DAY, buildKernelCommands, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { toORPCError } from '../src/rpc.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
// The per-recipient cap of the configured runtime below.
const TIGHT = 3;

const suite = ADMIN ? describe : describe.skip;

interface Created {
  inviteId: string;
  acceptPath: string;
}

suite('invite mail limits on PostgreSQL (#185)', () => {
  const dbName = `crove_test_invite_limits_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  // Default limits: 5 invites per recipient in any 24 hours.
  let runtime: Runtime;
  // Configured: TIGHT invites per recipient.
  let tight: Runtime;

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

  async function person(name: string) {
    const email = `${name}-${randomUUID().slice(0, 8)}@limits.test`;
    const id = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email, name: null });
    return { id, email };
  }

  async function orgOf(owner: { id: string }) {
    return (await createOrg(runtime, asUser(owner.id), `Org ${randomUUID().slice(0, 6)}`)).orgId;
  }

  const invite = (rt: Runtime, orgId: string, inviter: string, email: string, role: 'admin' | 'member' | 'viewer' = 'member') =>
    rt.execute<Created>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });

  // Revoked invites created hoursAgo, as if earlier invites had been sent: they count like any other.
  async function sent(orgId: string, inviter: string, emails: string[], hoursAgo = 0) {
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, token_sha256, invited_by, status, revoked_at, revoked_by, created_at, expires_at)
         SELECT $1::uuid, e, 'member', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), $2::uuid, 'revoked',
                now(), $2::uuid, now() - make_interval(hours => $4::int), now() - make_interval(hours => $4::int) + interval '7 days'
         FROM unnest($3::text[]) e`,
        [orgId, inviter, emails, hoursAgo],
      ),
    );
  }

  async function invitesOf(where: string, params: unknown[]) {
    return admin(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.member_invite WHERE ${where}`, params)).rows[0]?.n);
  }

  function outcomes(results: PromiseSettledResult<unknown>[]) {
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    return { ok: results.filter((r) => r.status === 'fulfilled').length, refused };
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
    // Enough connections that every parallel invite below runs in its own transaction at once.
    pool = createPool({ connectionString: appUrl.toString(), max: 16 });
    db = createDb(pool);
    const queries = kernelQueries({ inboundDomain: null });
    runtime = new Runtime(db).register({ commands: kernelCommands, queries });
    tight = new Runtime(db).register({ commands: buildKernelCommands({ inviteLimits: { perRecipientPerDay: TIGHT } }), queries });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives parallel invites exactly the room left under the per-org limit', async () => {
    for (let round = 0; round < 2; round++) {
      const owner = await person('owner');
      const orgId = await orgOf(owner);
      await sent(
        orgId,
        owner.id,
        Array.from({ length: MAX_INVITES_PER_DAY - 2 }, (_, i) => `earlier-${i}-${randomUUID().slice(0, 6)}@limits.test`),
      );
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => invite(runtime, orgId, owner.id, `burst-${i}-${randomUUID().slice(0, 6)}@limits.test`)),
      );
      const { ok, refused } = outcomes(results);
      expect(ok).toBe(2);
      expect(refused.map((e) => [e.code, e.status, e.details])).toEqual(
        Array.from({ length: 6 }, () => ['INVITE_RATE_LIMITED', 429, { rule: 'invite_org_per_day', limit: MAX_INVITES_PER_DAY }]),
      );
      expect(await invitesOf(`org_id = $1 AND created_at > now() - interval '24 hours'`, [orgId])).toBe(MAX_INVITES_PER_DAY);
    }
  });

  it('gives parallel invites of one email exactly the per-email limit, each replacing the one before', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    const email = `same-${randomUUID().slice(0, 8)}@limits.test`;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => invite(runtime, orgId, owner.id, email)));
    const { ok, refused } = outcomes(results);
    expect(ok).toBe(MAX_INVITES_PER_EMAIL_PER_DAY);
    // No unique-index conflict or retry: every invite after the first saw and replaced the pending one.
    expect(refused.map((e) => [e.code, e.status, e.details])).toEqual(
      Array.from({ length: 6 - MAX_INVITES_PER_EMAIL_PER_DAY }, () => [
        'INVITE_RATE_LIMITED',
        429,
        { rule: 'invite_email_per_day', limit: MAX_INVITES_PER_EMAIL_PER_DAY },
      ]),
    );
    expect(refused[0]?.message).toBe('Tổ chức đã mời email này quá nhiều lần trong 24 giờ qua; hãy thử lại sau');
    expect(await invitesOf('org_id = $1 AND email = $2', [orgId, email])).toBe(MAX_INVITES_PER_EMAIL_PER_DAY);
    expect(await invitesOf(`org_id = $1 AND email = $2 AND status = 'pending'`, [orgId, email])).toBe(1);
  });

  it('caps the invites one address gets from all orgs together, exactly under concurrency', async () => {
    const email = `wanted-${randomUUID().slice(0, 8)}@limits.test`;
    const inviters = await Promise.all(Array.from({ length: 5 }, () => person('owner')));
    const orgs = [];
    for (const inviter of inviters) orgs.push({ orgId: await orgOf(inviter), inviter: inviter.id });
    const results = await Promise.allSettled(orgs.map((o) => invite(tight, o.orgId, o.inviter, email)));
    const { ok, refused } = outcomes(results);
    expect(ok).toBe(TIGHT);
    expect(refused.map((e) => [e.code, e.status, e.message, e.details])).toEqual(
      Array.from({ length: orgs.length - TIGHT }, () => [
        'INVITE_RATE_LIMITED',
        429,
        'Email này đã nhận quá nhiều lời mời trong 24 giờ qua; hãy thử lại sau',
        { rule: 'invite_recipient_per_day', limit: TIGHT },
      ]),
    );
    expect(toORPCError(refused[0])).toMatchObject({ code: 'INVITE_RATE_LIMITED', status: 429, data: { rule: 'invite_recipient_per_day', limit: TIGHT } });
    expect(await invitesOf('email = $1', [email])).toBe(TIGHT);
    // Another address is not affected, and neither is the default runtime's higher cap.
    expect(await invite(tight, orgs[4]!.orgId, orgs[4]!.inviter, `other-${randomUUID().slice(0, 8)}@limits.test`)).toMatchObject({
      inviteId: expect.any(String),
    });
    expect(await invite(runtime, orgs[4]!.orgId, orgs[4]!.inviter, email)).toMatchObject({ inviteId: expect.any(String) });
  });

  it('counts every invite the address got, revoked ones too, but only those of the last 24 hours', async () => {
    const owner = await person('owner');
    const elsewhere = await person('elsewhere');
    const orgId = await orgOf(owner);
    const otherOrg = await orgOf(elsewhere);
    const email = `counted-${randomUUID().slice(0, 8)}@limits.test`;
    // Older than the window: never counted.
    await sent(otherOrg, elsewhere.id, Array.from({ length: 10 }, () => email), 25);
    await sent(otherOrg, elsewhere.id, Array.from({ length: TIGHT - 1 }, () => email));
    const last = await invite(tight, orgId, owner.id, email);
    expect(last.inviteId).toEqual(expect.any(String));
    await expect(invite(tight, orgId, owner.id, email)).rejects.toMatchObject({
      code: 'INVITE_RATE_LIMITED',
      details: { rule: 'invite_recipient_per_day', limit: TIGHT },
    });
    // The refusal changed nothing: the pending invite stays the one that was sent.
    expect(await invitesOf(`org_id = $1 AND email = $2 AND status = 'pending'`, [orgId, email])).toBe(1);
    expect(await invitesOf(`org_id = $1 AND email = $2`, [orgId, email])).toBe(1);
  });

  it('answers 429 invite_busy instead of waiting past the lock timeout, for the org and for the recipient', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    const other = await person('other');
    const otherOrg = await orgOf(other);
    const email = `busy-${randomUUID().slice(0, 8)}@limits.test`;
    for (const key of [`kernel.member.invite:${orgId}`, `kernel.member.invite.recipient:${email}`]) {
      const holder = new pg.Client({ connectionString: adminUrl });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        const started = Date.now();
        const refusal = invite(runtime, orgId, owner.id, email).catch((e: unknown) => e);
        // The org lock holds up only this org; the recipient lock holds up this address in every org.
        const unrelated = invite(runtime, otherOrg, other.id, key.includes('recipient') ? email : `free-${randomUUID().slice(0, 8)}@limits.test`).catch(
          (e: unknown) => e,
        );
        expect(await refusal).toMatchObject({
          code: 'INVITE_RATE_LIMITED',
          status: 429,
          message: 'Tổ chức đang gửi nhiều lời mời cùng lúc; hãy thử lại sau',
          details: { rule: 'invite_busy', retryAfterSeconds: 1 },
        });
        const waited = Date.now() - started;
        expect(waited).toBeGreaterThanOrEqual(2500);
        expect(waited).toBeLessThan(10_000);
        if (key.includes('recipient')) expect(await unrelated).toMatchObject({ code: 'INVITE_RATE_LIMITED', details: { rule: 'invite_busy' } });
        else expect(await unrelated).toMatchObject({ inviteId: expect.any(String) });
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    }
    expect(await invitesOf('org_id = $1', [orgId])).toBe(0);
    // Once the locks are free the invite goes through.
    expect(await invite(runtime, orgId, owner.id, email)).toMatchObject({ inviteId: expect.any(String) });
  });

  it('restores the caller lock_timeout, and refuses callers without a context, outside the inviting roles or with bad input', async () => {
    const owner = await person('owner');
    const viewer = await person('viewer');
    const orgId = await orgOf(owner);
    const created = await invite(runtime, orgId, owner.id, viewer.email, 'viewer');
    const token = created.acceptPath.slice(created.acceptPath.indexOf('#') + 1);
    await runtime.executeOrgless('kernel.member.invite.accept', { token }, { actor: asUser(viewer.id) });
    const asApp = <T>(userId: string, fn: (trx: Transaction<Database>) => Promise<T>) =>
      db.transaction().execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_context(${userId}::uuid, ${orgId}::uuid)`.execute(trx);
        return fn(trx);
      });
    const gate = (email: string, limits: [number, number, number] = [50, 3, 5]) =>
      sql`SELECT crove_kernel.invite_mail_gate(${email}, ${limits[0]}::int, ${limits[1]}::int, ${limits[2]}::int)`;

    const setting = await asApp(owner.id, async (trx) => {
      await sql`SELECT set_config('lock_timeout', '7s', true)`.execute(trx);
      await gate(`fine-${randomUUID().slice(0, 8)}@limits.test`).execute(trx);
      const { rows } = await sql<{ lock_timeout: string }>`SELECT current_setting('lock_timeout') AS lock_timeout`.execute(trx);
      return rows[0]?.lock_timeout;
    });
    expect(setting).toBe('7s');

    await expect(db.transaction().execute((trx) => gate('nobody@limits.test').execute(trx))).rejects.toThrow(/NO_CONTEXT/);
    await expect(asApp(viewer.id, (trx) => gate('someone@limits.test').execute(trx))).rejects.toThrow(/INVITE_GATE_FORBIDDEN/);
    for (const [email, limits] of [
      ['Upper@limits.test', [50, 3, 5]],
      [' padded@limits.test', [50, 3, 5]],
      ['ok@limits.test', [0, 3, 5]],
      ['ok@limits.test', [50, 0, 5]],
      ['ok@limits.test', [50, 3, 0]],
      ['ok@limits.test', [50, 3, 100001]],
    ] as const) {
      await expect(asApp(owner.id, (trx) => gate(email, [...limits]).execute(trx))).rejects.toThrow(/INVITE_LIMIT_INVALID/);
    }
  });
});
