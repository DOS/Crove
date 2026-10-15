// Micro-benchmark, not a test (issue #117): what the pool reset on release costs, and what re-checking current
// membership on every context helper call (plan §4.5) would cost compared with today's seal-only check. Skipped
// unless CROVE_BENCH=1, so CI never runs it. Run it with
//   CROVE_BENCH=1 CROVE_TEST_ADMIN_URL=<superuser url> pnpm exec vitest run --project db apps/kernel/test/context-cost.db.test.ts
// It creates and drops its own database and prints a table; the numbers depend on the machine and the network.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_RESET_SQL, createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ROUNDS = 5;

const suite = ADMIN && process.env.CROVE_BENCH === '1' ? describe : describe.skip;

// The per-call re-check a later migration could add (§4.5): the context's member must still be a member of the
// still-active org; a system context needs the org still active. Same contract as ctx_verified() otherwise.
const RECHECK_BODY = `
DECLARE
  v_ctx text := coalesce(pg_catalog.current_setting('crove.ctx', true), '');
  v_seal text := coalesce(pg_catalog.current_setting('crove.ctx_seal', true), '');
  v jsonb;
BEGIN
  IF v_ctx = '' AND v_seal = '' THEN
    RETURN NULL;
  END IF;
  IF v_ctx = '' OR v_seal = '' OR v_seal IS DISTINCT FROM crove_kernel.ctx_mac(v_ctx) THEN
    RAISE EXCEPTION 'CONTEXT_SEAL_INVALID' USING ERRCODE = '42501';
  END IF;
  v := v_ctx::jsonb;
  IF v ->> 'actor' = 'user' THEN
    PERFORM 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.tenant t ON t.org_id = m.org_id
    WHERE m.org_id = (v ->> 'org')::uuid AND m.user_id = (v ->> 'user')::uuid AND t.status = 'active';
  ELSE
    PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = (v ->> 'org')::uuid AND t.status = 'active';
  END IF;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN v;
END`;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

