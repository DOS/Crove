// The posting path, the only way to write the ledger. crove_finance.post_journal_entry() inserts an entry
// and all of its lines in one call, stamps org and author from the context and checks that it balances.
// The database refuses direct inserts, and lines added to an entry after the transaction that created it.
// A reversal (reversal.ts) is posted here too, as a new entry naming the one it reverses; the database checks
// that its lines mirror the original's. Nothing posts into a locked month, nor on or before the org's opening entry
// (period-lock.ts), and no amount has more decimals than the book currency uses (AMOUNT_SCALE, #1282).
// Each entry posts one revision of its source (#1283, ADR-0021 decision 5): posting the same revision again with the
// same payload returns the posted entry and writes nothing, another payload is refused (IDEMPOTENCY_CONFLICT), and a
// new revision must follow the previous one and come after its reversal (REVISION_OUT_OF_ORDER, SOURCE_STILL_POSTED).
// The caller learns which (#1925): `replayed` is true when the entry was already on the books, so it skips what it does
// once per posting (its activity, its event, the rows that depend on the entry). A replay of an entry no longer in force
// (a later revision posted, or the entry reversed) is refused (POSTING_SUPERSEDED): a retried old request never takes
// a reversed entry for the one on the books.
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

export interface PostingResult {
  id: string;
  // True when the same revision and payload were already posted (in this transaction or an earlier one): nothing was
  // written, and the posting's side effects already happened then.
  replayed: boolean;
}

export async function postJournalEntry(ctx: CommandContext, posting: Posting): Promise<PostingResult> {
  const lines = posting.lines.map((l) => ({
    line_no: l.lineNo,
    account_code: l.accountCode,
    debit: l.debit,
    credit: l.credit,
    party_id: l.partyId,
    memo: l.memo,
  }));
  const revision = posting.sourceRevision ?? 1;
  // One source at a time, with the lock the definer takes first (the same key: the definer's org is the context's, which
  // is ctx.orgId, never NULL, since a NULL part would take no lock at all), so no other transaction can post this
  // revision between the look below and the definer's own. Held to the end of the transaction; the definer's second
  // take of it is free.
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'crove_finance.journal_entry.source:' || ${ctx.orgId}::uuid::text || ':' || ${posting.sourceType}::text || ':' || ${posting.sourceId}::uuid::text, 0))`.execute(
    ctx.trx,
  );
  // Already posted: the definer replays it (same payload) or refuses it (another one). A replay can only be of an entry
  // this caller may see: the definer replays only into the entity the context allows.
  const before = await ctx.trx
    .selectFrom('crove_finance.journal_entry')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('source_type', '=', posting.sourceType)
    .where('source_id', '=', posting.sourceId)
    .where('source_revision', '=', revision)
    .executeTakeFirst();
  let rows: Array<{ id: string }>;
  try {
    ({ rows } = await sql<{ id: string }>`
      SELECT crove_finance.post_journal_entry(
        ${posting.entryDate}::date, ${posting.description}, ${posting.sourceType}, ${posting.sourceId}::uuid, ${JSON.stringify(lines)}::jsonb,
        ${posting.reversesEntryId ?? null}::uuid, ${revision}::int, ${posting.legalEntityId ?? null}::uuid
      ) AS id`.execute(ctx.trx));
  } catch (error) {
    // An entry dated in a locked month, or on or before the opening entry (period-lock.ts), or an amount the book
    // currency cannot hold, or a source revision the ledger refuses: say so instead of a system error.
    throw postingGuardError(error, posting.beforeOpening) ?? amountScaleError(error) ?? sourceRevisionError(error) ?? legalEntityError(error) ?? error;
  }
  const id = rows[0]?.id;
  if (!id) throw new DomainError('INTERNAL', 500, 'Không ghi được bút toán');
  if (!before) return { id, replayed: false };
  if (before.id !== id) throw new DomainError('INTERNAL', 500, 'Không ghi được bút toán');
  // A replay: the entry must still be the one in force for its source.
  const state = await ctx.trx
    .selectFrom('crove_finance.journal_entry as e')
    .select((eb) => [
      eb
        .exists(
          eb
            .selectFrom('crove_finance.journal_entry as later')
            .select('later.id')
            .whereRef('later.org_id', '=', 'e.org_id')
            .whereRef('later.source_type', '=', 'e.source_type')
            .whereRef('later.source_id', '=', 'e.source_id')
            .whereRef('later.source_revision', '>', 'e.source_revision'),
        )
        .as('superseded'),
      eb
        .exists(eb.selectFrom('crove_finance.journal_entry as r').select('r.id').whereRef('r.org_id', '=', 'e.org_id').whereRef('r.reverses_entry_id', '=', 'e.id'))
        .as('reversed'),
    ])
    .where('e.org_id', '=', ctx.orgId)
    .where('e.id', '=', id)
    .executeTakeFirstOrThrow();
  if (state.superseded || state.reversed) {
    throw new DomainError(
      'POSTING_SUPERSEDED',
      409,
      state.superseded
        ? 'Chứng từ này đã được ghi sổ lại bằng một lần ghi sau; yêu cầu này là của lần ghi cũ nên sổ không ghi lại nó.'
        : 'Bút toán của yêu cầu này đã bị đảo; sổ không ghi lại nó. Nếu cần, hãy ghi sổ chứng từ bằng lần ghi kế tiếp.',
      { sourceType: posting.sourceType, sourceId: posting.sourceId, revision, entryId: id, reason: state.superseded ? 'later_revision' : 'reversed' },
    );
  }
  return { id, replayed: true };
}

// The posting of a caller whose source is new in its own command (a voucher or document it just inserted, the command's
// own id, the approval it runs under): a replay cannot be a retry of this posting, so it is refused (ALREADY_POSTED)
// rather than taken as success, and nothing the caller does once per posting runs twice.
export async function postNewEntry(ctx: CommandContext, posting: Posting): Promise<string> {
  const posted = await postJournalEntry(ctx, posting);
  if (posted.replayed) {
    throw new DomainError('ALREADY_POSTED', 409, 'Chứng từ này đã được ghi sổ rồi; lần ghi này không ghi gì thêm.', {
      sourceType: posting.sourceType,
      sourceId: posting.sourceId,
      revision: posting.sourceRevision ?? 1,
      entryId: posted.id,
    });
  }
  return posted.id;
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
