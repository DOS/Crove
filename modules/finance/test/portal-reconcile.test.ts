// Reconciling the tax portal's purchase list with Crove's purchases (#465): the match key, template and series
// variants, the fallback without a tax code, amounts as a check, cancelled and replaced invoices, duplicates, period
// scoping; the portal status words; and the worker's second check of the sandbox's answer.
import { describe, expect, it } from 'vitest';
import { PORTAL_LIST_SKIP_REASONS as EXTRACT_SKIP_REASONS, type ExtractedPortalList } from '@crove/extract-contract';
import { PORTAL_LIST_SKIP_REASONS } from '@crove/kernel-contract';
import { checkPortalList, firstPerOutcome, invoiceSymbol, portalStatus, reconcilePortalList, type CroveInvoice, type PortalRow } from '../src/index.ts';

const LIST = '00000000-0000-7000-8000-000000000001';
const SELLER = '0100109107';
const OTHER = '0302712572';
const PERIOD = { from: '2026-09-01', to: '2026-09-30' };

let rowNo = 3;
const portal = (number: string, extra: Partial<PortalRow> = {}): PortalRow => ({
  listId: LIST,
  rowNo: ++rowNo,
  sellerTaxCode: SELLER,
  sellerName: 'Nhà cung cấp',
  template: '1',
  series: 'C26TAA',
  number,
  issueDate: '2026-09-10',
  currency: 'VND',
  subtotal: '1000000',
  vatAmount: '100000',
  total: '1100000',
  status: 'original',
  statusLabel: 'Hóa đơn mới',
  ...extra,
});

let id = 0;
// A document is posted on its invoice date unless the test says otherwise; a proposal has no posting date.
const crove = (number: string, extra: Partial<CroveInvoice> = {}): CroveInvoice => {
  const base: CroveInvoice = {
    kind: 'document',
    id: `00000000-0000-7000-8000-${String(++id).padStart(12, '0')}`,
    sellerTaxCode: SELLER,
    sellerName: 'Nhà cung cấp',
    template: '1',
    series: 'C26TAA',
    number,
    issueDate: '2026-09-10',
    currency: 'VND',
    vatAmount: '100000',
    total: '1100000',
    sourceFileId: null,
    postingDate: null,
    ...extra,
  };
  return 'postingDate' in extra ? base : { ...base, postingDate: base.kind === 'document' ? base.issueDate : null };
};

const outcomes = (rows: PortalRow[], invoices: CroveInvoice[]) =>
  reconcilePortalList(rows, invoices, PERIOD).items.map((i) => [i.portal?.number ?? i.crove?.number, i.outcome, i.crove?.kind ?? null]);

