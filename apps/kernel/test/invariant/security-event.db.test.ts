// Invariant suite (Decision 7): refusals before membership is established are noted in crove_kernel.security_event
// (issue #1006, plan §4.4 step 3, gate row T4, red-team S24): per caller, sampled, kept 30 days, readable by no tenant
// or login role, written and pruned only by definers. Keep this directory self-contained: import package code under
// test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and
// drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { pruneSecurityEvents } from '../../src/worker.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const NOTE = 'crove_kernel.security_event_note(text,text,text,uuid)';
const PRUNE = 'crove_kernel.security_event_prune(integer,integer)';
const ROWS_PER_CALLER = 20;
const WINDOW_MS = 3600 * 1000;

const suite = ADMIN ? describe : describe.skip;

suite('security_event: refusals before membership on PostgreSQL (#1006)', () => {
  const dbName = `crove_test_secevent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let runtime: Runtime;
  let owner = '';
  let orgA = '';
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

  const events = (userId: string) =>
    withAdmin(async (a) => {
      const { rows } = await a.query<{ command: string; code: string; target_org: string | null; overflow: boolean; refusals: number }>(
        `SELECT command, code, target_org, overflow, refusals::int FROM crove_kernel.security_event
          WHERE caller = $1 ORDER BY overflow, command, code, target_org`,
        [`user:${userId}`],
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
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    workerDb = createDb(workerPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    owner = await user('owner');
    ({ orgId: orgA } = await createOrg(runtime, asUser(owner), `Org A ${randomUUID().slice(0, 8)}`));
  });

  // Windows are fixed hours: start each test at least 10 seconds before the next boundary, so its counts stay in one.
  beforeEach(async () => {
    const left = WINDOW_MS - (Date.now() % WINDOW_MS);
    if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 500));
  }, 15_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("notes an outsider's refused command and query against the org, never in the org's audit", async () => {
    const outsider = await user('outsider');
    const auditBefore = await withAdmin(async (a) => (await a.query(`SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1`, [orgA])).rows[0].n);
    for (let i = 0; i < 2; i++) {
      await expect(runtime.execute('kernel.org.set_contact_email', { email: null }, { actor: asUser(outsider), orgId: orgA })).rejects.toMatchObject({
        code: 'NOT_A_MEMBER',
      });
    }
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(outsider), orgId: orgA })).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });

    expect(await events(outsider)).toEqual([
      { command: 'kernel.org.get', code: 'NOT_A_MEMBER', target_org: orgA, overflow: false, refusals: 1 },
      { command: 'kernel.org.set_contact_email', code: 'NOT_A_MEMBER', target_org: orgA, overflow: false, refusals: 2 },
    ]);
    const auditAfter = await withAdmin(async (a) => (await a.query(`SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1`, [orgA])).rows[0].n);
    expect(auditAfter).toBe(auditBefore);
  });

  it('keeps a caller to a fixed number of rows per window, whatever org ids it makes up', async () => {
    const prober = await user('prober');
    const extra = 7;
    for (let i = 0; i < ROWS_PER_CALLER + extra; i++) {
      await expect(runtime.execute('kernel.org.set_contact_email', { email: null }, { actor: asUser(prober), orgId: randomUUID() })).rejects.toMatchObject({
        status: expect.any(Number),
      });
    }
    const rows = await events(prober);
    const targeted = rows.filter((r) => !r.overflow);
    const overflow = rows.filter((r) => r.overflow);
    expect(targeted).toHaveLength(ROWS_PER_CALLER);
    expect(targeted.every((r) => r.refusals === 1 && r.target_org !== null)).toBe(true);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatchObject({ command: 'kernel.org.set_contact_email', target_org: null, refusals: extra });
    // A target already noted in the window is still counted on its own row past the bound.
    const first = targeted[0]?.target_org as string;
    await expect(runtime.execute('kernel.org.set_contact_email', { email: null }, { actor: asUser(prober), orgId: first })).rejects.toBeTruthy();
    expect((await events(prober)).find((r) => r.target_org === first)?.refusals).toBe(2);
  });

  it('notes an org-less command refused before its org exists (T4: org creation past its rate limit)', async () => {
    const founder = await user('founder');
    for (let i = 0; i < 5; i++) await createOrg(runtime, asUser(founder), `Founder org ${i} ${randomUUID().slice(0, 8)}`);
    await expect(createOrg(runtime, asUser(founder), `One too many ${randomUUID().slice(0, 8)}`)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(await events(founder)).toEqual([{ command: 'kernel.org.create', code: 'RATE_LIMITED', target_org: null, overflow: false, refusals: 1 }]);
  });

  it('is machinery: no role reads it, the note refuses a tenant context, and only the worker prunes', async () => {
    for (const url of [appUrl, workerUrl]) {
      await withClient(url, async (c) => {
        await expect(c.query(`SELECT * FROM crove_kernel.security_event`)).rejects.toThrow(/permission denied/);
        await expect(c.query(`INSERT INTO crove_kernel.security_event (window_start, caller, command, code) VALUES (now(), 'user:${randomUUID()}', 'x', 'X')`)).rejects.toThrow(
          /permission denied/,
        );
      });
    }
    const acl = await withAdmin(async (a) => {
      const { rows } = await a.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f.fn, r.role, has_function_privilege(r.role, f.fn, 'EXECUTE') AS can
           FROM unnest($1::text[]) AS f(fn), unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) AS r(role)
          ORDER BY 1, 2`,
        [[NOTE, PRUNE]],
      );
      return rows.filter((r) => r.can).map((r) => `${r.fn} ${r.role}`);
    });
    expect(acl).toEqual([`${NOTE} crove_app`, `${NOTE} crove_worker`, `${PRUNE} crove_worker`]);
    const defs = await withAdmin(async (a) => {
      const { rows } = await a.query<{ definer: boolean; config: string[] }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p WHERE p.oid IN ($1::regprocedure, $2::regprocedure)`,
        [NOTE, PRUNE],
      );
      return rows;
    });
    expect(defs).toEqual([
      { definer: true, config: ['search_path=pg_catalog, pg_temp'] },
      { definer: true, config: ['search_path=pg_catalog, pg_temp'] },
    ]);

    await withClient(appUrl, async (c) => {
      await expect(c.query(`SELECT crove_kernel.security_event_note('user:not-a-uuid', 'x', 'X', NULL)`)).rejects.toMatchObject({ code: '22023' });
      await expect(c.query(`SELECT crove_kernel.security_event_note($1, 'x', 'lower', NULL)`, [`user:${randomUUID()}`])).rejects.toMatchObject({ code: '22023' });
      // A refusal after membership belongs to the org's audit, never here.
      await c.query('BEGIN');
      try {
        await c.query(`SELECT crove_kernel.enter_user_context($1::uuid, $2::text)`, [orgA, contextToken(owner, orgA)]);
        await expect(c.query(`SELECT crove_kernel.security_event_note($1, 'x', 'X', NULL)`, [`user:${owner}`])).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.query('ROLLBACK');
      }
      await expect(c.query(`SELECT crove_kernel.security_event_prune(30, 10)`)).rejects.toThrow(/permission denied/);
    });
  });

  it('prunes windows older than 30 days and keeps the rest', async () => {
    const old = `user:${randomUUID()}`;
    const recent = `user:${randomUUID()}`;
    await withAdmin((a) =>
      a.query(
        `INSERT INTO crove_kernel.security_event (window_start, caller, command, code) VALUES
           (now() - interval '31 days', $1, 'kernel.org.set_contact_email', 'NOT_A_MEMBER'),
           (now() - interval '29 days', $2, 'kernel.org.set_contact_email', 'NOT_A_MEMBER')`,
        [old, recent],
      ),
    );
    expect(await pruneSecurityEvents(workerDb)).toBeGreaterThanOrEqual(1);
    const left = await withAdmin(async (a) => (await a.query<{ caller: string }>(`SELECT caller FROM crove_kernel.security_event WHERE caller = ANY ($1)`, [[old, recent]])).rows);
    expect(left).toEqual([{ caller: recent }]);
    await withClient(workerUrl, async (c) => {
      for (const args of [[0, 10], [30, 0], [null, 10]]) {
        await expect(c.query(`SELECT crove_kernel.security_event_prune($1, $2)`, args)).rejects.toMatchObject({ code: '22023' });
      }
    });
  });
});
