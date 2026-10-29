// The books per legal entity, part 2a (issue #1280) on a real PostgreSQL 17: the posting path takes the entity (a
// replay must name the stored entry's entity, a source stays in one entity, an entity the caller may not see is
// refused), legal_entity_id never changes for any role, voucher numbers and period locks are kept per entity, a row's
// parents must all be of its entity, sales invoice and bank line keys are per entity, and the finance queries resolve
// the entity a call is for (finance.legal_entities.list, finance.period.lock_state, finance.period.lock).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BookEntity, PeriodLockState } from '@crove/kernel-contract';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const RLS_DENIED = /new row violates row-level security policy/;

const suite = ADMIN ? describe : describe.skip;

suite('finance books per legal entity, part 2a (#1280)', () => {
  const dbName = `crove_test_finance_le_books_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let kyselyPool: pg.Pool;
  let runtime: Runtime;
  let orgId = '';
  let owner = '';
  let member = '';
  let defaultEntity = '';
  let branch = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  // One transaction as crove_app in userId's context; committed when commit is set, else rolled back.
  async function asApp<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>, commit = false): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const result = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  const lines = (amount: string, reverse = false) =>
    JSON.stringify(
      reverse
        ? [
            { line_no: 1, account_code: '6422', debit: '0', credit: amount },
            { line_no: 2, account_code: '331', debit: amount, credit: '0' },
          ]
        : [
            { line_no: 1, account_code: '6422', debit: amount, credit: '0' },
            { line_no: 2, account_code: '331', debit: '0', credit: amount },
          ],
    );
  // The 8-argument posting path.
  const post = (c: pg.PoolClient, a: { source: string; amount: string; entity: string | null; revision?: number; reverses?: string | null; date?: string }) =>
    c
      .query<{ id: string }>(`SELECT crove_finance.post_journal_entry($1::date, 'le books', 'test.le', $2::uuid, $3::jsonb, $4::uuid, $5::int, $6::uuid) AS id`, [
        a.date ?? '2026-09-15',
        a.source,
        lines(a.amount, a.reverses != null),
        a.reverses ?? null,
        a.revision ?? 1,
        a.entity,
      ])
      .then((r) => r.rows[0]?.id as string);

  const entityOf = (table: string, id: string) =>
    admin(async (a) => (await a.query<{ e: string }>(`SELECT legal_entity_id AS e FROM ${table} WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0]?.e);

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
    appPool = new pg.Pool({ connectionString: login('crove_app', 'test-app-pw'), max: 3 });
    workerPool = new pg.Pool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 1 });
    kyselyPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    const db = createDb(kyselyPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@le-books2.test', name: null });
    member = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'member@le-books2.test', name: null });
    ({ orgId } = await createOrg(runtime, asUser(owner), 'Sổ hai pháp nhân'));
    await admin(async (a) => {
      defaultEntity = (await a.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await a.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Đà Nẵng', 'branch', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
      await a.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, member]);
      await a.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        member,
        branch,
        owner,
      ]);
    });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    await kyselyPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('posts in the entity named, the reversed entry’s, or the default one, and refuses one the caller may not see', async () => {
    const source = randomUUID();
    const inBranch = await asApp(owner, (c) => post(c, { source, amount: '100000', entity: branch }), true);
    expect(await entityOf('crove_finance.journal_entry', inBranch)).toBe(branch);
    const parts = await admin(
      async (a) =>
        (
          await a.query<{ e: string }>(
            `SELECT DISTINCT legal_entity_id AS e FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2
             UNION SELECT DISTINCT legal_entity_id FROM crove_finance.period_balance_delta WHERE org_id = $1 AND entry_id = $2`,
            [orgId, inBranch],
          )
        ).rows,
    );
    expect(parts).toEqual([{ e: branch }]);
    // No entity named: the default one.
    const plain = await asApp(owner, (c) => post(c, { source: randomUUID(), amount: '5000', entity: null }), true);
    expect(await entityOf('crove_finance.journal_entry', plain)).toBe(defaultEntity);
    // A reversal without an entity: the reversed entry's.
    const reversal = await asApp(owner, (c) => post(c, { source: randomUUID(), amount: '100000', entity: null, reverses: inBranch }), true);
    expect(await entityOf('crove_finance.journal_entry', reversal)).toBe(branch);
    // An entity that is not the org's, and the default entity for a member limited to the branch.
    await expect(asApp(owner, (c) => post(c, { source: randomUUID(), amount: '1', entity: randomUUID() }))).rejects.toMatchObject({
      code: '42501',
      message: 'LEGAL_ENTITY_NOT_ALLOWED',
    });
    await expect(asApp(member, (c) => post(c, { source: randomUUID(), amount: '1', entity: defaultEntity }))).rejects.toMatchObject({
      code: '42501',
      message: 'LEGAL_ENTITY_NOT_ALLOWED',
    });
    await expect(asApp(member, (c) => post(c, { source: randomUUID(), amount: '1', entity: null }))).rejects.toMatchObject({ message: 'LEGAL_ENTITY_NOT_ALLOWED' });
  });

  it('replays only for the stored entry’s entity, and keeps every revision of a source in one entity', async () => {
    const source = randomUUID();
    const first = await asApp(owner, (c) => post(c, { source, amount: '42000', entity: branch }), true);
    // The same revision and payload: the posted entry.
    expect(await asApp(owner, (c) => post(c, { source, amount: '42000', entity: branch }), true)).toBe(first);
    // The same revision and payload naming another entity: not a replay (the entity is compared as a column).
    await expect(asApp(owner, (c) => post(c, { source, amount: '42000', entity: defaultEntity }))).rejects.toMatchObject({
      code: '23505',
      message: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(asApp(owner, (c) => post(c, { source, amount: '42000', entity: null }))).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' });
    // Revision 2 after the reversal must stay in the branch.
    await asApp(owner, (c) => post(c, { source: randomUUID(), amount: '42000', entity: null, reverses: first }), true);
    await expect(asApp(owner, (c) => post(c, { source, amount: '43000', entity: defaultEntity, revision: 2 }))).rejects.toMatchObject({
      code: '23514',
      message: 'SOURCE_LEGAL_ENTITY',
    });
    const second = await asApp(owner, (c) => post(c, { source, amount: '43000', entity: branch, revision: 2 }), true);
    expect(await entityOf('crove_finance.journal_entry', second)).toBe(branch);
  });

  it('never changes legal_entity_id, for any role', async () => {
    const entry = await asApp(owner, (c) => post(c, { source: randomUUID(), amount: '777', entity: null }), true);
    await admin(async (a) => {
      await a.query(`INSERT INTO crove_finance.categorization_rule (org_id, match_kind, match_text, debit_account) VALUES ($1, 'keyword', 'van phong pham', '6422')`, [orgId]);
      await a.query(
        `INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount) VALUES ($1, '1121', $2, 1, '2026-09-01', 'phí', -11000)`,
        [orgId, randomUUID()],
      );
    });
    const tables = ['crove_finance.journal_entry', 'crove_finance.journal_line', 'crove_finance.period_balance_delta', 'crove_finance.period_lock', 'crove_finance.categorization_rule', 'crove_finance.bank_line'];
    const move = (table: string) => `UPDATE ${table} SET legal_entity_id = '${branch}' WHERE org_id = '${orgId}' AND legal_entity_id = '${defaultEntity}'`;
    // Each role in turn: refused (no privilege, append-only, or LEGAL_ENTITY_IMMUTABLE), never applied.
    const attempts: Array<{ who: string; run: (sql: string) => Promise<unknown> }> = [
      { who: 'crove_app (owner context)', run: (q) => asApp(owner, (c) => c.query(q)) },
      {
        who: 'crove_worker (system context)',
        run: async (q) => {
          const c = await workerPool.connect();
          try {
            await c.query('BEGIN');
            await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
            return await c.query(q);
          } finally {
            await c.query('ROLLBACK');
            c.release();
          }
        },
      },
      ...['crove_tenant', 'crove_definer_tenant'].map((role) => ({
        who: `${role} (owner context)`,
        run: (q: string) =>
          admin(async (a) => {
            await a.query('BEGIN');
            try {
              await a.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner, orgId)]);
              await a.query(`SET LOCAL ROLE ${role}`);
              return await a.query(q);
            } finally {
              await a.query('ROLLBACK');
            }
          }),
      })),
      { who: 'the database owner', run: (q) => admin((a) => a.query(q)) },
    ];
    for (const table of tables) {
      for (const attempt of attempts) {
        await expect(attempt.run(move(table)), `${attempt.who} moving ${table}`).rejects.toThrow(/permission denied|append-only|LEGAL_ENTITY_IMMUTABLE/);
      }
    }
    const moved = await admin(
      async (a) =>
        (
          await a.query<{ n: string }>(
            `SELECT (SELECT count(*) FROM crove_finance.journal_entry WHERE id = $1 AND legal_entity_id <> $2)
                  + (SELECT count(*) FROM crove_finance.categorization_rule WHERE org_id = $3 AND match_text = 'van phong pham' AND legal_entity_id <> $2) AS n`,
            [entry, defaultEntity, orgId],
          )
        ).rows[0]?.n,
    );
    expect(moved).toBe('0');
  });

  it('numbers vouchers per entity and requires each voucher’s entry to be of its entity', async () => {
    // A journal voucher (NVK) with its entry, written by the database owner in one transaction.
    const nvk = (entity: string, entryEntity: string) =>
      admin(async (a) => {
        await a.query('BEGIN');
        try {
          const v = (
            await a.query<{ id: string; number: number }>(
              `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, legal_entity_id) VALUES ($1, '2026-09-20', 'kết chuyển', $2) RETURNING id, number`,
              [orgId, entity],
            )
          ).rows[0] as { id: string; number: number };
          const e = (
            await a.query<{ id: string }>(
              `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, '2026-09-20', 'nvk', 'finance.journal_voucher', $2, $3) RETURNING id`,
              [orgId, v.id, entryEntity],
            )
          ).rows[0]?.id;
          await a.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 10, 0), ($1, $2, 2, '331', 0, 10)`, [orgId, e]);
          await a.query('COMMIT');
          return v.number;
        } catch (error) {
          await a.query('ROLLBACK');
          throw error;
        }
      });
    expect(await nvk(defaultEntity, defaultEntity)).toBe(1);
    expect(await nvk(branch, branch)).toBe(1);
    expect(await nvk(branch, branch)).toBe(2);
    expect(await nvk(defaultEntity, defaultEntity)).toBe(2);
    await expect(nvk(branch, defaultEntity)).rejects.toThrow(/must be posted as a journal entry dated/);
  });

  it('locks months per entity, and the one-argument forms lock the default entity', async () => {
    await asApp(owner, (c) => c.query(`SELECT crove_finance.lock_period('2026-07-01'::date, $1::uuid)`, [branch]), true);
    await expect(asApp(owner, (c) => post(c, { source: randomUUID(), amount: '10', entity: branch, date: '2026-07-31' }))).rejects.toMatchObject({
      code: '55000',
      message: 'PERIOD_LOCKED',
    });
    // The default entity's July is still open.
    await asApp(owner, (c) => post(c, { source: randomUUID(), amount: '10', entity: defaultEntity, date: '2026-07-31' }), true);
    // The member limited to the branch reads the branch's lock row only; locking needs an owner or admin anyway.
    const seen = await asApp(member, async (c) => (await c.query<{ e: string }>('SELECT legal_entity_id AS e FROM crove_finance.period_lock')).rows.map((r) => r.e));
    expect(seen).toEqual([branch]);
    // finance.period.lock_state and finance.period.lock resolve the entity.
    const state = await runtime.query<PeriodLockState>('finance.period.lock_state', { legalEntityId: branch }, { actor: asUser(owner), orgId });
    expect(state).toMatchObject({ legalEntityId: branch, lockedThrough: '2026-07-31' });
    const plainState = await runtime.query<PeriodLockState>('finance.period.lock_state', {}, { actor: asUser(owner), orgId });
    expect(plainState).toMatchObject({ legalEntityId: defaultEntity, lockedThrough: null });
    const locked = await runtime.execute<PeriodLockState>('finance.period.lock', { month: '2026-06' }, { actor: asUser(owner), orgId });
    expect(locked).toMatchObject({ legalEntityId: defaultEntity, lockedThrough: '2026-06-30' });
    await asApp(owner, (c) => c.query(`SELECT crove_finance.unlock_period('2026-06-01'::date)`), true);
    await expect(
      runtime.execute('finance.period.lock', { month: '2026-06', legalEntityId: randomUUID() }, { actor: asUser(owner), orgId }),
    ).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED', status: 403 });
  });

  it('lists the entities a caller may see and resolves the one a call is for', async () => {
    const ownerList = await runtime.query<BookEntity[]>('finance.legal_entities.list', {}, { actor: asUser(owner), orgId });
    expect(ownerList.map((e) => [e.id, e.isDefault])).toEqual([
      [defaultEntity, true],
      [branch, false],
    ]);
    const memberList = await runtime.query<BookEntity[]>('finance.legal_entities.list', {}, { actor: asUser(member), orgId });
    expect(memberList).toEqual([{ id: branch, name: 'Chi nhánh Đà Nẵng', kind: 'branch', taxCode: null, isDefault: false }]);
    // The member sees one entity, so a call without one is for it; naming the default entity is refused.
    expect(await runtime.query<PeriodLockState>('finance.period.lock_state', {}, { actor: asUser(member), orgId })).toMatchObject({ legalEntityId: branch });
    await expect(runtime.query('finance.period.lock_state', { legalEntityId: defaultEntity }, { actor: asUser(member), orgId })).rejects.toMatchObject({
      code: 'LEGAL_ENTITY_NOT_ALLOWED',
    });
    // A member seeing two entities, none of them the default, must choose.
    const third = await admin(
      async (a) =>
        (await a.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Huế', 'branch', $2) RETURNING id`, [orgId, owner])).rows[0]
          ?.id as string,
    );
    await admin((a) =>
      a.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, member, third, owner]),
    );
    await expect(runtime.query('finance.period.lock_state', {}, { actor: asUser(member), orgId })).rejects.toMatchObject({ code: 'LEGAL_ENTITY_REQUIRED', status: 422 });
  });

  it('requires every parent of a row to be of its entity, and keeps sales invoices and bank lines unique per entity', async () => {
    await admin(async (a) => {
      const party = (await a.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'Khách hàng') RETURNING id`, [orgId])).rows[0]?.id;
      // A sales invoice number per entity: the same series and number in both entities.
      const sale = async (entity: string) => {
        await a.query('BEGIN');
        try {
          const doc = (
            await a.query<{ id: string }>(
              `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id)
               VALUES ($1, $2, '1C26TAA', '00000001', '2026-09-10', 100, 0, 100, 'sale', $3) RETURNING id`,
              [orgId, party, entity],
            )
          ).rows[0]?.id as string;
          const e = (
            await a.query<{ id: string }>(
              `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, '2026-09-10', 'bán', 'finance.purchase_document', $2, $3) RETURNING id`,
              [orgId, doc, entity],
            )
          ).rows[0]?.id as string;
          await a.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '131', 100, 0), ($1, $2, 2, '5111', 0, 100)`, [orgId, e]);
          await a.query('COMMIT');
          return { doc, entry: e };
        } catch (error) {
          await a.query('ROLLBACK');
          throw error;
        }
      };
      const inDefault = await sale(defaultEntity);
      const inBranch = await sale(branch);
      await expect(sale(branch)).rejects.toMatchObject({ code: '23505', constraint: 'purchase_document_sale_invoice_uq' });
      // A void naming a document of one entity and a reversal entry of another.
      await expect(
        a.query(`INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'nhầm')`, [orgId, inDefault.doc, inBranch.entry]),
      ).rejects.toMatchObject({ code: '23514', message: 'LEGAL_ENTITY_MISMATCH' });
      // Bank lines: the same key in two entities, refused twice in one.
      const line = (entity: string) =>
        a.query(
          `INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount, dedupe_key, legal_entity_id)
           VALUES ($1, '1121', $2, 1, '2026-09-02', 'chuyển khoản', 500000, 'ref:FT26001', $3)`,
          [orgId, randomUUID(), entity],
        );
      await line(defaultEntity);
      await line(branch);
      await expect(line(branch)).rejects.toMatchObject({ code: '23505', constraint: 'bank_line_dedupe_uq' });
    });
    // A member limited to the branch cannot attach a branch row under the default entity's document.
    await expect(
      asApp(member, (c) =>
        c.query(`INSERT INTO crove_finance.categorization_rule (org_id, legal_entity_id, match_kind, match_text, debit_account, source_document_id)
                 SELECT $1, $2, 'keyword', 'muc in', '6422', d.id FROM crove_finance.purchase_document d WHERE d.org_id = $1 LIMIT 1`, [orgId, branch]),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      admin(async (a) => {
        const doc = (await a.query<{ id: string }>(`SELECT id FROM crove_finance.purchase_document WHERE org_id = $1 AND legal_entity_id = $2 LIMIT 1`, [orgId, defaultEntity])).rows[0]?.id;
        return asApp(member, (c) =>
          c.query(`INSERT INTO crove_finance.categorization_rule (org_id, legal_entity_id, match_kind, match_text, debit_account, source_document_id) VALUES ($1, $2, 'keyword', 'giay a4', '6422', $3)`, [
            orgId,
            branch,
            doc,
          ]),
        );
      }),
    ).rejects.toThrow(new RegExp(`${RLS_DENIED.source}|null value in column "legal_entity_id"`));
  });
});
