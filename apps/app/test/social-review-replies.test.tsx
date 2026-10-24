// The team's reply to a client's answer (#1301): the review links panel on the post screen, where members and above
// reply, edit and remove it, and both public review pages (one post and a plan), where the client reads it signed with
// the org's or its branding's name and never a member's; and a plan's body sent once per post (#930). Rendered on the
// server from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e), fetchFile: () => Promise.reject(new Error('not fetched')), uploadFiles: () => Promise.reject(new Error('not uploaded')) };
});

const { SocialReviewPage, planChannel } = await import('../src/routes/social-review.tsx');
const { ReviewLinks } = await import('../src/components/social-review-links.tsx');

const TOKEN = 'b'.repeat(43);
const ORG = 'Công ty Truyền thông Sao Mai';
const MEMBER = '0190f000-0000-7000-8000-000000000001';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function render(node: React.ReactNode, locale: 'vi' | 'en' = 'vi') {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const channel = { provider: 'facebook', channel: 'Fanpage Sao Mai', status: 'in_review', signature: null, title: null, linkUrl: null };
const answer = (reply: { body: string; at: string } | null, body = 'Đổi ảnh bìa giúp chị') => ({ name: 'Chị Lan', verdict: 'changes_requested', body, at: '2026-10-20T03:00:00.000Z', reply });
const single = (brand: unknown, feedback: unknown[]) => ({
  org: ORG,
  brand,
  expiresAt: '2026-12-01T00:00:00.000Z',
  changed: false,
  channels: [{ ...channel, body: 'Khai trương chi nhánh mới', mediaCount: 0 }],
  feedback,
});

describe('the client review pages show the team reply (#1301)', () => {
  const saved = (globalThis as { window?: unknown }).window;
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = { location: { hash: `#${TOKEN}` }, localStorage: { getItem: () => null, setItem: () => undefined } };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved;
  });
  beforeEach(() => client.current.clear());

  const page = (data: unknown, locale: 'vi' | 'en' = 'vi') => {
    client.current.setQueryData(['client-review', TOKEN], data);
    return render(<SocialReviewPage />, locale);
  };

  it('signs the reply with the org name under the answer, as plain text', () => {
    const html = page(single(null, [answer({ body: 'Dạ, nhóm đổi ngay ạ <script>alert(1)</script>', at: '2026-10-20T04:00:00.000Z' })]));
    expect(text(html)).toContain(`Đổi ảnh bìa giúp chị ${ORG} trả lời`);
    expect(text(html)).toContain('Dạ, nhóm đổi ngay ạ');
    // Escaped, never markup.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(text(page(single(null, [answer({ body: 'Done', at: '2026-10-20T04:00:00.000Z' })]), 'en'))).toContain(`Reply from ${ORG}`);
  });

  it("signs with the report branding's name when the org has one, and shows nothing without a reply", () => {
    const branded = page(single({ name: 'Sao Mai Agency', logo: null, accent: null, hideCrove: false }, [answer({ body: 'Dạ', at: '2026-10-20T04:00:00.000Z' })]));
    expect(text(branded)).toContain('Sao Mai Agency trả lời');
    expect(text(branded)).not.toContain(`${ORG} trả lời`);
    // An answer without a reply, and a server from before replies (no field), look as before.
    for (const fb of [answer(null), { name: 'Chị Lan', verdict: 'comment', body: 'Ổn', at: '2026-10-20T03:00:00.000Z' }]) {
      expect(text(page(single(null, [fb])))).not.toContain('trả lời');
    }
  });

  it("shows each plan post's body once, a channel's own text where it has one, and the reply per post (#930)", () => {
    const plan = {
      kind: 'plan',
      org: ORG,
      brand: null,
      expiresAt: '2026-12-01T00:00:00.000Z',
      from: null,
      to: null,
      posts: [
        {
          id: '0190f000-0000-7000-8000-00000000000a',
          gone: false,
          at: '2026-11-02T02:00:00.000Z',
          changed: false,
          body: 'Ưu đãi tháng 11',
          channels: [
            { ...channel, body: null, media: [] },
            { ...channel, provider: 'zalo', channel: 'Zalo OA', body: 'Ưu đãi riêng Zalo', media: [] },
          ],
          answers: 1,
          feedback: [{ ...answer({ body: 'Dạ giá đã gồm VAT ạ', at: '2026-10-21T04:00:00.000Z' }, 'Giá đã gồm VAT chưa?'), verdict: 'comment' }],
        },
      ],
    };
    const html = text(page(plan));
    expect(html).toContain('Ưu đãi tháng 11');
    expect(html).toContain('Ưu đãi riêng Zalo');
    expect(html).toContain(`Giá đã gồm VAT chưa? ${ORG} trả lời`);
    expect(html).toContain('Dạ giá đã gồm VAT ạ');
  });

  it("takes the post's body for a channel that shows it", () => {
    const c = { ...channel, body: null, media: [] };
    expect(planChannel({ body: 'Bài chung' }, c).body).toBe('Bài chung');
    expect(planChannel({ body: 'Bài chung' }, { ...c, body: '' }).body).toBe('');
    expect(planChannel({ body: null }, c).body).toBe('');
    // A server from before #930 sends the body on every channel and none on the post.
    expect(planChannel({}, { ...c, body: 'Riêng' }).body).toBe('Riêng');
  });
});

