// Pinned internal comments (#1180) in the app: the board draws a numbered marker for each open pinned comment on the
// post's image or along its video, lists the pins as buttons, hides a resolved comment's marker, offers the image and
// the video moment to pin only to who may write, and a pin on a file the post no longer uses shows in its comment on
// an earlier image with that file's thumbnail; in Vietnamese and in English. Rendered on the server, with the timeline
// answered from a seeded cache; nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const off = (key: string) => ({ queryOptions: () => ({ queryKey: [key], queryFn: () => null, enabled: false }), key: () => [key] });
vi.mock('../src/lib/api.ts', () => ({
  client: { social: { posts: {} } },
  orpc: { org: { get: off('org') }, social: { posts: { activity: off('activity'), get: off('post'), list: off('list') } } },
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));

const { PostActivity } = await import('../src/components/social-activity.tsx');
const { boardMedia, boardPins, clockOf } = await import('../src/components/social-comment-pins.tsx');

const U1 = '11111111-1111-4111-8111-111111111111';
const PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const none = { variantId: null, decision: null, editedAt: null, editable: false, url: null, code: null, checklist: null, resolvedAt: null, resolvedBy: null, resolvedByName: null, resolvable: false, pin: null };
const pin = (fileId: string, mime: string, where: { x: number; y: number } | { atSeconds: number }, current = true) => ({
  fileId,
  mime,
  filename: mime.startsWith('video/') ? 'clip.mp4' : 'banner.jpg',
  x: 'x' in where ? where.x : null,
  y: 'y' in where ? where.y : null,
  atSeconds: 'atSeconds' in where ? where.atSeconds : null,
  current,
});
const comment = (id: string, at: string, body: string, extra: Record<string, unknown>) => ({ ...none, id, kind: 'comment' as const, at, userId: U1, name: 'Minh', body, ...extra });
// Newest first, as the timeline answers.
const items = [
  comment('c-old', '2026-10-22T05:00:00.000Z', 'Màu nền tối quá', { pin: pin(OLD, 'image/png', { x: 0.1, y: 0.1 }, false) }),
  comment('c-video', '2026-10-22T04:00:00.000Z', 'Chữ ở giây 12 bị che', { variantId: V1, pin: pin(CLIP, 'video/mp4', { atSeconds: 12.4 }) }),
  comment('c-done', '2026-10-22T03:00:00.000Z', 'Đổi màu chữ', { pin: pin(PHOTO, 'image/jpeg', { x: 0.9, y: 0.9 }), resolvedAt: '2026-10-22T03:30:00.000Z', resolvedBy: U1, resolvedByName: 'Minh' }),
  comment('c-logo', '2026-10-22T02:00:00.000Z', 'Logo nhỏ quá', { pin: pin(PHOTO, 'image/jpeg', { x: 0.25, y: 0.75 }) }),
  comment('c-plain', '2026-10-22T01:00:00.000Z', 'Không ghim', {}),
];
const media = boardMedia(
  [{ fileId: PHOTO, mime: 'image/jpeg', altText: 'Ảnh khai trương' }],
  [{ variantId: V1, channel: 'Facebook', ownMedia: true, media: [{ fileId: CLIP, mime: 'video/mp4', altText: null, durationMs: 30000 }] }],
);

function render(canWrite: boolean, locale: 'vi' | 'en' = 'vi'): string {
  const qc = new QueryClient();
  qc.setQueryData(['activity'], { items, more: false });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <PostActivity postId="p-1" channels={[{ variantId: V1, name: 'Facebook' }]} canWrite={canWrite} media={media} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const markers = (html: string) => [...html.matchAll(/<button[^>]*data-testid="pin-marker"[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

describe('pinned comments (#1180)', () => {
  it('numbers the open pins from the oldest and draws them on the image and along the video, without the resolved one', () => {
    const html = render(true);
    const shown = markers(html);
    expect(shown).toHaveLength(2);
    const [logo, moment] = shown;
    expect(attr(logo ?? '', 'aria-label')).toBe('Ghim 1: Logo nhỏ quá');
    expect(attr(logo ?? '', 'id')).toBe('pin-c-logo');
    expect(attr(logo ?? '', 'style')).toContain('left:25%');
    expect(attr(logo ?? '', 'style')).toContain('top:75%');
    expect(attr(moment ?? '', 'aria-label')).toBe('Ghim 2 ở 0:12: Chữ ở giây 12 bị che');
    expect(attr(moment ?? '', 'style')).toMatch(/left:41\.3\d*%/);
    // The pins as a list of buttons under each file, and the labels of the files.
    expect(text(html)).toContain('Ghim 1 · Logo nhỏ quá');
    expect(text(html)).toContain('Ghim 2 · 0:12 · Chữ ở giây 12 bị che');
    expect(text(html)).toContain('Ảnh 1');
    expect(text(html)).toContain('Video 1 · riêng Facebook');
    // Each comment says where it is pinned; the resolved one's marker is hidden.
    const entries = html.split('<li id="comment-').slice(1);
    expect(entries.map((e) => e.slice(0, e.indexOf('"')))).toEqual(['c-old', 'c-video', 'c-done', 'c-logo', 'c-plain']);
    expect(text(entries[3] ?? '')).toContain('Ghim 1');
    expect(text(entries[1] ?? '')).toContain('Ghim 2 · 0:12');
    expect(text(entries[2] ?? '')).toContain('Có ghim trên ảnh, đã ẩn vì đã xử lý');
    expect(text(entries[4] ?? '')).not.toContain('Ghim');
    expect(entries.every((e) => e.startsWith('c-') && /tabindex="-1"/.test(e.slice(0, 400)))).toBe(true);
  });

  it('shows a pin on a file the post no longer uses as on an earlier image, with that file’s thumbnail', () => {
    const html = render(true);
    const old = html.split('<li id="comment-').find((e) => e.startsWith('c-old')) ?? '';
    expect(old).toContain('data-testid="pin-old"');
    expect(text(old)).toContain('trên ảnh cũ');
    expect(markers(html).some((m) => m.includes('c-old'))).toBe(false);
    expect(text(render(true, 'en'))).toContain('on an earlier image');
  });

  it('offers the image and the video moment to pin to a writer only; a reader still sees the markers', () => {
    const writer = text(render(true));
    expect(writer).toContain('Bấm vào đúng chỗ trên ảnh để ghim bình luận vào đó');
    expect(render(true)).toContain('aria-label="Ghim bình luận vào một chỗ trên Ảnh 1"');
    expect(writer).toContain('Ghim tại 0:00');
    const reader = render(false);
    expect(markers(reader)).toHaveLength(2);
    expect(reader).not.toContain('Ghim bình luận vào một chỗ trên');
    expect(text(reader)).not.toContain('Ghim tại');
    const english = render(true, 'en');
    expect(markers(english).map((m) => attr(m, 'aria-label'))).toEqual(['Pin 1: Logo nhỏ quá', 'Pin 2 at 0:12: Chữ ở giây 12 bị che']);
    expect(text(english)).toContain('Pin at 0:00');
    expect(text(english)).toContain('Video 1 · Facebook only');
  });

  it('builds the board from the post’s files and each channel’s own, once each, and numbers its pins', () => {
    expect(media.map((m) => [m.fileId, m.variantId])).toEqual([
      [PHOTO, null],
      [CLIP, V1],
    ]);
    // A channel inheriting the post's files adds nothing; a channel's own copy of a post file shows once, as the post's.
    const again = boardMedia([{ fileId: PHOTO, mime: 'image/jpeg', altText: null }], [
      { variantId: V1, channel: 'X', ownMedia: false, media: [{ fileId: PHOTO, mime: 'image/jpeg', altText: null }] },
      { variantId: 'v-2', channel: 'Y', ownMedia: true, media: [{ fileId: PHOTO, mime: 'image/jpeg', altText: null }, { fileId: OLD, mime: 'application/pdf', altText: null }] },
    ]);
    expect(again.map((m) => m.fileId)).toEqual([PHOTO]);
    expect(boardPins(items, new Set([PHOTO, CLIP])).map((p) => [p.commentId, p.n])).toEqual([
      ['c-logo', 1],
      ['c-video', 2],
    ]);
    expect(boardPins(items, new Set([CLIP])).map((p) => [p.commentId, p.n])).toEqual([['c-video', 1]]);
    expect([clockOf(0), clockOf(12.9), clockOf(75)]).toEqual(['0:00', '0:12', '1:15']);
  });
});
