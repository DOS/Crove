// A kill switch per relay type (#1696, plan §4.12) on PostgreSQL 17: while the operator's 'relay:<event type>' switch
// is engaged, the relay's claim (crove_kernel.outbox_claim, what the worker's relay calls) leaves that type's outbox
// rows pending and claims every other type, and the back-pressure lag does not age them; releasing the switch drains
// them, in order. The claim marks a held row once and then passes it without touching it (#1713), so a large held
// backlog does not slow every relay pass. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { outboxLagSeconds } from '../src/back-pressure.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const HELD = 'test.relay.held';
const OTHER = 'test.relay.other';

suite('a kill switch per relay type on PostgreSQL (#1696)', () => {
  const dbName = `crove_test_relay_kill_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let orgId = '';

  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  async function connect<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const admin = <T>(fn: (client: pg.Client) => Promise<T>) => connect(adminUrl, fn);

  // An outbox event of the given type and age, pending as crove_kernel.emit leaves it; returns its id.
  const add = (type: string, age = '0 seconds') =>
    admin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `WITH e AS (INSERT INTO crove_kernel.outbox_event (org_id, type, payload, created_at)
                    VALUES ($1, $2, '{}', now() - $3::interval) RETURNING org_id, id)
         INSERT INTO crove_kernel.outbox_pending (org_id, event_id) SELECT org_id, id FROM e RETURNING event_id AS id`,
        [orgId, type, age],
      );
      return rows[0]?.id as string;
    });
  // The relay's claim, as the worker login runs it.
  const claim = async (limit = 100) =>
    connect(login('crove_worker', 'test-worker-pw'), async (c) => (await c.query<{ event_id: string; type: string }>('SELECT event_id, type FROM crove_kernel.outbox_claim($1)', [limit])).rows);
  // Claims until nothing is left: the org's own events, so the outbox holds only a test's rows.
  const drain = async () => {
    for (let i = 0; i < 100; i++) if ((await claim()).length === 0) return;
    throw new Error('the outbox never drained');
  };
  const pending = () => admin(async (c) => (await c.query<{ id: string }>('SELECT event_id AS id FROM crove_kernel.outbox_pending ORDER BY seq')).rows.map((r) => r.id));
  const set = (key: string, engaged: boolean) => admin((c) => c.query('SELECT crove_kernel.global_kill_switch_set($1, $2, $3, $4)', [key, engaged, 'diễn tập', 'ops']));

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
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    const appDb = createDb(appPool);
    const runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const owner = await upsertIdentity(appDb, { issuer: 'relay-kill-test', subject: 'owner', email: 'owner@relay-kill.test', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, 'Relay kill switch test'));
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('holds the outbox rows of a switched type, relays the others, and drains the held ones once released', async () => {
    await drain();
    expect(await pending()).toEqual([]);

    const held1 = await add(HELD, '1 hour');
    const other1 = await add(OTHER);
    const held2 = await add(HELD);
    const other2 = await add(OTHER);

    await set(`relay:${HELD}`, true);
    expect(await admin(async (c) => (await c.query('SELECT crove_kernel.global_kill_switch_on($1) AS on', [`relay:${HELD}`])).rows[0])).toEqual({ on: true });
    // The relay passes the held rows at the head of the outbox and claims the others, in order.
    expect(await claim()).toEqual([
      { event_id: other1, type: OTHER },
      { event_id: other2, type: OTHER },
    ]);
    expect(await claim()).toEqual([]);
    expect(await pending()).toEqual([held1, held2]);
    // A claim smaller than the held backlog still reaches a newer row of another type.
    const other3 = await add(OTHER);
    expect(await claim(1)).toEqual([{ event_id: other3, type: OTHER }]);
    // The held hour-old row does not count as relay lag, so back-pressure does not pause other work for it.
    expect(await outboxLagSeconds(workerDb)).toBe(0);
    // The prober still sees the waiting work (incidents runbook §7).
    expect(await admin(async (c) => (await c.query<{ n: number }>('SELECT outbox_pending AS n FROM crove_kernel.health()')).rows[0]?.n)).toBe(2);

    // Released: the next relay pass drains them, oldest first.
    await set(`relay:${HELD}`, false);
    expect(await outboxLagSeconds(workerDb)).toBeGreaterThanOrEqual(3600);
    expect(await claim()).toEqual([
      { event_id: held1, type: HELD },
      { event_id: held2, type: HELD },
    ]);
    expect(await pending()).toEqual([]);
    expect(await outboxLagSeconds(workerDb)).toBe(0);
  });

  it('holds each engaged type on its own, and only while its latest change engages it', async () => {
    await drain();
    const third = 'test.relay.third';
    await set(`relay:${HELD}`, true);
    await set(`relay:${OTHER}`, true);
    await set(`relay:${OTHER}`, false);
    await set(`relay:${third}`, true);
    const held = await add(HELD);
    const other = await add(OTHER);
    const thirdId = await add(third);
    expect(await claim()).toEqual([{ event_id: other, type: OTHER }]);
    await set(`relay:${third}`, false);
    expect(await claim()).toEqual([{ event_id: thirdId, type: third }]);
    await set(`relay:${HELD}`, false);
    expect(await claim()).toEqual([{ event_id: held, type: HELD }]);
    // The relay switches leave the deployment-wide 'ai' and 'mail' keys alone.
    expect(await admin(async (c) => (await c.query(`SELECT crove_kernel.global_kill_switch_on('ai') AS ai, crove_kernel.global_kill_switch_on('mail') AS mail`)).rows[0])).toEqual({
      ai: false,
      mail: false,
    });
  });

  // A held backlog of `n` events of one type, an hour old, emitted in one statement; returns their ids in queue order.
  const addMany = async (type: string, n: number) => {
    const before = new Set(await pending());
    await admin((c) =>
      c.query(
        `WITH e AS (INSERT INTO crove_kernel.outbox_event (org_id, type, payload, created_at)
                    SELECT $1, $2, jsonb_build_object('i', g), now() - interval '1 hour' FROM generate_series(1, $3) g
                    RETURNING org_id, id)
         INSERT INTO crove_kernel.outbox_pending (org_id, event_id) SELECT org_id, id FROM e`,
        [orgId, type, n],
      ),
    );
    return (await pending()).filter((id) => !before.has(id));
  };
  // What a statement touched, from this transaction's own table statistics: the outbox_event probes (one per pending
  // row whose type is looked up) and the outbox_pending rows read and updated.
  const touched = async <T>(c: pg.Client, run: () => Promise<T>) => {
    const stats = async () =>
      Object.fromEntries(
        (
          await c.query<{ relname: string; scans: string; rows: string; updated: string }>(
            `SELECT relname, (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text AS scans,
                    (coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0))::text AS rows, n_tup_upd::text AS updated
             FROM pg_stat_xact_user_tables WHERE schemaname = 'crove_kernel' AND relname IN ('outbox_event', 'outbox_pending')`,
          )
        ).rows.map((r) => [r.relname, { scans: Number(r.scans), rows: Number(r.rows), updated: Number(r.updated) }]),
      ) as Record<'outbox_event' | 'outbox_pending', { scans: number; rows: number; updated: number }>;
    await c.query('BEGIN');
    try {
      const start = await stats();
      const result = await run();
      const end = await stats();
      await c.query('COMMIT');
      const diff = (t: 'outbox_event' | 'outbox_pending') => ({
        scans: end[t].scans - start[t].scans,
        rows: end[t].rows - start[t].rows,
        updated: end[t].updated - start[t].updated,
      });
      return { result, event: diff('outbox_event'), pending: diff('outbox_pending') };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  };
  const asWorker = <T>(fn: (c: pg.Client) => Promise<T>) => connect(login('crove_worker', 'test-worker-pw'), fn);
  const claimIn = (c: pg.Client, limit = 100) =>
    c.query<{ event_id: string; type: string }>('SELECT event_id, type FROM crove_kernel.outbox_claim($1)', [limit]).then((r) => r.rows);

  it('passes a large held backlog without walking it on every claim (#1713)', async () => {
    await drain();
    const BACKLOG = 2000;
    await set(`relay:${HELD}`, true);
    const held = await addMany(HELD, BACKLOG);
    expect(held).toHaveLength(BACKLOG);

    // The first claim meets every held row once: one event probe and one mark each, and claims none of them.
    const first = await asWorker((c) => touched(c, () => claimIn(c)));
    expect(first.result).toEqual([]);
    expect(first.event.scans).toBeGreaterThanOrEqual(BACKLOG);
    expect(first.pending.updated).toBe(BACKLOG);
    expect(await pending()).toEqual(held);

    // From then on a claim reaches newer rows of other types, and a newer held row, without touching the marked backlog.
    const others = [await add(OTHER), await add(OTHER), await add(OTHER)];
    const lateHeld = await add(HELD);
    const next = await asWorker((c) => touched(c, () => claimIn(c)));
    expect(next.result).toEqual(others.map((event_id) => ({ event_id, type: OTHER })));
    expect(next.event.scans).toBeLessThan(20);
    expect(next.pending.rows).toBeLessThan(20);
    expect(next.pending.updated).toBe(1);
    // An empty pass touches no held row either.
    const idle = await asWorker((c) => touched(c, () => claimIn(c)));
    expect(idle.result).toEqual([]);
    expect(idle.event.scans).toBeLessThan(5);
    expect(idle.pending.rows).toBeLessThan(5);
    expect(idle.pending.updated).toBe(0);

    // The back-pressure lag passes the marked backlog too, and does not age it.
    const other = await add(OTHER, '10 minutes');
    const lag = await asWorker((c) => touched(c, async () => (await c.query<{ lag: number }>('SELECT crove_kernel.outbox_lag_seconds() AS lag')).rows[0]?.lag));
    expect(lag.result).toBeGreaterThanOrEqual(600);
    expect(lag.result).toBeLessThan(3600);
    expect(lag.event.scans).toBeLessThan(5);
    expect(lag.pending.rows).toBeLessThan(5);
    expect(await claim()).toEqual([{ event_id: other, type: OTHER }]);
    expect(await outboxLagSeconds(workerDb)).toBe(0);
    // The prober and the operator's status still count every held row.
    expect(await admin(async (c) => (await c.query<{ n: number }>('SELECT outbox_pending AS n FROM crove_kernel.health()')).rows[0]?.n)).toBe(BACKLOG + 1);
    expect(await pending()).toEqual([...held, lateHeld]);

    // Released while another type stays held: the marks of the released type stop counting at once (the lag ages them
    // before any claim), and the backlog drains in its order, the other held type's row staying pending.
    const KEEP = 'test.relay.keep';
    await set(`relay:${KEEP}`, true);
    const kept = await add(KEEP);
    await set(`relay:${HELD}`, false);
    expect(await outboxLagSeconds(workerDb)).toBeGreaterThanOrEqual(3600);
    const drained: string[] = [];
    for (let i = 0; i < 100; i++) {
      const rows = await claim();
      if (rows.length === 0) break;
      expect(rows.every((r) => r.type === HELD)).toBe(true);
      drained.push(...rows.map((r) => r.event_id));
    }
    expect(drained).toEqual([...held, lateHeld]);
    expect(await pending()).toEqual([kept]);
    expect(await outboxLagSeconds(workerDb)).toBe(0);

    // Held, marked, and held again after a release with nothing else held: the claim ignores marks when nothing is held.
    const again = await addMany(KEEP, 5);
    expect(await claim()).toEqual([]);
    await set(`relay:${KEEP}`, false);
    expect(await claim()).toEqual([kept, ...again].map((event_id) => ({ event_id, type: KEEP })));
    expect(await pending()).toEqual([]);
  });

  it('accepts only an event type as a relay key, flipped by the database owner alone, with its history kept', async () => {
    for (const key of ['relay:', 'relay:kernel', 'relay:Kernel.File', 'relay:kernel.*', 'relay:kernel..file', `relay:a.${'b'.repeat(200)}`, 'social', 'relays:kernel.file']) {
      await expect(set(key, true), key).rejects.toMatchObject({ code: '23514' });
    }
    for (const [role, password] of [
      ['crove_app', 'test-app-pw'],
      ['crove_worker', 'test-worker-pw'],
    ] as const) {
      await connect(login(role, password), async (c) => {
        await expect(c.query(`SELECT crove_kernel.global_kill_switch_set('relay:a.b', true, 'x', 'y')`), role).rejects.toMatchObject({ code: '42501' });
        await expect(c.query('SELECT crove_kernel.relay_held_types()'), role).rejects.toMatchObject({ code: '42501' });
        expect((await c.query(`SELECT crove_kernel.global_kill_switch_on('relay:a.b') AS on`)).rows[0]).toEqual({ on: false });
      });
    }
    // No Crove role may read the held types or flip a switch; the claim stays the worker's alone.
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];
    const matrix = await admin(async (c) => {
      const fns = ['crove_kernel.relay_held_types()', 'crove_kernel.global_kill_switch_set(text,boolean,text,text)', 'crove_kernel.outbox_claim(integer)'];
      const { rows } = await c.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r
         WHERE has_function_privilege(r, f::regprocedure, 'EXECUTE') ORDER BY 1, 2`,
        [fns, roles],
      );
      return rows;
    });
    expect(matrix).toEqual([{ fn: 'crove_kernel.outbox_claim(integer)', role: 'crove_worker' }]);
    // Every change is kept, with who and why; a key of this test's own, so the other tests' changes do not count.
    const key = 'relay:test.relay.history';
    await set(key, true);
    await set(key, false);
    const history = await admin(
      async (c) => (await c.query(`SELECT key, engaged, reason, changed_by FROM crove_kernel.global_kill_switch WHERE key = $1 ORDER BY changed_at, id`, [key])).rows,
    );
    expect(history).toEqual([
      { key, engaged: true, reason: 'diễn tập', changed_by: 'ops' },
      { key, engaged: false, reason: 'diễn tập', changed_by: 'ops' },
    ]);
    await expect(admin((c) => c.query(`DELETE FROM crove_kernel.global_kill_switch WHERE key LIKE 'relay:%'`))).rejects.toThrow();
  });
});
