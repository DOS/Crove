// SPDX-License-Identifier: AGPL-3.0-only
// After a restore (issue #2007, plan §7.9) on PostgreSQL 17. A copy of the database made at a "backup point" plays the
// restored database; the original goes on numbering past that point (a series that existed, a series created after
// it, a journal voucher) and the worker archives it into the same store. Then, against the copy: the report names the
// batches and the rows the archive holds beyond it, the restore check raises every series above the archived numbers
// (one audited command each, a lost series created again with its archived key), and the next numbers allocated in the
// copy lie above every archived one. The reseed definer is the worker's alone, in a system context, and never lowers a
// number, and a series it made keeps its doc type's reset. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes
// its own databases.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { RESTORE_REPORT_EXIT, numberReseedCommand, runRestoreReport } from '../src/restore-report.ts';
import { LocalArchiveStore, restoreReport, verifyArchive, writeArchive } from '../src/worm.ts';
import { contextToken } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const OPERATOR = { type: 'system' as const, component: 'operator' };

const suite = ADMIN ? describe : describe.skip;

suite('restore report and series reseed on PostgreSQL (#2007)', () => {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dbName = `crove_test_restore_${stamp}`;
  const copyName = `crove_test_restored_${stamp}`;
  let dir = '';
  let store: LocalArchiveStore;
  let orgId = '';
  let userId = '';
  let entityId = '';
  const pools: pg.Pool[] = [];

  const urlOf = (name: string, user?: [string, string]) => {
    const url = new URL(ADMIN as string);
    url.pathname = `/${name}`;
    if (user) [url.username, url.password] = user;
    return url.toString();
  };
  const APP: [string, string] = ['crove_app', 'test-app-pw'];
  const WORKER: [string, string] = ['crove_worker', 'test-worker-pw'];
  function dbFor(name: string, user: [string, string]): Db {
    const pool = createPool({ connectionString: urlOf(name, user), max: 2 });
    pools.push(pool);
    return createDb(pool);
  }
  async function client<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  // One committed transaction in the owner's context.
  async function asOwner<T>(name: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    return client(urlOf(name, APP), async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }
  // A number of `docType`, through ctx.numbering.allocate's definer.
  const allocate = (name: string, docType: string) =>
    asOwner(name, async (c) => {
      const { rows } = await c.query<{ number: string; allocation_id: string }>(
        `SELECT number::text AS number, allocation_id FROM crove_kernel.allocate_number(NULL, $1, '2026-10-01', 'test.record', $2::uuid)`,
        [docType, randomUUID()],
      );
      return rows[0]!;
    });
  // A journal voucher (NVK) numbered by its trigger, with its entry.
  const journalVoucher = (name: string) =>
    asOwner(name, async (c) => {
      const { rows } = await c.query<{ id: string; number: string; allocation: string }>(
        `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description) VALUES ($1, '2026-10-01', 'restore check')
         RETURNING id, number::text AS number, number_allocation_id AS allocation`,
        [orgId],
      );
      const v = rows[0]!;
      const lines = [
        { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
        { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
      ];
      const entry = await c.query<{ id: string }>(
        `SELECT crove_finance.post_journal_entry('2026-10-01'::date, 'restore check', 'finance.journal_voucher', $1::uuid, $2::jsonb) AS id`,
        [v.id, JSON.stringify(lines)],
      );
      return { ...v, entryId: entry.rows[0]!.id };
    });
  // Everything written so far moves back by `minutes`, past the archiver's lag.
  const age = (minutes: number) =>
    client(urlOf(dbName), async (c) => {
      await c.query(`SET session_replication_role = replica`);
      const recent = `> now() - interval '10 minutes'`;
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - make_interval(mins => $1) WHERE occurred_at ${recent}`, [minutes]);
      for (const table of ['crove_finance.journal_entry', 'crove_finance.journal_voucher', 'crove_kernel.number_series']) {
        await c.query(`UPDATE ${table} SET created_at = created_at - make_interval(mins => $1) WHERE created_at ${recent}`, [minutes]);
      }
      await c.query(`UPDATE crove_kernel.number_allocation SET allocated_at = allocated_at - make_interval(mins => $1) WHERE allocated_at ${recent}`, [minutes]);
    });
  const archive = async () => {
    const worker = dbFor(dbName, WORKER);
    while ((await writeArchive(worker, store, { lagSeconds: 60 })) > 0);
  };

  // Before the backup point: three numbers of a series, and a journal voucher. After it, in the original only: two
  // more of that series, a series created after the backup with two numbers, and a second journal voucher.
  const before: { numbers: string[]; voucher?: { number: string } } = { numbers: [] };
  const after: { numbers: string[]; late: string[]; voucher?: { id: string; number: string; allocation: string; entryId: string } } = { numbers: [], late: [] };

  beforeAll(async () => {
    await client(ADMIN as string, (c) => c.query(`CREATE DATABASE ${dbName}`));
    await migrate({ adminUrl: urlOf(dbName), dir: MIGRATIONS });
    await setRolePasswords(urlOf(dbName), { crove_app: APP[1], crove_worker: WORKER[1] });
    const db = dbFor(dbName, APP);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'restore-report', email: 'restore-report@example.com', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Org restore'));
    entityId = await client(urlOf(dbName), async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]!.id);
    dir = mkdtempSync(join(tmpdir(), 'crove-restore-report-'));
    store = new LocalArchiveStore(dir);

    for (let i = 0; i < 3; i++) before.numbers.push((await allocate(dbName, 'test.restore')).number);
    before.voucher = await journalVoucher(dbName);
    await age(120);
    await archive();

    // The backup point: a copy of the database, which needs every other session to the original closed.
    await Promise.all(pools.splice(0).map((p) => p.end()));
    await client(ADMIN as string, async (c) => {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
      await c.query(`CREATE DATABASE ${copyName} TEMPLATE ${dbName}`);
    });

    for (let i = 0; i < 2; i++) after.numbers.push((await allocate(dbName, 'test.restore')).number);
    for (let i = 0; i < 2; i++) after.late.push((await allocate(dbName, 'test.restore.late')).number);
    after.voucher = await journalVoucher(dbName);
    await age(30);
    await archive();
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!ADMIN) return;
    await client(ADMIN, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${copyName} WITH (FORCE)`);
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    });
  });

  it('archived the numbers on both sides of the backup point, in version 7 batches the original verifies', async () => {
    expect(before.numbers).toEqual(['1', '2', '3']);
    expect(after.numbers).toEqual(['4', '5']);
    expect(after.late).toEqual(['1', '2']);
    expect(after.voucher?.number).toBe(String(Number(before.voucher?.number) + 1));
    expect(await verifyArchive(dbFor(dbName, WORKER), store)).toMatchObject({ ok: true, problems: [] });
  });

  it('lets only the worker read the series highs and next numbers, and run the reseed', async () => {
    const allowed = await client(urlOf(dbName), async (c) => {
      const { rows } = await c.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role
         FROM unnest(ARRAY['crove_kernel.archive_series_highs(timestamptz,timestamptz)', 'crove_kernel.archive_series_next()',
                           'crove_kernel.archive_legal_entities()', 'crove_kernel.number_series_reseed(uuid,uuid,text,text,bigint)']) f,
              unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) r
         WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
      );
      return rows.map((r) => `${r.fn} ${r.role}`);
    });
    expect(allowed).toEqual([
      'crove_kernel.archive_legal_entities() crove_worker',
      'crove_kernel.archive_series_highs(timestamptz,timestamptz) crove_worker',
      'crove_kernel.archive_series_next() crove_worker',
      'crove_kernel.number_series_reseed(uuid,uuid,text,text,bigint) crove_worker',
    ]);
    // The worker outside a system context of the org is refused.
    await expect(
      sql`SELECT * FROM crove_kernel.number_series_reseed(NULL, ${entityId}::uuid, 'test.restore', '2026', 100)`.execute(dbFor(dbName, WORKER)),
    ).rejects.toThrow(/NUMBER_RESEED_SYSTEM_CONTEXT/);
  });

  it('reports what the archive holds beyond the restored database, per org', async () => {
    const report = await restoreReport(dbFor(copyName, WORKER), store);
    expect(report.problems).toEqual([]);
    expect(report.beyond.length).toBeGreaterThan(0);
    expect(report.recorded).toBe(report.batches - report.beyond.length);
    expect(report.orphaned).toEqual([]);
    const org = report.orgs.find((o) => o.orgId === orgId);
    expect(org).toMatchObject({ journalEntries: [after.voucher?.entryId], journalVouchers: [after.voucher?.id], cashVouchers: [], documentVoids: [], numberVoids: [] });
    // Two of the old series, two of the late one and the voucher's: five allocations, and the late series itself.
    expect(org?.allocations).toHaveLength(5);
    expect(org?.allocations).toContain(after.voucher?.allocation);
    expect(org?.series).toHaveLength(1);
    expect(report.uncovered).toEqual([]);
    const reseed = Object.fromEntries(report.reseed.map((s) => [s.docType, [s.archivedHigh, s.next]]));
    expect(reseed).toEqual({
      'test.restore': ['5', '4'],
      'test.restore.late': ['2', null],
      'finance.journal_voucher': [after.voucher?.number, after.voucher?.number],
    });
  });

  it('raises every series above the archive through one audited command each, and the next numbers follow the archived ones', async () => {
    const workerDb = dbFor(copyName, WORKER);
    const runtime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({ commands: [numberReseedCommand()] });
    const lines: string[] = [];
    const run = (argv: string[]) => runRestoreReport({ db: workerDb, store, runtime, log: (l) => lines.push(l), error: (l) => lines.push(l), out: () => {} }, argv);
    // Without --reseed the series stay behind: keep writes closed.
    expect(await run([])).toBe(RESTORE_REPORT_EXIT.behind);
    expect(await run(['--reseed'])).toBe(RESTORE_REPORT_EXIT.lost);
    expect(lines.filter((l) => l.includes('reseeded:'))).toHaveLength(3);

    const audits = await client(urlOf(copyName), async (c) => {
      const { rows } = await c.query<{ actor_type: string; outcome: string; detail: { docType: string; next: string; previousNext: string | null } }>(
        `SELECT actor_type, outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.number.reseed' ORDER BY occurred_at, id`,
        [orgId],
      );
      return rows;
    });
    expect(audits.map((a) => [a.actor_type, a.outcome, a.detail.docType, a.detail.next, a.detail.previousNext]).sort()).toEqual(
      [
        ['system', 'ok', 'finance.journal_voucher', String(Number(after.voucher?.number) + 1), after.voucher?.number],
        ['system', 'ok', 'test.restore', '6', '4'],
        ['system', 'ok', 'test.restore.late', '3', null],
      ].sort(),
    );

    // The next numbers in the restored database lie above every archived one.
    expect((await allocate(copyName, 'test.restore')).number).toBe('6');
    expect((await allocate(copyName, 'test.restore.late')).number).toBe('3');
    expect((await journalVoucher(copyName)).number).toBe(String(Number(after.voucher?.number) + 1));
    // The late series came back with its archived id.
    const lateIds = await Promise.all(
      [dbName, copyName].map((name) =>
        client(urlOf(name), async (c) => (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.number_series WHERE org_id = $1 AND doc_type = 'test.restore.late'`, [orgId])).rows[0]?.id),
      ),
    );
    expect(lateIds[1]).toBe(lateIds[0]);

    // A second run finds nothing behind: the lost rows are still reported, and no series moves again.
    lines.length = 0;
    expect(await run(['--reseed'])).toBe(RESTORE_REPORT_EXIT.lost);
    expect(lines.filter((l) => l.includes('reseeded:'))).toEqual([]);
  });

  it('never lowers a series, and takes a floor for a key the archive does not name', async () => {
    const workerDb = dbFor(copyName, WORKER);
    const runtime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({ commands: [numberReseedCommand()] });
    const reseed = (docType: string, next: string, periodKey = '2026') =>
      runtime.execute<{ next: string; previousNext: string | null }>(
        'kernel.number.reseed',
        { seriesId: null, legalEntityId: entityId, docType, periodKey, next, source: 'floor', archivedHigh: null },
        { actor: OPERATOR, orgId },
      );
    expect(await reseed('test.restore', '2')).toMatchObject({ previousNext: '7', next: '7' });
    expect((await allocate(copyName, 'test.restore')).number).toBe('7');
    expect(await reseed('test.restore.floor', '41')).toMatchObject({ previousNext: null, next: '41' });
    // A series the reseed made has no allocation yet, and its doc type's reset is locked all the same: a switch would
    // number a new period from 1 beside the numbers the archive holds.
    await expect(asOwner(copyName, (c) => c.query(`SELECT crove_kernel.number_series_policy_set(NULL, 'test.restore.floor', 'never')`))).rejects.toThrow(
      /NUMBER_POLICY_IN_USE/,
    );
    expect((await allocate(copyName, 'test.restore.floor')).number).toBe('41');
    // A period key that does not fit the doc type's reset (yearly by default) is refused.
    await expect(reseed('test.restore.floor', '50', '2026-10')).rejects.toMatchObject({ code: 'NUMBER_RESEED_PERIOD_MISFIT' });
    // A user is not the operator.
    const app = new Runtime(dbFor(copyName, APP), { manifests: TEST_MANIFESTS }).register({ commands: [numberReseedCommand()] });
    await expect(
      app.execute('kernel.number.reseed', { seriesId: null, legalEntityId: entityId, docType: 'test.restore', periodKey: '2026', next: '100', source: 'floor', archivedHigh: null }, {
        actor: { type: 'user', userId, aal: 'aal1' },
        orgId,
      }),
    ).rejects.toThrow();
  });
});
