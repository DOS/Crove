// Invariant suite (Decision 7): who may purge and close an org (issue #1024). Only the worker login role may execute
// crove_kernel.org_purge_check and crove_kernel.org_purge, the definers behind the operator's org-purge role; nobody
// executes org_purge_refusal or the close trigger's function. The definers refuse any other session even when EXECUTE
// is granted by mistake, and the purge runs only in the org's sealed system context. No login role closes an org by
// itself: an UPDATE of the status to closed is refused to the API and to the worker (outside the purge definer), and
// even the purge definer's close does not commit without the kernel.org.purge audit row. The checked path closes an
// eligible org and refuses one whose export is too young. Keep this directory self-contained: import code under test,
// never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops
// its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { orgPurgeCommand, purgeOrg } from '../../src/org-purge.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const WORKER_ONLY = ['crove_kernel.org_purge_check(text)', 'crove_kernel.org_purge(integer)'];
const NOBODY = ['crove_kernel.org_purge_refusal(uuid,integer)', 'crove_kernel.tenant_close_requires_purge()'];
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];
const DAY = 24 * 60 * 60 * 1000;

const noBlobs: BlobStore = {
  put: async () => {
    throw new Error('not used');
  },
  get: async () => {
    throw new Error('not used');
  },
  delete: async () => {},
};

const suite = ADMIN ? describe : describe.skip;

