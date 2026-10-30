// A pure model of the ledger posting rules (ADR-0021 decisions 1 and 5): balance, amount scale, reversal and
// source_revision replay. It does not touch the database; `crove_finance.post_journal_entry()` stays the only
// write path. The model is the reference the property tests check, and the rules the Phase 2a definer must
// keep. State is immutable: every call returns a new state or a refusal.
import { createHash } from 'node:crypto';
import { money, sum, type DecimalValue, type Money } from '@crove/l10n-vn';
import { canonical, checkAmount, fixed4, minorUnits, MoneyError, parseDecimal } from './money.ts';

export const REVERSAL_SOURCE_TYPE = 'reversal';
export const REVERSAL_DOC_TYPE = 'NVK';

export interface LineInput {
  lineNo: number;
  accountCode: string;
  debit: Money;
  credit: Money;
  partyId: string | null;
}

export interface SourceRef {
  type: string;
  id: string;
  revision: number;
}

export interface PostingRequest {
  legalEntityId: string;
  entryDate: string;
  currency: string;
  docType: string;
  source: SourceRef;
  reversesId: string | null;
  lines: LineInput[];
}

export interface PostedEntry extends PostingRequest {
  id: string;
  payloadSha256: string;
}

export interface LedgerState {
  readonly entries: readonly PostedEntry[];
}

export type LedgerErrorCode =
  | 'UNKNOWN_CURRENCY'
  | 'INVALID_LINE'
  | 'TOO_FEW_LINES'
  | 'AMOUNT_SCALE'
  | 'AMOUNT_OVERFLOW'
  | 'UNBALANCED'
  | 'INVALID_SOURCE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_OUT_OF_ORDER'
  | 'SOURCE_STILL_POSTED'
  | 'DOCUMENT_REPOST'
  | 'INVALID_REVERSAL'
  | 'ENTRY_NOT_FOUND'
  | 'REVERSAL_NOT_REVERSIBLE';

export type PostOutcome =
  | { ok: true; state: LedgerState; entryId: string; replayed: boolean }
  | { ok: false; code: LedgerErrorCode; message: string };

export const emptyLedger: LedgerState = { entries: [] };

function refuse(code: LedgerErrorCode, message: string): PostOutcome {
  return { ok: false, code, message };
}

// Lines with canonical amounts, ordered by line number. Refuses malformed input before anything else.
function normalizeLines(request: PostingRequest): LineInput[] | PostOutcome {
  try {
    minorUnits(request.currency);
  } catch (error) {
    if (error instanceof MoneyError) return refuse('UNKNOWN_CURRENCY', error.message);
    throw error;
  }
  if (request.lines.length < 2) return refuse('TOO_FEW_LINES', `an entry needs at least 2 lines, got ${request.lines.length}`);
  const seen = new Set<number>();
  const lines: LineInput[] = [];
  for (const line of request.lines) {
    if (!Number.isInteger(line.lineNo) || line.lineNo < 1 || seen.has(line.lineNo)) {
      return refuse('INVALID_LINE', `line numbers must be distinct positive integers, got ${line.lineNo}`);
    }
    seen.add(line.lineNo);
    if (line.accountCode.trim() === '') return refuse('INVALID_LINE', `line ${line.lineNo} has no account`);
    let debit: Money;
    let credit: Money;
    try {
      debit = checkAmount(line.debit, request.currency);
      credit = checkAmount(line.credit, request.currency);
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      if (error.code === 'AMOUNT_SCALE' || error.code === 'AMOUNT_OVERFLOW') return refuse(error.code, `line ${line.lineNo}: ${error.message}`);
      return refuse('INVALID_LINE', `line ${line.lineNo}: ${error.message}`);
    }
    const d = money(debit);
    const c = money(credit);
    if (d.isNegative() || c.isNegative()) return refuse('INVALID_LINE', `line ${line.lineNo} has a negative amount`);
    if (d.isZero() === c.isZero()) return refuse('INVALID_LINE', `line ${line.lineNo} must have exactly one of debit and credit`);
    lines.push({ ...line, debit, credit });
  }
  lines.sort((a, b) => a.lineNo - b.lineNo);
  const diff = entryDifference(lines);
  if (!diff.isZero()) return refuse('UNBALANCED', `debits and credits differ by ${canonical(diff)}`);
  return lines;
}

// Sum of debits minus sum of credits.
export function entryDifference(lines: ReadonlyArray<Pick<LineInput, 'debit' | 'credit'>>): DecimalValue {
  return sum(lines.map((l) => parseDecimal(l.debit).minus(parseDecimal(l.credit))));
}

