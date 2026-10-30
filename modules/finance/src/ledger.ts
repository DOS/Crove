// The posting path, the only way to write the ledger. crove_finance.post_journal_entry() inserts an entry
// and all of its lines in one call, stamps org and author from the context and checks that it balances.
// The database refuses direct inserts, and lines added to an entry after the transaction that created it.
// A reversal (reversal.ts) is posted here too, as a new entry naming the one it reverses; the database checks
// that its lines mirror the original's. Nothing posts into a locked month, nor on or before the org's opening entry
// (period-lock.ts), and no amount has more decimals than the book currency uses (AMOUNT_SCALE, #1282).
// Each entry posts one revision of its source (#1283, ADR-0021 decision 5): posting the same revision again with the
// same payload returns the posted entry and writes nothing, another payload is refused (IDEMPOTENCY_CONFLICT), and a
// new revision must follow the previous one and come after its reversal (REVISION_OUT_OF_ORDER, SOURCE_STILL_POSTED).
import { sql } from 'kysely';
import { DomainError, type CommandContext } from '@crove/kernel-runtime';
import type { Money } from '@crove/l10n-vn';
import { legalEntityError } from './legal-entity.ts';
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
  // Which revision of the source this entry posts, 1 by default. A reversal is always revision 1 of its own source.
  sourceRevision?: number;
  // How a refusal for a date on or before the opening entry tells the user to go on (period-lock.ts); a later date by
  // default.
  beforeOpening?: BeforeOpeningChoice;
  // The legal entity the entry is booked in (#1280): resolveLegalEntity's answer for the command. Omitted: the reversed
  // entry's entity for a reversal, else the org's default entity (the posting path decides, and refuses an entity the
  // caller may not see).
  legalEntityId?: string;
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
        ${posting.reversesEntryId ?? null}::uuid, ${posting.sourceRevision ?? 1}::int, ${posting.legalEntityId ?? null}::uuid
      ) AS id`.execute(ctx.trx));
  } catch (error) {
    // An entry dated in a locked month, or on or before the opening entry (period-lock.ts), or an amount the book
    // currency cannot hold, or a source revision the ledger refuses: say so instead of a system error.
    throw postingGuardError(error, posting.beforeOpening) ?? amountScaleError(error) ?? sourceRevisionError(error) ?? legalEntityError(error) ?? error;
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

// The definer's refusals of a source revision (#1283), or null for any other error. Each is a conflict with what the
// ledger already holds for that source, so 409; the detail names the source and revisions, never an amount.
//   IDEMPOTENCY_CONFLICT (23505)    the revision was posted with another payload (lines, amounts, date or the entry it
//                                   reverses). Also the unique key itself, which a posting whose snapshot predates the
//                                   source lock (REPEATABLE READ) meets instead of a replay.
//   REVISION_OUT_OF_ORDER (23514)   not the revision right after the latest one posted.
//   SOURCE_STILL_POSTED (23514)     the previous revision has not been reversed yet.
//   REVERSAL_REVISION (23514)       a reversal posted as a revision other than 1 (no caller does today).
//   DOCUMENT_REPOST (23514)         a purchase or sale document posted again (journal_entry_document_one_revision,
//                                   #1928): a document is posted once; a wrong one is replaced by a new invoice (#916).
export function sourceRevisionError(error: unknown): DomainError | null {
  const pg = error as { code?: string; message?: string; detail?: string; constraint?: string } | null;
  const message = pg?.message;
  const known =
    (pg?.code === '23505' && (message === 'IDEMPOTENCY_CONFLICT' || pg.constraint === 'journal_entry_source_revision_key')) ||
    (pg?.code === '23514' &&
      (message === 'REVISION_OUT_OF_ORDER' ||
        message === 'SOURCE_STILL_POSTED' ||
        message === 'REVERSAL_REVISION' ||
        pg.constraint === 'journal_entry_document_one_revision'));
  if (!known) return null;
  let detail: { sourceType?: unknown; sourceId?: unknown; revision?: unknown; expected?: unknown; entryId?: unknown } = {};
  try {
    detail = JSON.parse(pg?.detail ?? '{}') as typeof detail;
  } catch {
    detail = {};
  }
  const revision = typeof detail.revision === 'number' ? detail.revision : null;
  const expected = typeof detail.expected === 'number' ? detail.expected : null;
  const entryId = typeof detail.entryId === 'string' ? detail.entryId : null;
  const source = {
    sourceType: typeof detail.sourceType === 'string' ? detail.sourceType : null,
    sourceId: typeof detail.sourceId === 'string' ? detail.sourceId : null,
    revision,
  };
  if (pg?.constraint === 'journal_entry_document_one_revision') {
    return new DomainError(
      'DOCUMENT_REPOST',
      409,
      'Hóa đơn đã ghi sổ một lần thì không ghi sổ lại được. Nếu hóa đơn sai, hãy đảo bút toán của nó và ghi hóa đơn thay thế hoặc điều chỉnh như một chứng từ mới.',
      source,
    );
  }
  if (message === 'REVISION_OUT_OF_ORDER') {
    const which = expected === null ? '' : ` (lần ${expected})`;
    const given = revision === null ? '' : `, không phải lần ${revision}`;
    return new DomainError('REVISION_OUT_OF_ORDER', 409, `Chứng từ này chỉ ghi sổ lại được bằng lần ghi kế tiếp${which}${given}.`, {
      ...source,
      expected,
    });
  }
  if (message === 'SOURCE_STILL_POSTED') {
    const which = revision === null ? '' : ` (lần ${revision})`;
    return new DomainError(
      'SOURCE_STILL_POSTED',
      409,
      `Bút toán trước của chứng từ này${which} vẫn còn trên sổ; hãy đảo bút toán đó trước rồi mới ghi sổ lại.`,
      { ...source, entryId },
    );
  }
  if (message === 'REVERSAL_REVISION') {
    return new DomainError('REVERSAL_REVISION', 409, 'Bút toán đảo chỉ ghi sổ một lần, như lần ghi đầu tiên của nó; không ghi lại bút toán đảo được.', {
      ...source,
      entryId,
    });
  }
  return new DomainError(
    'IDEMPOTENCY_CONFLICT',
    409,
    'Chứng từ này đã được ghi sổ với nội dung khác (dòng, số tiền, ngày hoặc bút toán được đảo); sổ giữ nguyên bút toán đã ghi.',
    { ...source, entryId },
  );
}
