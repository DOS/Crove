// The request context on a hot standby (#105). Opt-in: needs CROVE_TEST_ADMIN_URL (superuser on the primary) and
// CROVE_TEST_STANDBY_URL (superuser on a streaming hot standby of that primary), so CI skips it. The run creates and
// drops its own database on the primary and waits for the standby to replay it.
//
// Pins what the plan says (§3.3, T10): advisory locks and pg_locks work during recovery, so enter_context, the
// re-entry guard and the sealed context behave as on the primary; a standby refuses writes, so commands fail there.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const STANDBY = process.env.CROVE_TEST_STANDBY_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const suite = ADMIN && STANDBY ? describe : describe.skip;

suite('request context on a hot standby (#105)', () => {
  const dbName = `crove_test_standby_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let standbyAppUrl = '';
  let owner = '';
  let orgId = '';
  const asOwner = () => ({ type: 'user' as const, userId: owner, aal: 'aal1' as const });

  const withDatabase = (url: string, database: string, login?: { user: string; password: string }) => {
    const u = new URL(url);
    u.pathname = `/${database}`;
    if (login) {
      u.username = login.user;
      u.password = login.password;
    }
    return u.toString();
  };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const adminUrl = withDatabase(ADMIN as string, dbName);
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const primaryPool = createPool({ connectionString: withDatabase(ADMIN as string, dbName, { user: 'crove_app', password: 'test-app-pw' }), max: 1 });
    try {
      const db = createDb(primaryPool);
      const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
      owner = await upsertIdentity(db, { issuer: 'test', subject: 'standby-owner', email: 'owner@standby.test', name: null });
      orgId = (await createOrg(runtime, asOwner(), 'Standby')).orgId;
    } finally {
      await primaryPool.end();
    }

    // Wait until the standby has replayed everything the primary wrote so far.
    const primary = new pg.Client({ connectionString: ADMIN });
    const standby = new pg.Client({ connectionString: STANDBY });
    await primary.connect();
    await standby.connect();
    try {
      const { rows } = await standby.query<{ recovery: boolean }>('SELECT pg_is_in_recovery() AS recovery');
      expect(rows[0]?.recovery, 'CROVE_TEST_STANDBY_URL must point at a hot standby').toBe(true);
      const lsn = (await primary.query<{ lsn: string }>('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0]?.lsn;
      const deadline = Date.now() + 30_000;
      for (;;) {
        const replayed = await standby.query<{ done: boolean }>('SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS done', [lsn]);
        if (replayed.rows[0]?.done) break;
        if (Date.now() > deadline) throw new Error('the standby did not replay the test database within 30 s');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await primary.end();
      await standby.end();
    }
    standbyAppUrl = withDatabase(STANDBY as string, dbName, { user: 'crove_app', password: 'test-app-pw' });
  }, 120_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('enters the sealed context and refuses a second entry, as on the primary', async () => {
    const c = new pg.Client({ connectionString: standbyAppUrl });
    await c.connect();
    try {
      for (const begin of ['BEGIN', 'BEGIN READ ONLY']) {
        await c.query(begin);
        try {
          const entered = await c.query<{ role: string }>('SELECT crove_kernel.enter_user_context($1::uuid, $2::text) AS role', [orgId, contextToken(owner, orgId)]);
          expect(entered.rows[0]?.role).toBe('owner');
          const { rows } = await c.query<{ org: string; locks: number }>(
            `SELECT crove_kernel.ctx_org_id()::text AS org,
                    (SELECT count(*)::int FROM pg_locks l WHERE l.locktype = 'advisory' AND l.classid = 1129467734::oid
                       AND l.objid = pg_backend_pid()::oid AND l.objsubid = 2 AND l.pid = pg_backend_pid()) AS locks`,
          );
          expect(rows[0]).toEqual({ org: orgId, locks: 1 });
          await c.query(`SELECT set_config('crove.ctx', '', true), set_config('crove.ctx_seal', '', true)`);
          await expect(c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner, orgId)])).rejects.toMatchObject({
            code: '42501',
            message: 'CONTEXT_REENTRY',
          });
        } finally {
          await c.query('ROLLBACK');
        }
      }
    } finally {
      await c.end();
    }
  });

  it('serves queries through the runtime and refuses commands, which write', async () => {
    const pool = createPool({ connectionString: standbyAppUrl, max: 1 });
    try {
      const runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
      // No session checks here (no session source, no sessionId): a first-seen session record would be a write.
      await expect(runtime.query('kernel.org.get', {}, { actor: asOwner(), orgId })).resolves.toMatchObject({ orgId });
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner, orgId)]);
        await expect(c.query(`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'x')`, [orgId])).rejects.toMatchObject({ code: '25006' });
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    } finally {
      await pool.end();
    }
  });
});