describe('reconcilePortalList', () => {
  it('matches on seller tax code, series and number, and sorts what needs work first', () => {
    const result = reconcilePortalList(
      [portal('1'), portal('2'), portal('3')],
      [crove('1'), crove('3', { kind: 'proposal' }), crove('9')],
      PERIOD,
    );
    expect(result.items.map((i) => [i.portal?.number ?? i.crove?.number, i.outcome])).toEqual([
      ['2', 'missing'],
      ['9', 'not_on_portal'],
      ['3', 'in_inbox'],
      ['1', 'matched'],
    ]);
    expect(result.summary).toEqual({ portalInvoices: 3, matched: 1, inInbox: 1, amountMismatch: 0, missing: 1, voidInCrove: 0, void: 0, notOnPortal: 1, declaredLate: 0, duplicateRows: 0 });
  });

  it('does not match another seller, series or template, and normalizes numbers and series', () => {
    expect(outcomes([portal('1')], [crove('1', { sellerTaxCode: OTHER })])).toEqual([
      ['1', 'missing', null],
      ['1', 'not_on_portal', 'document'],
    ]);
    expect(outcomes([portal('1')], [crove('1', { series: 'C26TBB' })]).map((o) => o[1])).toEqual(['missing', 'not_on_portal']);
    expect(outcomes([portal('1', { template: '2' })], [crove('1')]).map((o) => o[1])).toEqual(['missing', 'not_on_portal']);
    // Zero padding, case and spaces, a template written into the series, a missing template.
    expect(outcomes([portal('0000123', { series: 'c26taa ' })], [crove('123')])).toEqual([['0000123', 'matched', 'document']]);
    expect(outcomes([portal('5', { template: null, series: '1C26TAA' })], [crove('5')])).toEqual([['5', 'matched', 'document']]);
    expect(outcomes([portal('6')], [crove('6', { template: null })])).toEqual([['6', 'matched', 'document']]);
  });

  it('matches a Crove invoice without a seller tax code on series and number only when that is unambiguous', () => {
    const single = reconcilePortalList([portal('7')], [crove('7', { sellerTaxCode: null })], PERIOD).items;
    expect(single).toEqual([expect.objectContaining({ outcome: 'matched', withoutTaxCode: true })]);
    const twoSellers = outcomes([portal('8'), portal('8', { sellerTaxCode: OTHER })], [crove('8', { sellerTaxCode: null })]);
    expect(twoSellers.map((o) => o[1])).toEqual(['missing', 'missing', 'not_on_portal']);
  });

  it('checks the total, the VAT and the currency, allowing one dong of rounding', () => {
    const items = reconcilePortalList(
      [portal('1', { total: '1100001' }), portal('2', { total: '1100002' }), portal('3', { vatAmount: '99000' }), portal('4', { currency: 'USD' }), portal('5', { total: null, vatAmount: null })],
      [crove('1'), crove('2'), crove('3'), crove('4'), crove('5', { total: '1' })],
      PERIOD,
    ).items;
    const byNumber = Object.fromEntries(items.map((i) => [i.portal?.number, [i.outcome, i.differences]]));
    expect(byNumber).toEqual({
      '1': ['matched', []],
      '2': ['amount_mismatch', ['total']],
      '3': ['amount_mismatch', ['vat']],
      '4': ['amount_mismatch', ['currency']],
      // Without the portal's amounts there is nothing to check.
      '5': ['matched', []],
    });
  });

  it('treats replaced and cancelled invoices as no longer counting, and adjusted ones as still counting', () => {
    const result = reconcilePortalList(
      [
        portal('1', { status: 'cancelled' }),
        portal('2', { status: 'replaced' }),
        portal('3', { status: 'cancelled' }),
        portal('4', { status: 'adjusted' }),
        portal('5', { status: 'replacement' }),
        portal('6', { status: 'unknown' }),
      ],
      [crove('1'), crove('2', { kind: 'proposal', total: '5' })],
      PERIOD,
    );
    expect(Object.fromEntries(result.items.map((i) => [i.portal?.number, [i.outcome, i.differences]]))).toEqual({
      '1': ['void_in_crove', []],
      '2': ['void_in_crove', []],
      '3': ['void', []],
      '4': ['missing', []],
      '5': ['missing', []],
      '6': ['missing', []],
    });
  });

  it('counts the same invoice on two lists once, keeping a later cancellation', () => {
    const second = '00000000-0000-7000-8000-000000000002';
    const result = reconcilePortalList([portal('1'), portal('1', { listId: second, status: 'cancelled' }), portal('2'), portal('2', { listId: second })], [crove('1')], PERIOD);
    expect(result.items.map((i) => [i.portal?.number, i.outcome, i.duplicateRows])).toEqual([
      ['2', 'missing', 1],
      ['1', 'void_in_crove', 1],
    ]);
    expect(result.summary.duplicateRows).toBe(2);
  });

  it('matches the booked document before a pending duplicate of it, and reports the duplicate whatever its date', () => {
    const result = reconcilePortalList([portal('1')], [crove('1', { kind: 'proposal', issueDate: '2026-08-30' }), crove('1')], PERIOD);
    expect(result.items.map((i) => [i.portal?.number ?? i.crove?.number, i.outcome, i.crove?.kind, i.duplicateInCrove])).toEqual([
      ['1', 'not_on_portal', 'proposal', true],
      ['1', 'matched', 'document', false],
    ]);
    expect(result.items[0]?.outsidePeriod).toBe(true);
    // The same invoice booked twice: one matches, the other is a duplicate.
    const twice = reconcilePortalList([portal('2')], [crove('2'), crove('2')], PERIOD).items;
    expect(twice.map((i) => [i.outcome, i.duplicateInCrove])).toEqual([
      ['not_on_portal', true],
      ['matched', false],
    ]);
    expect(reconcilePortalList([portal('3')], [crove('3')], PERIOD).summary.notOnPortal).toBe(0);
  });

  it('flags portal rows outside the period, and reports only Crove invoices of the period as not on the portal', () => {
    const result = reconcilePortalList([portal('1', { issueDate: '2026-10-01' })], [crove('1', { issueDate: '2026-10-01' }), crove('2', { issueDate: '2026-08-31' })], PERIOD);
    expect(result.items).toEqual([expect.objectContaining({ outcome: 'matched', outsidePeriod: true })]);
  });
});

