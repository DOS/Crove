// Bank statements (issue #326, stage 1): a bank's Excel or CSV export, read in the browser, becomes the statement lines
// of one bank account, deduplicated as ADR-0021 section 6 says (domain/bank-statement.ts). A line becomes a bank voucher
// in stage 2a (bank-match.ts).
// - finance.bank.preview: checks a file against what the account has and answers line by line. It writes nothing.
// - finance.bank.import: checks it again and stores its new and ambiguous lines, refusing a file with an invalid row.
//   R1: it records the bank's own figures and posts nothing. Imports of one account are serialized by a
//   transaction-level advisory lock, so two at once cannot both store the same line: the second waits, then sees the
//   first's lines (READ COMMITTED, the runtime's isolation for commands). The unique key on (account, dedupe_key)
//   refuses a double from any writer anyway, and the insert skips a key already there rather than failing.
// - finance.bank.lines: the stored lines of one account for a month, quarter or year, each with what became of it
//   (stage 2a, bank-match.ts: open, proposed as a voucher, or settled by one).
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zBankStatementImport, zLedgerPeriod, type BankImportPreview, type BankImportResult, type BankLines, type BankStatementImport } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { resolveLegalEntity } from './legal-entity.ts';
import { Decimal } from '@crove/l10n-vn';
import { chartAccounts } from './accounts.ts';
import { bankLineStates } from './bank-match.ts';
import { checkStatement, readStatement, type StatementCheck, type StoredChainLine } from './domain/bank-statement.ts';
import { ledgerPeriod } from './domain/ledger-reports.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// Importing statements is data entry, like uploading invoices.
const IMPORTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const BANK_IMPORT_KIND = 'finance.bank_statement';

// A bank account of the org: a TT133 account under 112, or a sub-account rolling up to one. An import needs it active.
async function bankAccount(ctx: QueryContext, code: string, active: boolean) {
  const account = (await chartAccounts(ctx, [code])).get(code);
  if (!account || !account.rootCode.startsWith('112')) {
    throw new DomainError('NOT_A_BANK_ACCOUNT', 422, `Tài khoản ${code} không phải tài khoản tiền gửi ngân hàng (112) của tổ chức`, { code });
  }
  if (active && !account.active) {
    throw new DomainError('ACCOUNT_INACTIVE', 422, `Tài khoản ${code} đã ngừng sử dụng; hãy chọn tài khoản khác`, { codes: [code] });
  }
  return account;
}

