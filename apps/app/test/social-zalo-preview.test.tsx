// The composer's Zalo OA preview (#943): the first image as the cover, every other image after the text in order, its
// alt text as the caption. Rendered on the server; images stay placeholders, as nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: {},
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));

const { PlatformPreview } = await import('../src/components/social-preview.tsx');

const image = (n: number, altText = '') => ({ fileId: `f-${n}`, altText, mime: 'image/jpeg', sizeBytes: 100_000 });
const content = (media: ReturnType<typeof image>[]) => ({ body: 'Khai trương chi nhánh mới.', title: 'Khai trương', linkUrl: '', media });

function render(provider: string, media: ReturnType<typeof image>[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="vi" messages={viMessages} timeZone="Asia/Ho_Chi_Minh">
        <PlatformPreview channel="Tiệm Bánh B" provider={provider} content={content(media)} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('Zalo OA preview', () => {
  it('shows the cover, then every other image after the text with its alt text as the caption', () => {
    const html = render('zalo_oa', [image(1, 'Mặt tiền'), image(2, 'Quầy bánh mì'), image(3), image(4, 'Bàn ngoài trời')]);
    expect(html.match(/<figure/g)).toHaveLength(3);
    expect([...html.matchAll(/<figcaption[^>]*>([^<]*)<\/figcaption>/g)].map((m) => m[1])).toEqual(['Quầy bánh mì', 'Bàn ngoài trời']);
    // All images are shown, so there is no "1/4" counter on the cover.
    expect(html).not.toContain('1/4');
    expect(html.indexOf('Khai trương chi nhánh mới.')).toBeLessThan(html.indexOf('<figure'));
  });

  it('keeps a single image as the cover alone, and other article channels as before', () => {
    expect(render('zalo_oa', [image(1, 'Mặt tiền')])).not.toContain('<figure');
    const blog = render('wordpress', [image(1), image(2)]);
    expect(blog).not.toContain('<figure');
    expect(blog).toContain('1/2');
  });
});