suite('context cost micro-benchmark (#117)', () => {
  const dbName = `crove_bench_ctx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let owner = '';
  let orgId = '';
  let setupPool: pg.Pool;
  const report: string[] = [];

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // Median over ROUNDS of the mean microseconds per iteration of fn, after one warm-up round.
  async function time(iterations: number, fn: () => Promise<unknown>): Promise<number> {
    const rounds: number[] = [];
    for (let round = 0; round <= ROUNDS; round++) {
      const start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) await fn();
      const us = Number(process.hrtime.bigint() - start) / 1000 / iterations;
      if (round > 0) rounds.push(us);
    }
    return median(rounds);
  }

  // Microseconds per helper call inside the database: one statement evaluates the expression once per row of
  // generate_series(1, n); the same statement counting the bare series is subtracted, so the round trip cancels out.
  async function perCall(c: pg.Client, expression: string, n = 200_000): Promise<number> {
    const run = (expr: string) => time(1, () => c.query(`SELECT count(${expr}) FROM generate_series(1, ${n}) g`));
    return ((await run(expression)) - (await run('g'))) / n;
  }

  const transaction = async (c: pg.ClientBase) => {
    await c.query('BEGIN');
    await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner, orgId]);
    await c.query('SELECT count(*) FROM crove_kernel.party');
    await c.query('COMMIT');
  };

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    setupPool = createPool({ connectionString: appUrl, max: 1 });
    const db = createDb(setupPool);
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    owner = await upsertIdentity(db, { issuer: 'test', subject: 'bench-owner', email: 'owner@bench.test', name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, 'Bench')).orgId;
    await withAdmin((a) =>
      a.query(`INSERT INTO crove_kernel.party (org_id, name) SELECT $1, 'party ' || g FROM generate_series(1, 50) g`, [orgId]),
    );
  });

  afterAll(async () => {
    await setupPool?.end();
    // Straight to stdout: vitest hides console output of passing tests.
    process.stdout.write(`\ncontext cost (#117), median of ${ROUNDS} rounds\n${report.join('\n')}\n\n`);
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('measures the session reset on release', async () => {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      const n = 300;
      const none = await time(n, () => transaction(c));
      const reset = await time(n, async () => {
        await c.query(SESSION_RESET_SQL);
        await transaction(c);
      });
      const discard = await time(n, async () => {
        await c.query('DISCARD ALL');
        await transaction(c);
      });
      const resetAlone = await time(n, () => c.query(SESSION_RESET_SQL));
      report.push(
        `one client, sequential: transaction (BEGIN, enter_context, RLS read, COMMIT) ${none.toFixed(0)} us`,
        `  + SESSION_RESET_SQL before it: ${reset.toFixed(0)} us (+${(reset - none).toFixed(0)} us); the reset alone ${resetAlone.toFixed(0)} us`,
        `  + DISCARD ALL before it:       ${discard.toFixed(0)} us (+${(discard - none).toFixed(0)} us)`,
      );
    } finally {
      await c.end();
    }

    // Through a pool, 8 callers sharing 4 connections: the reset runs after release, off the caller's path, but it
    // keeps the connection out of the pool for one more round trip.
    for (const [label, make] of [
      ['pg.Pool (no reset)', () => new pg.Pool({ connectionString: appUrl, max: 4 })],
      ['createPool (reset on release)', () => createPool({ connectionString: appUrl, max: 4 })],
    ] as const) {
      const pool = make();
      try {
        const total = 600;
        const rounds: number[] = [];
        for (let round = 0; round <= ROUNDS; round++) {
          let left = total;
          const start = process.hrtime.bigint();
          await Promise.all(
            Array.from({ length: 8 }, async () => {
              while (left-- > 0) {
                const client = await pool.connect();
                try {
                  await transaction(client);
                } finally {
                  client.release();
                }
              }
            }),
          );
          if (round > 0) rounds.push(total / (Number(process.hrtime.bigint() - start) / 1e9));
        }
        report.push(`pool max 4, 8 callers: ${label} ${median(rounds).toFixed(0)} transactions/s`);
      } finally {
        await pool.end();
      }
    }
  }, 600_000);

  it('measures a per-call membership re-check against the seal-only check', async () => {
    await withAdmin((a) =>
      a.query(`CREATE OR REPLACE FUNCTION crove_kernel.ctx_verified_recheck() RETURNS jsonb LANGUAGE plpgsql STABLE
               SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$${RECHECK_BODY}$f$;
               GRANT EXECUTE ON FUNCTION crove_kernel.ctx_verified_recheck() TO crove_tenant`),
    );
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner, orgId]);
      const { rows } = await c.query<{ a: unknown; b: unknown }>(
        'SELECT crove_kernel.ctx_verified() AS a, crove_kernel.ctx_verified_recheck() AS b',
      );
      expect(rows[0]?.b).toEqual(rows[0]?.a);
      const helper = await perCall(c, 'crove_kernel.ctx_org_id()');
      const seal = await perCall(c, `(crove_kernel.ctx_verified() ->> 'org')::uuid`);
      const recheck = await perCall(c, `(crove_kernel.ctx_verified_recheck() ->> 'org')::uuid`);
      const floor = await perCall(c, `current_setting('crove.ctx', true)`);
      await c.query('COMMIT');
      report.push(
        `per helper call, inside the database: ctx_org_id() today ${helper.toFixed(2)} us; ctx_verified() ${seal.toFixed(2)} us;`,
        `  with the membership re-check ${recheck.toFixed(2)} us (${(recheck / seal).toFixed(2)}x); reading the setting alone ${floor.toFixed(2)} us`,
      );

      // Per statement: RLS calls the helper once per statement (InitPlan), so the re-check adds one call to each.
      const n = 1000;
      const statement = async (fn: string) => {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [owner, orgId]);
        const us = await time(n, () => c.query(`SELECT count(*) FROM crove_kernel.party WHERE org_id = (SELECT (${fn}() ->> 'org')::uuid)`));
        await c.query('COMMIT');
        return us;
      };
      const rls = await statement('crove_kernel.ctx_verified');
      const rlsRecheck = await statement('crove_kernel.ctx_verified_recheck');
      report.push(
        `per RLS statement with a round trip (50 rows): ${rls.toFixed(0)} us today, ${rlsRecheck.toFixed(0)} us with the re-check (+${(rlsRecheck - rls).toFixed(0)} us)`,
      );
    } finally {
      await c.end();
    }
  }, 600_000);
});