// Canonical posting payload, the ADR-0021 decision 5 hash input: legal entity, date, currency, document
// type, the entry it reverses, and the lines with amounts at 4 decimals. The party is part of the payload
// here because the reports read receivables and payables per party.
export function payloadHash(request: PostingRequest): string {
  const lines = [...request.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => [l.lineNo, l.accountCode, l.partyId, fixed4(l.debit), fixed4(l.credit)]);
  const payload = [request.legalEntityId, request.entryDate, request.currency, request.docType, request.reversesId, lines];
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function sameSource(entry: PostedEntry, source: Pick<SourceRef, 'type' | 'id'>): boolean {
  return entry.source.type === source.type && entry.source.id === source.id;
}

export function findEntry(state: LedgerState, entryId: string): PostedEntry | undefined {
  return state.entries.find((e) => e.id === entryId);
}

export function reversalOf(state: LedgerState, entryId: string): PostedEntry | undefined {
  return state.entries.find((e) => e.reversesId === entryId);
}

// The rules a reversal must follow, beyond those of any entry: it targets an existing entry that is not
// itself a reversal, is revision 1 of source (reversal, target), and mirrors the target's lines.
function checkReversal(state: LedgerState, request: PostingRequest, lines: LineInput[]): PostOutcome | null {
  const isReversalSource = request.source.type === REVERSAL_SOURCE_TYPE;
  if (request.reversesId === null) {
    return isReversalSource ? refuse('INVALID_REVERSAL', 'a reversal source needs the entry it reverses') : null;
  }
  if (!isReversalSource || request.source.id !== request.reversesId || request.source.revision !== 1) {
    return refuse('INVALID_REVERSAL', 'a reversal is revision 1 of source (reversal, reversed entry id)');
  }
  const target = findEntry(state, request.reversesId);
  if (!target) return refuse('ENTRY_NOT_FOUND', `entry ${request.reversesId} does not exist`);
  if (target.reversesId !== null) return refuse('REVERSAL_NOT_REVERSIBLE', `entry ${target.id} is a reversal; post the original again instead`);
  if (target.legalEntityId !== request.legalEntityId || target.currency !== request.currency) {
    return refuse('INVALID_REVERSAL', 'a reversal keeps the legal entity and currency of the entry it reverses');
  }
  const mirrored =
    target.lines.length === lines.length &&
    target.lines.every((t, i) => {
      const l = lines[i];
      return (
        l !== undefined &&
        l.lineNo === t.lineNo &&
        l.accountCode === t.accountCode &&
        l.partyId === t.partyId &&
        money(l.debit).equals(money(t.credit)) &&
        money(l.credit).equals(money(t.debit))
      );
    });
  return mirrored ? null : refuse('INVALID_REVERSAL', 'a reversal swaps the debit and credit of every line of the entry it reverses');
}

export const DOCUMENT_SOURCE_TYPE = 'finance.purchase_document';

// Posts one entry. Order of checks: the request on its own (currency, lines, scale, balance), then
// idempotency (same source and revision: a replay if the payload hash matches, else a conflict), then the
// revision rule (next revision only, after the previous one was reversed), then the reversal rules.
export function postEntry(state: LedgerState, request: PostingRequest, newId: () => string): PostOutcome {
  const { source } = request;
  if (source.type.trim() === '' || source.id.trim() === '' || !Number.isInteger(source.revision) || source.revision < 1) {
    return refuse('INVALID_SOURCE', 'a source needs a type, an id and a revision of at least 1');
  }
  const lines = normalizeLines(request);
  if (!Array.isArray(lines)) return lines;
  const normalized: PostingRequest = { ...request, lines };
  const hash = payloadHash(normalized);

  const existing = state.entries.find((e) => sameSource(e, source) && e.source.revision === source.revision);
  if (existing) {
    if (existing.payloadSha256 === hash) return { ok: true, state, entryId: existing.id, replayed: true };
    return refuse('IDEMPOTENCY_CONFLICT', `revision ${source.revision} of ${source.type}/${source.id} was posted with a different payload`);
  }

  const latest = state.entries.filter((e) => sameSource(e, source)).reduce<PostedEntry | undefined>(
    (best, e) => (best === undefined || e.source.revision > best.source.revision ? e : best),
    undefined,
  );
  const expected = (latest?.source.revision ?? 0) + 1;
  if (source.revision !== expected) return refuse('REVISION_OUT_OF_ORDER', `expected revision ${expected}, got ${source.revision}`);
  if (latest && !reversalOf(state, latest.id)) {
    return refuse('SOURCE_STILL_POSTED', `reverse revision ${latest.source.revision} of ${source.type}/${source.id} first`);
  }
  // A purchase or sale document is posted once (#1928, the CHECK journal_entry_document_one_revision): it has one void,
  // so a revision 2 could never be reversed; a wrong invoice is replaced by a new document (#916).
  if (source.type === DOCUMENT_SOURCE_TYPE && source.revision > 1) {
    return refuse('DOCUMENT_REPOST', `${source.type}/${source.id} is posted once; record its replacement as a new document`);
  }

  const reversalProblem = checkReversal(state, normalized, lines);
  if (reversalProblem) return reversalProblem;

  const entry: PostedEntry = { ...normalized, id: newId(), payloadSha256: hash };
  if (findEntry(state, entry.id)) throw new Error(`entry id ${entry.id} is already used`);
  return { ok: true, state: { entries: [...state.entries, entry] }, entryId: entry.id, replayed: false };
}

// The reversal of an entry, dated `entryDate` (an open period): every line with debit and credit swapped.
export function reversalRequest(entry: PostedEntry, entryDate: string): PostingRequest {
  return {
    legalEntityId: entry.legalEntityId,
    entryDate,
    currency: entry.currency,
    docType: REVERSAL_DOC_TYPE,
    source: { type: REVERSAL_SOURCE_TYPE, id: entry.id, revision: 1 },
    reversesId: entry.id,
    lines: entry.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
  };
}

// Reverses an entry. Reversing it again with the same date is a replay that returns the same reversal.
export function reverseEntry(state: LedgerState, entryId: string, entryDate: string, newId: () => string): PostOutcome {
  const entry = findEntry(state, entryId);
  if (!entry) return refuse('ENTRY_NOT_FOUND', `entry ${entryId} does not exist`);
  return postEntry(state, reversalRequest(entry, entryDate), newId);
}

// Net balance (debit minus credit) per account over the given entries.
export function accountBalances(entries: ReadonlyArray<Pick<PostedEntry, 'lines'>>): Map<string, DecimalValue> {
  const balances = new Map<string, DecimalValue>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const delta = parseDecimal(line.debit).minus(parseDecimal(line.credit));
      balances.set(line.accountCode, (balances.get(line.accountCode) ?? money(0)).plus(delta));
    }
  }
  return balances;
}
