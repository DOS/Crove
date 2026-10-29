// Invariant suite (ADR-0021 section 2, issue #1401): gapless numbering on a real PostgreSQL 17, as the API login role in
// sealed tenant contexts.
// - Gapless: 40 clients post 10 journal vouchers each at once, about 1 in 10 rolled back after the voucher took its
//   number and its entry was posted; the committed vouchers are numbered exactly 1..N, each with its own allocation,
//   and the series' next number is N + 1. A rolled-back posting leaves no number and no allocation behind.
// - Void: a number is voided once (a second void fails 23505), a number never allocated or allocated in another org
//   cannot be voided (23503), and only an owner or admin user voids (42501 for a member and a system context).
// - Writes: no tenant role inserts, updates or deletes a series, an allocation, a void or a policy directly; only the
//   definers do. Allocations and voids are append-only for every role, the database owner included.
// - Scope: a member limited to another legal entity cannot allocate in the default entity, and its refused voucher
//   insert takes no number. The series the voucher triggers own cannot be allocated through allocate_number.
// Keep this directory self-contained: no imports or fixtures from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const CLIENTS = 40;
const PER_CLIENT = 10;
const LINES = JSON.stringify([
  { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
  { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
]);

type Who = { user: string } | 'system';

suite('gapless numbering on PostgreSQL (#1401)', () => {
  const dbName = `crove_test_numbering_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtimePool: pg.Pool;
  let owner = '';
  let member = '';
  let accountant = '';
  let ownerB = '';
  let orgA = '';
  let orgB = '';
  let entityA = '';
  let branchA = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // One transaction in the context of `who` in `org` (a user as crove_app, the system as crove_worker, the only role
  // that enters it); committed unless `rollback`.
  async function tx<T>(who: Who, org: string, fn: (c: pg.PoolClient) => Promise<T>, rollback = false): Promise<T> {
    const c = await (who === 'system' ? workerPool : pool).connect();
    try {
      await c.query('BEGIN');
      if (who === 'system') await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [org]);
      else await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [who.user, org]);
      const out = await fn(c);
      await c.query(rollback ? 'ROLLBACK' : 'COMMIT');
      return out;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      c.release();
    }
  }

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => ({ ok: true as const }),
      (error: { code?: string; message?: string }) => ({ ok: false as const, code: error.code, message: error.message }),
    );

  // A journal voucher with its entry, as finance.journal_voucher.record writes them (the voucher first).
  async function postVoucher(c: pg.ClientBase, org: string, date: string): Promise<{ id: string; number: number; period: string }> {
    const { rows } = await c.query<{ id: string; number: number; number_period: string }>(
      `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description) VALUES ($1, $2, 'numbering invariant')
       RETURNING id, number, number_period`,
      [org, date],
    );
    const v = rows[0]!;
    await c.query(`SELECT crove_finance.post_journal_entry($1::date, 'numbering invariant', 'finance.journal_voucher', $2::uuid, $3::jsonb)`, [date, v.id, LINES]);
    return { id: v.id, number: v.number, period: v.number_period };
  }

  const allocate = (c: pg.ClientBase, entity: string | null, docType = 'test.invoice', targetId = randomUUID()) =>
    c.query<{ period_key: string; number: string; allocation_id: string }>(
      `SELECT * FROM crove_kernel.allocate_number($1::uuid, $2::text, '2026-10-15'::date, 'test.invoice', $3::uuid)`,
      [entity, docType, targetId],
    );

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
    appUrl = app.toString();
    runtimePool = createPool({ connectionString: appUrl, max: 2 });
    const db = createDb(runtimePool);
    const rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const user = (name: string) => upsertIdentity(db, { issuer: 'numbering-inv', subject: randomUUID(), email: `${name}@numbering.test`, name: null });
    owner = await user('owner');
    member = await user('member');
    accountant = await user('accountant');
    ownerB = await user('owner-b');
    orgA = (await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Đánh số A')).orgId;
    orgB = (await createOrg(rt, { type: 'user', userId: ownerB, aal: 'aal1' }, 'Đánh số B')).orgId;
    await admin(async (c) => {
      entityA = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgA])).rows[0]!.id;
      branchA = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [
          orgA,
          owner,
        ])
      ).rows[0]!.id;
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgA, member, accountant]);
      // The accountant keeps the branch's books only.
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgA, accountant, branchA, owner],
      );
    });
    pool = new pg.Pool({ connectionString: appUrl, max: CLIENTS + 2 });
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerPool = new pg.Pool({ connectionString: worker.toString(), max: 2 });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    await runtimePool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    // pool.end() resolves before every one of the CLIENTS connections has closed on the server; a FORCE drop would
    // terminate the stragglers, and their 57P01 reaches the run as an unhandled error. Wait for them first.
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await root.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()',
        [dbName],
      );
      if (rows[0]?.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('numbers parallel postings 1..N with no gap when about 1 in 10 rolls back', { timeout: 300_000 }, async () => {
    const committed: string[] = [];
    let rolledBack = 0;
    await Promise.all(
      Array.from({ length: CLIENTS }, async (_, client) => {
        for (let i = 0; i < PER_CLIENT; i += 1) {
          const rollback = (client * PER_CLIENT + i) % 10 === 3;
          const v = await tx({ user: owner }, orgA, (c) => postVoucher(c, orgA, '2026-10-20'), rollback);
          if (rollback) rolledBack += 1;
          else committed.push(v.id);
        }
      }),
    );
    expect(rolledBack).toBe((CLIENTS * PER_CLIENT) / 10);
    const n = committed.length;
    const rows = await admin(async (c) =>
      (
        await c.query<{ id: string; number: number; number_period: string; a_number: string; target_id: string; series_next: string }>(
          `SELECT v.id, v.number, v.number_period, a.number::text AS a_number, a.target_id, s.next_number::text AS series_next
           FROM crove_finance.journal_voucher v
           JOIN crove_kernel.number_allocation a ON a.org_id = v.org_id AND a.id = v.number_allocation_id
           JOIN crove_kernel.number_series s ON s.org_id = a.org_id AND s.id = a.series_id
           WHERE v.org_id = $1 ORDER BY v.number`,
          [orgA],
        )
      ).rows,
    );
    // Every committed voucher, numbered exactly 1..N in the 2026 series, each by its own allocation.
    expect(rows.map((r) => r.id).sort()).toEqual([...committed].sort());
    expect(rows.map((r) => r.number)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(rows.every((r) => r.number_period === '2026' && Number(r.a_number) === r.number && r.target_id === r.id)).toBe(true);
    expect(new Set(rows.map((r) => r.series_next))).toEqual(new Set([String(n + 1)]));
    // No allocation outlived its rolled-back voucher.
    const allocations = await admin(
      async (c) =>
        (
          await c.query<{ n: number; max: string }>(
            `SELECT count(*)::int AS n, max(a.number)::text AS max FROM crove_kernel.number_allocation a
             JOIN crove_kernel.number_series s ON s.org_id = a.org_id AND s.id = a.series_id
             WHERE a.org_id = $1 AND s.doc_type = 'finance.journal_voucher'`,
            [orgA],
          )
        ).rows[0]!,
    );
    expect(allocations).toEqual({ n, max: String(n) });
  });

  it('voids a number once, never a number of another org or one never allocated, and only for owners and admins', async () => {
    const allocated = await tx({ user: owner }, orgA, async (c) => (await allocate(c, null)).rows[0]!);
    expect(allocated).toMatchObject({ period_key: '2026', number: '1' });
    const id = allocated.allocation_id;

    // A member, and a system context, are refused before anything is written.
    expect(await refusal(tx({ user: member }, orgA, (c) => c.query(`SELECT crove_kernel.void_number($1, 'sai số')`, [id])))).toMatchObject({
      ok: false,
      code: '42501',
      message: 'NUMBER_FORBIDDEN',
    });
    expect(await refusal(tx('system', orgA, (c) => c.query(`SELECT crove_kernel.void_number($1, 'sai số')`, [id])))).toMatchObject({
      ok: false,
      code: '42501',
      message: 'NUMBER_FORBIDDEN',
    });
    // The owner of another org cannot reach it.
    expect(await refusal(tx({ user: ownerB }, orgB, (c) => c.query(`SELECT crove_kernel.void_number($1, 'sai số')`, [id])))).toMatchObject({
      ok: false,
      code: '23503',
      message: 'NUMBER_ALLOCATION_NOT_FOUND',
    });
    // A number never allocated.
    expect(await refusal(tx({ user: owner }, orgA, (c) => c.query(`SELECT crove_kernel.void_number($1, 'sai số')`, [randomUUID()])))).toMatchObject({
      ok: false,
      code: '23503',
      message: 'NUMBER_ALLOCATION_NOT_FOUND',
    });
    // A blank reason.
    expect(await refusal(tx({ user: owner }, orgA, (c) => c.query(`SELECT crove_kernel.void_number($1, '  ')`, [id])))).toMatchObject({
      ok: false,
      code: '22023',
    });
    // Once, then 23505.
    await tx({ user: owner }, orgA, (c) => c.query(`SELECT crove_kernel.void_number($1, 'hóa đơn hủy')`, [id]));
    expect(await refusal(tx({ user: owner }, orgA, (c) => c.query(`SELECT crove_kernel.void_number($1, 'lần nữa')`, [id])))).toMatchObject({
      ok: false,
      code: '23505',
    });
    // The voided number is never given out again.
    const next = await tx({ user: owner }, orgA, async (c) => (await allocate(c, null)).rows[0]!);
    expect(next.number).toBe('2');
    const voids = await admin(async (c) => (await c.query('SELECT reason, voided_by FROM crove_kernel.number_void WHERE org_id = $1', [orgA])).rows);
    expect(voids).toEqual([{ reason: 'hóa đơn hủy', voided_by: owner }]);
  });

  it('lets no tenant role write a series, an allocation, a void or a policy, and keeps allocations and voids append-only', async () => {
    const allocationId = await tx({ user: owner }, orgA, async (c) => (await allocate(c, null)).rows[0]!.allocation_id);
    await tx({ user: owner }, orgA, (c) => c.query(`SELECT crove_kernel.void_number($1, 'append-only')`, [allocationId]));
    const writes = [
      `INSERT INTO crove_kernel.number_series (org_id, doc_type, period_key, next_number) VALUES ('${orgA}', 'test.raw', '2026', 1)`,
      `UPDATE crove_kernel.number_series SET next_number = next_number - 1`,
      `DELETE FROM crove_kernel.number_series`,
      `INSERT INTO crove_kernel.number_allocation (org_id, series_id, number, target_type, target_id)
       SELECT org_id, series_id, number + 1000, 'test.raw', gen_random_uuid() FROM crove_kernel.number_allocation LIMIT 1`,
      `UPDATE crove_kernel.number_allocation SET number = number + 1`,
      `DELETE FROM crove_kernel.number_allocation`,
      `INSERT INTO crove_kernel.number_void (org_id, allocation_id, reason) VALUES ('${orgA}', '${allocationId}', 'raw')`,
      `UPDATE crove_kernel.number_void SET reason = 'changed'`,
      `DELETE FROM crove_kernel.number_void`,
      `INSERT INTO crove_kernel.number_series_policy (org_id, doc_type, reset) VALUES ('${orgA}', 'test.raw', 'never')`,
      `UPDATE crove_kernel.number_series_policy SET reset = 'never'`,
      `DELETE FROM crove_kernel.number_series_policy`,
    ];
    for (const who of [{ user: owner }, 'system'] as const) {
      for (const statement of writes) {
        expect(await refusal(tx(who, orgA, (c) => c.query(statement))), `${JSON.stringify(who)}: ${statement}`).toMatchObject({
          ok: false,
          code: '42501',
          message: expect.stringMatching(/permission denied for table/),
        });
      }
    }
    // Append-only for the database owner too.
    for (const statement of [
      `UPDATE crove_kernel.number_allocation SET number = number + 1 WHERE org_id = '${orgA}'`,
      `DELETE FROM crove_kernel.number_allocation WHERE org_id = '${orgA}'`,
      `UPDATE crove_kernel.number_void SET reason = 'changed' WHERE org_id = '${orgA}'`,
      `DELETE FROM crove_kernel.number_void WHERE org_id = '${orgA}'`,
    ]) {
      expect(await refusal(admin((c) => c.query(statement))), statement).toMatchObject({ ok: false });
    }
  });

  it('allocates only in an entity within the context scope, and never in a series the voucher triggers own', async () => {
    const series = () =>
      admin(
        async (c) =>
          (await c.query<{ n: string }>(`SELECT coalesce(sum(next_number), 0)::text AS n FROM crove_kernel.number_series WHERE org_id = $1`, [orgA])).rows[0]!.n,
      );
    const before = await series();
    // The accountant sees the branch only: the default entity is refused, named or not.
    for (const entity of [entityA, null]) {
      expect(await refusal(tx({ user: accountant }, orgA, (c) => allocate(c, entity)))).toMatchObject({
        ok: false,
        code: '42501',
        message: 'LEGAL_ENTITY_NOT_ALLOWED',
      });
    }
    // An entity of another org, for its owner.
    expect(await refusal(tx({ user: ownerB }, orgB, (c) => allocate(c, entityA)))).toMatchObject({ ok: false, code: '42501', message: 'LEGAL_ENTITY_NOT_ALLOWED' });
    // A voucher of the default entity, by the accountant: row security refuses it, and no number was taken.
    expect(
      await refusal(
        tx({ user: accountant }, orgA, (c) =>
          c.query(`INSERT INTO crove_finance.journal_voucher (org_id, legal_entity_id, voucher_date, description) VALUES ($1, $2, '2026-10-20', 'x')`, [
            orgA,
            entityA,
          ]),
        ),
      ),
    ).toMatchObject({ ok: false, code: '42501' });
    // A voucher of another org, by the owner of org A: refused, and org B's series untouched.
    expect(
      await refusal(
        tx({ user: owner }, orgA, (c) =>
          c.query(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description) VALUES ($1, '2026-10-20', 'x')`, [orgB]),
        ),
      ),
    ).toMatchObject({ ok: false, code: '42501' });
    expect(await admin(async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.number_series WHERE org_id = $1', [orgB])).rows[0])).toEqual({ n: 0 });
    // The series the voucher triggers own.
    for (const docType of ['finance.journal_voucher', 'finance.cash_voucher.cash_receipt']) {
      expect(await refusal(tx({ user: owner }, orgA, (c) => allocate(c, null, docType)))).toMatchObject({
        ok: false,
        code: '42501',
        message: 'NUMBER_SERIES_RESERVED',
      });
    }
    // Nor a voucher's target type, which would hold a voucher's place in the one-number-per-record key.
    expect(
      await refusal(
        tx({ user: owner }, orgA, (c) =>
          c.query(`SELECT * FROM crove_kernel.allocate_number(NULL, 'test.other', '2026-10-15', 'finance.cash_voucher', $1::uuid)`, [randomUUID()]),
        ),
      ),
    ).toMatchObject({ ok: false, code: '42501', message: 'NUMBER_SERIES_RESERVED' });
    expect(await series()).toBe(before);
    // The branch, for the accountant: allowed, in the branch's own series.
    const branch = await tx({ user: accountant }, orgA, async (c) => (await allocate(c, branchA)).rows[0]!);
    expect(branch).toMatchObject({ period_key: '2026', number: '1' });
  });
});
