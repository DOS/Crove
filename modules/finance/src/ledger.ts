// The posting path, the only way to write the ledger. crove_finance.post_journal_entry() inserts an entry
// and all of its lines in one call, stamps org and author from the context and checks that it balances.
// The database refuses direct inserts, and lines added to an entry after the transaction that created it.
// A reversal (reversal.ts) is posted here too, as a new entry naming the one it reverses; the database checks
// that its lines mirror the original's. Nothing posts into a locked month, nor on or before the org's opening entry
// (period-lock.ts), and no amount has more decimals than the book currency uses (AMOUNT_SCALE, #1282).
import { sql } from 'kysely';
import { DomainError, type CommandContext } from '@crove/kernel-runtime';
import type { Money } from '@crove/l10n-vn';
import { postingGuardError, type BeforeOpeningChoice } from './period-lock.ts';

export interface PostingLine {
  lineNo: number;
  accountCode: string;
  debit: Money;
  credit: Money;
  partyId: string | null;
  memo: string | null;
}

export interface Posting {
  entryDate: string;
  description: string;
  sourceType: string;
  sourceId: string;
  lines: PostingLine[];
  // The posted entry this one reverses, or omitted for an ordinary entry.
  reversesEntryId?: string;
  // How a refusal for a date on or before the opening entry tells the user to go on (period-lock.ts); a later date by
  // default.
  beforeOpening?: BeforeOpeningChoice;
}

export async function postJournalEntry(ctx: CommandContext, posting: Posting): Promise<string> {
  const lines = posting.lines.map((l) => ({
    line_no: l.lineNo,
    account_code: l.accountCode,
    debit: l.debit,
    credit: l.credit,
    party_id: l.partyId,
    memo: l.memo,
  }));
  let rows: Array<{ id: string }>;
  try {
    ({ rows } = await sql<{ id: string }>`
      SELECT crove_finance.post_journal_entry(
        ${posting.entryDate}::date, ${posting.description}, ${posting.sourceType}, ${posting.sourceId}::uuid, ${JSON.stringify(lines)}::jsonb,
        ${posting.reversesEntryId ?? null}::uuid
      ) AS id`.execute(ctx.trx));
  } catch (error) {
    // An entry dated in a locked month, or on or before the opening entry (period-lock.ts), or an amount the book
    // currency cannot hold: say so instead of a system error.
    throw postingGuardError(error, posting.beforeOpening) ?? amountScaleError(error) ?? error;
  }
  const id = rows[0]?.id;
  if (!id) throw new DomainError('INTERNAL', 500, 'Không ghi được bút toán');
  return id;
}

// The definer's refusal of an amount with more decimals than the book currency uses (22023 AMOUNT_SCALE, with the line,
// account, currency, minor units and amount as JSON detail), or null for any other error. The ledger never rounds it
// silently. The line is the journal line, after amounts are added up per account, so the message names the account.
// An invoice with such an amount is refused earlier, before posting (record.ts AMOUNT_BELOW_DONG).
export function amountScaleError(error: unknown): DomainError | null {
  const pg = error as { code?: string; message?: string; detail?: string } | null;
  if (pg?.code !== '22023' || pg.message !== 'AMOUNT_SCALE') return null;
  let detail: { lineNo?: unknown; account?: unknown; currency?: unknown; minorUnits?: unknown; amount?: unknown } = {};
  try {
    detail = JSON.parse(pg.detail ?? '{}') as typeof detail;
  } catch {
    detail = {};
  }
  const lineNo = typeof detail.lineNo === 'number' ? detail.lineNo : null;
  const account = typeof detail.account === 'string' ? detail.account : null;
  const currency = typeof detail.currency === 'string' ? detail.currency : null;
  const minorUnits = typeof detail.minorUnits === 'number' ? detail.minorUnits : null;
  const amount = typeof detail.amount === 'string' ? detail.amount : null;
  const where = account === null ? 'Bút toán có số tiền' : `Số tiền ghi vào tài khoản ${account}`;
  const rule =
    minorUnits === 0 || minorUnits === null
      ? `sổ ghi bằng ${currency ?? 'VND'} không có số lẻ`
      : `${currency ?? 'đồng tiền ghi sổ'} chỉ có ${minorUnits} chữ số sau dấu phẩy`;
  return new DomainError(
    'AMOUNT_SCALE',
    422,
    `${where}${amount === null ? '' : ` (${amount})`} lẻ hơn mức cho phép: ${rule}. Sổ không tự làm tròn; hãy sửa số tiền ở dòng đó thành số đã làm tròn rồi ghi lại.`,
    { lineNo, account, currency, minorUnits, amount },
  );
}
