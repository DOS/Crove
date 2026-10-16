// Property tests for the pure ledger model (ADR-0021 decisions 1 and 5, issue #154).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal, money } from '@crove/l10n-vn';
import {
  accountBalances,
  checkAmount,
  CURRENCY_MINOR_UNITS,
  emptyLedger,
  entryDifference,
  lineAmount,
  postEntry,
  reversalOf,
  reverseEntry,
  toBookCurrency,
  type LedgerState,
  type LineInput,
  type PostedEntry,
  type PostingRequest,
  type PostOutcome,
} from '../src/index.ts';

const LE = 'le-1';
const ACCOUNTS = ['1111', '1121', '131', '331', '1561', '5111', '632', '6422'];
const CURRENCIES = ['VND', 'USD', 'KWD', 'CLF'];

function idSource(): () => string {
  let n = 0;
  return () => `entry-${++n}`;
}

function scaleOf(currency: string): number {
  return CURRENCY_MINOR_UNITS[currency] ?? 0;
}

// A positive amount in a currency's minor units, up to 10^12 of them.
function amountArb(currency: string): fc.Arbitrary<string> {
  return fc.bigInt({ min: 1n, max: 10n ** 12n }).map((minor) => new Decimal(minor.toString()).dividedBy(10 ** scaleOf(currency)).toFixed());
}

// Balanced lines: 1 to 4 random debits and 1 to 4 random credits, plus one line that closes the gap.
function balancedLinesArb(currency: string): fc.Arbitrary<LineInput[]> {
  const side = fc.array(fc.tuple(fc.constantFrom(...ACCOUNTS), amountArb(currency)), { minLength: 1, maxLength: 4 });
  return fc.tuple(side, side, fc.constantFrom(...ACCOUNTS)).map(([debits, credits, closing]) => {
    const raw = [
      ...debits.map(([account, amount]) => ({ account, debit: amount, credit: '0' })),
      ...credits.map(([account, amount]) => ({ account, debit: '0', credit: amount })),
    ];
    const gap = entryDifference(raw);
    if (gap.greaterThan(0)) raw.push({ account: closing, debit: '0', credit: gap.toFixed() });
    if (gap.lessThan(0)) raw.push({ account: closing, debit: gap.negated().toFixed(), credit: '0' });
    return raw.map((l, i) => ({ lineNo: i + 1, accountCode: l.account, debit: l.debit, credit: l.credit, partyId: null }));
  });
}

function request(currency: string, lines: LineInput[], source = { type: 'purchase_document', id: 'doc-1', revision: 1 }): PostingRequest {
  return { legalEntityId: LE, entryDate: '2026-10-01', currency, docType: 'NVK', source, reversesId: null, lines };
}

function posted(outcome: PostOutcome): Extract<PostOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`expected a posting, got ${outcome.code}: ${outcome.message}`);
  return outcome;
}

function entryOf(state: LedgerState, id: string): PostedEntry {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`no entry ${id}`);
  return entry;
}

function balances(entries: PostedEntry[]): Record<string, string> {
  return Object.fromEntries([...accountBalances(entries)].map(([account, value]) => [account, value.toFixed()]));
}

const entryArb = fc.constantFrom(...CURRENCIES).chain((currency) => balancedLinesArb(currency).map((lines) => ({ currency, lines })));

