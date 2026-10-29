// A re-posted source counts once (issue #1338). Since #1283 a source document may have several journal entries:
// revision 1, its reversal, then revision 2. The lists that join a source to its entry keep the latest revision only
// (modules/finance/src/source-entry.ts), so a purchase document and a cash voucher posted again each show once, with
// their revision 2 entry, and a document's export history names each file that took one of its revisions in, once.
// The entries are written by the database owner, as the posting path would leave them; the lists are read through the
// runtime as the org's owner.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

type Line = [lineNo: number, account: string, debit: string, credit: string];
const mirror = (lines: Line[]): Line[] => lines.map(([n, account, debit, credit]) => [n, account, credit, debit]);

const suite = ADMIN ? describe : describe.skip;

suite('a re-posted source counts once in the finance lists (#1338)', () => {
  const dbName = `crove_test_live_revision_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let userId = '';
  let orgId = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // Runs the steps in one transaction as the database owner, who may write the ledger directly; the deferred checks
  // (a document or voucher with its entry, a reversal with the void of its document) run at commit.
  const inTransaction = (steps: (c: pg.Client) => Promise<void>) =>
    admin(async (c) => {
      await c.query('BEGIN');
      try {
        await steps(c);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });

  async function entry(
    c: pg.Client,
    e: { date: string; sourceType: string; sourceId: string; revision?: number; reverses?: string; lines: Line[] },
  ): Promise<string> {
    const id = randomUUID();
    await c.query(
      `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, source_revision, reverses_entry_id)
       VALUES ($1, $2, $3, 'live revision', $4, $5, $6, $7)`,
      [orgId, id, e.date, e.sourceType, e.sourceId, e.revision ?? 1, e.reverses ?? null],
    );
    for (const [n, account, debit, credit] of e.lines) {
      await c.query('INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)', [
        orgId,
        id,
        n,
        account,
        debit,
        credit,
      ]);
    }
    return id;
  }

  const query = <T>(name: string, input: unknown) => runtime.query<T>(name, input, { actor: { type: 'user', userId, aal: 'aal1' }, orgId });
  // An export of the journal or a MISA file over a range, as the export routes record it (#878).
  const exported = (input: { from: string; to: string; format?: string }) =>
    runtime.execute('finance.journal.export', { ...input, entries: 1 }, { actor: { type: 'user', userId, aal: 'aal1' }, orgId, idempotencyKey: randomUUID() });

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 2 });
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    userId = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@live-revision.test', name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Công ty Ghi lại')).orgId;
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists a purchase document posted, reversed and posted again once, with its revision 2 entry', async () => {
    const party = randomUUID();
    const document = randomUUID();
    const lines: Line[] = [
      [1, '6422', '100000', '0'],
      [2, '1331', '10000', '0'],
      [3, '331', '0', '110000'],
    ];
    let first = '';
    await inTransaction(async (c) => {
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, name, tax_code) VALUES ($1, $2, 'Nhà cung cấp Ghi lại', '0101234564')`, [orgId, party]);
      await c.query(
        `INSERT INTO crove_finance.purchase_document (org_id, id, direction, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total)
         VALUES ($1, $2, 'purchase', $3, 'C26TLR', '501', '2026-09-10', 100000, 10000, 110000)`,
        [orgId, document, party],
      );
      first = await entry(c, { date: '2026-09-10', sourceType: 'finance.purchase_document', sourceId: document, lines });
    });
    // Exported while revision 1 is in force: the journal and the MISA purchases file of its dates.
    await exported({ from: '2026-09-01', to: '2026-09-15' });
    await exported({ from: '2026-09-01', to: '2026-09-15', format: 'misa_sme_purchases' });
    // The reversal of revision 1 voids the document in the same transaction, as finance.journal.reverse does. The void
    // stays: a purchase document has one void (#1928), so revision 2 counts in the ledger while the document stays out
    // of VAT and MISA. This test pins only that each list shows the document once.
    let reversal = '';
    await inTransaction(async (c) => {
      reversal = await entry(c, { date: '2026-09-20', sourceType: 'test.reversal', sourceId: randomUUID(), reverses: first, lines: mirror(lines) });
      await c.query(`INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'Ghi lại')`, [
        orgId,
        document,
        reversal,
      ]);
    });
    let second = '';
    await inTransaction(async (c) => {
      second = await entry(c, { date: '2026-09-25', sourceType: 'finance.purchase_document', sourceId: document, revision: 2, lines });
    });
    // Exported after revision 2: the journal of its dates, the journal of the month, which holds both revisions, and a
    // MISA file, which leaves the voided document out.
    await exported({ from: '2026-09-20', to: '2026-09-30' });
    await exported({ from: '2026-09-01', to: '2026-09-30' });
    await exported({ from: '2026-09-01', to: '2026-09-30', format: 'misa_sme_purchases' });

    // Two entries name the document; the list shows it once, with revision 2.
    const listed = (await query<Array<{ id: string; journalEntryId: string | null }>>('finance.documents.list', {})).filter((d) => d.id === document);
    expect(listed).toEqual([expect.objectContaining({ id: document, journalEntryId: second })]);
    expect(await query('finance.documents.get', { id: document })).toMatchObject({ id: document, journalEntryId: second, voided: { reversalEntryId: reversal } });
    // The voided document stays out of the MISA export, as before.
    expect(await query<unknown[]>('finance.vouchers.purchases', { from: '2026-09-01', to: '2026-09-30' })).toEqual([]);
    // The document's export history: each file that took one of its revisions in, once.
    const history = await query<Array<{ format: string; from: string | null; to: string | null }>>('finance.document.exports', { documentId: document });
    expect(history.map((h) => [h.format, h.from, h.to])).toEqual([
      ['journal', '2026-09-01', '2026-09-15'],
      ['misa_sme_purchases', '2026-09-01', '2026-09-15'],
      ['journal', '2026-09-20', '2026-09-30'],
      ['journal', '2026-09-01', '2026-09-30'],
    ]);
    // The journal lists every entry: both revisions and the reversal.
    const journal = await query<Array<{ id: string }>>('finance.journal.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(journal.map((e) => e.id).sort()).toEqual([first, reversal, second].sort());
  });

  it('lists a cash voucher posted, reversed and posted again once, in force with its revision 2 entry', async () => {
    const voucher = randomUUID();
    const lines: Line[] = [
      [1, '1111', '500000', '0'],
      [2, '711', '0', '500000'],
    ];
    let first = '';
    await inTransaction(async (c) => {
      await c.query(
        `INSERT INTO crove_finance.cash_voucher (org_id, id, voucher_type, voucher_date, cash_account, description, amount)
         VALUES ($1, $2, 'cash_receipt', '2026-10-05', '1111', 'Thu tiền ghi lại', 500000)`,
        [orgId, voucher],
      );
      first = await entry(c, { date: '2026-10-05', sourceType: 'finance.cash_voucher', sourceId: voucher, lines });
    });
    await inTransaction(async (c) => {
      await entry(c, { date: '2026-10-08', sourceType: 'test.reversal', sourceId: randomUUID(), reverses: first, lines: mirror(lines) });
    });
    let second = '';
    await inTransaction(async (c) => {
      second = await entry(c, { date: '2026-10-09', sourceType: 'finance.cash_voucher', sourceId: voucher, revision: 2, lines });
    });

    // Before #1338 the list showed the voucher twice: revision 1 with its reversal, and revision 2.
    const page = await query<{ items: Array<{ id: string; journalEntryId: string | null; reversal: unknown }> }>('finance.vouchers.list', {});
    expect(page.items.filter((v) => v.id === voucher)).toEqual([expect.objectContaining({ id: voucher, journalEntryId: second, reversal: null })]);
    // The MISA export of receipts: once, in force.
    expect(await query<unknown[]>('finance.vouchers.cash', { type: 'cash_receipt' })).toHaveLength(1);
  });
});
