// Invariant suite (Decision 7): the per-org rate limit on inbound address rotation (issue #113, plan §7.6). Every
// rotation leaves a permanent tombstone in crove_kernel.inbound_address, so the definer refuses a rotation past the
// per-day or total limit, under a per-org lock with a bounded wait, and fails closed on a malformed limit setting.
// Owners rotate with a fresh second factor, so these tests hold whether rotation is R2 or R3. Keep this directory
// self-contained: import package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const DAY_S = 24 * 60 * 60;

const suite = ADMIN ? describe : describe.skip;

suite('inbound address rotation rate limit on PostgreSQL (#113)', () => {
  const dbName = `crove_test_rotlimit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  // Default limits: 3 per 24 hours, 50 in total.
  let runtime: Runtime;
  // Configured limits: 2 per 24 hours, 3 in total.
  let tight: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // A fresh owner and org: org creation has its own per-user limit, so every org gets its own owner.
  async function newOrg(label: string): Promise<{ owner: string; orgId: string }> {
    const tag = `${label}-${randomUUID().slice(0, 8)}`;
    const owner = await upsertIdentity(db, { issuer: 'test', subject: tag, email: `${tag}@example.com`, name: null });
    const { orgId } = await createOrg(runtime, asUser(owner), `Org ${tag}`);
    return { owner, orgId };
  }

  const rotate = (target: Runtime, org: { owner: string; orgId: string }, idempotencyKey?: string) =>
    target.execute<{ inboundToken: string }>('kernel.inbound.rotate', {}, {
      actor: asMfa(org.owner),
      orgId: org.orgId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

  // The org's ledger, its current token and its successful rotation audit rows, as the database owner sees them.
  const footprint = (orgId: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ rows: number; retired: number; token: string; audits: number }>(
        `SELECT (SELECT count(*)::int FROM crove_kernel.inbound_address WHERE org_id = $1) AS rows,
                (SELECT count(*)::int FROM crove_kernel.inbound_address WHERE org_id = $1 AND retired_at IS NOT NULL) AS retired,
                (SELECT inbound_token FROM crove_kernel.tenant WHERE org_id = $1) AS token,
                (SELECT count(*)::int FROM crove_kernel.audit_event
                  WHERE org_id = $1 AND command = 'kernel.inbound.rotate' AND outcome = 'ok') AS audits`,
        [orgId],
      );
      return rows[0];
    });

  // Moves the org's ledger back by the given hours, so its rotations leave the rolling 24-hour window. The guard
  // trigger refuses every such change, so it is bypassed for this one statement (superuser only).
  const age = (orgId: string, hours: number) =>
    withAdmin(async (admin) => {
      await admin.query('BEGIN');
      await admin.query('SET LOCAL session_replication_role = replica');
      await admin.query(
        `UPDATE crove_kernel.inbound_address
            SET created_at = created_at - make_interval(hours => $2), retired_at = retired_at - make_interval(hours => $2)
          WHERE org_id = $1`,
        [orgId, hours],
      );
      await admin.query('COMMIT');
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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    db = createDb(pool);
    const queries = kernelQueries({ inboundDomain: 'in.test' });
    runtime = new Runtime(db).register({ commands: kernelCommands, queries });
    tight = new Runtime(db).register({ commands: buildKernelCommands({ inboundRotateLimits: { perDay: 2, total: 3 } }), queries });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses the fourth rotation in 24 hours with 429 and writes nothing; replays and other orgs are unaffected', async () => {
    const org = await newOrg('daily');
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const tokens: string[] = [];
    for (const key of keys) tokens.push((await rotate(runtime, org, key)).inboundToken);
    const atLimit = await footprint(org.orgId);
    expect(atLimit).toEqual({ rows: 4, retired: 3, token: tokens[2], audits: 3 });

    const refusal = rotate(runtime, org, randomUUID());
    await expect(refusal).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      details: { rule: 'inbound_rotate_per_day', limit: 3, retryAfterSeconds: expect.any(Number) },
    });
    const retryAfter = ((await refusal.catch((e: unknown) => e)) as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds;
    expect(retryAfter).toBeGreaterThan(DAY_S - 120);
    expect(retryAfter).toBeLessThanOrEqual(DAY_S);
    // Without a key it is refused just the same, and nothing was written either time.
    await expect(rotate(runtime, org)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(await footprint(org.orgId)).toEqual(atLimit);

    // A replay of an existing key at the limit returns its stored result and does not count.
    for (const [i, key] of keys.entries()) {
      await expect(rotate(runtime, org, key)).resolves.toEqual({ inboundToken: tokens[i] });
    }
    expect(await footprint(org.orgId)).toEqual(atLimit);

    // The limit is per org.
    const other = await newOrg('other');
    await expect(rotate(runtime, other, randomUUID())).resolves.toMatchObject({ inboundToken: expect.any(String) });

    // Once the rotations are older than 24 hours, the org may rotate again.
    await age(org.orgId, 25);
    await expect(rotate(runtime, org, randomUUID())).resolves.toMatchObject({ inboundToken: expect.any(String) });
    expect(await footprint(org.orgId)).toMatchObject({ rows: 5, retired: 4, audits: 4 });
  });

  it('applies configured limits, and keeps the total limit after the window passes', async () => {
    const org = await newOrg('total');
    await rotate(tight, org);
    await rotate(tight, org);
    await expect(rotate(tight, org)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429, details: { rule: 'inbound_rotate_per_day', limit: 2 } });
    await age(org.orgId, 25);
    await rotate(tight, org);
    await age(org.orgId, 25);
    const atTotal = await footprint(org.orgId);
    expect(atTotal).toMatchObject({ rows: 4, retired: 3, audits: 3 });
    await expect(rotate(tight, org, randomUUID())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      details: { rule: 'inbound_rotate_total', limit: 3 },
    });
    expect(await footprint(org.orgId)).toEqual(atTotal);
  });

  it('lets exactly one of several concurrent rotations at the boundary win, across connections', async () => {
    for (let round = 0; round < 3; round++) {
      const org = await newOrg(`race${round}`);
      await rotate(runtime, org);
      await rotate(runtime, org);
      const results = await Promise.allSettled([
        rotate(runtime, org, randomUUID()),
        rotate(runtime, org, randomUUID()),
        rotate(runtime, org),
        rotate(runtime, org),
      ]);
      const won = results.filter((r): r is PromiseFulfilledResult<{ inboundToken: string }> => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      // Each loser either waited and counted (per_day), or deadlocked with the holder on the tenant row and was refused
      // as busy; never a 409 or a 500.
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused).toHaveLength(3);
      for (const r of refused) {
        expect([r.reason.code, r.reason.status]).toEqual(['RATE_LIMITED', 429]);
        expect(['inbound_rotate_per_day', 'inbound_rotate_busy']).toContain(r.reason.details?.rule);
      }
      expect(await footprint(org.orgId)).toEqual({ rows: 4, retired: 3, token: won[0]?.value.inboundToken, audits: 3 });
    }
  });

  it('refuses with 429 inbound_rotate_busy instead of waiting past the lock timeout behind the same org', async () => {
    const org = await newOrg('busy');
    const before = await footprint(org.orgId);
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('kernel.inbound.rotate:' || $1, 0))`, [org.orgId]);
      const started = Date.now();
      await expect(rotate(runtime, org, randomUUID())).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        status: 429,
        details: { rule: 'inbound_rotate_busy', retryAfterSeconds: 1 },
      });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(2500);
      expect(waited).toBeLessThan(10_000);
      // Another org is not blocked by it.
      await expect(rotate(runtime, await newOrg('free'))).resolves.toMatchObject({ inboundToken: expect.any(String) });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(await footprint(org.orgId)).toEqual(before);
    // The session's own lock_timeout is restored after the lock: a later statement in the transaction is unaffected.
    const restored = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('lock_timeout', '7s', true)`.execute(trx);
      await sql`SELECT crove_kernel.enter_context(${org.owner}::uuid, ${org.orgId}::uuid)`.execute(trx);
      await sql`SELECT crove_kernel.inbound_rotate()`.execute(trx);
      const { rows } = await sql<{ lock_timeout: string }>`SELECT current_setting('lock_timeout') AS lock_timeout`.execute(trx);
      return rows[0]?.lock_timeout;
    });
    expect(restored).toBe('7s');
  });

  it('fails closed on a malformed limit setting', async () => {
    const org = await newOrg('malformed');
    const before = await footprint(org.orgId);
    for (const setting of ['crove.inbound_rotate_limit_per_day', 'crove.inbound_rotate_limit_total']) {
      for (const value of ['0', '-1', 'abc', '1e3', '1.5', '9999999', ' 3']) {
        await expect(
          db.transaction().execute(async (trx) => {
            await sql`SELECT crove_kernel.enter_context(${org.owner}::uuid, ${org.orgId}::uuid)`.execute(trx);
            await sql`SELECT set_config(${setting}, ${value}, true)`.execute(trx);
            await sql`SELECT crove_kernel.inbound_rotate()`.execute(trx);
          }),
        ).rejects.toThrow(/INBOUND_ROTATE_LIMIT_INVALID/);
      }
    }
    expect(await footprint(org.orgId)).toEqual(before);
  });
});
