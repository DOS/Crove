// Offboarding and retention invariants (issue #38, plan §4.9, §7.9) on a real PostgreSQL 17: only owners enter an
// offboarding org, the login roles make no status change but the audited move to offboarding, staff (a non-superuser
// runner too) may, a closed org is refused to everyone, and the retention purge is the worker's alone and touches no
// audit, outbox or ledger row. Part of the invariant suite: CI runs this file from the base branch on protected-path
// PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database and role.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, myOrgs, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

suite('offboarding and retention invariants (#38)', () => {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dbName = `crove_test_offboard_inv_${stamp}`;
  // A non-superuser staff role that can act as the table owner and also holds ADMIN on crove_app without inheriting
  // it, as a CREATEROLE migration runner that created crove_app does on PostgreSQL 16+.
  const staffRole = `crove_test_staff_${stamp}`;
  let adminUrl = '';
  let appUrl = '';
  let staffUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const system = { type: 'system' as const, component: 'invariant' };

  async function newUser(label: string) {
    const tag = `${label}-${randomUUID().slice(0, 8)}`;
    const email = `${tag}@example.com`;
    return { id: await upsertIdentity(db, { issuer: 'test', subject: tag, email, name: null }), email };
  }

  async function connect<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const admin = <T>(fn: (c: pg.Client) => Promise<T>) => connect(adminUrl, fn);

  async function orgWithMember(name: string) {
    const owner = await newUser('owner');
    const member = await newUser('member');
    const org = await createOrg(runtime, asUser(owner.id), name);
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: member.email, role: 'admin' },
      { actor: asMfa(owner.id), orgId: org.orgId },
    );
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(member.id) });
    return { org, owner, member };
  }

  const status = (orgId: string) =>
    admin(async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.status);

  // One statement as the API login role, inside the owner's context, committed.
  async function asApp(userId: string, orgId: string, statement: string) {
    await connect(appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_context($1, $2)', [userId, orgId]);
        await c.query(statement, [orgId]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    await connect(ADMIN as string, (c) => c.query(`CREATE DATABASE ${dbName}`));
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const owner = await admin(async (c) => (await c.query<{ owner: string }>(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'crove_kernel.tenant'::regclass`)).rows[0]?.owner);
    await admin(async (c) => {
      await c.query(`CREATE ROLE ${staffRole} LOGIN NOSUPERUSER PASSWORD 'test-staff-pw'`);
      await c.query(`GRANT ${owner} TO ${staffRole}`);
      await c.query(`GRANT crove_app TO ${staffRole} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
    });
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    staffUrl = loginUrl(staffRole, 'test-staff-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    workerDb = createDb(workerPool);
    runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    workerRuntime = new Runtime(workerDb).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    await connect(ADMIN, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${staffRole}`);
    });
  });

  it('lets only owners enter an offboarding org, and refuses the offboard command to everyone else', async () => {
    const { org, owner, member } = await orgWithMember('Công ty Bất biến');
    // An admin may not offboard; neither may the owner without a fresh second factor.
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(member.id), orgId: org.orgId })).rejects.toMatchObject({
      status: 403,
    });
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asUser(owner.id), orgId: org.orgId })).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    expect(await status(org.orgId)).toBe('active');

    await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });
    expect(await status(org.orgId)).toBe('offboarding');
    // The admin is refused by the database itself and no longer sees the org; the owner keeps both.
    await expect(
      db.transaction().execute((trx) => sql`SELECT crove_kernel.enter_context(${member.id}::uuid, ${org.orgId}::uuid)`.execute(trx)),
    ).rejects.toThrow(/NOT_A_MEMBER/);
    expect((await myOrgs(db, member.id)).map((o) => o.orgId)).not.toContain(org.orgId);
    expect((await myOrgs(db, owner.id)).find((o) => o.orgId === org.orgId)).toMatchObject({ role: 'owner' });
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(owner.id), orgId: org.orgId })).resolves.toMatchObject({ orgId: org.orgId });
    // Inbound mail no longer resolves to the org.
    const token = await admin(async (c) => (await c.query<{ t: string }>('SELECT inbound_token AS t FROM crove_kernel.tenant WHERE org_id = $1', [org.orgId])).rows[0]?.t);
    const resolved = await workerDb.transaction().execute(async (trx) => (await sql<{ org: string | null }>`SELECT crove_kernel.org_by_inbound_token(${token}) AS org`.execute(trx)).rows[0]?.org);
    expect(resolved).toBeNull();
  });

  it('lets the login roles make no status change but the audited move to offboarding; staff may close', async () => {
    const { org, owner } = await orgWithMember('Công ty Trạng thái');
    await expect(asApp(owner.id, org.orgId, `UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`)).rejects.toThrow(
      /ORG_OFFBOARD_UNAUDITED/,
    );
    await expect(asApp(owner.id, org.orgId, `UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`)).rejects.toThrow(
      /TENANT_STATUS_TRANSITION/,
    );
    expect(await status(org.orgId)).toBe('active');

    await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });
    await expect(asApp(owner.id, org.orgId, `UPDATE crove_kernel.tenant SET status = 'active' WHERE org_id = $1`)).rejects.toThrow(
      /TENANT_STATUS_TRANSITION/,
    );
    expect(await status(org.orgId)).toBe('offboarding');

    // Staff that is not a superuser, but acts as the table owner, closes the org.
    await connect(staffUrl, (c) => c.query(`UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`, [org.orgId]));
    expect(await status(org.orgId)).toBe('closed');
    // A closed org is refused to everyone: the owner and the worker's system context.
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(owner.id), orgId: org.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(workerRuntime.query('kernel.org.export.snapshot', { table: 'kernel.tenant' }, { actor: system, orgId: org.orgId })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('keeps the retention purge to the worker and away from audit, outbox and ledger tables', async () => {
    const { rows } = await admin((c) =>
      c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_tenant', 'crove_definer_tenant', 'crove_worker']) r
         WHERE has_function_privilege(r, 'crove_kernel.retention_purge(integer)', 'EXECUTE')`,
      ),
    );
    expect(rows.map((r) => r.role)).toEqual(['crove_worker']);
    await expect(sql`SELECT * FROM crove_kernel.retention_purge(1)`.execute(db)).rejects.toThrow(/permission denied/);
    // The session_user check holds on its own: a more privileged definer granted to the API is refused.
    await admin(async (c) => {
      await c.query(`CREATE FUNCTION public.retention_probe() RETURNS SETOF record LANGUAGE sql SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp AS $$ SELECT * FROM crove_kernel.retention_purge(1) $$`);
      await c.query('GRANT EXECUTE ON FUNCTION public.retention_probe() TO crove_app');
    });
    try {
      await expect(sql`SELECT * FROM public.retention_probe() AS t(store text, deleted int, more boolean)`.execute(db)).rejects.toThrow(
        /RETENTION_WORKER_ONLY/,
      );
    } finally {
      await admin((c) => c.query('DROP FUNCTION public.retention_probe()'));
    }
    const body = await admin(async (c) => (await c.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'retention_purge'`)).rows[0]?.src ?? '');
    expect(body).toMatch(/idempotency_key/);
    expect(body).not.toMatch(/audit_event|outbox_event|crove_finance|auth_session|inbound_address|context_key|tenant_member|crove_kernel\.file\b/);
  });
});
