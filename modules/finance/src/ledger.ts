// The posting path, the only way to write the ledger. crove_finance.post_journal_entry() inserts an entry
// and all of its lines in one call, stamps org and author from the context and checks that it balances.
// The database refuses direct inserts, and lines added to an entry after the transaction that created it.
// A reversal (reversal.ts) is posted here too, as a new entry naming the one it reverses; the database checks
// that its lines mirror the original's. Nothing posts into a locked month (period-lock.ts).
import { sql } from 'kysely';
import { DomainError, type CommandContext } from '@crove/kernel-runtime';
import type { Money } from '@crove/l10n-vn';
import { periodLockedError } from './period-lock.ts';

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
    // An entry dated in a locked month (period-lock.ts): say so instead of a system error.
    throw periodLockedError(error) ?? error;
  }
  const id = rows[0]?.id;
  if (!id) throw new DomainError('INTERNAL', 500, 'Không ghi được bút toán');
  return id;
}
