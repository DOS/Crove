// The assisted sync from the tax portal (#325): the portal's JSON rows turned into the list the manual import reads,
// and checked by the same rules (checkPortalList). The rows are untrusted: every quirk the portal's answers show
// (numbers for tax codes, dates as instants or epoch milliseconds, amounts as numbers) reads, and a row that does not
// name an invoice properly is skipped with its reason, never guessed.
import { describe, expect, it } from 'vitest';
import { zExtractedPortalList } from '@crove/extract-contract';
import { PortalListTooLarge, checkPortalList, normalizePortalInvoices, portalDate, portalStatus, readSyncedList, xmlCallKey, type PortalAnswer } from '../src/index.ts';

const PERIOD = { from: '2026-09-01', to: '2026-09-30' };
const TOO_LARGE = 'Danh sách của kỳ này quá lớn để lấy một lần; hãy xuất danh sách Excel từ cổng thuế rồi tải lên';
const BUYER = '0309876546';
const SELLER = '0101234564';

const row = (extra: Record<string, unknown> = {}) => ({
  nbmst: SELLER,
  nbten: 'CÔNG TY TNHH DỊCH VỤ MẪU',
  nmmst: BUYER,
  khmshdon: '1',
  khhdon: 'C26TAB',
  shdon: '9101',
  tdlap: '2026-09-02T17:00:00.000Z',
  dvtte: 'VND',
  tgtcthue: '1800000',
  tgtthue: '180000',
  tgtttbso: '1980000',
  tthai: '1',
  ttxly: '5',
  ...extra,
});

describe('portalDate', () => {
  it('reads the invoice date in Vietnam whatever form the portal sends', () => {
    // 17:00 UTC is midnight the next day in Vietnam.
    expect(portalDate('2026-09-02T17:00:00.000Z')).toBe('2026-09-03');
    expect(portalDate('2026-09-02T17:00:00.000+0000')).toBe('2026-09-03');
    expect(portalDate('2026-09-03T00:00:00')).toBe('2026-09-03');
    expect(portalDate(String(Date.parse('2026-09-20T00:00:00+07:00')))).toBe('2026-09-20');
    expect(portalDate('20/09/2026')).toBe('2026-09-20');
    expect(portalDate('yesterday')).toBeNull();
    expect(portalDate(null)).toBeNull();
  });
});

