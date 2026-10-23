// The composer's poll preview on Mastodon, Telegram and LinkedIn (#1118): a LinkedIn poll's own question above the
// options, the length where the poll has one, several answers and hidden results when chosen. Rendered on the server;
// nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { POLL_RULES } from '@crove/mod-social/contract';
import { catalog } from '../src/i18n/runtime.ts';
import type { PreviewContent } from '../src/components/social-preview.tsx';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: {},
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));

const { PlatformPreview } = await import('../src/components/social-preview.tsx');

function render(provider: string, poll: Partial<PreviewContent>, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <PlatformPreview channel="Quán Phở" provider={provider} content={{ body: 'Bạn thích món nào?', title: '', linkUrl: '', media: [], ...poll }} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('poll preview (#1118)', () => {
  it('shows a LinkedIn poll with its own question above the options and its length', () => {
    const html = render('linkedin_page', { poll: ['Quận 1', 'Thủ Đức'], pollMinutes: 4320, pollQuestion: 'Chi nhánh tiếp theo ở đâu?' });
    expect(html.indexOf('Bạn thích món nào?')).toBeLessThan(html.indexOf('Chi nhánh tiếp theo ở đâu?'));
    expect(html.indexOf('Chi nhánh tiếp theo ở đâu?')).toBeLessThan(html.indexOf('Quận 1'));
    expect(html).toContain('Còn 3 ngày');
  });

  it('says when voters may pick several options and when results stay hidden', () => {
    const html = render('mastodon', { poll: ['Phở', 'Bún chả'], pollMinutes: 1440, pollMultiple: true, pollHideTotals: true });
    expect(html).toContain('Có thể chọn nhiều đáp án');
    expect(html).toContain('Kết quả hiện khi bình chọn kết thúc');
    expect(render('mastodon', { poll: ['Phở', 'Bún chả'], pollMultiple: true }, 'en')).toContain('More than one answer allowed');
    expect(render('mastodon', { poll: ['Phở', 'Bún chả'] })).not.toContain('Có thể chọn nhiều đáp án');
  });

  it('shows no length for a Telegram poll left open until stopped', () => {
    const html = render('telegram', { poll: ['Phở', 'Bún chả'] });
    expect(html).toContain('Phở');
    expect(html).not.toContain('Còn ');
  });

  it('offers the poll editor on Mastodon, Telegram and both LinkedIn channels, with their limits', () => {
    expect(POLL_RULES.mastodon).toMatchObject({ maxOptions: 4, maxChars: 50, multiple: true, hideTotals: true });
    expect(POLL_RULES.telegram).toMatchObject({ maxOptions: 12, maxChars: 100, textAsQuestion: { maxChars: 300 } });
    expect(POLL_RULES.linkedin).toEqual(POLL_RULES.linkedin_page);
    expect(POLL_RULES.linkedin?.duration?.choices).toEqual([1440, 4320, 10_080, 20_160]);
  });
});
