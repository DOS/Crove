// Invariant suite (Decision 7): counts of messages dropped for a retired inbound address (issue #139, plan §7.6).
// Only the worker login role records a drop, only the API login role reads the count, and only for an owner or admin
// of the org in its sealed context; a drop counts for the org that retired the address and no other, only in the 30
// days after the rotation, and nothing about the message is stored. Keep this directory self-contained: import
// package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL;
// each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const RECORD = 'crove_kernel.inbound_drop_record(text)';
const COUNT = 'crove_kernel.inbound_drop_count()';

const suite = ADMIN ? describe : describe.skip;

suite('inbound drop count invariants on PostgreSQL', () => {
  const dbName = `crove_test_dropinv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  const users = { owner: '', admin: '', member: '', viewer: '', other: '' };
  let orgA = '';
  let orgB = '';
  // The org A token retired by a real rotation, and org B's active token.
  let retiredA = '';
  let activeB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '7a1d2c3b-4e5f-4a6b-9c7d-8e9f0a1b2c3d',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function join(orgId: string, inviter: string, userId: string, email: string, role: 'admin' | 'member' | 'viewer') {
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });
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

  // The worker's call, as crove_worker, in its own transaction.
  const record = (token: string) => withClient(workerUrl, (c) => c.query('SELECT crove_kernel.inbound_drop_record($1)', [token]));

  const drops = () =>
    withAdmin(async (c) => {
      const { rows } = await c.query<{ org_id: string; token: string; dropped_count: string }>(
        `SELECT d.org_id, a.token, d.dropped_count::text FROM crove_kernel.inbound_drop d
         JOIN crove_kernel.inbound_address a ON a.org_id = d.org_id AND a.id = d.address_id ORDER BY a.token`,
      );
      return rows;
    });

  // The count as the API reads it, for a user in the context of an org.
  const countAs = (userId: string, orgId: string) =>
    withClient(appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
        const { rows } = await c.query<{ n: string }>('SELECT crove_kernel.inbound_drop_count() AS n');
        return Number(rows[0]?.n);
      } finally {
        await c.query('ROLLBACK');
      }
    });

  const tokenOf = (orgId: string) =>
    withAdmin(async (c) => (await c.query<{ t: string }>('SELECT inbound_token AS t FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.t ?? '');

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
      users[name] = await upsertIdentity(db, { issuer: 'test', subject: `drop-${name}`, email: `drop-${name}@example.com`, name: null });
    }
    orgA = (await createOrg(runtime, asUser(users.owner), 'Drop Org A')).orgId;
    orgB = (await createOrg(runtime, asUser(users.other), 'Drop Org B')).orgId;
    for (const role of ['admin', 'member', 'viewer'] as const) {
      await join(orgA, users.owner, users[role], `drop-${role}@example.com`, role);
    }
    retiredA = await tokenOf(orgA);
    await runtime.execute('kernel.inbound.rotate', {}, { actor: asMfa(users.owner), orgId: orgA });
    activeB = await tokenOf(orgB);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only the worker login role record a drop and only the API login role read the count (EXECUTE matrix)', async () => {
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];
    const { matrix, shape } = await withAdmin(async (c) => {
      const { rows } = await c.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r
         WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
        [[RECORD, COUNT], roles],
      );
      const { rows: defs } = await c.query<{ fn: string; definer: boolean; config: string[]; public: boolean; owns_table: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, p.proconfig AS config,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public,
                p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'crove_kernel.inbound_drop'::regclass) AS owns_table
         FROM pg_proc p WHERE p.oid IN ($1::regprocedure, $2::regprocedure) ORDER BY 1`,
        [RECORD, COUNT],
      );
      return { matrix: rows, shape: defs };
    });
    expect(matrix).toEqual([
      { fn: COUNT, role: 'crove_app' },
      { fn: RECORD, role: 'crove_worker' },
    ]);
    expect(shape).toEqual(
      [COUNT, RECORD].map((fn) => ({ fn, definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false, owns_table: true })),
    );

    // Each login role is refused the other's function by the database.
    await expect(withClient(appUrl, (c) => c.query('SELECT crove_kernel.inbound_drop_record($1)', [retiredA]))).rejects.toThrow(
      /permission denied for function inbound_drop_record/,
    );
    await expect(withClient(workerUrl, (c) => c.query('SELECT crove_kernel.inbound_drop_count()'))).rejects.toThrow(
      /permission denied for function inbound_drop_count/,
    );

    // The session_user check holds on its own: with EXECUTE granted to crove_app (rolled back), recording is refused.
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`GRANT EXECUTE ON FUNCTION ${RECORD} TO crove_app`);
        await c.query('SET SESSION AUTHORIZATION crove_app');
        await expect(c.query('SELECT crove_kernel.inbound_drop_record($1)', [retiredA])).rejects.toMatchObject({
          code: '42501',
          message: 'INBOUND_DROP_WORKER_ONLY',
        });
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(await drops()).toEqual([]);
  });

  it('keeps the counts definer-only and stores nothing about the message', async () => {
    const shape = await withAdmin(async (c) => {
      const { rows: columns } = await c.query<{ name: string }>(
        `SELECT attname::text AS name FROM pg_attribute WHERE attrelid = 'crove_kernel.inbound_drop'::regclass AND attnum > 0 AND NOT attisdropped
         ORDER BY attnum`,
      );
      const { rows: grants } = await c.query<{ role: string; op: string }>(
        `SELECT r.rolname AS role, p AS op
         FROM pg_roles r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
         WHERE r.rolname LIKE 'crove\\_%' AND has_table_privilege(r.oid, 'crove_kernel.inbound_drop'::regclass, p)
         ORDER BY 1, 2`,
      );
      const { rows: table } = await c.query<{ rls: boolean; policies: number }>(
        `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS policies
         FROM pg_class c WHERE c.oid = 'crove_kernel.inbound_drop'::regclass`,
      );
      return { columns: columns.map((r) => r.name), grants, table: table[0] };
    });
    // A count and two times per retired address: no content, sender, subject, recipient or hash.
    expect(shape.columns).toEqual(['org_id', 'address_id', 'dropped_count', 'first_dropped_at', 'last_dropped_at']);
    expect(shape.grants).toEqual([]);
    expect(shape.table).toEqual({ rls: true, policies: 0 });
  });

  it('counts a drop for the org that retired the address, and for no other org', async () => {
    await record(retiredA);
    await record(retiredA.toUpperCase());
    expect(await drops()).toEqual([{ org_id: orgA, token: retiredA, dropped_count: '2' }]);
    // An active token, a token that never existed, an empty or malformed one, change nothing.
    for (const token of [activeB, await tokenOf(orgA), randomBytes(12).toString('hex'), '', 'not a token']) await record(token);
    expect(await drops()).toEqual([{ org_id: orgA, token: retiredA, dropped_count: '2' }]);

    // Owners and admins of org A read it; members and viewers are refused; org B reads 0.
    await expect(countAs(users.owner, orgA)).resolves.toBe(2);
    await expect(countAs(users.admin, orgA)).resolves.toBe(2);
    for (const userId of [users.member, users.viewer]) {
      await expect(countAs(userId, orgA)).rejects.toMatchObject({ code: '42501', message: 'INBOUND_DROP_OWNER_ONLY' });
    }
    await expect(countAs(users.other, orgB)).resolves.toBe(0);
    // Without a context, nothing.
    await expect(withClient(appUrl, (c) => c.query('SELECT crove_kernel.inbound_drop_count()'))).rejects.toMatchObject({
      code: '42501',
      message: 'NO_CONTEXT',
    });

    // The org query carries the count for owners and admins only.
    const detail = (userId: string, orgId: string) =>
      runtime.query<{ inboundDroppedCount: number | null }>('kernel.org.get', {}, { actor: asUser(userId), orgId });
    await expect(detail(users.owner, orgA)).resolves.toMatchObject({ inboundDroppedCount: 2 });
    await expect(detail(users.admin, orgA)).resolves.toMatchObject({ inboundDroppedCount: 2 });
    await expect(detail(users.viewer, orgA)).resolves.toMatchObject({ inboundDroppedCount: null });
    await expect(detail(users.other, orgB)).resolves.toMatchObject({ inboundDroppedCount: 0 });
  });

  it('counts only in the 30 days after the rotation', async () => {
    // A ledger row of org B retired 31 days ago (inserted as the database owner; the guard allows inserts).
    const old = randomBytes(12).toString('hex');
    const oldId = randomUUID();
    await withAdmin((c) =>
      c.query(
        `INSERT INTO crove_kernel.inbound_address (org_id, id, token, created_at, retired_at)
         VALUES ($1, $2, $3, now() - interval '40 days', now() - interval '31 days')`,
        [orgB, oldId, old],
      ),
    );
    await record(old);
    expect((await drops()).filter((d) => d.token === old)).toEqual([]);
    // A count left from inside the window stops showing once the window has passed.
    await withAdmin((c) =>
      c.query(
        `INSERT INTO crove_kernel.inbound_drop (org_id, address_id, dropped_count, first_dropped_at, last_dropped_at)
         VALUES ($1, $2, 5, now() - interval '30 days', now() - interval '30 days')`,
        [orgB, oldId],
      ),
    );
    await expect(countAs(users.other, orgB)).resolves.toBe(0);
    await record(old);
    expect((await drops()).find((d) => d.token === old)?.dropped_count).toBe('5');
  });
});