describe('money rules (ADR-0021 decision 1)', () => {
  it('refuses more decimals than the currency allows instead of rounding', () => {
    expect(checkAmount('100', 'VND')).toBe('100');
    expect(() => checkAmount('100.5', 'VND')).toThrow(/AMOUNT_SCALE/);
    expect(checkAmount('100.50', 'USD')).toBe('100.5');
    expect(() => checkAmount('1.005', 'USD')).toThrow(/AMOUNT_SCALE/);
    expect(() => checkAmount('1.00005', 'CLF')).toThrow(/AMOUNT_SCALE/);
    expect(() => checkAmount('10000000000000000', 'VND')).toThrow(/AMOUNT_OVERFLOW/);
    expect(() => checkAmount('1e5', 'VND')).toThrow(/NOT_A_DECIMAL/);
    expect(() => checkAmount('1', 'XXX')).toThrow(/UNKNOWN_CURRENCY/);
  });

  it('rounds a line once, half away from zero, to the currency', () => {
    expect(lineAmount('3', '33333.33333333', 'VND')).toBe('100000');
    expect(lineAmount('1', '0.5', 'VND')).toBe('1');
    expect(lineAmount('-1', '0.5', 'VND')).toBe('-1');
    expect(lineAmount('2', '1.005', 'USD')).toBe('2.01');
    expect(() => lineAmount('1.0000001', '1', 'VND')).toThrow(/AMOUNT_SCALE/);
  });

  it('converts through a direct quote, rounded once', () => {
    expect(toBookCurrency('1234.56', 'USD', '25432.5', 'VND')).toBe('31397947');
    expect(() => toBookCurrency('1', 'USD', '0', 'VND')).toThrow(/INVALID_FX_RATE/);
  });

  it('line rounding is within half a minor unit of the exact product and uses the currency scale', () => {
    const quantity = fc.integer({ min: -(10 ** 9), max: 10 ** 9 }).map((n) => new Decimal(n).dividedBy(1000).toFixed());
    const unit = fc.bigInt({ min: 0n, max: 10n ** 15n }).map((n) => new Decimal(n.toString()).dividedBy(10 ** 8).toFixed());
    fc.assert(
      fc.property(quantity, unit, fc.constantFrom(...CURRENCIES), (q, u, currency) => {
        const rounded = money(lineAmount(q, u, currency));
        const exact = money(q).times(money(u));
        expect(rounded.decimalPlaces()).toBeLessThanOrEqual(scaleOf(currency));
        expect(rounded.minus(exact).abs().lessThanOrEqualTo(new Decimal(10).pow(-scaleOf(currency)).dividedBy(2))).toBe(true);
      }),
    );
  });
});

describe('entry balance', () => {
  it('every generated balanced entry posts, and the stored entry balances', () => {
    fc.assert(
      fc.property(entryArb, ({ currency, lines }) => {
        const outcome = posted(postEntry(emptyLedger, request(currency, lines), idSource()));
        const entry = entryOf(outcome.state, outcome.entryId);
        expect(entryDifference(entry.lines).isZero()).toBe(true);
        for (const line of entry.lines) {
          expect(money(line.debit).plus(money(line.credit)).decimalPlaces()).toBeLessThanOrEqual(scaleOf(currency));
        }
      }),
    );
  });

  it('one minor unit off on any line is refused as unbalanced', () => {
    fc.assert(
      fc.property(entryArb, fc.nat(), ({ currency, lines }, pick) => {
        const index = pick % lines.length;
        const unit = new Decimal(10).pow(-scaleOf(currency));
        const skewed = lines.map((l, i) => {
          if (i !== index) return l;
          return money(l.debit).isZero() ? { ...l, credit: money(l.credit).plus(unit).toFixed() } : { ...l, debit: money(l.debit).plus(unit).toFixed() };
        });
        const outcome = postEntry(emptyLedger, request(currency, skewed), idSource());
        expect(outcome.ok ? 'posted' : outcome.code).toBe('UNBALANCED');
      }),
    );
  });

  it('refuses malformed lines', () => {
    const ok = (debit: string, credit: string, lineNo = 1): LineInput => ({ lineNo, accountCode: '6422', debit, credit, partyId: null });
    const code = (lines: LineInput[], currency = 'VND') => {
      const outcome = postEntry(emptyLedger, request(currency, lines), idSource());
      return outcome.ok ? 'posted' : outcome.code;
    };
    expect(code([ok('100', '0')])).toBe('TOO_FEW_LINES');
    expect(code([ok('100', '100'), ok('0', '0', 2)])).toBe('INVALID_LINE');
    expect(code([ok('-100', '0'), ok('0', '-100', 2)])).toBe('INVALID_LINE');
    expect(code([ok('100', '0'), ok('0', '100', 1)])).toBe('INVALID_LINE');
    expect(code([ok('100.5', '0'), ok('0', '100.5', 2)])).toBe('AMOUNT_SCALE');
    expect(code([ok('100', '0'), ok('0', '100', 2)], 'XXX')).toBe('UNKNOWN_CURRENCY');
  });
});