describe('late invoices (#478, #560)', () => {
  // A September invoice approved after September was locked, posted on 1 October.
  const late = { issueDate: '2026-09-20', postingDate: '2026-10-01' };
  const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

  it('matches a late invoice in its own period and says it is declared in the later period of its posting date', () => {
    const result = reconcilePortalList([portal('1', { issueDate: '2026-09-20' })], [crove('1', late)], PERIOD);
    expect(result.items).toEqual([expect.objectContaining({ outcome: 'matched', declaredInLaterPeriod: true, crove: expect.objectContaining({ postingDate: '2026-10-01' }) })]);
    // Not on the list either: still Crove's invoice of the period, and still declared later.
    expect(reconcilePortalList([], [crove('2', late)], PERIOD).items).toEqual([expect.objectContaining({ outcome: 'not_on_portal', declaredInLaterPeriod: true })]);
    // An invoice posted on its own date is declared in its own period.
    expect(reconcilePortalList([portal('3')], [crove('3')], PERIOD).items).toEqual([expect.objectContaining({ outcome: 'matched', declaredInLaterPeriod: false })]);
  });

  it('reports a late invoice in the period it was posted in as declared late there, not as missing from the portal', () => {
    const result = reconcilePortalList([portal('5', { issueDate: '2026-10-05' })], [crove('4', late), crove('5', { issueDate: '2026-10-05' })], OCTOBER);
    expect(result.items.map((i) => [i.crove?.number, i.outcome, i.outsidePeriod, i.declaredInLaterPeriod])).toEqual([
      ['5', 'matched', false, false],
      ['4', 'declared_late', true, false],
    ]);
    expect(result.summary).toMatchObject({ matched: 1, notOnPortal: 0, declaredLate: 1 });
    // A proposal has no posting date and an invoice of an earlier period posted then is none of this period's.
    expect(reconcilePortalList([], [crove('6', { issueDate: '2026-09-20', kind: 'proposal' }), crove('7', { issueDate: '2026-09-20' })], OCTOBER).items).toEqual([]);
    // Posted after this period too: declared in neither this period nor its own.
    expect(reconcilePortalList([], [crove('8', { issueDate: '2026-09-20', postingDate: '2026-11-02' })], OCTOBER).items).toEqual([]);
  });

  it('matches a late invoice to a row of the period it was posted in when that list happens to hold it', () => {
    const result = reconcilePortalList([portal('9', { issueDate: '2026-09-20' })], [crove('9', late)], OCTOBER);
    expect(result.items).toEqual([expect.objectContaining({ outcome: 'matched', outsidePeriod: true, declaredInLaterPeriod: false })]);
  });
});

describe('portal duplicates and templates', () => {
  it('counts a row without a template as the same invoice as one with it, so neither looks missing', () => {
    const second = '00000000-0000-7000-8000-000000000003';
    const result = reconcilePortalList([portal('1', { template: '1' }), portal('1', { listId: second, template: null })], [crove('1')], PERIOD);
    expect(result.items.map((i) => [i.portal?.number, i.outcome, i.duplicateRows])).toEqual([['1', 'matched', 1]]);
    expect(result.summary).toMatchObject({ portalInvoices: 1, missing: 0, duplicateRows: 1 });
    // The template-less row first: the later row's template fills it, and a third with another template stays apart.
    const apart = reconcilePortalList([portal('2', { template: null }), portal('2', { template: '1' }), portal('2', { template: '2' })], [crove('2', { template: '1' })], PERIOD);
    expect(apart.items.map((i) => [i.portal?.template, i.outcome])).toEqual([
      ['2', 'missing'],
      [null, 'matched'],
    ]);
  });
});