describe('normalizePortalInvoices', () => {
  it('reads the rows of every query in order, as the manual import shapes them', () => {
    const answers: PortalAnswer[] = [
      { query: 'purchase_5', rows: [row(), row({ shdon: '9102', tdlap: '2026-09-04T17:00:00.000Z' })] },
      { query: 'purchase_6', rows: [row({ nbmst: '100109107', khhdon: 'k26tbb', shdon: '78', tthai: '4' })] },
      { query: 'purchase_8', rows: [] },
      { query: 'sco', rows: [row({ khhdon: 'C26MCC', shdon: '501', tdlap: String(Date.parse('2026-09-20T00:00:00+07:00')), dvtte: null })] },
    ];
    const { list, withXml } = normalizePortalInvoices(answers, PERIOD);
    // The shape the sandbox answers for an uploaded list: the same checks hold.
    expect(zExtractedPortalList.safeParse(list).success).toBe(true);
    expect(list.rows.map((r) => [r.rowNo, r.series, r.number, r.issueDate])).toEqual([
      [1, 'C26TAB', '9101', '2026-09-03'],
      [2, 'C26TAB', '9102', '2026-09-05'],
      [3, 'K26TBB', '78', '2026-09-03'],
      [4, 'C26MCC', '501', '2026-09-20'],
    ]);
    // A tax code sent as a number lost its leading zero; it is padded back.
    expect(list.rows[2]?.sellerTaxCode).toBe('0100109107');
    expect(list.rows[2]?.statusLabel).toBe('Hóa đơn đã bị thay thế');
    expect(portalStatus(list.rows[2]?.statusLabel ?? null)).toBe('replaced');
    expect(list.rows[0]?.checkResult).toBe('Đã cấp mã hóa đơn');
    expect(list.rows[2]?.checkResult).toBe('Cục Thuế đã nhận không mã');
    expect(list.rows[3]?.currency).toBe('VND');
    expect([...withXml]).toEqual([1, 2]);
    expect(list.listFrom).toBe('2026-09-01');
    expect(list.listTo).toBe('2026-09-30');
    expect(list.skippedCount).toBe(0);
  });

  it('keeps amounts as the decimal text the portal sent', () => {
    const { list } = normalizePortalInvoices([{ query: 'purchase_5', rows: [row({ tgtcthue: '123456789012.5', tgtthue: '0', tgtttbso: '123456789012.5', dvtte: 'usd' })] }], PERIOD);
    expect(list.rows[0]).toMatchObject({ subtotal: '123456789012.5', vatAmount: '0', total: '123456789012.5', currency: 'USD' });
  });

  it('skips a row that names an invoice but cannot be read, with the reason, and ignores empty rows', () => {
    const { list } = normalizePortalInvoices(
      [
        {
          query: 'purchase_5',
          rows: [
            row({ nbmst: null }),
            row({ nbmst: '12' }),
            row({ shdon: null }),
            row({ khhdon: '' }),
            row({ tdlap: 'not a date' }),
            row({ tgtttbso: '1.980.000' }),
            row({ khhdon: 'C26<script>' }),
            { nbmst: null, khhdon: null, shdon: null },
            'not an object',
            row({ shdon: '9200' }),
          ],
        },
      ],
      PERIOD,
    );
    expect(list.skipped.map((s) => s.reason)).toEqual(['no_tax_code', 'bad_tax_code', 'no_number', 'no_series', 'bad_date', 'bad_amount', 'too_long', 'no_number']);
    expect(list.skippedCount).toBe(8);
    expect(list.rows.map((r) => r.number)).toEqual(['9200']);
  });

  it('refuses a list larger than an upload may be', () => {
    const many = Array.from({ length: 20_001 }, (_, i) => row({ shdon: String(i + 1) }));
    // The domain's own error (domain/ stays pure, #1680); the portal sync answers it 422 with this code and message.
    let refused: unknown;
    try {
      normalizePortalInvoices([{ query: 'purchase_5', rows: many }], PERIOD);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PortalListTooLarge);
    expect(refused).toMatchObject({ code: 'PORTAL_LIST_TOO_LARGE', message: TOO_LARGE });
  });

  it('feeds the same checks as an uploaded list: the org must be the buyer', () => {
    const { list } = normalizePortalInvoices([{ query: 'purchase_5', rows: [row(), row({ shdon: '2', nbmst: BUYER, nmmst: SELLER })] }], PERIOD);
    const own = checkPortalList(list, BUYER);
    expect(own.ok && own.rows.length).toBe(1);
    expect(own.ok && own.ownSales).toBe(1);
    const other = checkPortalList(list, '0302712572');
    expect(other.ok).toBe(false);
  });
});

describe('readSyncedList', () => {
  it('records the refusal of a list too large as the stored list\'s failure (#1680)', () => {
    // Two queries of 10001 rows each: each answer within its cap, the list over it.
    const half = (query: 'purchase_5' | 'purchase_6', offset: number) => ({ query, rows: Array.from({ length: 10_001 }, (_, i) => row({ shdon: String(offset + i + 1) })) });
    const evidence = { period: '2026-09', from: PERIOD.from, to: PERIOD.to, answers: [half('purchase_5', 0), half('purchase_6', 10_001)] };
    expect(readSyncedList(new TextEncoder().encode(JSON.stringify(evidence)), PERIOD)).toEqual({ ok: false, error: TOO_LARGE });
  });
});

describe('xmlCallKey', () => {
  it('names one invoice of one list', () => {
    expect(xmlCallKey('00000000-0000-7000-8000-000000000001', { sellerTaxCode: SELLER, template: '1', series: 'C26TAB', number: '9101' })).toBe(
      'finance.portal_sync:xml:00000000-0000-7000-8000-000000000001:0101234564:1:C26TAB:9101',
    );
  });
});