describe('the review links panel answers each client answer (#1301)', () => {
  beforeEach(() => {
    client.current.clear();
    client.current.setQueryData(['org', 'get'], { members: [{ userId: MEMBER, displayName: 'Minh Anh', email: 'minh.anh@saomai.test' }] });
  });
  const feedback = (reply: { body: string; by: string; at: string } | null, id: string) => ({
    id,
    linkId: '0190f000-0000-7000-8000-0000000000ff',
    name: 'Chị Lan',
    verdict: 'comment',
    body: 'Giá đã gồm VAT chưa?',
    changed: false,
    createdAt: '2026-10-20T03:00:00.000Z',
    reply,
  });
  const panel = (canReply: boolean, locale: 'vi' | 'en' = 'vi') => {
    client.current.setQueryData(['social', 'reviewLinks', 'list'], {
      links: [],
      feedback: [
        feedback({ body: 'Dạ đã gồm VAT ạ', by: MEMBER, at: '2026-10-20T04:00:00.000Z' }, '0190f000-0000-7000-8000-0000000000a1'),
        feedback({ body: 'Để em kiểm tra', by: '0190f000-0000-7000-8000-0000000000ee', at: '2026-10-20T05:00:00.000Z' }, '0190f000-0000-7000-8000-0000000000a2'),
        feedback(null, '0190f000-0000-7000-8000-0000000000a3'),
      ],
    });
    return text(render(<ReviewLinks postId="0190f000-0000-7000-8000-0000000000b1" canDecide={false} canReply={canReply} />, locale));
  };

  it('shows each reply with the member who wrote it, and lets members reply, edit and remove', () => {
    const html = panel(true);
    expect(html).toContain('Nhóm đã trả lời · Minh Anh ·');
    expect(html).toContain('Dạ đã gồm VAT ạ');
    // A member who left is not named.
    expect(html).toContain('Nhóm đã trả lời · Người đã rời nhóm ·');
    expect(html.match(/Sửa/g)).toHaveLength(2);
    expect(html.match(/Xóa trả lời/g)).toHaveLength(2);
    expect(html.match(/Trả lời khách/g)).toHaveLength(1);
    const en = panel(true, 'en');
    expect(en).toContain('Team reply · Minh Anh ·');
    expect(en.match(/Reply to the client/g)).toHaveLength(1);
  });

  it('shows the replies but no reply controls to a viewer', () => {
    const html = panel(false);
    expect(html).toContain('Dạ đã gồm VAT ạ');
    expect(html).not.toContain('Trả lời khách');
    expect(html).not.toContain('Xóa trả lời');
  });
});
