// Posts published outside Crove on the Metrics tab (#1054): one list with Crove's own by publish time, the switch and
// its hint, the chip, and a link to the post only when its page is https. Rendered on the server.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { OutsideChip, OutsidePostCell, OutsideSwitch } from '../src/components/social-external-posts.tsx';
import { catalog } from '../src/i18n/runtime.ts';
import { mergePublished, outsideUrl } from '../src/lib/social-external.ts';

// The catalogs as the app shows them, the product name (#1040) filled in.
const viMessages = catalog('vi');
const enMessages = catalog('en');

const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={locale === 'vi' ? viMessages : enMessages} timeZone="Asia/Ho_Chi_Minh">
      {node}
    </IntlProvider>,
  );

describe('mergePublished', () => {
  it("merges outside posts into Crove's list by publish time without reordering Crove's rows", () => {
    const crove = [
      { variantId: 'v1', publishedAt: '2026-10-20T08:00:00.000Z' },
      { variantId: 'v2', publishedAt: null },
      { variantId: 'v3', publishedAt: '2026-10-18T08:00:00.000Z' },
    ];
    const outside = [
      { id: 'e1', publishedAt: '2026-10-21T08:00:00.000Z' },
      { id: 'e2', publishedAt: '2026-10-18T08:00:00.000Z' },
    ];
    expect(mergePublished(crove, outside).map((i) => (i.kind === 'crove' ? i.row.variantId : i.row.id))).toEqual(['e1', 'v1', 'e2', 'v2', 'v3']);
    // With no outside posts the Crove list is unchanged.
    expect(mergePublished(crove, []).map((i) => i.row)).toEqual(crove);
  });

  it('links only https pages', () => {
    expect(outsideUrl('https://www.facebook.com/1_2')).toBe('https://www.facebook.com/1_2');
    expect(outsideUrl('http://www.facebook.com/1_2')).toBeNull();
    expect(outsideUrl('javascript:alert(1)')).toBeNull();
    expect(outsideUrl('not a url')).toBeNull();
    expect(outsideUrl(null)).toBeNull();
  });
});

describe('outside posts on the Metrics tab', () => {
  it('shows the switch with its hint, and says why it is off under a label filter', () => {
    const on = render(<OutsideSwitch checked onChange={() => undefined} />);
    expect(on).toContain('Tính cả bài đăng ngoài Crove');
    expect(on).toContain(viMessages.social.external.hint);
    const labelled = render(<OutsideSwitch checked onChange={() => undefined} disabled />);
    expect(labelled).toContain(viMessages.social.external.noLabels);
    expect(labelled).toContain('disabled');
    expect(render(<OutsideSwitch checked={false} onChange={() => undefined} />, 'en')).toContain('Include posts published outside Crove');
  });

  it('carries the chip, links to the post on the platform only over https, and escapes the text', () => {
    const linked = render(<OutsidePostCell excerpt="Khai trương <b>chi nhánh</b>" url="https://www.facebook.com/1_2" meta="Facebook · Fanpage" />);
    expect(linked).toContain('Đăng ngoài Crove');
    expect(linked).toContain('href="https://www.facebook.com/1_2"');
    expect(linked).toContain('rel="noopener noreferrer nofollow"');
    expect(linked).toContain('Khai trương &lt;b&gt;chi nhánh&lt;/b&gt;');
    const unsafe = render(<OutsidePostCell excerpt="" url="javascript:alert(1)" meta="Instagram" />);
    expect(unsafe).not.toContain('href=');
    expect(unsafe).toContain(viMessages.social.external.noText);
  });

  it('names the chip as the page asks, so a client report never says Crove', () => {
    expect(render(<OutsideChip />)).toContain('Đăng ngoài Crove');
    const report = render(<OutsideChip label={viMessages.social.clientReport.direct} />);
    expect(report).toContain('Đăng trực tiếp');
    expect(report).not.toContain('Crove');
    expect(viMessages.social.clientReport.withExternal).not.toContain('Crove');
    expect(enMessages.social.clientReport.withExternal).not.toContain('Crove');
  });
});
