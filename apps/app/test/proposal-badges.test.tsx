// SPDX-License-Identifier: AGPL-3.0-only
// The badges of an Inbox row (#2054): a posting a reversal voided says so in both languages, in the error chip, and
// carries no "all checks pass" success badge beside it; a standing posting keeps it.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { ProposalBadges, type ProposalBadgesItem } from '../src/components/proposal-badges.tsx';
import { catalog } from '../src/i18n/runtime.ts';

const posted: ProposalBadgesItem = {
  kind: 'finance.purchase',
  direction: 'purchase',
  duplicateOf: null,
  signatureStatus: 'verified',
  failedChecks: 0,
  warnChecks: 0,
  requestedByAgent: null,
  extracted: true,
  voided: false,
};

function render(item: ProposalBadgesItem, locale: 'vi' | 'en'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <ProposalBadges item={item} />
    </IntlProvider>,
  );
}

// The variant of the badge holding `label`, as the chip's data attribute gives it: read from the tag that opens it.
function variantOf(html: string, label: string): string | undefined {
  const at = html.indexOf(`>${label}<`);
  if (at < 0) return undefined;
  const tag = html.slice(0, at).split('<span').at(-1) ?? '';
  return /data-variant="([a-z]+)"/.exec(tag)?.[1];
}

describe('the badges of an Inbox row', () => {
  it('says a voided posting is voided, in the error chip, and drops the success badge', () => {
    for (const locale of ['vi', 'en'] as const) {
      const words = catalog(locale).inbox;
      const html = render({ ...posted, voided: true }, locale);
      expect(html, locale).toContain(words.voided);
      expect(variantOf(html, words.voided), locale).toBe('destructive');
      expect(html, locale).not.toContain(`>${words.matched}<`);
    }
  });

  it('keeps the success badge on a posting that stands, and shows no voided chip', () => {
    for (const locale of ['vi', 'en'] as const) {
      const words = catalog(locale).inbox;
      const html = render(posted, locale);
      expect(html, locale).toContain(`>${words.matched}<`);
      expect(html, locale).not.toContain(words.voided);
    }
  });

  // #2091: a proposal with a line no rule matched says so in both languages, and is not shown as matched.
  it('shows the count of unclassified lines as a warning, in vi and en, and no success badge', () => {
    const unclassified = { ...posted, warnChecks: 1, unclassifiedLines: 2 };
    expect(render(unclassified, 'vi')).toContain('>2 dòng chưa phân loại<');
    expect(render(unclassified, 'en')).toContain('>2 lines unclassified<');
    expect(render({ ...unclassified, unclassifiedLines: 1 }, 'en')).toContain('>1 line unclassified<');
    for (const locale of ['vi', 'en'] as const) {
      const html = render(unclassified, locale);
      expect(variantOf(html, locale === 'vi' ? '2 dòng chưa phân loại' : '2 lines unclassified'), locale).toBe('warning');
      expect(html, locale).not.toContain(`>${catalog(locale).inbox.matched}<`);
      // A proposal with every line classified shows no such badge.
      expect(render({ ...posted, unclassifiedLines: 0 }, locale), locale).not.toMatch(/unclassified|chưa phân loại/);
    }
  });

  it("words it as the file's chip does", () => {
    expect(catalog('vi').inbox.voided).toBe('Đã hủy (đảo bút toán)');
    expect(catalog('vi').inbox.voided).toBe(catalog('vi').inbox.fileStatus.voided);
    expect(catalog('en').inbox.voided).toBe(catalog('en').inbox.fileStatus.voided);
  });
});
