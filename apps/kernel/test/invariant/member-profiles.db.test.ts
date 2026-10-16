// Invariant suite (Decision 7): tenant reads of user_account go through crove_kernel.member_profiles (issue #169,
// plan §3.6, Decision 14). The definer returns id, email and display name only for members of the org in the sealed
// context: another org's members, users who share no org with the caller, former members and unknown ids return
// nothing; no context returns nothing and a forged one is refused; only the API login role may call it; and the
// kernel's member reads (kernel.org.get, the pending invite list) show what it returns. Keep this directory
// self-contained: import package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
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
const FN = 'crove_kernel.member_profiles(uuid[])';
const SEAL_INVALID = { code: '42501', message: 'CONTEXT_SEAL_INVALID' };

const suite = ADMIN ? describe : describe.skip;

suite('member profiles definer invariants on PostgreSQL', () => {
  const dbName = `crove_test_profinv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  // ownerA and memberA in org A; ownerB in org B; both in A and B; leaver joined A and was removed; outsider in none.
  const users = { ownerA: '', memberA: '', ownerB: '', both: '', leaver: '', outsider: '' };
  let orgA = '';
  let orgB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '7a1d2c3b-4e5f-4a6b-9c7d-8e9f0a1b2c3d',
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const emailOf = (name: string) => `prof-${name}@example.com`;

  async function join(orgId: string, inviter: string, userId: string, email: string) {
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email, role: 'member' },
      { actor: asMfa(inviter), orgId },
    );
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(userId) });
  }

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const withAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(adminUrl, fn);

  // The definer as the API calls it: crove_app, in the context of (userId, orgId) when given, inside a transaction.
  const profilesAs = (ctx: { userId: string; orgId: string } | null, ids: string[]) =>
    withClient(appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        if (ctx) await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [ctx.userId, ctx.orgId]);
        const { rows } = await c.query<{ user_id: string; email: string; display_name: string | null }>(
          'SELECT user_id, email, display_name FROM crove_kernel.member_profiles($1::uuid[]) ORDER BY email',
          [ids],
        );
        return rows;
      } finally {
        await c.query('ROLLBACK');
      }
    });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    for (const name of Object.keys(users) as Array<keyof typeof users>) {
      users[name] = await upsertIdentity(db, { issuer: 'test', subject: `prof-${name}`, email: emailOf(name), name: `Name ${name}` });
    }
    orgA = (await createOrg(runtime, asUser(users.ownerA), 'Profiles Org A')).orgId;
    orgB = (await createOrg(runtime, asUser(users.ownerB), 'Profiles Org B')).orgId;
    await join(orgA, users.ownerA, users.memberA, emailOf('memberA'));
    await join(orgA, users.ownerA, users.both, emailOf('both'));
    await join(orgB, users.ownerB, users.both, emailOf('both'));
    await join(orgA, users.ownerA, users.leaver, emailOf('leaver'));
    await runtime.execute('kernel.member.remove', { userId: users.leaver }, { actor: asMfa(users.ownerA), orgId: orgA });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('returns only members of the org in the sealed context, never arbitrary users', async () => {
    const everyone = [...Object.values(users), randomUUID()];
    const inA = await profilesAs({ userId: users.memberA, orgId: orgA }, everyone);
    expect(inA).toEqual(
      (['both', 'memberA', 'ownerA'] as const).map((n) => ({ user_id: users[n], email: emailOf(n), display_name: `Name ${n}` })),
    );
    const inB = await profilesAs({ userId: users.ownerB, orgId: orgB }, everyone);
    expect(inB.map((r) => r.user_id)).toEqual([users.both, users.ownerB]);

    // Another org's member, a user in no org, a former member and an unknown id: nothing, even asked one by one.
    for (const id of [users.ownerB, users.outsider, users.leaver, randomUUID()]) {
      expect(await profilesAs({ userId: users.ownerA, orgId: orgA }, [id]), id).toEqual([]);
    }
    // A user who shares org B with ownerB is still not visible from org A's context through ownerB.
    expect(await profilesAs({ userId: users.both, orgId: orgA }, [users.ownerB])).toEqual([]);
    // Empty and NULL arrays return nothing.
    expect(await profilesAs({ userId: users.ownerA, orgId: orgA }, [])).toEqual([]);
    const nullIds = await withClient(appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.ownerA, orgA]);
        return (await c.query('SELECT * FROM crove_kernel.member_profiles(NULL)')).rows;
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(nullIds).toEqual([]);
  });

  it('requires a sealed context: none returns nothing, a forged one is refused', async () => {
    const ids = Object.values(users);
    expect(await profilesAs(null, ids)).toEqual([]);

    // A context written with set_config (no seal, a copied seal or an edited one) is refused before any row is read.
    const sealed = await withClient(appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.ownerA, orgA]);
        const { rows } = await c.query<{ ctx: string; seal: string }>(
          `SELECT current_setting('crove.ctx') AS ctx, current_setting('crove.ctx_seal') AS seal`,
        );
        return rows[0] as { ctx: string; seal: string };
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const forgedB = sealed.ctx.replace(orgA, orgB);
    expect(forgedB).not.toBe(sealed.ctx);
    for (const [ctx, seal] of [
      [sealed.ctx, ''],
      [sealed.ctx, sealed.seal],
      [forgedB, sealed.seal],
      ['', sealed.seal],
    ] as const) {
      const error = await withClient(appUrl, async (c) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT set_config('crove.ctx', $1, true), set_config('crove.ctx_seal', $2, true)`, [ctx, seal]);
          return await c.query('SELECT * FROM crove_kernel.member_profiles($1::uuid[])', [ids]).then(() => null, (e: unknown) => e);
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(error, `${ctx} / ${seal}`).toMatchObject(SEAL_INVALID);
    }
  });

  it('lets only the API login role call it, as a pinned definer owned with the identity table (EXECUTE matrix)', async () => {
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober'];
    const { matrix, shape } = await withAdmin(async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT r AS role FROM unnest($1::text[]) r WHERE has_function_privilege(r, $2::regprocedure, 'EXECUTE') ORDER BY 1`,
        [roles, FN],
      );
      const { rows: defs } = await c.query<{ definer: boolean; config: string[]; public: boolean; owns_table: boolean; volatility: string }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config, p.provolatile::text AS volatility,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public,
                p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'crove_kernel.user_account'::regclass) AS owns_table
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      return { matrix: rows.map((r) => r.role), shape: defs };
    });
    expect(matrix).toEqual(['crove_app']);
    expect(shape).toEqual([{ definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false, owns_table: true, volatility: 's' }]);
    await expect(withClient(workerUrl, (c) => c.query('SELECT * FROM crove_kernel.member_profiles(ARRAY[]::uuid[])'))).rejects.toThrow(
      /permission denied for function member_profiles/,
    );
  });

  it("serves the kernel's member reads: org members and the pending invites' inviters", async () => {
    const detail = await runtime.query<{ members: Array<{ userId: string; email: string; displayName: string | null; role: string }> }>(
      'kernel.org.get',
      {},
      { actor: asUser(users.memberA), orgId: orgA },
    );
    expect(detail.members).toEqual([
      { userId: users.ownerA, email: emailOf('ownerA'), displayName: 'Name ownerA', role: 'owner' },
      { userId: users.memberA, email: emailOf('memberA'), displayName: 'Name memberA', role: 'member' },
      { userId: users.both, email: emailOf('both'), displayName: 'Name both', role: 'member' },
    ]);

    // The pending invite list names the inviter.
    await runtime.execute('kernel.member.invite.create', { email: 'prof-new@example.com', role: 'member' }, { actor: asMfa(users.ownerA), orgId: orgA });
    const invites = await runtime.query<Array<{ email: string; invitedBy: string | null }>>(
      'kernel.member.invites.list',
      {},
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    expect(invites.find((i) => i.email === 'prof-new@example.com')?.invitedBy).toBe('Name ownerA');

    // The already-a-member check sees members' emails through the definer, and only this org's.
    await expect(
      runtime.execute('kernel.member.invite.create', { email: emailOf('memberA').toUpperCase(), role: 'member' }, { actor: asMfa(users.ownerA), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'ALREADY_MEMBER', status: 409 });
    await expect(
      runtime.execute('kernel.member.invite.create', { email: emailOf('ownerB'), role: 'member' }, { actor: asMfa(users.ownerA), orgId: orgA }),
    ).resolves.toMatchObject({ acceptPath: expect.any(String) });
  });
});