describe('reversal', () => {
  it('an entry plus its reversal nets to zero on every account', () => {
    fc.assert(
      fc.property(entryArb, ({ currency, lines }) => {
        const newId = idSource();
        const first = posted(postEntry(emptyLedger, request(currency, lines), newId));
        const reversal = posted(reverseEntry(first.state, first.entryId, '2026-11-01', newId));
        const pair = [entryOf(reversal.state, first.entryId), entryOf(reversal.state, reversal.entryId)];
        for (const value of accountBalances(pair).values()) expect(value.isZero()).toBe(true);
        // Reversing again on the same date is a replay; a reversal cannot itself be reversed.
        const again = posted(reverseEntry(reversal.state, first.entryId, '2026-11-01', newId));
        expect(again).toMatchObject({ entryId: reversal.entryId, replayed: true });
        const nested = reverseEntry(reversal.state, reversal.entryId, '2026-11-02', newId);
        expect(nested.ok ? 'posted' : nested.code).toBe('REVERSAL_NOT_REVERSIBLE');
      }),
    );
  });

  it('refuses a hand-made reversal that does not mirror the original', () => {
    const newId = idSource();
    const lines: LineInput[] = [
      { lineNo: 1, accountCode: '6422', debit: '100', credit: '0', partyId: null },
      { lineNo: 2, accountCode: '1111', debit: '0', credit: '100', partyId: null },
    ];
    const first = posted(postEntry(emptyLedger, request('VND', lines), newId));
    const fake: PostingRequest = {
      ...request('VND', [
        { lineNo: 1, accountCode: '6422', debit: '0', credit: '100', partyId: null },
        { lineNo: 2, accountCode: '1121', debit: '100', credit: '0', partyId: null },
      ], { type: 'reversal', id: first.entryId, revision: 1 }),
      reversesId: first.entryId,
    };
    const outcome = postEntry(first.state, fake, newId);
    expect(outcome.ok ? 'posted' : outcome.code).toBe('INVALID_REVERSAL');
  });
});

// Model-based test of source_revision (ADR-0021 decision 5). The model only tracks, per source, the payload
// of each revision and whether it was reversed; every command predicts the outcome from the model and
// checks the ledger agrees, then the ledger-wide invariants are checked.
interface Model {
  sources: Map<string, Array<{ payload: number; entryId: string; reversed: boolean; reversalDate: string | null }>>;
  entries: number;
}

interface Real {
  state: LedgerState;
  newId: () => string;
}

const SOURCES = ['doc-a', 'doc-b', 'doc-c'];
const PAYLOADS: LineInput[][] = [100, 250, 1000].map((amount) => [
  { lineNo: 1, accountCode: '6422', debit: String(amount), credit: '0', partyId: null },
  { lineNo: 2, accountCode: '1331', debit: String(amount / 10), credit: '0', partyId: null },
  { lineNo: 3, accountCode: '331', debit: '0', credit: String(amount + amount / 10), partyId: 'vendor-1' },
]);

function outcomeCode(outcome: PostOutcome): string {
  return outcome.ok ? (outcome.replayed ? 'replayed' : 'posted') : outcome.code;
}

function checkInvariants(model: Model, real: Real): void {
  const { entries } = real.state;
  expect(entries.length).toBe(model.entries);
  expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  for (const entry of entries) expect(entryDifference(entry.lines).isZero()).toBe(true);
  expect(entryDifference(entries.flatMap((e) => e.lines)).isZero()).toBe(true);
  const keys = entries.map((e) => JSON.stringify([e.source.type, e.source.id, e.source.revision]));
  expect(new Set(keys).size).toBe(keys.length);
  for (const entry of entries) {
    if (entry.reversesId !== null) {
      const original = entryOf(real.state, entry.reversesId);
      for (const value of accountBalances([original, entry]).values()) expect(value.isZero()).toBe(true);
    }
    if (entry.source.revision > 1) {
      const previous = entries.find((e) => e.source.type === entry.source.type && e.source.id === entry.source.id && e.source.revision === entry.source.revision - 1);
      expect(previous && reversalOf(real.state, previous.id)).toBeDefined();
    }
  }
}

