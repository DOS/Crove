// Pexels photos in the library and the composer (#1106): the credit under a photo links the photographer and Pexels,
// draws a link only to a page on pexels.com and shows a name as text; the search panel links back to Pexels in both
// languages. Rendered on the server; nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: { social: { stockPhotos: { status: vi.fn(), search: vi.fn(), save: vi.fn() } } },
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
}));

const { PEXELS_URL, StockCredit, StockPhotoSearch, pexelsHref } = await import('../src/components/social-stock-photos.tsx');

function render(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('Pexels credits and search panel (#1106)', () => {
  it('links only to pages on pexels.com', () => {
    expect(pexelsHref('https://www.pexels.com/@a')).toBe('https://www.pexels.com/@a');
    for (const bad of ['javascript:alert(1)', 'http://www.pexels.com/@a', 'https://pexels.com.evil.example/', 'https://evil.example/', '', null, undefined]) {
      expect(pexelsHref(bad), String(bad)).toBeNull();
    }
  });

  it('credits the photographer and Pexels with links back, in Vietnamese and English', () => {
    const vi = render(<StockCredit photographer="Trần Thị B" photographerUrl="https://www.pexels.com/@tran-thi-b" />);
    expect(vi).toContain('Ảnh của <a href="https://www.pexels.com/@tran-thi-b" target="_blank" rel="noopener noreferrer" class="text-link hover:underline">Trần Thị B</a> trên <a href="https://www.pexels.com"');
    const en = render(<StockCredit photographer="Trần Thị B" photographerUrl="https://www.pexels.com/@tran-thi-b" />, 'en');
    expect(en).toContain('Photo by <a href="https://www.pexels.com/@tran-thi-b"');
    expect(en).toContain(`on <a href="${PEXELS_URL}"`);
  });

  it('shows a name from Pexels as text and drops a link that leaves Pexels', () => {
    const html = render(<StockCredit photographer={'<img src=x onerror=alert(1)>'} photographerUrl="javascript:alert(1)" />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('javascript:');
  });

  it('links the search panel back to Pexels', () => {
    const html = render(<StockPhotoSearch />);
    expect(html).toContain('Ảnh miễn phí từ Pexels');
    expect(html).toContain(`Ảnh do <a href="${PEXELS_URL}"`);
    expect(render(<StockPhotoSearch mode="post" />, 'en')).toContain('Free photos from Pexels');
  });
});
