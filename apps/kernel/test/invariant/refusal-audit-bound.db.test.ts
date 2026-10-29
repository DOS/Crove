// Invariant suite (Decision 7): the bound on denied/failed audit rows (issue #162, plan §4.10). A refusal is counted
// in crove_kernel.refusal_tally; past the per-actor or per-org bound of a window it gets no audit row of its own,
// except the first refusal of each (command, code) of an actor in the window, which is always audited. The tally is
// definer-only machinery written from the sealed context, and a failing count never suppresses the audit row. Keep
// this directory self-contained: import package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, isSecurityRefusal, type RefusalAuditLimits } from '@crove/kernel-runtime';
import { pruneRefusalTally } from '../../src/worker.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const NOTE = 'crove_kernel.refusal_tally_note(text,text,boolean,integer,integer,integer,integer)';
const PRUNE = 'crove_kernel.refusal_tally_prune(integer,integer)';

// Refuses with the code it is given: 409 and 404 are audited as failed, 403 as denied.
const refuse = defineCommand({
  sideEffect: 'none',
  name: 'test.refuse',
  risk: 'R1',
  access: ['owner', 'admin', 'member'],
  input: z.object({ code: z.string().min(1).max(40), status: z.union([z.literal(403), z.literal(404), z.literal(409)]).default(409) }),
  handler: async (_ctx, input) => {
    throw new DomainError(input.code, input.status, 'refused');
  },
});
const refuseOther = defineCommand({ ...refuse, name: 'test.refuse_other' });

const suite = ADMIN ? describe : describe.skip;

