// The composer's Telegram preview (#1017): the link buttons under the post, in their rows, as Telegram lays out an
// inline keyboard. Rendered on the server; nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: {},
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));

const { PlatformPreview } = await import('../src/components/social-preview.tsx');

function render(buttons?: { text: string; url: string }[][]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
        <PlatformPreview channel="Quán Phở" provider="telegram" content={{ body: 'Khai trương chi nhánh mới.', title: '', linkUrl: '', media: [], ...(buttons ? { buttons } : {}) }} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('Telegram preview', () => {
  it('shows each row of buttons under the post, with the link on hover', () => {
    const html = render([[{ text: 'Mua ngay', url: 'https://shop.example/pho' }, { text: 'Zalo', url: 'https://zalo.me/0901234567' }], [{ text: 'Bản đồ', url: 'https://maps.example/quan-pho' }]]);
    const group = /<div[^>]*role="group"[^>]*aria-label="Nút dưới bài"[^>]*>(.*)<\/div><\/div>$/s.exec(html)?.[1] ?? '';
    const rows = group.split('<div class="flex gap-1">').slice(1);
    expect(rows.map((row) => [...row.matchAll(/title="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[2], m[1]]))).toEqual([
      [
        ['Mua ngay', 'https://shop.example/pho'],
        ['Zalo', 'https://zalo.me/0901234567'],
      ],
      [['Bản đồ', 'https://maps.example/quan-pho']],
    ]);
    expect(html.indexOf('Khai trương chi nhánh mới.')).toBeLessThan(html.indexOf('Mua ngay'));
  });

  it('shows no buttons when the post has none', () => {
    expect(render()).not.toContain('role="group"');
    expect(render([])).not.toContain('role="group"');
  });
});
