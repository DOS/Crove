// The fix of an image a channel refuses (#1500), in the composer's media editor: "Sửa cho kênh" under an image one of
// the post's channels refuses, naming them and the byte limit the fix keeps to, disabled for a viewer, never offered
// for a GIF or an image every channel takes. Rendered on the server; nothing is fetched or uploaded.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: {
    social: { watermark: { get: { queryOptions: () => ({ queryKey: ['social-watermark'], queryFn: () => null, enabled: false }) } } },
    channels: { list: { queryOptions: () => ({ queryKey: ['channels'], queryFn: () => [] }) } },
  },
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ aiEnabled: false }) }));

const { MediaField } = await import('../src/components/social-media.tsx');

const MB = 1024 * 1024;
const png = { fileId: 'f-png', altText: '', mime: 'image/png', sizeBytes: 6 * MB, width: 3000, height: 3000 };
const jpeg = { fileId: 'f-jpg', altText: '', mime: 'image/jpeg', sizeBytes: 300_000, width: 1080, height: 1080 };
const gif = { fileId: 'f-gif', altText: '', mime: 'image/gif', sizeBytes: 2 * MB };

function render(media: (typeof png | typeof gif)[], options: { disabled?: boolean; locale?: 'vi' | 'en'; connectionIds?: string[]; read?: boolean } = {}): string {
  const queries = new QueryClient();
  queries.setQueryData(['channels'], [
    { id: 'c-ig', provider: 'instagram' },
    { id: 'c-zalo', provider: 'zalo_oa' },
    { id: 'c-masto', provider: 'mastodon' },
  ]);
  // The PNG's first bytes were read: it does not move. Until they are, the button waits.
  if (options.read !== false) queries.setQueryData(['social-image-animated', png.fileId], false);
  return renderToStaticMarkup(
    <QueryClientProvider client={queries}>
      <IntlProvider locale={options.locale ?? 'vi'} messages={catalog(options.locale ?? 'vi')} timeZone="Asia/Ho_Chi_Minh">
        <MediaField media={media} disabled={options.disabled ?? false} onChange={() => undefined} connectionIds={options.connectionIds ?? ['c-ig', 'c-zalo']} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

// Whether the fix's button is there and disabled (the attribute, not the disabled: classes).
const fixDisabled = (html: string) => {
  const button = html.match(/<button[^>]*>(?:(?!<\/button>).)*Sửa cho kênh<\/button>/)?.[0];
  return button === undefined ? undefined : / disabled=""/.test(button);
};

describe('fixing a refused image in the media editor (#1500)', () => {
  it('offers "Sửa cho kênh" under a PNG Instagram and Zalo OA refuse, to a JPEG of at most 1 MB', () => {
    const html = render([png, jpeg]);
    expect(html.match(/Sửa cho kênh/g)).toHaveLength(1);
    expect(html).toContain('Instagram, Zalo OA không nhận ảnh này');
    expect(html).toContain('không quá 1.0 MB');
    expect(html).toContain('ảnh gốc vẫn còn trong thư viện');
    expect(fixDisabled(html)).toBe(false);
    expect(render([png], { locale: 'en' })).toContain('Fix for channels');
  });

  it('disables it for a viewer, and until the image is known not to move', () => {
    expect(fixDisabled(render([png], { disabled: true }))).toBe(true);
    expect(fixDisabled(render([png], { read: false }))).toBe(true);
  });

  it('offers nothing when every channel takes the image, or no channel is chosen', () => {
    expect(render([jpeg])).not.toContain('Sửa cho kênh');
    expect(render([png], { connectionIds: ['c-masto'] })).not.toContain('Sửa cho kênh');
    expect(render([png], { connectionIds: [] })).not.toContain('Sửa cho kênh');
  });

  it('never offers it for a GIF, and says to make it a video', () => {
    const html = render([gif]);
    expect(html).not.toContain('Sửa cho kênh');
    expect(html).toContain('Hãy chuyển ảnh thành video rồi tải lên');
  });
});
