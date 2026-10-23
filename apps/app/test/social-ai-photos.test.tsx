// AI drafts from the post's photos in the app (#1191): the picker offers the post's usable images and the library, keeps
// at most four in the order picked, leaves out videos, PDF files and images over 10 MB; the draft box sends the photos
// with the brief; a library photo offers "Soạn bài từ ảnh này", which opens the composer with it. Rendered on the server;
// nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: { social: { media: { list: () => Promise.resolve({ items: [], more: false }) } } },
  orpc: {},
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ aiEnabled: true }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, search, children, className }: { to: string; params: { slug: string }; search: { photo: string }; children: ReactNode; className?: string }) => (
    <a href={`${to.replace('$slug', params.slug)}?photo=${search.photo}`} className={className}>
      {children}
    </a>
  ),
}));

const { AiPhotoPicker, DraftFromPhotoLink, aiDraftInput, togglePhoto, usablePhoto } = await import('../src/components/social-ai-photos.tsx');

const jpeg = { fileId: 'f-1', altText: '', mime: 'image/jpeg', sizeBytes: 200_000, filename: 'banh-mi.jpg' };
const png = { fileId: 'f-2', altText: '', mime: 'image/png', sizeBytes: 300_000, filename: 'cua-tiem.png' };
const video = { fileId: 'f-3', altText: '', mime: 'video/mp4', sizeBytes: 5_000_000, filename: 'clip.mp4' };
const large = { fileId: 'f-4', altText: '', mime: 'image/jpeg', sizeBytes: 11 * 1024 * 1024, filename: 'lon.jpg' };
const pdf = { fileId: 'f-5', altText: '', mime: 'application/pdf', sizeBytes: 100_000, filename: 'menu.pdf' };

function wrap(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the AI photo picker', () => {
  it("offers the post's usable images, says why the others are left out, and how many are picked", () => {
    const html = wrap(<AiPhotoPicker postMedia={[jpeg, png, video, large, pdf]} picked={['f-2']} disabled={false} onChange={() => undefined} />);
    expect(html).toContain('Ảnh trong bài');
    expect(html).toContain('aria-label="Chọn ảnh banh-mi.jpg"');
    expect(html).toContain('aria-label="Bỏ chọn ảnh cua-tiem.png"');
    expect(html).not.toContain('clip.mp4');
    expect(html).not.toContain('lon.jpg');
    expect(html).not.toContain('menu.pdf');
    expect(html).toContain('Video, tệp PDF và ảnh lớn hơn 10 MB không dùng được để AI viết bài.');
    expect(html).toContain('Đã chọn 1/4 ảnh');
    expect(html).toContain('Chọn từ thư viện');
    expect(html).toContain('không tự bịa ra giá hay cam kết nào');
    const en = wrap(<AiPhotoPicker postMedia={[jpeg]} picked={[]} disabled={false} onChange={() => undefined} />, 'en');
    expect(en).toContain('The post&#x27;s images');
    expect(en).toContain('0 of 4 photos picked');
    expect(en).toContain('Pick from the library');
  });

  it('says when the post has no usable image, and disables the rest once four are picked', () => {
    expect(wrap(<AiPhotoPicker postMedia={[video]} picked={[]} disabled={false} onChange={() => undefined} />)).toContain('Bài chưa có ảnh nào dùng được, hãy chọn trong thư viện.');
    const extra = { ...jpeg, fileId: 'f-9', filename: 'them.jpg' };
    const html = wrap(<AiPhotoPicker postMedia={[jpeg, png, extra]} picked={['a', 'b', 'f-1', 'f-2']} disabled={false} onChange={() => undefined} />);
    expect(html).toContain('Chỉ chọn được tối đa 4 ảnh');
    expect(html).toMatch(/<button[^>]*aria-label="Chọn ảnh them.jpg"[^>]*disabled=""/);
    expect(html).not.toMatch(/<button[^>]*aria-label="Bỏ chọn ảnh banh-mi.jpg"[^>]*disabled=""/);
  });

  it('keeps at most four photos in the order picked, and takes one out on a second click', () => {
    expect(togglePhoto([], 'a')).toEqual(['a']);
    expect(togglePhoto(['a', 'b'], 'a')).toEqual(['b']);
    expect(togglePhoto(['a', 'b', 'c', 'd'], 'e')).toEqual(['a', 'b', 'c', 'd']);
    expect(togglePhoto(['a', 'b', 'c', 'd'], 'c')).toEqual(['a', 'b', 'd']);
    expect(usablePhoto(jpeg)).toBe(true);
    expect(usablePhoto({ mime: 'image/webp', sizeBytes: 10 * 1024 * 1024 })).toBe(true);
    expect([video, large, pdf].some(usablePhoto)).toBe(false);
  });

  it('sends the photos with the brief, in the language of the page, and no photos when none are picked', () => {
    expect(aiDraftInput({ brief: '  ', connectionIds: ['c-1'], locale: 'vi', source: null, photos: ['f-2', 'f-1'] })).toEqual({ brief: '', connectionIds: ['c-1'], language: 'vi', fileIds: ['f-2', 'f-1'] });
    expect(aiDraftInput({ brief: 'Khai trương ', connectionIds: ['c-1', 'c-2'], locale: 'en', source: 'https://shop.example/a', photos: [] })).toEqual({
      brief: 'Khai trương',
      connectionIds: ['c-1', 'c-2'],
      language: 'en',
      sourceUrl: 'https://shop.example/a',
    });
  });
});

describe('"Soạn bài từ ảnh này" on a library photo', () => {
  it('opens the composer with the photo, for images the model can be sent only', () => {
    expect(wrap(<DraftFromPhotoLink slug="tiem-banh" item={jpeg} />)).toContain('href="/o/tiem-banh/social/new?photo=f-1"');
    expect(wrap(<DraftFromPhotoLink slug="tiem-banh" item={jpeg} />)).toContain('Soạn bài từ ảnh này');
    expect(wrap(<DraftFromPhotoLink slug="tiem-banh" item={jpeg} />, 'en')).toContain('Draft a post from this photo');
    expect(wrap(<DraftFromPhotoLink slug="tiem-banh" item={video} />)).toBe('');
    expect(wrap(<DraftFromPhotoLink slug="tiem-banh" item={large} />)).toBe('');
  });
});
