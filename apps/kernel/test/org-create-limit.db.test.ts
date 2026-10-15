// Per-user rate limit on org creation (External-tenant gate T4, issue #94) on a real PostgreSQL 17. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { toORPCError } from '../src/rpc.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DAY_S = 24 * 60 * 60;

const suite = ADMIN ? describe : describe.skip;

suite('org creation rate limit on PostgreSQL (T4, #94)', () => {
  const dbName = `crove_test_orglimit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  // Default limits: 5 per 24 hours, 20 in total.
  let runtime: Runtime;
  // Configured limits: 2 per 24 hours, 3 in total.
  let tight: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function newUser(label: string): Promise<string> {
    const tag = `${label}-${randomUUID().slice(0, 8)}`;
    return upsertIdentity(db, { issuer: 'test', subject: tag, email: `${tag}@example.com`, name: null });
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // Tenants, audit rows and idempotency keys a user's org creations left, as the database owner sees them.
  async function footprint(userId: string) {
    return withAdmin(async (admin) => {
      const { rows } = await admin.query<{ tenants: number; audits: number; keys: number }>(
        `SELECT (SELECT count(*)::int FROM crove_kernel.tenant WHERE created_by = $1) AS tenants,
                (SELECT count(*)::int FROM crove_kernel.audit_event WHERE command = 'kernel.org.create' AND actor_id = $1) AS audits,
                (SELECT count(*)::int FROM crove_kernel.idempotency_key WHERE command = 'kernel.org.create' AND actor_key = 'user:' || $1) AS keys`,
        [userId],
      );
      return rows[0];
    });
  }

  // Moves every org the user created back by the given hours, so it leaves the rolling 24-hour window.
  async function age(userId: string, hours: number) {
    await withAdmin((admin) =>
      admin.query(`UPDATE crove_kernel.tenant SET created_at = created_at - make_interval(hours => $2) WHERE created_by = $1`, [userId, hours]),
    );
  }

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    db = createDb(pool);
    const queries = kernelQueries({ inboundDomain: 'in.test' });
    runtime = new Runtime(db).register({ commands: kernelCommands, queries });
    tight = new Runtime(db).register({ commands: buildKernelCommands({ orgCreateLimits: { perDay: 2, total: 3 } }), queries });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('refuses the sixth org in 24 hours with 429 RATE_LIMITED and writes nothing; replays and other users are unaffected', async () => {
    const user = await newUser('founder');
    const keys = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const created = [];
    for (const [i, key] of keys.entries()) created.push(await createOrg(runtime, asUser(user), `Công ty ${i}`, key));
    expect(await footprint(user)).toEqual({ tenants: 5, audits: 5, keys: 5 });

    const refusal = createOrg(runtime, asUser(user), 'Công ty thứ sáu', randomUUID());
    await expect(refusal).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Bạn đã tạo quá nhiều tổ chức trong 24 giờ qua (tối đa 5), hãy thử lại sau',
      details: { rule: 'org_create_per_day', limit: 5, retryAfterSeconds: expect.any(Number) },
    });
    const error = await refusal.catch((e: unknown) => e);
    const retryAfter = (error as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds;
    expect(retryAfter).toBeGreaterThan(DAY_S - 120);
    expect(retryAfter).toBeLessThanOrEqual(DAY_S);
    // The API answers it with HTTP 429 and the same code.
    expect(toORPCError(error)).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    // Without a key it is refused just the same.
    await expect(createOrg(runtime, asUser(user), 'Không khóa')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    // No tenant, audit row or key was written: there is no org to audit a refusal in.
    expect(await footprint(user)).toEqual({ tenants: 5, audits: 5, keys: 5 });

    // A replay of an existing key at the limit still returns its org, and creates nothing.
    for (const [i, key] of keys.entries()) {
      await expect(createOrg(runtime, asUser(user), `Công ty ${i}`, key)).resolves.toEqual(created[i]);
    }
    expect(await footprint(user)).toEqual({ tenants: 5, audits: 5, keys: 5 });

    // The limit is per user.
    const other = await newUser('other');
    await expect(createOrg(runtime, asUser(other), 'Người khác')).resolves.toMatchObject({ role: 'owner' });

    // Once the orgs are older than 24 hours, the user may create again.
    await age(user, 25);
    await expect(createOrg(runtime, asUser(user), 'Ngày hôm sau')).resolves.toMatchObject({ role: 'owner' });
    expect(await footprint(user)).toEqual({ tenants: 6, audits: 6, keys: 5 });
  });

  it('applies configured limits, and keeps the total limit after the window passes, counting closed orgs', async () => {
    const user = await newUser('total');
    await createOrg(tight, asUser(user), 'Một');
    await createOrg(tight, asUser(user), 'Hai');
    await expect(createOrg(tight, asUser(user), 'Ba')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      details: { rule: 'org_create_per_day', limit: 2 },
    });
    await age(user, 25);
    const third = await createOrg(tight, asUser(user), 'Ba');
    await age(user, 25);
    // A closed org still counts.
    await withAdmin((admin) => admin.query(`UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`, [third.orgId]));
    await expect(createOrg(tight, asUser(user), 'Bốn')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Bạn đã tạo đủ số tổ chức tối đa cho một tài khoản (3)',
      details: { rule: 'org_create_total', limit: 3 },
    });
    expect(await footprint(user)).toEqual({ tenants: 3, audits: 3, keys: 0 });
  });

  it('lets exactly one of several concurrent creations at the boundary win, across connections', async () => {
    for (let round = 0; round < 3; round++) {
      const user = await newUser(`race${round}`);
      for (let i = 0; i < 4; i++) await createOrg(runtime, asUser(user), `Đua ${i}`);
      const results = await Promise.allSettled([
        createOrg(runtime, asUser(user), 'Đua A', randomUUID()),
        createOrg(runtime, asUser(user), 'Đua B', randomUUID()),
        createOrg(runtime, asUser(user), 'Đua C'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused.map((r) => [r.reason.code, r.reason.status])).toEqual([
        ['RATE_LIMITED', 429],
        ['RATE_LIMITED', 429],
      ]);
      expect((await footprint(user))?.tenants).toBe(5);
    }
  });

  it('fails closed on a malformed limit setting', async () => {
    const user = await newUser('malformed');
    for (const value of ['0', '-1', 'abc', '1e3', '9999999']) {
      await expect(
        db.transaction().execute(async (trx) => {
          await sql`SELECT set_config('crove.org_create_limit_per_day', ${value}, true)`.execute(trx);
          await sql`SELECT crove_kernel.create_or_replay_org(${user}::uuid, 'malformed-org', 'Malformed', NULL)`.execute(trx);
        }),
      ).rejects.toThrow(/ORG_CREATE_LIMIT_INVALID/);
    }
    expect((await footprint(user))?.tenants).toBe(0);
  });
});
