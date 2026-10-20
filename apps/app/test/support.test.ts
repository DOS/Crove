// The feedback and support link and the quick guide (issue #310).
import { describe, expect, it } from 'vitest';
import { vi } from '../src/i18n/messages/vi.ts';
import { FIRM_GUIDE, fill } from '../src/lib/firm-guide.ts';
import { QUICK_GUIDE } from '../src/lib/quick-guide.ts';
import { supportLink } from '../src/lib/support.ts';

describe('support link', () => {
  it('hides the link when the deployment sets none', () => {
    expect(supportLink(undefined)).toBeNull();
    expect(supportLink(null)).toBeNull();
    expect(supportLink('')).toBeNull();
  });

  it('opens an https: page in a new tab and hands a mailto: address to the mail app', () => {
    expect(supportLink('https://chat.example.com/g/crove-pilot')).toEqual({ href: 'https://chat.example.com/g/crove-pilot', external: true });
    expect(supportLink('mailto:support@example.com?subject=Crove')).toEqual({ href: 'mailto:support@example.com?subject=Crove', external: false });
  });

  it('hides any other scheme, a mailto: without an address and a value that is not a URL', () => {
    for (const url of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', 'ftp://example.com', 'mailto:', 'mailto: ', 'not a url', '/support']) {
      expect(supportLink(url), url).toBeNull();
    }
  });
});

describe('quick guide', () => {
  it('covers upload, approve and export, in that order', () => {
    expect(QUICK_GUIDE.map((step) => step.id)).toEqual(['upload', 'approve', 'export']);
    for (const step of QUICK_GUIDE) expect(step.items.length, step.id).toBeGreaterThan(0);
  });

  it('names the buttons the screens show', () => {
    const text = QUICK_GUIDE.flatMap((step) => [step.title, ...step.items]).join('\n');
    for (const label of [vi.inbox.upload, vi.inboxDetail.approve, vi.inboxDetail.reject, vi.journal.export, vi.nav.inbox, vi.nav.journal]) {
      expect(text).toContain(`"${label}"`);
    }
  });

  it('is Vietnamese with diacritics and has no em dashes or en dashes', () => {
    for (const line of QUICK_GUIDE.flatMap((step) => [step.title, ...step.items])) {
      expect(line.trim(), line).not.toBe('');
      expect(line, line).not.toMatch(/[–—]/);
    }
    expect(QUICK_GUIDE.map((step) => step.title)).toEqual(['Bước 1. Tải hóa đơn lên', 'Bước 2. Kiểm tra và duyệt', 'Bước 3. Xuất Excel cho kế toán']);
  });
});

describe('firm guide (#661)', () => {
  const lines = FIRM_GUIDE.flatMap((step) => [step.title, ...step.items]);
  const text = lines.join('\n');

  it("walks one client's month in order, from adding the client to the hand-over", () => {
    expect(FIRM_GUIDE.map((step) => step.id)).toEqual(['client', 'setup', 'intake', 'review', 'bank', 'close', 'handover']);
    expect(FIRM_GUIDE.map((step) => step.title)).toEqual([
      'Bước 1. Thêm doanh nghiệp khách hàng',
      'Bước 2. Cài đặt một lần cho mỗi khách hàng',
      'Bước 3. Nhận hóa đơn mua vào và bán ra của tháng',
      'Bước 4. Kiểm tra và duyệt',
      'Bước 5. Ngân hàng và tiền mặt',
      'Bước 6. Khóa sổ và tờ khai GTGT',
      'Bước 7. Đưa số liệu sang phần mềm kế toán của hãng',
    ]);
    for (const step of FIRM_GUIDE) expect(step.items.length, step.id).toBeGreaterThan(0);
  });

  it('names the screens and buttons the app shows, placeholders filled in', () => {
    for (const label of [
      vi.nav.addOrg,
      vi.onboarding.lookUp,
      vi.nav.allClients,
      vi.settings.vatFilingPeriod,
      vi.openingBalance.open,
      vi.inbox.upload,
      vi.portalList.upload,
      fill(vi.inbox.bulk.approve, { count: 'N' }),
      vi.inboxDetail.approve,
      vi.bank.makeVoucher,
      vi.vouchers.new,
      vi.vat.exportXml,
      fill(vi.periodLock.lock, { month: 'MM/YYYY' }),
      vi.journal.exportMisa,
      vi.journal.exportMisaSales,
      vi.vouchers.exportReceipts,
      vi.vouchers.exportPayments,
      vi.journal.export,
    ]) {
      expect(text).toContain(`"${label}"`);
    }
    // Every quoted label is filled: no ICU placeholder is left for the reader.
    expect(text).not.toMatch(/[{}]/);
  });

  it('fills ICU placeholders and leaves unknown ones', () => {
    expect(fill('Duyệt {count, number} đề xuất', { count: 'N' })).toBe('Duyệt N đề xuất');
    expect(fill('Khóa sổ tháng {month}', { month: '09/2026' })).toBe('Khóa sổ tháng 09/2026');
    expect(fill('{a} và {b}', { a: 'x' })).toBe('x và {b}');
    // A placeholder named like an Object.prototype member is not filled from the prototype.
    expect(fill('{toString}', {})).toBe('{toString}');
  });

  it('is Vietnamese with diacritics and has no em dashes or en dashes', () => {
    for (const line of lines) {
      expect(line.trim(), line).not.toBe('');
      expect(line, line).not.toMatch(/[–—]/);
    }
  });
});
