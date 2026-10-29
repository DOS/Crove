// A ledger row that names a proposal names one being executed by its own command (#1853, from the review of #1848) on
// PostgreSQL 17, as the real login roles. A purchase document, cash voucher or journal voucher with a proposal_id, and a
// journal entry of source kernel.proposal, are what #1842 counts as a ledger proposal's effect; each must name a
// proposal of the writer's org, 'approved', for the command that writes that row. A row naming a pending, executed,
// rejected proposal, another command's, another org's or none at all is refused (EFFECT_PROPOSAL_MISMATCH), for the
// owner's and the worker's system context alike, and a proposal outside the writer's legal entities is refused too;
// the tables are append-only, so a written proposal_id never changes; a replacement invoice's reversal of its original
// names the purchase's proposal; staff are not checked. Part of the invariant suite: keep it self-contained (package code under test, no helpers from outside
// test/invariant/). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { enterUser } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const REFUSED = { code: '23514', message: 'EFFECT_PROPOSAL_MISMATCH' };
const LINES = JSON.stringify([
  { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
  { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
]);
const MIRRORED = JSON.stringify([
  { line_no: 1, account_code: '6422', debit: '0', credit: '100000' },
  { line_no: 2, account_code: '331', debit: '100000', credit: '0' },
]);
const suite = ADMIN ? describe : describe.skip;

type Outcome = { ok: true; value: unknown } | { ok: false; code: string | undefined; message: string };

suite('ledger rows naming a proposal on PostgreSQL (#1853)', () => {
  const dbName = `crove_test_effect_proposal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool | undefined;
  let owner = '';
  let orgId = '';
  let otherOrg = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // One transaction as the given writer (the owner, the worker's system context, or another member), always rolled
  // back.
  async function as(writer: string, fn: (c: pg.Client) => Promise<unknown>): Promise<Outcome> {
    const c = new pg.Client({ connectionString: writer === 'system' ? workerUrl : appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      if (writer === 'system') await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
      else await enterUser(c, writer === 'owner' ? owner : writer, orgId);
      return { ok: true, value: await fn(c) };
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { ok: false, code: e.code, message: e.message };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  // A proposal of the command in the given state and org, written by the database owner (staff are not checked).
  // NULL entity: the org's default one.
  const proposal = (command: string, status: 'pending' | 'approved' | 'executed' | 'rejected', org = orgId, entity: string | null = null) =>
    admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, eligible_approvers, authors, decided_by, decided_at, executed_command_id,
                                                legal_entity_id)
             VALUES ($1, 'test.effect', $2, $3, 'T1853', '{"n": 1}', ARRAY[$4::uuid], '[]',
                     CASE WHEN $3 = 'pending' THEN NULL ELSE $4::uuid END, CASE WHEN $3 = 'pending' THEN NULL ELSE now() END,
                     CASE WHEN $3 IN ('approved', 'executed') THEN gen_random_uuid() END,
                     coalesce($5::uuid, (SELECT e.id FROM crove_kernel.legal_entity e WHERE e.org_id = $1 AND e.is_default))) RETURNING id`,
            [org, command, status, owner, entity],
          )
        ).rows[0]?.id as string,
    );

  // The rows each command writes, naming the proposal.
  const purchaseDocument = (proposalId: string) => (c: pg.Client) =>
    c.query(
      `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total, proposal_id)
       SELECT $1::uuid, p.id, $3::text, '2026-10-15', 100000, 0, 100000, $2::uuid FROM crove_kernel.party p WHERE p.org_id = $1::uuid ORDER BY p.id LIMIT 1`,
      [orgId, proposalId, `T${randomUUID().slice(0, 8)}`],
    );
  const cashVoucher = (proposalId: string) => (c: pg.Client) =>
    c.query(
      `INSERT INTO crove_finance.cash_voucher (org_id, voucher_type, number, voucher_date, cash_account, description, amount, proposal_id)
       VALUES ($1, 'cash_receipt', 0, '2026-10-15', '1111', 'thu tiền', 100000, $2)`,
      [orgId, proposalId],
    );
  const journalVoucher = (proposalId: string) => (c: pg.Client) =>
    c.query(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id) VALUES ($1, '2026-10-15', 'chứng từ', $2)`, [orgId, proposalId]);
  // An entry, then its reversal ordered by the proposal (source kernel.proposal), as finance.journal.reverse posts it.
  const reversal = (proposalId: string) => async (c: pg.Client) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT crove_finance.post_journal_entry('2026-10-15'::date, 'gốc', 'test.original', $1::uuid, $2::jsonb) AS id`,
      [randomUUID(), LINES],
    );
    return c.query(`SELECT crove_finance.post_journal_entry('2026-10-15'::date, 'đảo', 'kernel.proposal', $1::uuid, $2::jsonb, $3::uuid, 1)`, [
      proposalId,
      MIRRORED,
      rows[0]?.id,
    ]);
  };

  const PATHS = [
    { name: 'purchase document', command: 'finance.purchase.record', write: purchaseDocument },
    { name: 'cash voucher', command: 'finance.voucher.record', write: cashVoucher },
    { name: 'journal voucher', command: 'finance.journal_voucher.record', write: journalVoucher },
    { name: 'reversal entry', command: 'finance.journal.reverse', write: reversal },
  ] as const;

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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 2 });
    const db = createDb(pool);
    const rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@effect-proposal.test', name: null });
    ({ orgId } = await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Chứng từ có đề xuất'));
    ({ orgId: otherOrg } = await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Tổ chức khác'));
    // A seller for the purchase documents.
    await admin((c) => c.query(`INSERT INTO crove_kernel.party (org_id, name, tax_code) VALUES ($1, 'Người bán', '0101234567')`, [orgId]));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("writes each row naming an approved proposal of the row's own command", async () => {
    for (const path of PATHS) {
      for (const writer of ['owner', 'system'] as const) {
        const id = await proposal(path.command, 'approved');
        await expect(as(writer, path.write(id)), `${writer}: ${path.name}`).resolves.toMatchObject({ ok: true });
      }
    }
    // The other commands that post a journal voucher.
    for (const command of ['finance.closing.record', 'finance.depreciation.record']) {
      const id = await proposal(command, 'approved');
      await expect(as('owner', journalVoucher(id)), command).resolves.toMatchObject({ ok: true });
    }
    // A replacement invoice reverses its original's entry in the name of the purchase's proposal (#916).
    const replacement = await proposal('finance.purchase.record', 'approved');
    await expect(as('owner', reversal(replacement)), 'replacement invoice reversal').resolves.toMatchObject({ ok: true });
  });

  it('refuses a row naming a pending, executed or rejected proposal, another command, another org or no proposal', async () => {
    for (const path of PATHS) {
      // A ledger command none of this row's writers is (a purchase may write a reversal entry, #916).
      const other = path.command === 'finance.voucher.record' ? 'finance.purchase.record' : 'finance.voucher.record';
      const cases: Array<[string, string]> = [
        ['a pending proposal', await proposal(path.command, 'pending')],
        ['an executed proposal', await proposal(path.command, 'executed')],
        ['a rejected proposal', await proposal(path.command, 'rejected')],
        ["another command's proposal", await proposal(other, 'approved')],
        ["another org's proposal", await proposal(path.command, 'approved', otherOrg)],
        ['no proposal at all', randomUUID()],
      ];
      for (const [label, id] of cases) {
        for (const writer of ['owner', 'system'] as const) {
          await expect(as(writer, path.write(id)), `${writer}: ${path.name}, ${label}`).resolves.toMatchObject({ ok: false, ...REFUSED });
        }
      }
    }
  });

  it('never lets a written proposal_id change, and leaves rows with none and staff writes alone', async () => {
    const pending = await proposal('finance.purchase.record', 'pending');
    // The tables are append-only: no tenant writer updates a row (refused before any row is read), so the insert is
    // the only check needed.
    for (const table of ['purchase_document', 'cash_voucher', 'journal_voucher']) {
      await expect(
        as('owner', (c) => c.query(`UPDATE crove_finance.${table} SET proposal_id = $2 WHERE org_id = $1 AND id = $3`, [orgId, pending, randomUUID()])),
        table,
      ).resolves.toMatchObject({ ok: false, code: '42501' });
    }
    // A row naming no proposal, from a tenant writer.
    await expect(
      as('owner', (c) =>
        c.query(
          `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total)
           SELECT $1::uuid, p.id, 'T-free', '2026-10-15', 100000, 0, 100000 FROM crove_kernel.party p WHERE p.org_id = $1::uuid ORDER BY p.id LIMIT 1`,
          [orgId],
        ),
      ),
    ).resolves.toMatchObject({ ok: true });
    // Staff (the database owner) may write history as it was; rolled back, since a voucher commits only with its entry.
    const staff = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        return (await c.query(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id) VALUES ($1, '2026-10-15', 'sửa', $2)`, [orgId, pending]))
          .rowCount;
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(staff).toBe(1);
  });

  it("refuses a proposal the writer's legal entities do not include, as the writer cannot read it", async () => {
    const branch = await admin(
      async (c) =>
        (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner]))
          .rows[0]?.id as string,
    );
    const user = await upsertIdentity(createDb(pool as pg.Pool), { issuer: 'test', subject: randomUUID(), email: 'limited@effect-proposal.test', name: null });
    const limited = await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, user]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        user,
        branch,
        owner,
      ]);
      return user;
    });
    const ofBranch = await proposal('finance.journal_voucher.record', 'approved', orgId, branch);
    const ofDefault = await proposal('finance.journal_voucher.record', 'approved');
    // The branch's voucher, as the member limited to the branch writes it.
    const write = (proposalId: string) => (c: pg.Client) =>
      c.query(`INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, legal_entity_id) VALUES ($1, '2026-10-15', 'chi nhánh', $2, $3)`, [
        orgId,
        proposalId,
        branch,
      ]);
    await expect(as(limited, write(ofBranch))).resolves.toMatchObject({ ok: true });
    await expect(as(limited, write(ofDefault))).resolves.toMatchObject({ ok: false, ...REFUSED });
  });
});
