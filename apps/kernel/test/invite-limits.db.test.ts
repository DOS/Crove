// Invite mail limits (#185) on a real PostgreSQL 17: the per-org and per-(org, email) counts of the last 24 hours are
// exact under concurrency (crove_kernel.invite_mail_gate counts under a lock per org and one per recipient), a busy
// lock answers 429 instead of parking a connection, and one address gets at most the configured number of invites
// from all orgs together, except an org's first invite of it, which other orgs cannot block. That the cap reveals nothing about accounts is in test/invariant/invites.db.test.ts. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Database, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { MAX_INVITES_PER_DAY, MAX_INVITES_PER_EMAIL_PER_DAY, buildKernelCommands, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { toORPCError } from '../src/rpc.ts';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
// The per-recipient cap of the configured runtime below.
const TIGHT = 6;

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
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries });
    tight = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: buildKernelCommands({ inviteLimits: { perRecipientPerDay: TIGHT } }), queries });
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

  it('caps the repeat invites one address gets from all orgs together, exactly under concurrency', async () => {
    const email = `wanted-${randomUUID().slice(0, 8)}@limits.test`;
    const inviters = await Promise.all(Array.from({ length: 4 }, () => person('owner')));
    const orgs = [];
    for (const inviter of inviters) orgs.push({ orgId: await orgOf(inviter), inviter: inviter.id });
    // Each org invited the address once already: 4 of the TIGHT invites in the window are used.
    for (const o of orgs) await sent(o.orgId, o.inviter, [email]);
    const results = await Promise.allSettled(orgs.map((o) => invite(tight, o.orgId, o.inviter, email)));
    const { ok, refused } = outcomes(results);
    expect(ok).toBe(TIGHT - orgs.length);
    expect(refused.map((e) => [e.code, e.status, e.message, e.details])).toEqual(
      Array.from({ length: orgs.length - (TIGHT - orgs.length) }, () => [
        'INVITE_RATE_LIMITED',
        429,
        'Email này đã nhận quá nhiều lời mời trong 24 giờ qua; hãy thử lại sau',
        { rule: 'invite_recipient_per_day', limit: TIGHT },
      ]),
    );
    expect(toORPCError(refused[0])).toMatchObject({ code: 'INVITE_RATE_LIMITED', status: 429, data: { rule: 'invite_recipient_per_day', limit: TIGHT } });
    expect(await invitesOf('email = $1', [email])).toBe(TIGHT);
    // Another address is not affected.
    expect(await invite(tight, orgs[0]!.orgId, orgs[0]!.inviter, `other-${randomUUID().slice(0, 8)}@limits.test`)).toMatchObject({
      inviteId: expect.any(String),
    });
  });

  it("never lets other orgs use up an address's cap against an org's first invite of it", async () => {
    const email = `employee-${randomUUID().slice(0, 8)}@limits.test`;
    // A stranger's orgs used up the cap (and more) for the address today.
    const stranger = await person('stranger');
    for (let i = 0; i < 2; i++) await sent(await orgOf(stranger), stranger.id, Array.from({ length: TIGHT }, () => email));
    // The employer's first invite of it goes through, and counts; its repeat is refused.
    const employer = await person('employer');
    const orgId = await orgOf(employer);
    expect(await invite(tight, orgId, employer.id, email)).toMatchObject({ inviteId: expect.any(String) });
    await expect(invite(tight, orgId, employer.id, email)).rejects.toMatchObject({
      code: 'INVITE_RATE_LIMITED',
      details: { rule: 'invite_recipient_per_day', limit: TIGHT },
    });
    expect(await invitesOf('email = $1 AND org_id = $2', [email, orgId])).toBe(1);
  });

  it('counts every invite the address got, revoked ones too, but only those of the last 24 hours', async () => {
    const owner = await person('owner');
    const elsewhere = await person('elsewhere');
    const orgId = await orgOf(owner);
    const otherOrg = await orgOf(elsewhere);
    const email = `counted-${randomUUID().slice(0, 8)}@limits.test`;
    // Older than the window: never counted.
    await sent(otherOrg, elsewhere.id, Array.from({ length: 10 }, () => email), 25);
    await sent(otherOrg, elsewhere.id, Array.from({ length: TIGHT - 2 }, () => email));
    // The first invite (always allowed) and one repeat fill the window up to TIGHT.
    const first = await invite(tight, orgId, owner.id, email);
    const repeat = await invite(tight, orgId, owner.id, email);
    expect([first.inviteId, repeat.inviteId]).toEqual([expect.any(String), expect.any(String)]);
    await expect(invite(tight, orgId, owner.id, email)).rejects.toMatchObject({
      code: 'INVITE_RATE_LIMITED',
      details: { rule: 'invite_recipient_per_day', limit: TIGHT },
    });
    // The refusal changed nothing: the pending invite stays the last one that was sent.
    expect(await invitesOf(`org_id = $1 AND email = $2 AND status = 'pending'`, [orgId, email])).toBe(1);
    expect(await invitesOf(`org_id = $1 AND email = $2`, [orgId, email])).toBe(2);
  });

  it('keeps the other refusals ahead of the daily limits', async () => {
    const owner = await person('owner');
    const adminP = await person('admin');
    const member = await person('member');
    const orgId = await orgOf(owner);
    for (const [who, role] of [
      [adminP, 'admin'],
      [member, 'member'],
    ] as const) {
      const created = await invite(runtime, orgId, owner.id, who.email, role);
      await runtime.executeOrgless('kernel.member.invite.accept', { token: created.acceptPath.slice(created.acceptPath.indexOf('#') + 1) }, { actor: asUser(who.id) });
    }
    const elsewhere = await person('elsewhere');
    const otherOrg = await orgOf(elsewhere);
    // A current member at the recipient cap and this org's per-email limit: still ALREADY_MEMBER.
    await sent(orgId, owner.id, Array.from({ length: MAX_INVITES_PER_EMAIL_PER_DAY }, () => member.email));
    await sent(otherOrg, elsewhere.id, Array.from({ length: 10 }, () => member.email));
    await expect(invite(runtime, orgId, owner.id, member.email)).rejects.toMatchObject({ code: 'ALREADY_MEMBER', status: 409 });
    // An admin re-inviting an owner's pending invitee at the limits: still INVITE_PENDING_BY_OWNER.
    const invitee = `pending-${randomUUID().slice(0, 8)}@limits.test`;
    await invite(runtime, orgId, owner.id, invitee);
    await sent(orgId, owner.id, Array.from({ length: MAX_INVITES_PER_EMAIL_PER_DAY }, () => invitee));
    await sent(otherOrg, elsewhere.id, Array.from({ length: 10 }, () => invitee));
    await expect(invite(runtime, orgId, adminP.id, invitee)).rejects.toMatchObject({ code: 'INVITE_PENDING_BY_OWNER', status: 409 });
    // At the pending cap and the org's daily limit: still TOO_MANY_INVITES.
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, token_sha256, invited_by)
         SELECT $1::uuid, 'held-' || g || '-' || $1::text || '@limits.test', 'member', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), $2::uuid
         FROM generate_series(1, 100 - (SELECT count(*)::int FROM crove_kernel.member_invite WHERE org_id = $1 AND status = 'pending')) g`,
        [orgId, owner.id],
      ),
    );
    await expect(invite(runtime, orgId, owner.id, `one-more-${randomUUID().slice(0, 8)}@limits.test`)).rejects.toMatchObject({
      code: 'TOO_MANY_INVITES',
      status: 429,
    });
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
          message: 'Hệ thống đang bận gửi lời mời; hãy thử lại sau',
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

  it('keys the limits on the inbox: +tags everywhere, dots only at Gmail (#270)', async () => {
    const keys = await admin(async (c) => {
      const cases = [
        'ab@gmail.com',
        'a.b+x@gmail.com',
        'A.B+X@GoogleMail.com',
        'a.b@googlemail.com',
        'a.b@example.com',
        'ab@example.com',
        'a+b+c@example.com',
        'a.b+x@sub.gmail.com',
        '+x@gmail.com',
        '...@gmail.com',
        'odd',
      ];
      const { rows } = await c.query<{ k: string }>('SELECT crove_kernel.invite_cap_key(e) AS k FROM unnest($1::text[]) WITH ORDINALITY u(e, n) ORDER BY n', [cases]);
      return Object.fromEntries(cases.map((e, i) => [e, rows[i]?.k]));
    });
    expect(keys).toEqual({
      'ab@gmail.com': 'ab@gmail.com',
      'a.b+x@gmail.com': 'ab@gmail.com',
      'A.B+X@GoogleMail.com': 'ab@gmail.com',
      'a.b@googlemail.com': 'ab@gmail.com',
      'a.b@example.com': 'a.b@example.com',
      'ab@example.com': 'ab@example.com',
      'a+b+c@example.com': 'a@example.com',
      'a.b+x@sub.gmail.com': 'a.b@sub.gmail.com',
      // A local part that is nothing but a tag or dots folds into no other address.
      '+x@gmail.com': '+x@gmail.com',
      '...@gmail.com': '...@gmail.com',
      odd: 'odd',
    });
    // The per-inbox count reads the index on the key.
    const plan = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL enable_seqscan = off');
        const { rows } = await c.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT 1 FROM crove_kernel.member_invite i
           WHERE crove_kernel.invite_cap_key(i.email) = 'ab@gmail.com' AND i.created_at > clock_timestamp() - interval '24 hours'`,
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(plan).toContain('member_invite_cap_key_created_idx');
  });

  it('folds address variants for the cap, never for who the invite is for (#270)', async () => {
    // Gmail addresses with an underscore, which Gmail never issues, so no one holds them (#1640).
    const r = randomUUID().slice(0, 8);
    const stranger = await person('stranger');
    const strangerOrg = await orgOf(stranger);
    // Another org used up the cap of two inboxes today.
    await sent(strangerOrg, stranger.id, Array.from({ length: TIGHT }, () => `a_b${r}@gmail.com`));
    await sent(strangerOrg, stranger.id, Array.from({ length: TIGHT }, () => `ab${r}@example.com`));
    const owner = await person('owner');
    const orgId = await orgOf(owner);

    // a_.b…+x@gmail.com is the inbox a_b…@gmail.com: the org's first invite of it passes, a repeat under another
    // spelling is refused by the cap.
    const first = await invite(tight, orgId, owner.id, `a_.b${r}+x@gmail.com`);
    expect(first).toMatchObject({ email: `a_.b${r}+x@gmail.com` });
    await expect(invite(tight, orgId, owner.id, `a_b${r}@googlemail.com`)).rejects.toMatchObject({
      code: 'INVITE_RATE_LIMITED',
      status: 429,
      details: { rule: 'invite_recipient_per_day', limit: TIGHT },
    });

    // a.b@example.com is not ab@example.com: no dots fold outside Gmail, so its repeats are not capped by the
    // stranger's invites. Its +tags fold, into this org's per-email limit too.
    for (const email of [`a.b${r}@example.com`, `a.b${r}@example.com`, `a.b${r}+y@example.com`]) {
      expect(await invite(tight, orgId, owner.id, email)).toMatchObject({ inviteId: expect.any(String) });
    }
    await expect(invite(tight, orgId, owner.id, `a.b${r}+z@example.com`)).rejects.toMatchObject({
      code: 'INVITE_RATE_LIMITED',
      details: { rule: 'invite_email_per_day', limit: MAX_INVITES_PER_EMAIL_PER_DAY },
    });

    // The invite stays bound to the email it names: the account of the inbox's plain address cannot accept it, the
    // account with that exact address can.
    const token = first.acceptPath.slice(first.acceptPath.indexOf('#') + 1);
    const plain = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `a_b${r}@gmail.com`, name: null });
    await expect(runtime.executeOrgless('kernel.member.invite.accept', { token }, { actor: asUser(plain) })).rejects.toMatchObject({
      code: 'INVITE_EMAIL_MISMATCH',
      status: 403,
    });
    const tagged = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `a_.b${r}+x@gmail.com`, name: null });
    await expect(runtime.executeOrgless('kernel.member.invite.accept', { token }, { actor: asUser(tagged) })).resolves.toMatchObject({ orgId });
    // The rows keep the addresses as given.
    expect(await invitesOf('org_id = $1 AND email = $2', [orgId, `a_.b${r}+x@gmail.com`])).toBe(1);
    expect(await invitesOf('org_id = $1 AND email = $2', [orgId, `a.b${r}+y@example.com`])).toBe(1);
  });

  it('dates invites by the database clock, whatever the API clock says (#270)', async () => {
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    const email = `clock-${randomUUID().slice(0, 8)}@limits.test`;
    const dbNow = async () => admin(async (c) => (await c.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]?.t as Date);
    const before = await dbNow();
    // The API host's clock is 30 hours behind the database: with created_at from it, every invite would already be
    // outside the window and the limits would never refuse.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(before.getTime() - 30 * 60 * 60 * 1000);
      for (let i = 0; i < MAX_INVITES_PER_EMAIL_PER_DAY; i++) {
        expect(await invite(runtime, orgId, owner.id, email)).toMatchObject({ inviteId: expect.any(String) });
      }
      await expect(invite(runtime, orgId, owner.id, email)).rejects.toMatchObject({
        code: 'INVITE_RATE_LIMITED',
        details: { rule: 'invite_email_per_day', limit: MAX_INVITES_PER_EMAIL_PER_DAY },
      });
    } finally {
      vi.useRealTimers();
    }
    const after = await dbNow();
    const created = await admin(
      async (c) => (await c.query<{ created_at: Date }>('SELECT created_at FROM crove_kernel.member_invite WHERE org_id = $1 ORDER BY created_at', [orgId])).rows,
    );
    expect(created).toHaveLength(MAX_INVITES_PER_EMAIL_PER_DAY);
    for (const row of created) {
      expect(row.created_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.created_at.getTime()).toBeLessThanOrEqual(after.getTime());
    }
  });

  it('refuses an invite already over a limit at once, without waiting for the locks (#270)', async () => {
    const email = `capped-${randomUUID().slice(0, 8)}@limits.test`;
    const stranger = await person('stranger');
    await sent(await orgOf(stranger), stranger.id, Array.from({ length: TIGHT }, () => email));
    const owner = await person('owner');
    const orgId = await orgOf(owner);
    await sent(orgId, owner.id, [email]);
    const full = await person('full');
    const fullOrg = await orgOf(full);
    await sent(
      fullOrg,
      full.id,
      Array.from({ length: MAX_INVITES_PER_DAY }, (_, i) => `earlier-${i}-${randomUUID().slice(0, 6)}@limits.test`),
    );
    const unlocked = (await invite(tight, orgId, owner.id, email).catch((e: unknown) => e)) as Record<string, unknown>;
    expect(unlocked).toMatchObject({ code: 'INVITE_RATE_LIMITED', status: 429, details: { rule: 'invite_recipient_per_day', limit: TIGHT } });

    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      // Both locks the invites need, held by another connection.
      for (const key of [`kernel.member.invite:${orgId}`, `kernel.member.invite:${fullOrg}`, `kernel.member.invite.recipient:${email}`]) {
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      }
      // The repeat invite of the capped address: refused at once, with the answer it gets without the locks.
      let started = Date.now();
      const refused = (await invite(tight, orgId, owner.id, email).catch((e: unknown) => e)) as Record<string, unknown>;
      expect(Date.now() - started).toBeLessThan(1500);
      expect({ type: refused?.constructor?.name, keys: Object.keys(refused).sort(), code: refused.code, status: refused.status, message: refused.message, details: refused.details }).toEqual(
        { type: unlocked?.constructor?.name, keys: Object.keys(unlocked).sort(), code: unlocked.code, status: unlocked.status, message: unlocked.message, details: unlocked.details },
      );
      // An org already at its daily limit: refused at once too.
      started = Date.now();
      await expect(invite(tight, fullOrg, full.id, `late-${randomUUID().slice(0, 8)}@limits.test`)).rejects.toMatchObject({
        code: 'INVITE_RATE_LIMITED',
        details: { rule: 'invite_org_per_day', limit: MAX_INVITES_PER_DAY },
      });
      expect(Date.now() - started).toBeLessThan(1500);
      // An invite the limits let through still waits for the locks, and is told the system is busy.
      const newcomer = await person('newcomer');
      const newcomerOrg = await orgOf(newcomer);
      started = Date.now();
      await expect(invite(tight, newcomerOrg, newcomer.id, email)).rejects.toMatchObject({ code: 'INVITE_RATE_LIMITED', details: { rule: 'invite_busy' } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(await invitesOf('org_id = $1', [orgId])).toBe(1);
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
        await sql`SELECT crove_kernel.enter_user_context(${orgId}::uuid, ${contextToken(userId, orgId)}::text)`.execute(trx);
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

    // The precheck (#270) checks the same, without the locks.
    const precheck = (email: string, limits: [number, number, number] = [50, 3, 5]) =>
      sql`SELECT crove_kernel.invite_mail_precheck(${email}, ${limits[0]}::int, ${limits[1]}::int, ${limits[2]}::int)`;
    for (const call of [gate, precheck]) {
      await expect(db.transaction().execute((trx) => call('nobody@limits.test').execute(trx))).rejects.toThrow(/NO_CONTEXT/);
      await expect(asApp(viewer.id, (trx) => call('someone@limits.test').execute(trx))).rejects.toThrow(/INVITE_GATE_FORBIDDEN/);
      for (const [email, limits] of [
        ['Upper@limits.test', [50, 3, 5]],
        [' padded@limits.test', [50, 3, 5]],
        ['ok@limits.test', [0, 3, 5]],
        ['ok@limits.test', [50, 0, 5]],
        ['ok@limits.test', [50, 3, 0]],
        ['ok@limits.test', [50, 3, 100001]],
      ] as const) {
        await expect(asApp(owner.id, (trx) => call(email, [...limits]).execute(trx))).rejects.toThrow(/INVITE_LIMIT_INVALID/);
      }
    }
    // The precheck takes no lock.
    const advisory = sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`;
    const held = await asApp(owner.id, async (trx) => {
      const before = (await advisory.execute(trx)).rows[0]?.n;
      await precheck(`free-${randomUUID().slice(0, 8)}@limits.test`).execute(trx);
      return [before, (await advisory.execute(trx)).rows[0]?.n];
    });
    expect(held[1]).toBe(held[0]);
  });
});
