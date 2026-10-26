// The search params of the ledger, VAT, portal list, vouchers, tasks and Inbox screens (#1513): what a link or a reload
// brings back, and how anything else falls back to the screen's default instead of an error.
import { describe, expect, it } from 'vitest';
import { parseTasksSearch } from '../src/lib/agents.ts';
import { defaultLedgerPeriod, ledgerChoiceOf, ledgerPeriodKey, parseLedgerSearch } from '../src/lib/ledger.ts';
import { parseInboxSearch } from '../src/lib/review.ts';
import { withSearch } from '../src/lib/search.ts';
import { parsePeriodSearch, periodChoiceOf, periodKey, periodSearch } from '../src/lib/vat.ts';
import { parseVouchersSearch } from '../src/lib/vouchers.ts';

const year = new Date().getFullYear();
const today = new Date(2026, 9, 26);

describe('periodChoiceOf', () => {
  it('reads a month or a quarter of the years offered', () => {
    expect(periodChoiceOf('2026-09', today)).toEqual({ kind: 'month', year: 2026, index: 9 });
    expect(periodChoiceOf('2021-Q4', today)).toEqual({ kind: 'quarter', year: 2021, index: 4 });
    for (const key of ['2026-01', '2026-12', '2026-Q1']) expect(periodKey(periodChoiceOf(key, today)!)).toBe(key);
  });

  it('refuses another shape, a month or quarter that does not exist, and a year the picker does not offer', () => {
    for (const key of ['2026-13', '2026-00', '2026-9', '2026-Q5', '2026-Q0', '2026', '2020-09', '2027-01', 'abc', '']) expect(periodChoiceOf(key, today), key).toBeNull();
  });
});

describe('ledgerChoiceOf', () => {
  it('reads a year as well as a month or a quarter', () => {
    expect(ledgerChoiceOf('2025', today)).toEqual({ kind: 'year', year: 2025, index: 1 });
    expect(ledgerChoiceOf('2026-Q3', today)).toEqual({ kind: 'quarter', year: 2026, index: 3 });
    expect(ledgerChoiceOf('2026-09', today)).toEqual({ kind: 'month', year: 2026, index: 9 });
    expect(ledgerChoiceOf('2019', today)).toBeNull();
    expect(ledgerChoiceOf('20266', today)).toBeNull();
  });
});

describe('parsePeriodSearch (VAT and portal list)', () => {
  it('keeps a valid period', () => {
    expect(parsePeriodSearch({ period: `${year}-03` })).toEqual({ period: `${year}-03` });
    expect(parsePeriodSearch({ period: `${year}-Q2` })).toEqual({ period: `${year}-Q2` });
  });

  it('drops an invalid period, a year alone and unknown keys', () => {
    expect(parsePeriodSearch({ period: `${year}-13` })).toEqual({});
    expect(parsePeriodSearch({ period: year })).toEqual({});
    expect(parsePeriodSearch({ period: ['x'], other: 1 })).toEqual({});
    expect(parsePeriodSearch({})).toEqual({});
  });

  it('writes no period for the default one', () => {
    expect(periodSearch('2026-09', '2026-09')).toEqual({});
    expect(periodSearch('2026-Q3', '2026-09')).toEqual({ period: '2026-Q3' });
  });
});

describe('parseLedgerSearch', () => {
  it('keeps the period, the report tab and the account, a year or an account the router read as a number included', () => {
    expect(parseLedgerSearch({ period: `${year}-Q1`, report: 'generalLedger', account: '1121' })).toEqual({ period: `${year}-Q1`, report: 'generalLedger', account: '1121' });
    expect(parseLedgerSearch({ period: year, account: 1121 })).toEqual({ period: String(year), account: '1121' });
  });

  it('drops each invalid param on its own, so the others still apply', () => {
    expect(parseLedgerSearch({ period: `${year}-14`, report: 'balance', account: '1121' })).toEqual({ account: '1121' });
    expect(parseLedgerSearch({ period: `${year}-01`, report: 'parties', account: 'a b' })).toEqual({ period: `${year}-01`, report: 'parties' });
    expect(parseLedgerSearch({ account: -5, report: 3 })).toEqual({});
  });

  it('round-trips the default period', () => {
    const key = ledgerPeriodKey(defaultLedgerPeriod());
    expect(parseLedgerSearch({ period: key })).toEqual({ period: key });
  });
});

describe('parseVouchersSearch', () => {
  it('keeps a voucher type and calendar dates', () => {
    expect(parseVouchersSearch({ type: 'bank_credit', from: '2026-09-01', to: '2026-09-30' })).toEqual({ type: 'bank_credit', from: '2026-09-01', to: '2026-09-30' });
  });

  it('drops an unknown type and an impossible or differently written date', () => {
    expect(parseVouchersSearch({ type: 'invoice', from: '2026-02-30', to: '30/09/2026' })).toEqual({});
    expect(parseVouchersSearch({ type: 'cash_receipt', to: 20260930 })).toEqual({ type: 'cash_receipt' });
  });
});

describe('parseTasksSearch and parseInboxSearch', () => {
  it('keep a known tab and drop anything else', () => {
    expect(parseTasksSearch({ filter: 'mine' })).toEqual({ filter: 'mine' });
    expect(parseTasksSearch({ filter: 'done' })).toEqual({});
    expect(parseInboxSearch({ status: 'expired' })).toEqual({ status: 'expired' });
    expect(parseInboxSearch({ status: 'approved', tab: 'executed' })).toEqual({});
  });
});

describe('withSearch', () => {
  it('changes some params and leaves out the ones set back to their default', () => {
    expect(withSearch({ period: '2026-Q3', account: '111' } as { period?: string; account?: string; report?: string }, { period: undefined, report: 'parties' })).toEqual({ account: '111', report: 'parties' });
  });
});
