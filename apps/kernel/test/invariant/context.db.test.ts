// Context re-entry guard (plan §4.5 item 1, External-tenant gate T10) on a real PostgreSQL 17: a transaction enters
// at most one context. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, toDomainError } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
// The context lock namespace in 20261015130000_crove_kernel_context_reentry_guard.sql ('CROV').
const NAMESPACE = 1129467734;
const REENTRY = { code: '42501', message: 'CONTEXT_REENTRY' };

const suite = ADMIN ? describe : describe.skip;

suite('context re-entry guard on PostgreSQL (§4.5 item 1, T10)', () => {
  const dbName = `crove_test_ctx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  const users = { owner: '', other: '', member: '' };
  let orgA = '';
  let orgB = '';
  const clients: pg.Client[] = [];

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  const enter = (c: pg.Client, userId: string, orgId: string) =>
    c.query<{ role: string }>('SELECT crove_kernel.enter_user_context($1::uuid, $2::text) AS role', [orgId, contextToken(userId, orgId)]);

  async function context(c: pg.Client) {
    const { rows } = await c.query<{ org: string | null; user: string | null; rawOrg: string | null; rawUser: string | null }>(
      `SELECT crove_kernel.ctx_org_id() AS org, crove_kernel.ctx_user_id() AS user,
              current_setting('crove.org_id', true) AS "rawOrg", current_setting('crove.user_id', true) AS "rawUser"`,
    );
    return rows[0];
  }

  // Context locks this backend holds, as the guard looks them up.
  async function contextLocks(c: pg.Client) {
    const { rows } = await c.query<{ mode: string }>(
      `SELECT l.mode FROM pg_locks l
       WHERE l.locktype = 'advisory' AND l.classid = $1::oid AND l.objid = pg_backend_pid()::oid AND l.objsubid = 2
         AND l.pid = pg_backend_pid() AND l.granted`,
      [NAMESPACE],
    );
    return rows.length;
  }

  // Runs fn in one transaction on c and always rolls back, so a raised error never leaks into the next case.
  async function inTx<T>(c: pg.Client, begin: 'BEGIN' | 'BEGIN READ ONLY', fn: () => Promise<T>): Promise<T> {
    await c.query(begin);
    try {
      return await fn();
    } finally {
      await c.query('ROLLBACK');
    }
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
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    // One connection, so every runtime transaction below reuses the same pooled backend.
    pool = createPool({ connectionString: appUrl, max: 1 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    users.owner = await upsertIdentity(db, { issuer: 'test', subject: 'ctx-owner', email: 'owner@ctx.test', name: null });
    users.other = await upsertIdentity(db, { issuer: 'test', subject: 'ctx-other', email: 'other@ctx.test', name: null });
    users.member = await upsertIdentity(db, { issuer: 'test', subject: 'ctx-member', email: 'member@ctx.test', name: null });
    orgA = (await createOrg(runtime, asUser(users.owner), 'Ctx A')).orgId;
    orgB = (await createOrg(runtime, asUser(users.other), 'Ctx B')).orgId;
    // owner belongs to both orgs; member belongs to org A only.
    const seed = new pg.Client({ connectionString: adminUrl });
    await seed.connect();
    await seed.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($3, $4, 'member')`, [
      orgB,
      users.owner,
      orgA,
      users.member,
    ]);
    await seed.end();
  });

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('refuses a second enter_context in a read-write transaction, same or different org and actor', async () => {
    const app = await connect(appUrl);
    for (const [userId, orgId] of [
      [users.owner, orgA],
      [users.owner, orgB],
      [users.member, orgA],
      [users.other, orgB],
    ] as const) {
      await inTx(app, 'BEGIN', async () => {
        await expect(enter(app, users.owner, orgA)).resolves.toMatchObject({ rows: [{ role: 'owner' }] });
        expect(await contextLocks(app)).toBe(1);
        await expect(enter(app, userId, orgId)).rejects.toMatchObject(REENTRY);
      });
    }
  });

  it('refuses a second enter_context inside BEGIN READ ONLY', async () => {
    const app = await connect(appUrl);
    for (const [userId, orgId] of [
      [users.owner, orgA],
      [users.owner, orgB],
      [users.member, orgA],
    ] as const) {
      await inTx(app, 'BEGIN READ ONLY', async () => {
        await enter(app, users.owner, orgA);
        await expect(enter(app, userId, orgId)).rejects.toMatchObject(REENTRY);
      });
    }
  });

  it('refuses re-entry across savepoints that keep the first entry', async () => {
    const app = await connect(appUrl);
    // enter_context, SAVEPOINT, enter_context.
    await inTx(app, 'BEGIN', async () => {
      await enter(app, users.owner, orgA);
      await app.query('SAVEPOINT s1');
      await expect(enter(app, users.owner, orgB)).rejects.toMatchObject(REENTRY);
    });
    // SAVEPOINT, enter_context, RELEASE SAVEPOINT, enter_context.
    await inTx(app, 'BEGIN', async () => {
      await app.query('SAVEPOINT s1');
      await enter(app, users.owner, orgA);
      await app.query('RELEASE SAVEPOINT s1');
      expect(await contextLocks(app)).toBe(1);
      await expect(enter(app, users.owner, orgB)).rejects.toMatchObject(REENTRY);
    });
  });

  it('still refuses after the caller tries to unlock the lock and reset the settings', async () => {
    const app = await connect(appUrl);
    await inTx(app, 'BEGIN', async () => {
      await enter(app, users.owner, orgA);
      // Neither call releases a transaction-level lock (both report it as not held at session level).
      await app.query('SELECT pg_advisory_unlock($1::int, pg_backend_pid())', [NAMESPACE]);
      await app.query('SELECT pg_advisory_unlock_all()');
      for (const name of ['crove.org_id', 'crove.user_id', 'crove.ctx', 'crove.ctx_seal']) {
        await app.query(`SELECT set_config($1, '', true)`, [name]);
      }
      expect(await context(app)).toMatchObject({ org: null, user: null });
      expect(await contextLocks(app)).toBe(1);
      await expect(enter(app, users.owner, orgB)).rejects.toMatchObject(REENTRY);
    });
  });

  it('starts clean after ROLLBACK TO SAVEPOINT undoes the first entry', async () => {
    const app = await connect(appUrl);
    await inTx(app, 'BEGIN', async () => {
      await app.query('SAVEPOINT s1');
      await enter(app, users.owner, orgA);
      expect(await context(app)).toMatchObject({ org: orgA, user: users.owner });
      await app.query('ROLLBACK TO SAVEPOINT s1');
      const reverted = await context(app);
      expect(reverted).toMatchObject({ org: null, user: null });
      expect(reverted?.rawOrg ?? '').toBe('');
      expect(reverted?.rawUser ?? '').toBe('');
      expect(await contextLocks(app)).toBe(0);
      await expect(enter(app, users.owner, orgB)).resolves.toMatchObject({ rows: [{ role: 'member' }] });
      expect(await context(app)).toMatchObject({ org: orgB, user: users.owner });
    });
  });

  it('refuses when a context setting is already present (defense in depth until the seal)', async () => {
    const app = await connect(appUrl);
    await inTx(app, 'BEGIN', async () => {
      await app.query(`SELECT set_config('crove.org_id', $1, true)`, [orgA]);
      await expect(enter(app, users.owner, orgA)).rejects.toMatchObject(REENTRY);
    });
  });

  it('fails closed when the key is already held at session level, by this session or another one', async () => {
    const app = await connect(appUrl);
    await app.query('SELECT pg_advisory_lock($1::int, pg_backend_pid())', [NAMESPACE]);
    try {
      await inTx(app, 'BEGIN', async () => {
        await expect(enter(app, users.owner, orgA)).rejects.toMatchObject(REENTRY);
      });
    } finally {
      await app.query('SELECT pg_advisory_unlock($1::int, pg_backend_pid())', [NAMESPACE]);
    }
    await inTx(app, 'BEGIN', async () => {
      await expect(enter(app, users.owner, orgA)).resolves.toMatchObject({ rows: [{ role: 'owner' }] });
    });

    // Another backend holding this backend's key makes the guard refuse at once instead of waiting for it.
    const squatter = await connect(appUrl);
    const { rows } = await app.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await squatter.query('SELECT pg_advisory_lock($1::int, $2::int)', [NAMESPACE, rows[0]?.pid]);
    try {
      await inTx(app, 'BEGIN', async () => {
        await app.query(`SET LOCAL statement_timeout = '5s'`);
        await expect(enter(app, users.owner, orgA)).rejects.toMatchObject(REENTRY);
      });
    } finally {
      await squatter.query('SELECT pg_advisory_unlock_all()');
    }
  });

  it('enters normally in the next transaction on the same connection, and never blocks other sessions', async () => {
    const app = await connect(appUrl);
    // After a committed entry, and after one that raised.
    await app.query('BEGIN');
    await enter(app, users.owner, orgA);
    await app.query('COMMIT');
    expect(await contextLocks(app)).toBe(0);
    expect(await context(app)).toMatchObject({ org: null, user: null });
    await inTx(app, 'BEGIN', async () => {
      await enter(app, users.owner, orgA);
      await expect(enter(app, users.owner, orgB)).rejects.toMatchObject(REENTRY);
    });
    await inTx(app, 'BEGIN READ ONLY', async () => {
      await expect(enter(app, users.owner, orgB)).resolves.toMatchObject({ rows: [{ role: 'member' }] });
    });

    // Two sessions hold a context at the same moment, in the same org, as the same user.
    const first = await connect(appUrl);
    const second = await connect(appUrl);
    await first.query('BEGIN');
    await second.query('BEGIN');
    try {
      await first.query(`SET LOCAL statement_timeout = '5s'`);
      await second.query(`SET LOCAL statement_timeout = '5s'`);
      await Promise.all([enter(first, users.owner, orgA), enter(second, users.owner, orgA)]);
      expect(await context(first)).toMatchObject({ org: orgA, user: users.owner });
      expect(await context(second)).toMatchObject({ org: orgA, user: users.owner });
      expect(await contextLocks(first)).toBe(1);
      expect(await contextLocks(second)).toBe(1);
    } finally {
      await first.query('ROLLBACK');
      await second.query('ROLLBACK');
    }

    // The runtime enters once per transaction: back-to-back queries on one pooled connection succeed.
    for (let i = 0; i < 3; i += 1) {
      await expect(runtime.query('kernel.org.get', {}, { actor: asUser(users.owner), orgId: i % 2 ? orgB : orgA })).resolves.toBeDefined();
    }
  });

  it('guards enter_system_context the same way', async () => {
    const worker = await connect(workerUrl);
    for (const begin of ['BEGIN', 'BEGIN READ ONLY'] as const) {
      await inTx(worker, begin, async () => {
        await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA]);
        await expect(worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA])).rejects.toMatchObject(REENTRY);
      });
      await inTx(worker, begin, async () => {
        await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA]);
        await expect(worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgB])).rejects.toMatchObject(REENTRY);
      });
    }
    await inTx(worker, 'BEGIN', async () => {
      await worker.query('SAVEPOINT s1');
      await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA]);
      await worker.query('ROLLBACK TO SAVEPOINT s1');
      expect(await context(worker)).toMatchObject({ org: null, user: null });
      await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgB]);
      expect(await context(worker)).toMatchObject({ org: orgB, user: null });
    });
  });

  it('keeps the guard private and pinned, and maps a re-entry to an internal error', async () => {
    const admin = await connect(adminUrl);
    const { rows } = await admin.query<{ fn: string; config: string[]; app: boolean; worker: boolean; tenant: boolean }>(
      `SELECT p.oid::regprocedure::text AS fn, p.proconfig AS config,
              has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker,
              has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant
       FROM pg_proc p
       WHERE p.oid IN ('crove_kernel.context_reentry_guard()'::regprocedure, 'crove_kernel.enter_context(uuid,uuid)'::regprocedure,
                       'crove_kernel.enter_system_context(uuid)'::regprocedure)
       ORDER BY 1`,
    );
    expect(rows).toEqual([
      { fn: 'crove_kernel.context_reentry_guard()', config: ['search_path=pg_catalog, pg_temp'], app: false, worker: false, tenant: false },
      // #1822: crove_app enters a user's context through enter_user_context; step 2 revokes enter_context from it, so
      // either holds until then. Nobody else may call it, before or after.
      { fn: 'crove_kernel.enter_context(uuid,uuid)', config: ['search_path=pg_catalog, pg_temp'], app: expect.any(Boolean), worker: false, tenant: false },
      { fn: 'crove_kernel.enter_system_context(uuid)', config: ['search_path=pg_catalog, pg_temp'], app: false, worker: true, tenant: false },
    ]);
    const app = await connect(appUrl);
    await expect(app.query('SELECT crove_kernel.context_reentry_guard()')).rejects.toThrow(/permission denied/);

    // A re-entry is a bug in the caller: it surfaces as INTERNAL (logged), never as a 403 the user could act on.
    const error = await inTx(app, 'BEGIN', async () => {
      await enter(app, users.owner, orgA);
      return enter(app, users.owner, orgA).catch((e: unknown) => e);
    });
    expect(toDomainError(error)).toMatchObject({ code: 'INTERNAL', status: 500 });
  });
});
