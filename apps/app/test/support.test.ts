// The feedback and support link and the quick guide (issue #310).
import { describe, expect, it } from 'vitest';
import { vi } from '../src/i18n/messages/vi.ts';
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
