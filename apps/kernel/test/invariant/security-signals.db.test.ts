// Invariant suite (Decision 7): who may read the detective security signals (issue #996, plan §7.8). Only the worker
// login role may execute crove_kernel.security_signals, a pinned definer that refuses any other session even with
// EXECUTE granted by mistake, and its memory table is reachable by definers only. Keep this directory self-contained:
// import package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FN = 'crove_kernel.security_signals(integer,integer,integer,integer)';
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];

const suite = ADMIN ? describe : describe.skip;

suite('security signals invariants on PostgreSQL (#996)', () => {
  const dbName = `crove_test_secsiginv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';

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
  });

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only the worker login role execute it, a pinned definer that refuses any other session', async () => {
    const { matrix, shape, table } = await withClient(adminUrl, async (c) => {
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
      const { rows: grants } = await c.query<{ rls: boolean; grantees: number }>(
        `SELECT c.relrowsecurity AS rls,
                (SELECT count(*)::int FROM unnest($1::text[]) r WHERE has_table_privilege(r, c.oid, 'SELECT') OR has_table_privilege(r, c.oid, 'INSERT')
                   OR has_table_privilege(r, c.oid, 'UPDATE') OR has_table_privilege(r, c.oid, 'DELETE')) AS grantees
         FROM pg_class c WHERE c.oid = 'crove_kernel.security_signal_seen'::regclass`,
        [ROLES],
      );
      return { matrix: rows, shape: defs, table: grants };
    });
    expect(matrix).toEqual([{ role: 'crove_worker' }]);
    expect(shape).toEqual([{ definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false }]);
    expect(table).toEqual([{ rls: true, grantees: 0 }]);

    await expect(withClient(appUrl, (c) => c.query('SELECT * FROM crove_kernel.security_signals(300, 20, 500, 3600)'))).rejects.toThrow(
      /permission denied for function security_signals/,
    );
    await expect(withClient(workerUrl, (c) => c.query('SELECT * FROM crove_kernel.security_signal_seen'))).rejects.toThrow(/permission denied for table security_signal_seen/);
    // The worker reads its signals.
    await expect(withClient(workerUrl, (c) => c.query('SELECT * FROM crove_kernel.security_signals(300, 20, 500, 3600)'))).resolves.toBeDefined();

    // The session_user check holds on its own: with EXECUTE granted to crove_app (rolled back), it is refused.
    await withClient(adminUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`GRANT EXECUTE ON FUNCTION ${FN} TO crove_app`);
        await c.query('SET SESSION AUTHORIZATION crove_app');
        await expect(c.query('SELECT * FROM crove_kernel.security_signals(300, 20, 500, 3600)')).rejects.toMatchObject({
          code: '42501',
          message: 'SECURITY_SIGNALS_WORKER_ONLY',
        });
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });
});