suite('refusal audit bound on PostgreSQL (#162)', () => {
  const dbName = `crove_test_refusal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  // No reserve here, so the per-actor and per-org bounds show on their own; the reserve has its own test.
  const LIMITS: RefusalAuditLimits = { perActor: 3, perOrg: 5, windowSeconds: 3600, reserve: 0 };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const withAdmin = <T>(fn: (admin: pg.Client) => Promise<T>) => withClient(adminUrl, fn);

  async function user(label: string): Promise<string> {
    const tag = `${label}-${randomUUID().slice(0, 8)}`;
    return upsertIdentity(db, { issuer: 'test', subject: tag, email: `${tag}@example.com`, name: null });
  }

  async function newOrg(label: string): Promise<{ owner: string; orgId: string }> {
    const owner = await user(label);
    const { orgId } = await createOrg(runtime, asUser(owner), `Org ${label} ${randomUUID().slice(0, 8)}`);
    return { owner, orgId };
  }

  async function addMember(orgId: string, label: string): Promise<string> {
    const member = await user(label);
    await withAdmin((a) => a.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, member]));
    return member;
  }

  async function refused(target: Runtime, orgId: string, userId: string, code: string, command = 'test.refuse', status = 409) {
    await expect(target.execute(command, { code, status }, { actor: asUser(userId), orgId })).rejects.toMatchObject({ code, status });
  }

  const audits = (orgId: string, userId?: string) =>
    withAdmin(async (a) => {
      const { rows } = await a.query<{ command: string; code: string; outcome: string }>(
        `SELECT command, detail ->> 'code' AS code, outcome FROM crove_kernel.audit_event
          WHERE org_id = $1 AND outcome <> 'ok' AND ($2::uuid IS NULL OR actor_id = $2::uuid) ORDER BY occurred_at, id`,
        [orgId, userId ?? null],
      );
      return rows;
    });

  const tally = (orgId: string) =>
    withAdmin(async (a) => {
      const { rows } = await a.query<{ actor_key: string; command: string; code: string; refusals: number; audited: number }>(
        `SELECT actor_key, command, code, refusals::int, audited::int FROM crove_kernel.refusal_tally
          WHERE org_id = $1 ORDER BY actor_key, command, code`,
        [orgId],
      );
      return rows;
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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 8 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS, refusalAudit: LIMITS }).register({
      commands: [...kernelCommands, refuse, refuseOther],
      queries: kernelQueries({ inboundDomain: 'in.test' }),
    });
  });

  // Windows are fixed, so a test that straddled a window boundary would split its counts: start each test at least
  // 10 seconds before the next boundary.
  beforeEach(async () => {
    const left = LIMITS.windowSeconds * 1000 - (Date.now() % (LIMITS.windowSeconds * 1000));
    if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 500));
  }, 15_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('audits an actor until the per-actor bound, then only counts, keeping the first of each (command, code)', async () => {
    const org = await newOrg('actor');
    for (let i = 0; i < 6; i++) await refused(runtime, org.orgId, org.owner, 'NOPE');
    // Past the bound: a new code, and the same code on another command, still get their first row.
    await refused(runtime, org.orgId, org.owner, 'OTHER');
    await refused(runtime, org.orgId, org.owner, 'OTHER');
    await refused(runtime, org.orgId, org.owner, 'NOPE', 'test.refuse_other', 403);
    await refused(runtime, org.orgId, org.owner, 'NOPE', 'test.refuse_other', 403);

    expect(await audits(org.orgId)).toEqual([
      { command: 'test.refuse', code: 'NOPE', outcome: 'failed' },
      { command: 'test.refuse', code: 'NOPE', outcome: 'failed' },
      { command: 'test.refuse', code: 'NOPE', outcome: 'failed' },
      { command: 'test.refuse', code: 'OTHER', outcome: 'failed' },
      { command: 'test.refuse_other', code: 'NOPE', outcome: 'denied' },
    ]);
    const key = `user:${org.owner}`;
    expect(await tally(org.orgId)).toEqual([
      { actor_key: key, command: 'test.refuse', code: 'NOPE', refusals: 6, audited: 3 },
      { actor_key: key, command: 'test.refuse', code: 'OTHER', refusals: 2, audited: 1 },
      { actor_key: key, command: 'test.refuse_other', code: 'NOPE', refusals: 2, audited: 1 },
    ]);
  });

  it('bounds the org across its actors, still auditing each actor first refusal of a kind', async () => {
    const org = await newOrg('org');
    const first = await addMember(org.orgId, 'first');
    const second = await addMember(org.orgId, 'second');
    // 3 audited for the first member (its own bound), 2 more counted: the org has 5 refusals, its bound.
    for (let i = 0; i < 5; i++) await refused(runtime, org.orgId, first, 'NOPE');
    await refused(runtime, org.orgId, second, 'NOPE');
    await refused(runtime, org.orgId, second, 'NOPE');
    expect((await audits(org.orgId, first)).length).toBe(3);
    // The second member is under its own bound, but the org is past its bound: only the first of the kind.
    expect((await audits(org.orgId, second)).length).toBe(1);
    expect(await tally(org.orgId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor_key: `user:${first}`, refusals: 5, audited: 3 }),
        expect.objectContaining({ actor_key: `user:${second}`, refusals: 2, audited: 1 }),
      ]),
    );
  });

  it('keeps orgs apart, and starts over in the next window', async () => {
    const busy = await newOrg('busy');
    const quiet = await newOrg('quiet');
    for (let i = 0; i < 5; i++) await refused(runtime, busy.orgId, busy.owner, 'NOPE');
    await refused(runtime, quiet.orgId, quiet.owner, 'NOPE');
    await refused(runtime, quiet.orgId, quiet.owner, 'NOPE');
    expect((await audits(busy.orgId)).length).toBe(3);
    expect((await audits(quiet.orgId)).length).toBe(2);

    // Move the busy org's counts into the previous window.
    await withAdmin((a) => a.query(`UPDATE crove_kernel.refusal_tally SET window_start = window_start - interval '1 hour' WHERE org_id = $1`, [busy.orgId]));
    await refused(runtime, busy.orgId, busy.owner, 'NOPE');
    await refused(runtime, busy.orgId, busy.owner, 'NOPE');
    expect((await audits(busy.orgId)).length).toBe(5);
  });

  it('keeps a reserve per actor that another member filling the org bound cannot take', async () => {
    const reserved = new Runtime(db, { manifests: TEST_MANIFESTS, refusalAudit: { perActor: 5, perOrg: 5, windowSeconds: 3600, reserve: 2 } }).register({
      commands: [...kernelCommands, refuse],
    });
    const org = await newOrg('reserve');
    const flooder = await addMember(org.orgId, 'flooder');
    const other = await addMember(org.orgId, 'other');
    // The flooder spends the whole org bound (5 audited, then counted only).
    for (let i = 0; i < 7; i++) await refused(reserved, org.orgId, flooder, 'NOPE');
    expect((await audits(org.orgId, flooder)).length).toBe(5);
    // The other member's first two refusals of the same kind still get their rows; the third is only counted.
    for (let i = 0; i < 3; i++) await refused(reserved, org.orgId, other, 'NOPE');
    expect((await audits(org.orgId, other)).length).toBe(2);
    expect(await tally(org.orgId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ actor_key: `user:${other}`, refusals: 3, audited: 2 })]),
    );
  });

  it('audits security-relevant refusals up to the actor limit even past the org bound', async () => {
    expect(isSecurityRefusal(new DomainError('FORBIDDEN', 403, 'x'))).toBe(true);
    expect(isSecurityRefusal(new DomainError('STEP_UP_REQUIRED', 403, 'x'))).toBe(true);
    expect(isSecurityRefusal(new DomainError('ANY_NOT_FOUND', 404, 'x'))).toBe(true);
    expect(isSecurityRefusal(new DomainError('CONFLICT', 409, 'x'))).toBe(false);
    const org = await newOrg('security');
    const flooder = await addMember(org.orgId, 'flooder');
    const prober = await addMember(org.orgId, 'prober');
    for (let i = 0; i < 5; i++) await refused(runtime, org.orgId, flooder, 'NOPE');
    // The org bound (5) is spent. FORBIDDEN still gets rows up to the prober's own limit (3), and so does a 404.
    for (let i = 0; i < 4; i++) await refused(runtime, org.orgId, prober, 'FORBIDDEN', 'test.refuse', 403);
    expect((await audits(org.orgId, prober)).length).toBe(3);
    const lone = await newOrg('security-404');
    const member = await addMember(lone.orgId, 'member');
    for (let i = 0; i < 5; i++) await refused(runtime, lone.orgId, lone.owner, 'NOPE');
    for (let i = 0; i < 4; i++) await refused(runtime, lone.orgId, member, 'THING_NOT_FOUND', 'test.refuse', 404);
    expect((await audits(lone.orgId, member)).length).toBe(3);
    // An ordinary code from the same member past the org bound: only its first.
    for (let i = 0; i < 2; i++) await refused(runtime, lone.orgId, member, 'NOPE');
    expect((await audits(lone.orgId, member)).length).toBe(4);
  });

  it('prunes tally windows older than the retention, from the worker only', async () => {
    const org = await newOrg('prune');
    const key = `user:${org.owner}`;
    await withAdmin((a) =>
      a.query(
        `INSERT INTO crove_kernel.refusal_tally (org_id, window_start, actor_key, command, code)
         VALUES ($1, now() - interval '10 days', $2, 'old', 'A'), ($1, now() - interval '8 days', $2, 'old', 'B'),
                ($1, now() - interval '6 days', $2, 'recent', 'C'), ($1, now(), $2, 'recent', 'D')`,
        [org.orgId, key],
      ),
    );
    const workerPool = createPool({ connectionString: workerUrl, max: 1 });
    try {
      expect(await pruneRefusalTally(createDb(workerPool), 7)).toBeGreaterThanOrEqual(2);
    } finally {
      await workerPool.end();
    }
    expect((await tally(org.orgId)).map((r) => r.command).sort()).toEqual(['recent', 'recent']);
    await withClient(appUrl, async (app) => {
      await expect(app.query(`SELECT crove_kernel.refusal_tally_prune(7, 10)`)).rejects.toThrow(/permission denied/);
    });
    await withClient(workerUrl, async (worker) => {
      for (const args of [[0, 10], [3651, 10], [7, 0], [7, 100_001], [null, 10]]) {
        await expect(worker.query(`SELECT crove_kernel.refusal_tally_prune($1, $2)`, args)).rejects.toMatchObject({ code: '22023' });
      }
    });
  });

  it('writes a row for every refusal when unbounded', async () => {
    const unbounded = new Runtime(db, { manifests: TEST_MANIFESTS, refusalAudit: 'unbounded' }).register({ commands: [...kernelCommands, refuse] });
    const org = await newOrg('unbounded');
    for (let i = 0; i < 6; i++) await refused(unbounded, org.orgId, org.owner, 'NOPE');
    expect((await audits(org.orgId)).length).toBe(6);
    expect(await tally(org.orgId)).toEqual([]);
  });

  it('holds the tally as definer-only machinery, executable by the API and worker login roles only', async () => {
    await withAdmin(async (a) => {
      const { rows: privileges } = await a.query<{ role: string; op: string }>(
        `SELECT r AS role, p AS op FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader']) r,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
          WHERE has_table_privilege(r, 'crove_kernel.refusal_tally', p)`,
      );
      expect(privileges).toEqual([]);
      const { rows: table } = await a.query<{ rls: boolean; policies: number }>(
        `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c WHERE c.oid = 'crove_kernel.refusal_tally'::regclass`,
      );
      expect(table).toEqual([{ rls: true, policies: 0 }]);
      const { rows: fn } = await a.query<{ fn: string; definer: boolean; config: string[]; public: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, p.proconfig AS config,
                EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public
           FROM pg_proc p WHERE p.oid IN ('${NOTE}'::regprocedure, '${PRUNE}'::regprocedure) ORDER BY 1`,
      );
      expect(fn).toEqual([
        { fn: NOTE, definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false },
        { fn: PRUNE, definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false },
      ]);
      const roles = `ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter']`;
      const { rows: execute } = await a.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest(${roles}) r, unnest(ARRAY['${NOTE}', '${PRUNE}']) f
          WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
      );
      expect(execute).toEqual([
        { fn: NOTE, role: 'crove_app' },
        { fn: NOTE, role: 'crove_worker' },
        { fn: PRUNE, role: 'crove_worker' },
      ]);
    });
  });

  it('takes the org and the actor from the sealed context only, and refuses bad arguments', async () => {
    const org = await newOrg('context');
    await withClient(appUrl, async (app) => {
      // No context: nothing to count against.
      await expect(app.query(`SELECT crove_kernel.refusal_tally_note('x', 'Y', false, 3, 5, 0, 3600)`)).rejects.toMatchObject({ code: '42501', message: 'NO_CONTEXT' });
      await app.query('BEGIN');
      try {
        await app.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [org.owner, org.orgId]);
        for (const args of [
          [null, 'Y', false, 3, 5, 0, 3600],
          ['', 'Y', false, 3, 5, 0, 3600],
          ['x', 'Y'.repeat(101), false, 3, 5, 0, 3600],
          ['x', 'Y', null, 3, 5, 0, 3600],
          ['x', 'Y', false, 0, 5, 0, 3600],
          ['x', 'Y', false, 3, 1_000_000, 0, 3600],
          ['x', 'Y', false, 3, 5, -1, 3600],
          ['x', 'Y', false, 3, 5, 4, 3600],
          ['x', 'Y', false, 3, 5, 0, 59],
          ['x', 'Y', false, 3, 5, 0, 86_401],
        ]) {
          await app.query('SAVEPOINT s');
          await expect(app.query(`SELECT crove_kernel.refusal_tally_note($1, $2, $3, $4, $5, $6, $7)`, args)).rejects.toMatchObject({ code: '22023' });
          await app.query('ROLLBACK TO SAVEPOINT s');
        }
        const { rows } = await app.query<{ audit: boolean }>(`SELECT crove_kernel.refusal_tally_note('x', 'Y', false, 3, 5, 0, 3600) AS audit`);
        expect(rows).toEqual([{ audit: true }]);
        // The caller cannot read the tally it just wrote.
        await expect(app.query('SELECT count(*) FROM crove_kernel.refusal_tally')).rejects.toThrow(/permission denied/);
      } finally {
        await app.query('ROLLBACK');
      }
    });
    // A system actor counts as one key per org.
    await withClient(workerUrl, async (worker) => {
      await worker.query('BEGIN');
      await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [org.orgId]);
      await worker.query(`SELECT crove_kernel.refusal_tally_note('x', 'Y', false, 3, 5, 0, 3600)`);
      await worker.query('COMMIT');
    });
    expect(await tally(org.orgId)).toEqual([{ actor_key: 'system', command: 'x', code: 'Y', refusals: 1, audited: 1 }]);
  });

  it('still writes the audit row when the count fails, and says so in the log', async () => {
    const org = await newOrg('fallback');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls: unknown[][] = [];
    await withAdmin((a) => a.query(`REVOKE EXECUTE ON FUNCTION ${NOTE} FROM crove_app`));
    try {
      for (let i = 0; i < 5; i++) await refused(runtime, org.orgId, org.owner, 'NOPE');
    } finally {
      await withAdmin((a) => a.query(`GRANT EXECUTE ON FUNCTION ${NOTE} TO crove_app`));
      calls = [...errors.mock.calls];
      errors.mockRestore();
    }
    expect((await audits(org.orgId)).length).toBe(5);
    expect(await tally(org.orgId)).toEqual([]);
    const lines = calls.filter(([line]) => line === '[execute test.refuse] REFUSAL_TALLY_FAILED');
    expect(lines.length).toBe(5);
    expect(lines[0]?.[1]).toEqual({ orgId: org.orgId, actorType: 'user', actorId: org.owner, refusal: 'NOPE', sqlState: '42501' });
  });
});
