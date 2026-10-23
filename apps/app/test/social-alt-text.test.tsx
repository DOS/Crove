// AI alt text suggestions in the composer's media editor (#817, #1121): a "Gợi ý mô tả ảnh" action per image when AI is
// on, a recorded answer filling only that image's field for the member to edit, and the ask carrying the page's
// language and the post's channels. Rendered on the server; nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const config = { aiEnabled: true };
const describeImage = vi.fn(async (_input: { fileId: string; language: 'vi' | 'en'; connectionIds?: string[] }) => ({ altText: 'Ổ bánh mì giòn trên khay gỗ' }));

vi.mock('../src/lib/api.ts', () => ({
  client: { social: { posts: { describeImage } } },
  orpc: { social: { watermark: { get: { queryOptions: () => ({ queryKey: ['social-watermark'], queryFn: () => null, enabled: false }) } } } },
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => config }));

const { MediaField, askAltText, withSuggestedAlt } = await import('../src/components/social-media.tsx');

const image = { fileId: 'f-1', altText: '', mime: 'image/jpeg', sizeBytes: 100_000 };
const video = { fileId: 'f-2', altText: '', mime: 'video/mp4', sizeBytes: 5_000_000 };

function render(options: { ai?: boolean; locale?: 'vi' | 'en' } = {}): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale={options.locale ?? 'vi'} messages={catalog(options.locale ?? 'vi')} timeZone="Asia/Ho_Chi_Minh">
        <MediaField media={[image, video]} disabled={false} onChange={() => undefined} {...(options.ai === false ? {} : { onAiUsed: () => undefined })} connectionIds={['c-1']} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('AI alt text suggestions in the media editor', () => {
  beforeEach(() => {
    config.aiEnabled = true;
    describeImage.mockClear();
  });

  it('offers "Gợi ý mô tả ảnh" for each image, not for a video', () => {
    expect(render().match(/Gợi ý mô tả ảnh/g)).toHaveLength(1);
    expect(render({ locale: 'en' }).match(/Suggest image description/g)).toHaveLength(1);
  });

  it('hides it when the server has no AI, and where AI help does not taint a post', () => {
    config.aiEnabled = false;
    expect(render()).not.toContain('Gợi ý mô tả ảnh');
    config.aiEnabled = true;
    expect(render({ ai: false })).not.toContain('Gợi ý mô tả ảnh');
  });

  it("fills only that image's field with the recorded answer, asked in the page's language for the post's channels", async () => {
    const altText = await askAltText('f-1', 'vi', ['c-1', 'c-2']);
    expect(describeImage).toHaveBeenCalledWith({ fileId: 'f-1', language: 'vi', connectionIds: ['c-1', 'c-2'] });
    expect(withSuggestedAlt([image, video], 'f-1', altText)).toEqual([{ ...image, altText: 'Ổ bánh mì giòn trên khay gỗ' }, video]);
    // An image removed while the model answered gets nothing, and nothing else changes.
    expect(withSuggestedAlt([video], 'f-1', altText)).toEqual([video]);
    await askAltText('f-1', 'en');
    expect(describeImage).toHaveBeenLastCalledWith({ fileId: 'f-1', language: 'en' });
  });
});