describe('reconciliation size', () => {
  it('groups many rows under one key with distinct templates in linear time', () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => portal('1', { template: `T${i}` }));
    const started = performance.now();
    const result = reconcilePortalList(rows, [crove('1', { template: 'T7' })], PERIOD);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.summary).toMatchObject({ portalInvoices: 50_000, matched: 1, missing: 49_999, duplicateRows: 0 });
  });
});

describe('invoiceSymbol', () => {
  it('splits a template written into the series, and leaves anything else as written', () => {
    expect(invoiceSymbol(null, '1C26TAA')).toEqual({ template: '1', series: 'C26TAA' });
    expect(invoiceSymbol('1', '1c26taa')).toEqual({ template: '1', series: 'C26TAA' });
    expect(invoiceSymbol('2', '1C26TAA')).toEqual({ template: '2', series: '1C26TAA' });
    expect(invoiceSymbol(' 01GTKT0/001 ', 'AA/26E')).toEqual({ template: '01GTKT0/001', series: 'AA/26E' });
  });
});

describe('portalStatus', () => {
  it('reads the portal status words with or without diacritics, and its numbers', () => {
    expect(portalStatus('Hóa đơn mới')).toBe('original');
    expect(portalStatus('Hóa đơn thay thế')).toBe('replacement');
    expect(portalStatus('Hóa đơn điều chỉnh')).toBe('adjustment');
    expect(portalStatus('Hóa đơn đã bị thay thế')).toBe('replaced');
    expect(portalStatus('Hóa đơn đã bị điều chỉnh')).toBe('adjusted');
    expect(portalStatus('Hóa đơn đã bị hủy')).toBe('cancelled');
    expect(portalStatus('HOA DON DA BI HUY')).toBe('cancelled');
    expect(portalStatus('Đã hủy')).toBe('cancelled');
    expect(portalStatus('6')).toBe('cancelled');
    expect(portalStatus('4')).toBe('replaced');
    expect(portalStatus('1')).toBe('original');
    expect(portalStatus('Đang xử lý')).toBe('unknown');
    expect(portalStatus(null)).toBe('unknown');
  });
});

describe('firstPerOutcome', () => {
  it('keeps the first items of each outcome, in order', () => {
    const items = ['missing', 'missing', 'matched', 'missing', 'matched', 'void'].map((outcome, i) => ({ outcome, i }));
    expect(firstPerOutcome(items, 2).map((x) => x.i)).toEqual([0, 1, 2, 4, 5]);
    expect(firstPerOutcome(items, 10)).toEqual(items);
  });
});