class PostCommand implements fc.Command<Model, Real> {
  readonly source: string;
  readonly revisionShift: number;
  readonly payload: number;
  constructor(source: string, revisionShift: number, payload: number) {
    this.source = source;
    this.revisionShift = revisionShift;
    this.payload = payload;
  }
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const revisions = model.sources.get(this.source) ?? [];
    const revision = Math.max(1, revisions.length + this.revisionShift);
    const existing = revisions[revision - 1];
    let expected: string;
    if (existing) expected = existing.payload === this.payload ? 'replayed' : 'IDEMPOTENCY_CONFLICT';
    else if (revision !== revisions.length + 1) expected = 'REVISION_OUT_OF_ORDER';
    else if (revisions.length > 0 && !revisions[revisions.length - 1]?.reversed) expected = 'SOURCE_STILL_POSTED';
    else expected = 'posted';

    const outcome = postEntry(real.state, request('VND', PAYLOADS[this.payload] ?? [], { type: 'purchase_document', id: this.source, revision }), real.newId);
    expect(outcomeCode(outcome)).toBe(expected);
    if (outcome.ok) {
      if (existing) expect(outcome.entryId).toBe(existing.entryId);
      real.state = outcome.state;
      if (!outcome.replayed) {
        revisions.push({ payload: this.payload, entryId: outcome.entryId, reversed: false, reversalDate: null });
        model.sources.set(this.source, revisions);
        model.entries += 1;
      }
    }
    checkInvariants(model, real);
  }
  toString(): string {
    return `post(${this.source}, shift ${this.revisionShift}, payload ${this.payload})`;
  }
}

class ReverseCommand implements fc.Command<Model, Real> {
  readonly source: string;
  readonly date: string;
  constructor(source: string, date: string) {
    this.source = source;
    this.date = date;
  }
  check(model: Readonly<Model>): boolean {
    return (model.sources.get(this.source)?.length ?? 0) > 0;
  }
  run(model: Model, real: Real): void {
    const revisions = model.sources.get(this.source) ?? [];
    const latest = revisions[revisions.length - 1];
    if (!latest) throw new Error('check() guarantees a revision');
    let expected: string;
    if (!latest.reversed) expected = 'posted';
    else expected = latest.reversalDate === this.date ? 'replayed' : 'IDEMPOTENCY_CONFLICT';

    const outcome = reverseEntry(real.state, latest.entryId, this.date, real.newId);
    expect(outcomeCode(outcome)).toBe(expected);
    if (outcome.ok) {
      real.state = outcome.state;
      if (!outcome.replayed) {
        latest.reversed = true;
        latest.reversalDate = this.date;
        model.entries += 1;
      }
    }
    checkInvariants(model, real);
  }
  toString(): string {
    return `reverse(${this.source}, ${this.date})`;
  }
}

describe('source_revision model (ADR-0021 decision 5)', () => {
  it('replay, conflict, revision order and reversal rules hold for any sequence of commands', () => {
    const commands = [
      fc.tuple(fc.constantFrom(...SOURCES), fc.integer({ min: -1, max: 2 }), fc.integer({ min: 0, max: PAYLOADS.length - 1 }))
        .map(([source, shift, payload]) => new PostCommand(source, shift, payload)),
      fc.tuple(fc.constantFrom(...SOURCES), fc.constantFrom('2026-11-01', '2026-11-02')).map(([source, date]) => new ReverseCommand(source, date)),
    ];
    fc.assert(
      fc.property(fc.commands(commands, { maxCommands: 60 }), (cmds) => {
        fc.modelRun(() => ({ model: { sources: new Map(), entries: 0 }, real: { state: emptyLedger, newId: idSource() } }), cmds);
      }),
      { numRuns: 300 },
    );
  });

  it('a replay returns the original entry and adds nothing', () => {
    const newId = idSource();
    const lines = PAYLOADS[0] ?? [];
    const first = posted(postEntry(emptyLedger, request('VND', lines), newId));
    const replay = posted(postEntry(first.state, request('VND', lines.map((l) => ({ ...l, debit: money(l.debit).toFixed(2) }))), newId));
    expect(replay).toMatchObject({ entryId: first.entryId, replayed: true });
    expect(replay.state.entries).toHaveLength(1);
    expect(balances([...replay.state.entries])).toEqual({ '6422': '100', '1331': '10', '331': '-110' });
  });
});