// What the account already has around the file: the stored keys among the file's, the date and amount of stored lines
// on the file's days, the last stored line before its first day and the stored lines of its days, in import order.
// Of one legal entity (#1280): a bank account's lines are deduplicated and chained per entity.
async function check(ctx: QueryContext, input: BankStatementImport, legalEntityId: string): Promise<StatementCheck> {
  const { lines, keys } = readStatement(input);
  const dates = lines.map((l) => l.date).sort();
  const from = dates[0];
  const to = dates.at(-1);
  const fileKeys = keys.filter((k): k is string => k !== null);
  const storedKeys =
    fileKeys.length === 0
      ? []
      : await ctx.trx
          .selectFrom('crove_finance.bank_line')
          .select('dedupe_key')
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', legalEntityId)
          .where('bank_account', '=', input.bankAccount)
          .where('dedupe_key', 'in', fileKeys)
          .execute();
  let within: Array<StoredChainLine> = [];
  let before: StoredChainLine | null = null;
  if (from && to) {
    within = await ctx.trx
      .selectFrom('crove_finance.bank_line')
      .select(['value_date as date', 'amount', 'running_balance as balance'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('bank_account', '=', input.bankAccount)
      .where('value_date', '>=', from)
      .where('value_date', '<=', to)
      .orderBy('value_date')
      .orderBy('import_id')
      .orderBy('position')
      .execute();
    before =
      (await ctx.trx
        .selectFrom('crove_finance.bank_line')
        .select(['value_date as date', 'amount', 'running_balance as balance'])
        .where('org_id', '=', ctx.orgId)
        .where('legal_entity_id', '=', legalEntityId)
        .where('bank_account', '=', input.bankAccount)
        .where('value_date', '<', from)
        .orderBy('value_date', 'desc')
        .orderBy('import_id', 'desc')
        .orderBy('position', 'desc')
        .executeTakeFirst()) ?? null;
  }
  const dateAmounts = new Set(within.map((l) => `${l.date}|${new Decimal(l.amount).toFixed()}`));
  return checkStatement(
    input,
    { keys: new Set(storedKeys.map((k) => k.dedupe_key as string)), dateAmounts },
    {
      before: before && { ...before, amount: new Decimal(before.amount).toFixed(), balance: before.balance === null ? null : new Decimal(before.balance).toFixed() },
      within: within.map((l) => ({ ...l, amount: new Decimal(l.amount).toFixed(), balance: l.balance === null ? null : new Decimal(l.balance).toFixed() })),
    },
  );
}

const lockAccount = (ctx: QueryContext, legalEntityId: string, code: string) =>
  sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`${BANK_IMPORT_KIND}:${ctx.orgId}:${legalEntityId}:${code}`}, 0))`.execute(ctx.trx);

export const bankPreview = defineQuery({
  name: 'finance.bank.preview',
  input: zBankStatementImport,
  access: IMPORTERS,
  handler: async (ctx, input): Promise<BankImportPreview> => {
    await bankAccount(ctx, input.bankAccount, true);
    return (await check(ctx, input, await resolveLegalEntity(ctx, input.legalEntityId))).preview;
  },
});

export const bankImport = defineCommand({
  name: 'finance.bank.import',
  input: zBankStatementImport,
  risk: 'R1',
  access: IMPORTERS,
  handler: async (ctx, input): Promise<BankImportResult> => {
    await bankAccount(ctx, input.bankAccount, true);
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    await lockAccount(ctx, legalEntityId, input.bankAccount);
    const { preview, lines } = await check(ctx, input, legalEntityId);
    if (!preview.ok) {
      throw new DomainError('BANK_IMPORT_INVALID', 422, 'Sao kê có dòng không đọc được; hãy xem lại trước khi nhập', {
        rows: preview.rows.filter((r) => r.errors.length > 0).map((r) => r.rowNo),
      });
    }
    // Time-ordered and taken under the lock, so ordering by import_id is the order the imports were made in.
    const { rows: ids } = await sql<{ id: string }>`SELECT crove_kernel.uuid_v7() AS id`.execute(ctx.trx);
    const importId = ids[0]?.id;
    if (!importId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    const actor = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    let stored = 0;
    // In chunks, so a long statement stays under the bind-parameter limit.
    for (let i = 0; i < lines.length; i += 500) {
      const chunk = lines.slice(i, i + 500);
      const inserted = await ctx.trx
        .insertInto('crove_finance.bank_line')
        .values(
          chunk.map((l) => ({
            org_id: ctx.orgId,
            legal_entity_id: legalEntityId,
            bank_account: input.bankAccount,
            import_id: importId,
            position: l.position,
            value_date: l.date,
            description: l.description,
            amount: l.amount,
            running_balance: l.balance,
            bank_ref: l.reference,
            dedupe_key: l.key,
            ambiguous: l.ambiguous,
            created_by: actor,
          })),
        )
        .onConflict((oc) => oc.columns(['org_id', 'legal_entity_id', 'bank_account', 'dedupe_key']).where('dedupe_key', 'is not', null).doNothing())
        .returning('id')
        .execute();
      stored += inserted.length;
    }
    // Under the lock nothing else stores lines of this account, so every line the check called new was stored.
    if (stored !== lines.length) throw new DomainError('RETRY', 409, 'Xung đột đồng thời, hãy thử lại');
    const result = { importId, counts: preview.counts, breaks: preview.breaks };
    ctx.audit({ bankAccount: input.bankAccount, importId, filename: input.filename, from: preview.from, to: preview.to, ...preview.counts, breaks: preview.breaks.length });
    await ctx.activity(
      'finance.bank_account',
      importId,
      'bank.statement_imported',
      `Nhập sao kê ${input.bankAccount}: ${preview.counts.new + preview.counts.ambiguous} dòng mới, ${preview.counts.duplicate} dòng đã có`,
    );
    // Lines that need a look: the owners and admins are told (#671, finance.notification.dispatch).
    if (preview.counts.ambiguous > 0) await ctx.emit('finance.bank.imported', { importId, bankAccount: input.bankAccount, ambiguous: preview.counts.ambiguous });
    return result;
  },
});

export const bankLines = defineQuery({
  name: 'finance.bank.lines',
  input: z.object({ bankAccount: z.string().max(50), period: zLedgerPeriod }),
  access: ALL,
  handler: async (ctx, input): Promise<BankLines> => {
    await bankAccount(ctx, input.bankAccount, false);
    const period = ledgerPeriod(input.period);
    const rows = await ctx.trx
      .selectFrom('crove_finance.bank_line')
      .select(['id', 'value_date', 'description', 'amount', 'running_balance', 'bank_ref', 'ambiguous', 'import_id'])
      .where('org_id', '=', ctx.orgId)
      .where('bank_account', '=', input.bankAccount)
      .where('value_date', '>=', period.from)
      .where('value_date', '<=', period.to)
      .orderBy('value_date')
      .orderBy('import_id')
      .orderBy('position')
      .execute();
    const states = await bankLineStates(ctx, rows.map((r) => r.id));
    let moneyIn = new Decimal(0);
    let moneyOut = new Decimal(0);
    const lines = rows.map((r) => {
      const amount = new Decimal(r.amount);
      if (amount.isPositive()) moneyIn = moneyIn.plus(amount);
      else moneyOut = moneyOut.plus(amount.abs());
      return {
        id: r.id,
        date: r.value_date,
        description: r.description,
        amount: amount.toFixed(),
        balance: r.running_balance === null ? null : new Decimal(r.running_balance).toFixed(),
        reference: r.bank_ref,
        ambiguous: r.ambiguous,
        importId: r.import_id,
        state: states.get(r.id) ?? { status: 'open' as const },
      };
    });
    return { bankAccount: input.bankAccount, from: period.from, to: period.to, lines, moneyIn: moneyIn.toFixed(), moneyOut: moneyOut.toFixed() };
  },
});
