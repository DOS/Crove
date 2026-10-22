// The request for missing purchase invoices (#669): the period names, the amounts and the mail rendered from its merge
// data (request and reminder, Reply-To, the cut-off list, escaping). The commands are covered on PostgreSQL in
// apps/kernel/test/finance-missing-invoices.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import {
  MISSING_INVOICE_PAYLOAD_BYTES,
  collectMissing,
  formatAmount,
  mailPayload,
  periodLabel,
  renderMissingInvoiceMail,
  type MissingInvoiceMail,
  type MissingItem,
} from '../src/index.ts';

const item = (number: string, extra: Partial<MissingInvoiceMail['periods'][number]['items'][number]> = {}) => ({
  sellerName: 'Công ty TNHH Văn phòng phẩm Hồng Hà',
  sellerTaxCode: '0101234564',
  template: '1',
  series: 'C26TAB',
  number,
  issueDate: '2026-09-05',
  total: '1980000',
  currency: 'VND',
  ...extra,
});

const request: MissingInvoiceMail = {
  kind: 'request',
  orgName: 'Công ty Người Mua Mẫu',
  requestPeriod: '2026-09',
  periods: [{ period: '2026-09', count: 2, items: [item('9007'), item('9008', { total: null })] }],
  count: 2,
};

describe('missing invoice mail (#669)', () => {
  it('names months and quarters as Vietnamese does', () => {
    expect(periodLabel('2026-09')).toBe('tháng 9/2026');
    expect(periodLabel('2026-Q3')).toBe('quý 3/2026');
  });

  it('writes amounts with Vietnamese separators', () => {
    expect(formatAmount('1980000', 'VND')).toBe('1.980.000 đồng');
    expect(formatAmount('1234.5', 'USD')).toBe('1.234,5 USD');
    expect(formatAmount('-500000', 'VND')).toBe('-500.000 đồng');
  });

  it('lists the invoices of the period and asks for a reply to the inbound address', () => {
    const mail = renderMissingInvoiceMail(request, { replyTo: 'abc123@in.crove.example' });
    expect(mail.replyTo).toBe('abc123@in.crove.example');
    expect(mail.text).toContain('Kính gửi Quý công ty Công ty Người Mua Mẫu,');
    expect(mail.text).toContain('chưa nhận được 2 hóa đơn đầu vào dưới đây của tháng 9/2026');
    expect(mail.text).toContain(
      '1. Công ty TNHH Văn phòng phẩm Hồng Hà (MST 0101234564): hóa đơn số 9007, ký hiệu 1C26TAB, ngày 05/09/2026, tổng tiền 1.980.000 đồng',
    );
    expect(mail.text).toContain('2. Công ty TNHH Văn phòng phẩm Hồng Hà (MST 0101234564): hóa đơn số 9008, ký hiệu 1C26TAB, ngày 05/09/2026\n');
    expect(mail.text).toContain('chuyển tiếp thư của người bán tới địa chỉ abc123@in.crove.example');
    expect(mail.html).toContain('<td style="padding:6px 8px;border-bottom:1px solid #d0d7de;white-space:nowrap;text-align:right">1.980.000 đồng</td>');
  });

  it('asks only for a reply when the deployment receives no mail', () => {
    const mail = renderMissingInvoiceMail(request, { replyTo: null });
    expect(mail.replyTo).toBeUndefined();
    expect(mail.text).toContain('bằng cách trả lời thư này.');
    expect(mail.text).not.toContain('chuyển tiếp');
  });

  // #1040: the footer names the product by BRAND_NAME, "Crove" when not given.
  it('names the product by the brand it is given', () => {
    expect(renderMissingInvoiceMail(request, { replyTo: null }).text).toContain('gửi tự động qua Crove theo yêu cầu');
    const mail = renderMissingInvoiceMail(request, { replyTo: null, brand: "Sổ & Co's" });
    expect(mail.text).toContain("gửi tự động qua Sổ & Co's theo yêu cầu");
    expect(mail.html).toContain('gửi tự động qua Sổ &amp; Co&#39;s theo yêu cầu');
    expect(`${mail.text}${mail.html}`).not.toContain('Crove');
  });

  it('groups a reminder by period and says how many invoices it left out', () => {
    const reminder: MissingInvoiceMail = {
      kind: 'reminder',
      orgName: 'Công ty Người Mua Mẫu',
      periods: [
        { period: '2026-08', count: 1, items: [item('8001')] },
        { period: '2026-Q3', count: 5, items: [item('9001'), item('9002')] },
      ],
      count: 6,
    };
    const mail = renderMissingInvoiceMail(reminder, { replyTo: null });
    expect(mail.text).toContain('vẫn còn 6 hóa đơn đầu vào');
    expect(mail.text).toContain('Tháng 8/2026 (1 hóa đơn)\n1. ');
    expect(mail.text).toContain('Quý 3/2026 (5 hóa đơn)\n1. ');
    expect(mail.text).toContain('Và 3 hóa đơn khác;');
    expect(mail.text).toContain('gửi tự động hằng tháng');
    expect(mail.html).toContain('<h3 style="font-size:15px;margin:16px 0 4px">Quý 3/2026 (5 hóa đơn)</h3>');
  });

  it('escapes names from the sheet and keeps them on one line', () => {
    const mail = renderMissingInvoiceMail(
      { ...request, orgName: 'A <b>&</b>\nB', periods: [{ period: '2026-09', count: 1, items: [item('1', { sellerName: '<script>x</script>‮' })] }], count: 1 },
      { replyTo: null },
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(mail.html).toContain('A &lt;b&gt;&amp;&lt;/b&gt; B');
    expect(mail.text).not.toContain('‮');
  });

  it('keeps the merge data under its byte budget, however long the seller names, and counts what it left out', () => {
    const long = 'Công ty Trách nhiệm hữu hạn Thương mại và Dịch vụ Kỹ thuật Hưng Thịnh Phát Đạt Miền Bắc '.repeat(6);
    const items = Array.from({ length: 150 }, (_, i) => item(String(i + 1), { sellerName: long }));
    const payload = mailPayload('request', 'Công ty Người Mua Mẫu', [{ period: '2026-09', items }], '2026-09');
    const shown = payload.periods[0]?.items ?? [];
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(MISSING_INVOICE_PAYLOAD_BYTES);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(150);
    expect(shown.every((i) => i.sellerName.length <= 200)).toBe(true);
    expect(payload).toMatchObject({ count: 150, periods: [{ period: '2026-09', count: 150 }] });
    expect(renderMissingInvoiceMail(payload, { replyTo: null }).text).toContain(`Và ${150 - shown.length} hóa đơn khác;`);
    // Short names: the count cap.
    const many = mailPayload('reminder', 'A', [
      { period: '2026-08', items: Array.from({ length: 100 }, (_, i) => item(`8${i}`)) },
      { period: '2026-09', items: Array.from({ length: 100 }, (_, i) => item(`9${i}`)) },
    ]);
    expect(many.periods.map((p) => [p.count, p.items.length])).toEqual([
      [100, 100],
      [100, 50],
    ]);
  });

  it('lists an invoice of a month and its quarter once, and skips a period too large to reconcile', async () => {
    const lists: Record<string, MissingItem[]> = {
      '2026-08': [item('8001')],
      '2026-09': [item('9001'), item('9002')],
      '2026-Q3': [item('8001'), item('9001'), item('9002'), item('9100', { issueDate: '2026-07-10' })],
    };
    const load = async (period: string) => {
      if (period === '2026-10') throw new DomainError('PERIOD_TOO_LARGE', 422, 'too large');
      return lists[period] ?? [];
    };
    const { missing, skipped } = await collectMissing(['2026-08', '2026-09', '2026-10', '2026-Q3'], load);
    expect(skipped).toEqual(['2026-10']);
    expect(missing.map((m) => [m.period, m.items.map((i) => i.number)])).toEqual([
      ['2026-08', ['8001']],
      ['2026-09', ['9001', '9002']],
      ['2026-Q3', ['9100']],
    ]);
    // Any other failure still fails the reminder.
    await expect(collectMissing(['2026-08'], async () => Promise.reject(new Error('connection lost')))).rejects.toThrow('connection lost');
  });

  it('refuses merge data that is not a missing-invoice mail', () => {
    expect(() => renderMissingInvoiceMail({ kind: 'request' }, { replyTo: null })).toThrow();
    expect(() => renderMissingInvoiceMail({ ...request, periods: [{ period: 'bad', count: 1, items: [] }] }, { replyTo: null })).toThrow();
  });
});
