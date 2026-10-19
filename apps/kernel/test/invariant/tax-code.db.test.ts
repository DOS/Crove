// The org's tax code (#430, review of #427) on a real PostgreSQL 17: it decides which invoices are read as sales, so
// only kernel.org.set_tax_code, run by an owner or admin, changes it. A raw statement in an owner's context commits
// only with that command's audit row, a member's or the worker's is refused whatever audit row it forges, a row is
// never inserted with one, and staff (a non-superuser runner too) may change it. Part of the invariant suite: CI runs
// this file from the base branch on protected-path PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a superuser URL; the
// run creates and drops its own database and role. The tax codes are made up and fail the MST checksum.
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
const FIRST = '0101234564';
const SECOND = '0309876546';
const THIRD = '0312345670';

const suite = ADMIN ? describe : describe.skip;

suite('tax code invariants (#430)', () => {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dbName = `crove_test_tax_code_inv_${stamp}`;
  // A non-superuser staff role that can act as the table owner, as the migration runner does.
  const staffRole = `crove_test_tax_staff_${stamp}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let staffUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

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

  async function invite(orgId: string, ownerId: string, role: 'admin' | 'member') {
    const user = await newUser(role);
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: user.email, role },
      { actor: asMfa(ownerId), orgId },
    );
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(user.id) });
    return user;
  }

  async function orgWithMembers(name: string) {
    const owner = await newUser('owner');
    const org = await createOrg(runtime, asUser(owner.id), name);
    return { org, owner, admin: await invite(org.orgId, owner.id, 'admin'), member: await invite(org.orgId, owner.id, 'member') };
  }

  const taxCode = (orgId: string) =>
    admin(async (c) => (await c.query<{ tax_code: string | null }>('SELECT tax_code FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.tax_code);

  // Statements in one transaction as a login role, after entering a context (`enter`), committed.
  async function commitAs(url: string, enter: { sql: string; params: unknown[] } | null, statements: Array<{ sql: string; params: unknown[] }>) {
    await connect(url, async (c) => {
      await c.query('BEGIN');
      try {
        if (enter) await c.query(enter.sql, enter.params);
        for (const s of statements) await c.query(s.sql, s.params);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }
  const userContext = (userId: string, orgId: string) => ({ sql: 'SELECT crove_kernel.enter_context($1, $2)', params: [userId, orgId] });
  const setCode = (orgId: string, code: string | null) => ({ sql: 'UPDATE crove_kernel.tenant SET tax_code = $2 WHERE org_id = $1', params: [orgId, code] });
  // An audit row of the command, as execute() would write it, naming `actorId` and the new value.
  const forgedAudit = (orgId: string, actorId: string, code: string) => ({
    sql: `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
          VALUES ($1, 'user', $2, 'kernel.org.set_tax_code', gen_random_uuid(), 'ok', repeat('0', 64), $3::jsonb)`,
    params: [orgId, actorId, JSON.stringify({ previous: null, taxCode: code })],
  });

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
    });
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    staffUrl = loginUrl(staffRole, 'test-staff-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    await connect(ADMIN, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${staffRole}`);
    });
  });

  it('lets owners and admins change the tax code through kernel.org.set_tax_code, and members not at all', async () => {
    const { org, owner, admin: orgAdmin, member } = await orgWithMembers('Công ty Mã số thuế');
    await runtime.execute('kernel.org.set_tax_code', { taxCode: FIRST }, { actor: asUser(owner.id), orgId: org.orgId });
    expect(await taxCode(org.orgId)).toBe(FIRST);
    await runtime.execute('kernel.org.set_tax_code', { taxCode: SECOND }, { actor: asUser(orgAdmin.id), orgId: org.orgId });
    expect(await taxCode(org.orgId)).toBe(SECOND);
    await expect(runtime.execute('kernel.org.set_tax_code', { taxCode: THIRD }, { actor: asUser(member.id), orgId: org.orgId })).rejects.toMatchObject({
      status: 403,
    });
    await runtime.execute('kernel.org.set_tax_code', { taxCode: null }, { actor: asUser(owner.id), orgId: org.orgId });
    expect(await taxCode(org.orgId)).toBeNull();
  });

  it('refuses a raw change in an owner or admin context without the command audit row, at commit', async () => {
    const { org, owner, admin: orgAdmin } = await orgWithMembers('Công ty Chưa ghi vết');
    for (const who of [owner, orgAdmin]) {
      await expect(commitAs(appUrl, userContext(who.id, org.orgId), [setCode(org.orgId, FIRST)])).rejects.toThrow(/TAX_CODE_UNAUDITED/);
    }
    // An audit row of another command, or naming another value, does not count either.
    await expect(
      commitAs(appUrl, userContext(owner.id, org.orgId), [
        { ...forgedAudit(org.orgId, owner.id, FIRST), sql: forgedAudit(org.orgId, owner.id, FIRST).sql.replace("'kernel.org.set_tax_code'", "'kernel.org.set_vat_filing_period'") },
        setCode(org.orgId, FIRST),
      ]),
    ).rejects.toThrow(/TAX_CODE_UNAUDITED/);
    await expect(
      commitAs(appUrl, userContext(owner.id, org.orgId), [forgedAudit(org.orgId, owner.id, SECOND), setCode(org.orgId, FIRST)]),
    ).rejects.toThrow(/TAX_CODE_UNAUDITED/);
    expect(await taxCode(org.orgId)).toBeNull();
  });

  it('refuses a change by a member, the worker or no context, whatever audit row it forges', async () => {
    const { org, owner, member } = await orgWithMembers('Công ty Giả mạo');
    // A member's context: an audit row naming the owner does not make the member an owner.
    await expect(
      commitAs(appUrl, userContext(member.id, org.orgId), [forgedAudit(org.orgId, owner.id, FIRST), setCode(org.orgId, FIRST)]),
    ).rejects.toThrow(/TAX_CODE_FORBIDDEN/);
    // The worker's system context of the org.
    await expect(
      commitAs(workerUrl, { sql: 'SELECT crove_kernel.enter_system_context($1)', params: [org.orgId] }, [
        forgedAudit(org.orgId, owner.id, FIRST),
        setCode(org.orgId, FIRST),
      ]),
    ).rejects.toThrow(/TAX_CODE_FORBIDDEN/);
    // Without a context the row is not even visible.
    await commitAs(appUrl, null, [setCode(org.orgId, FIRST)]);
    expect(await taxCode(org.orgId)).toBeNull();
  });

  it('never inserts an org with a tax code from a login role', async () => {
    const { org, owner } = await orgWithMembers('Công ty Chèn');
    await expect(
      commitAs(appUrl, userContext(owner.id, org.orgId), [
        {
          sql: `INSERT INTO crove_kernel.tenant (org_id, slug, name, created_by, tax_code) VALUES ($1, $2, 'Chèn', $3, $4)`,
          params: [org.orgId, `chen-${stamp}`, owner.id, FIRST],
        },
      ]),
    ).rejects.toThrow(/TAX_CODE_FORBIDDEN/);
  });

  it('lets staff, a non-superuser runner too, change the tax code without the command', async () => {
    const { org } = await orgWithMembers('Công ty Hỗ trợ');
    await connect(staffUrl, (c) => c.query(setCode(org.orgId, FIRST).sql, setCode(org.orgId, FIRST).params));
    expect(await taxCode(org.orgId)).toBe(FIRST);
    await admin((c) => c.query(setCode(org.orgId, SECOND).sql, setCode(org.orgId, SECOND).params));
    expect(await taxCode(org.orgId)).toBe(SECOND);
  });

  it('lets no login or tenant role call the guards, which pin search_path (EXECUTE matrix)', async () => {
    const { rows } = await admin((c) =>
      c.query<{ fn: string; definer: boolean; config: string[] | null; callers: string[] }>(
        `SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, p.proconfig AS config,
                ARRAY(SELECT r FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
                      WHERE has_function_privilege(r, p.oid, 'EXECUTE')) AS callers
         FROM pg_proc p WHERE p.oid IN ('crove_kernel.tenant_tax_code_guard()'::regprocedure, 'crove_kernel.tenant_tax_code_requires_audit()'::regprocedure)
         ORDER BY 1`,
      ),
    );
    expect(rows).toEqual([
      { fn: 'crove_kernel.tenant_tax_code_guard()', definer: true, config: ['search_path=pg_catalog, pg_temp'], callers: [] },
      { fn: 'crove_kernel.tenant_tax_code_requires_audit()', definer: true, config: ['search_path=pg_catalog, pg_temp'], callers: [] },
    ]);
  });
});