suite('org purge invariants on PostgreSQL (#1024)', () => {
  const dbName = `crove_test_orgpurgeinv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let worker: Runtime;

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const status = (orgId: string) =>
    withClient(adminUrl, async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.status);

  // An org in offboarding with an export of the current format recorded `exportedDaysAgo` days ago, set up as staff.
  async function offboarded(exportedDaysAgo: number) {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'test', subject: `owner-${tag}`, email: `owner-${tag}@purge.test`, name: null });
    const org = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, `Công ty ${tag}`);
    await withClient(adminUrl, async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [org.orgId]);
      await c.query('COMMIT');
      for (const [command, actorType, actorId, daysAgo, detail] of [
        ['kernel.org.offboard', 'user', owner, exportedDaysAgo + 5, {}],
        ['kernel.org.export.record', 'system', null, exportedDaysAgo, { format: 'crove.org-export.v2' }],
      ] as const) {
        await c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
           VALUES ($1, $2, $3, $4, $5, $6, 'ok', $7, $8)`,
          [org.orgId, new Date(Date.now() - daysAgo * DAY), actorType, actorId, command, randomUUID(), '0'.repeat(64), JSON.stringify(detail)],
        );
      }
    });
    return { orgId: org.orgId, owner };
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
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    const registry = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry).register({ commands: [orgPurgeCommand({ store: noBlobs })] });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only the worker login role execute the purge definers, pinned definers that refuse any other session', async () => {
    const { matrix, shape } = await withClient(adminUrl, async (c) => {
      const { rows } = await c.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f, unnest($2::text[]) r
         WHERE has_function_privilege(r, f::regprocedure, 'EXECUTE') ORDER BY 1, 2`,
        [[...WORKER_ONLY, ...NOBODY], ROLES],
      );
      const { rows: defs } = await c.query<{ definer: boolean; config: string[]; public: boolean }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
         FROM unnest($1::text[]) f JOIN pg_proc p ON p.oid = f::regprocedure`,
        [[...WORKER_ONLY, ...NOBODY]],
      );
      return { matrix: rows, shape: defs };
    });
    expect(matrix.map((r) => `${r.fn} ${r.role}`).sort()).toEqual(WORKER_ONLY.map((fn) => `${fn} crove_worker`).sort());
    expect(shape).toEqual([...WORKER_ONLY, ...NOBODY].map(() => ({ definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false })));

    await expect(withClient(appUrl, (c) => c.query('SELECT * FROM crove_kernel.org_purge(30)'))).rejects.toThrow(/permission denied for function org_purge/);
    await expect(withClient(appUrl, (c) => c.query(`SELECT * FROM crove_kernel.org_purge_check('x')`))).rejects.toThrow(/permission denied for function org_purge_check/);

    // The session_user check holds on its own: with EXECUTE granted to crove_app (rolled back), both are refused.
    await withClient(adminUrl, async (c) => {
      for (const [fn, call] of [
        ['crove_kernel.org_purge(integer)', 'SELECT * FROM crove_kernel.org_purge(30)'],
        ['crove_kernel.org_purge_check(text)', `SELECT * FROM crove_kernel.org_purge_check('x')`],
      ] as const) {
        await c.query('BEGIN');
        try {
          await c.query(`GRANT EXECUTE ON FUNCTION ${fn} TO crove_app`);
          await c.query('SET SESSION AUTHORIZATION crove_app');
          await expect(c.query(call)).rejects.toMatchObject({ code: '42501', message: 'ORG_PURGE_WORKER_ONLY' });
        } finally {
          await c.query('ROLLBACK');
        }
      }
    });
  });

  it('lets no login role close an org by itself, not even the purge definer without its audit row', async () => {
    const org = await offboarded(31);

    // The API login role, in the owner's context.
    await expect(
      withClient(appUrl, async (c) => {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org.orgId, contextToken(org.owner, org.orgId)]);
        await c.query(`UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`, [org.orgId]);
        await c.query('COMMIT');
      }),
    ).rejects.toThrow(/TENANT_STATUS_TRANSITION/);

    await withClient(workerUrl, async (c) => {
      // The worker in the org's system context, but outside the definer: a plain UPDATE is refused.
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_system_context($1)', [org.orgId]);
        await expect(c.query(`UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`, [org.orgId])).rejects.toThrow(/TENANT_STATUS_TRANSITION/);
      } finally {
        await c.query('ROLLBACK');
      }
      // The definer outside a system context.
      await expect(c.query('SELECT * FROM crove_kernel.org_purge(30)')).rejects.toMatchObject({ code: '42501', message: 'ORG_PURGE_SYSTEM_CONTEXT' });
      // The definer in the system context, but without the command's audit row: refused at commit.
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_system_context($1)', [org.orgId]);
      const { rows } = await c.query<{ outcome: string }>('SELECT outcome FROM crove_kernel.org_purge(30)');
      expect(rows).toEqual([{ outcome: 'ok' }]);
      await expect(c.query('COMMIT')).rejects.toThrow(/ORG_CLOSE_UNAUDITED/);
    });
    expect(await status(org.orgId)).toBe('offboarding');
  });

  it('closes an org only through the checked path, and refuses one whose export is too young', async () => {
    const young = await offboarded(29);
    await expect(purgeOrg(worker, 30, { ref: young.orgId, reason: 'test' })).resolves.toEqual({ kind: 'refused', orgId: young.orgId, refusal: 'too_early' });
    // Fewer days than the floor: the command's input refuses them, and the database on its own.
    await expect(worker.execute('kernel.org.purge', { minDays: 1, reason: 'test' }, { actor: { type: 'system', component: 'operator' }, orgId: young.orgId })).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      withClient(workerUrl, async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_system_context($1)', [young.orgId]);
          return (await c.query<{ outcome: string }>('SELECT outcome FROM crove_kernel.org_purge(1)')).rows;
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).resolves.toEqual([{ outcome: 'invalid' }]);
    expect(await status(young.orgId)).toBe('offboarding');

    const due = await offboarded(31);
    await expect(purgeOrg(worker, 30, { ref: due.orgId, reason: 'test' })).resolves.toMatchObject({ kind: 'purged', orgId: due.orgId });
    expect(await status(due.orgId)).toBe('closed');
    // A closed org is refused to everyone afterwards, the worker's system context included.
    await expect(
      withClient(workerUrl, async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_system_context($1)', [due.orgId]);
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).rejects.toThrow(/TENANT_NOT_ACTIVE/);
  });
});