describe('checkPortalList', () => {
  const list = (rows: Array<Partial<ExtractedPortalList['rows'][number]>>, extra: Partial<ExtractedPortalList> = {}): ExtractedPortalList => ({
    sheetName: 'Sheet1',
    headerRow: 3,
    columns: [],
    listFrom: '2026-09-01',
    listTo: '2026-09-30',
    buyerTaxCode: null,
    skipped: [],
    skippedCount: 0,
    rows: rows.map((r, i) => ({
      rowNo: i + 4,
      sellerTaxCode: SELLER,
      sellerName: 'A',
      buyerTaxCode: OTHER,
      template: '1',
      series: 'C26TAA',
      number: String(i + 1),
      issueDate: '2026-09-10',
      currency: 'VND',
      subtotal: '100.50',
      vatAmount: null,
      total: '110',
      statusLabel: 'Hóa đơn đã bị hủy',
      checkResult: null,
      ...r,
    })),
    ...extra,
  });

  it('refuses a list whose every invoice row was skipped, and shares the skip reasons with the sandbox contract', () => {
    expect(checkPortalList(list([], { skipped: [{ rowNo: 7, reason: 'bad_date' }], skippedCount: 3 }), OTHER)).toEqual({
      ok: false,
      error: expect.stringContaining('3 dòng lỗi, ví dụ dòng 7'),
    });
    expect([...PORTAL_LIST_SKIP_REASONS]).toEqual([...EXTRACT_SKIP_REASONS]);
  });

  it('normalizes amounts and reads the status into the stored rows', () => {
    const checked = checkPortalList(list([{}]), OTHER);
    expect(checked).toEqual({
      ok: true,
      rows: [expect.objectContaining({ subtotal: '100.5', vatAmount: null, total: '110', status: 'cancelled' })],
      listFrom: '2026-09-01',
      listTo: '2026-09-30',
      ownSales: 0,
      otherBuyers: 0,
    });
  });

  it('refuses impossible dates and a row number given twice with the reason, before anything reaches the database', () => {
    expect(checkPortalList(list([{ issueDate: '2026-02-30' }]), OTHER)).toEqual({ ok: false, error: 'Dòng 4: ngày lập hóa đơn không hợp lệ (2026-02-30)' });
    expect(checkPortalList(list([{ issueDate: '0000-01-01' }]), OTHER)).toEqual({ ok: false, error: 'Dòng 4: ngày lập hóa đơn không hợp lệ (0000-01-01)' });
    expect(checkPortalList(list([{}], { listTo: '0000-12-31' }), OTHER)).toEqual({ ok: false, error: expect.stringContaining('ngày không hợp lệ (0000-12-31)') });
    expect(checkPortalList(list([{}], { listFrom: '2026-09-31' }), OTHER)).toEqual({ ok: false, error: expect.stringContaining('ngày không hợp lệ (2026-09-31)') });
    expect(checkPortalList(list([{}], { listFrom: '2026-10-01', listTo: '2026-09-30' }), OTHER)).toEqual({ ok: false, error: expect.stringContaining('từ 2026-10-01 đến 2026-09-30') });
    expect(checkPortalList(list([{ rowNo: 9 }, { rowNo: 9 }]), OTHER)).toEqual({ ok: false, error: expect.stringContaining('dòng 9 hai lần') });
    expect(checkPortalList(list([{}], { listFrom: null, listTo: null }), OTHER)).toMatchObject({ ok: true, listFrom: null, listTo: null });
  });

  it("counts the rows it drops as the org's own sales or another buyer's", () => {
    const checked = checkPortalList(list([{ sellerTaxCode: OTHER }, { buyerTaxCode: '0101234564' }, { buyerTaxCode: '0101234564' }, {}]), OTHER);
    expect(checked).toMatchObject({ ok: true, ownSales: 1, otherBuyers: 2 });
    expect(checked.ok && checked.rows.map((r) => r.number)).toEqual(['4']);
  });

  it("refuses another company's list, by its rows' buyer or the line above the header", () => {
    expect(checkPortalList(list([{ buyerTaxCode: '0101234564' }, { buyerTaxCode: '0101234564' }]), OTHER)).toEqual({
      ok: false,
      error: expect.stringContaining('mã số thuế 0101234564, không phải của công ty này'),
    });
    // Rows of another buyer in a list of the org's purchases are dropped; a row without a buyer is kept.
    const mixed = checkPortalList(list([{ buyerTaxCode: '0101234564' }, {}, { buyerTaxCode: null }]), OTHER);
    expect(mixed.ok && mixed.rows.map((r) => r.number)).toEqual(['2', '3']);
  });

  it("refuses an empty list and the sales list, and drops the org's own sales from a mixed one", () => {
    expect(checkPortalList(list([{}], { buyerTaxCode: SELLER }), OTHER)).toEqual({ ok: false, error: expect.stringContaining(`mã số thuế ${SELLER}, không phải của công ty này (${OTHER})`) });
    expect(checkPortalList(list([]), OTHER)).toEqual({ ok: false, error: expect.stringContaining('không có hóa đơn nào') });
    expect(checkPortalList(list([{ sellerTaxCode: OTHER }]), OTHER)).toEqual({ ok: false, error: expect.stringContaining('bán ra') });
    const mixed = checkPortalList(list([{ sellerTaxCode: OTHER }, {}]), OTHER);
    expect(mixed.ok && mixed.rows.map((r) => r.sellerTaxCode)).toEqual([SELLER]);
    // Without the org's tax code a list cannot be told apart from another company's: refused.
    expect(checkPortalList(list([{}]), null)).toEqual({ ok: false, error: expect.stringContaining('mã số thuế của công ty trong Cài đặt') });
  });
});
