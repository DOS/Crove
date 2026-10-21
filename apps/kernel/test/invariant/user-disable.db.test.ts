// Invariant suite (Decision 7): who may block a user account (issue #985, ADR-0028 section 2). Only the worker login
// role may execute crove_kernel.user_set_disabled, the definer behind the operator's user-disable and user-enable
// roles: no tenant, API, prober or reporter role, and the function refuses any other session even when EXECUTE is
// granted by mistake. A disabled account is refused on its next org-less call. Keep this directory self-contained:
// import package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, resolveIdentity, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FN = 'crove_kernel.user_set_disabled(text,boolean)';
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];

const suite = ADMIN ? describe : describe.skip;

suite('user disable invariants on PostgreSQL (#985)', () => {
  const dbName = `crove_test_userdisinv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

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
    pool = createPool({ connectionString: appUrl, max: 2 });
    db = createDb(pool);
    runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only the worker login role execute it, a pinned definer that refuses any other session', async () => {
    const { matrix, shape } = await withClient(adminUrl, async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT r AS role FROM unnest($1::text[]) r WHERE has_function_privilege(r, $2::regprocedure, 'EXECUTE') ORDER BY 1`,
        [ROLES, FN],
      );
      const { rows: defs } = await c.query<{ definer: boolean; config: string[]; public: boolean }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      return { matrix: rows, shape: defs };
    });
    expect(matrix).toEqual([{ role: 'crove_worker' }]);
    expect(shape).toEqual([{ definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false }]);

    await expect(withClient(appUrl, (c) => c.query('SELECT * FROM crove_kernel.user_set_disabled($1, true)', [randomUUID()]))).rejects.toThrow(
      /permission denied for function user_set_disabled/,
    );

    // The session_user check holds on its own: with EXECUTE granted to crove_app (rolled back), it is refused.
    await withClient(adminUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`GRANT EXECUTE ON FUNCTION ${FN} TO crove_app`);
        await c.query('SET SESSION AUTHORIZATION crove_app');
        await expect(c.query('SELECT * FROM crove_kernel.user_set_disabled($1, true)', [randomUUID()])).rejects.toMatchObject({
          code: '42501',
          message: 'USER_STATUS_WORKER_ONLY',
        });
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it('refuses a disabled account when it next signs in or calls the API, and lets it back once enabled', async () => {
    // Every request resolves the token's identity (crove_kernel.identity_resolve) before anything else.
    const email = `blocked-${randomUUID().slice(0, 8)}@disable.test`;
    const identity = { issuer: 'test', subject: randomUUID(), email, name: null };
    const userId = await upsertIdentity(db, identity);
    await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Before');
    const set = (disabled: boolean) =>
      withClient(workerUrl, async (c) => (await c.query<{ outcome: string; changed: boolean }>('SELECT outcome, changed FROM crove_kernel.user_set_disabled($1, $2)', [email, disabled])).rows[0]);

    expect(await set(true)).toEqual({ outcome: 'ok', changed: true });
    const request = () => resolveIdentity(db, { ...identity, sessionId: randomUUID(), upstream: false });
    await expect(request()).rejects.toMatchObject({ code: '42501', message: 'USER_DISABLED' });
    expect(await set(false)).toEqual({ outcome: 'ok', changed: true });
    await expect(request()).resolves.toBe(userId);
  });
});
