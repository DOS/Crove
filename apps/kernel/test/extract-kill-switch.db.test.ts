// "Dừng AI" stops the AI reads of PDFs and photos (#886) on PostgreSQL 17: the extraction job's file query says so
// while a kill switch for the org or the finance module is engaged, and not for another module or once released. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('kill switches and AI extraction on PostgreSQL (#886)', () => {
  const dbName = `crove_test_extract_kill_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });
  const system = { type: 'system' as const, component: 'finance.extract' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    rt = register(db);
    // The extraction job runs in the worker, as the system.
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    worker = register(createDb(workerPool));
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

  it('says AI is stopped while a switch for the org or the finance module is engaged, and not otherwise', async () => {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@kill.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const fileId = randomUUID();
    const sha = 'a'.repeat(64);
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, 'hd.pdf', 'application/pdf', 10, 'upload')`,
        [orgId, fileId, sha, `org/${orgId}/${sha}`],
      ),
    );
    const stopped = async () => (await worker.query<{ aiStopped: boolean } | null>('finance.extraction.file', { fileId }, { actor: system, orgId }))?.aiStopped;
    const engage = (scope: string, target: string) =>
      rt.execute<{ killSwitchId: string }>('kernel.agent.kill_switch.engage', { scope, target, reason: 'thử' }, { actor: asUser(owner), orgId });
    const release = (id: string) => rt.execute('kernel.agent.kill_switch.release', { id }, { actor: asMfa(owner), orgId });

    expect(await stopped()).toBe(false);
    const org = await engage('org', '*');
    expect(await stopped()).toBe(true);
    await release(org.killSwitchId);
    expect(await stopped()).toBe(false);
    const finance = await engage('module', 'finance');
    expect(await stopped()).toBe(true);
    await release(finance.killSwitchId);
    expect(await stopped()).toBe(false);
    // A switch for one agent stops that agent's runs, not the org's document reading.
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'agent', $2, $3)`, [orgId, randomUUID(), owner]),
    );
    expect(await stopped()).toBe(false);

    // The operator's switch for every org (#886 part 2): only the database owner flips it, every runtime role reads it.
    const set = (engaged: boolean) => admin((c) => c.query(`SELECT crove_kernel.global_kill_switch_set('ai', $1, 'thử', 'ops')`, [engaged]));
    await set(true);
    expect(await stopped()).toBe(true);
    await set(false);
    expect(await stopped()).toBe(false);
    for (const [role, password] of [['crove_app', 'test-app-pw'], ['crove_worker', 'test-worker-pw']] as const) {
      const url = new URL(adminUrl);
      url.username = role;
      url.password = password;
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      try {
        expect((await c.query(`SELECT crove_kernel.global_kill_switch_on('ai') AS on`)).rows[0]).toEqual({ on: false });
        await expect(c.query(`SELECT crove_kernel.global_kill_switch_set('ai', true, 'x', 'y')`), role).rejects.toMatchObject({ code: '42501' });
        await expect(c.query('SELECT * FROM crove_kernel.global_kill_switch'), role).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.end();
      }
    }
    // The history is append-only, for the owner too.
    await expect(admin((c) => c.query(`UPDATE crove_kernel.global_kill_switch SET engaged = true`))).rejects.toThrow();
    const history = await admin(async (c) => (await c.query(`SELECT key, engaged, reason, changed_by FROM crove_kernel.global_kill_switch ORDER BY changed_at, id`)).rows);
    expect(history).toEqual([
      { key: 'ai', engaged: true, reason: 'thử', changed_by: 'ops' },
      { key: 'ai', engaged: false, reason: 'thử', changed_by: 'ops' },
    ]);
  });
});
