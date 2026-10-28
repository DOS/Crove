// The same text going out again on a channel (#1156) in the app: a refusal on X and LinkedIn, advice elsewhere, with
// when and how the other post stands, in natural Vietnamese and in English, and the link to the AI rewrite only where
// the member may use it. Rendered on the server.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DuplicateNote } from '../src/components/social-duplicate.tsx';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const render = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const at = '2026-10-16T02:30:00.000Z';

describe('the same text again on a channel (#1156)', () => {
  it('says X and LinkedIn refuse it, with when the other post went out', () => {
    const x = render(<DuplicateNote provider="x" of={{ at, status: 'published' }} rewriteTarget="social-rewrite" />);
    expect(text(x)).toMatch(/^X không nhận bài có nội dung trùng với bài đã đăng trên kênh này lúc .*16.*\. Hãy sửa nội dung trước khi bài được đăng\. Nhờ Vy viết lại$/);
    expect(x).toContain('text-destructive');
    const page = text(render(<DuplicateNote provider="linkedin_page" of={{ at, status: 'queued' }} rewriteTarget={null} />, 'en'));
    expect(page).toMatch(/^LinkedIn Page refuses a post whose text matches one waiting in this channel’s queue for .+\. Change the text before it goes out\.$/);
  });

  it('advises elsewhere, names the channel in the review panel, and links to the rewrite only when given one', () => {
    const fb = render(<DuplicateNote provider="facebook_page" of={{ at, status: 'scheduled' }} channel="Tiệm Bánh B" rewriteTarget={null} />);
    expect(text(fb)).toMatch(/^Tiệm Bánh B: Nội dung này trùng với bài đã hẹn đăng trên kênh này lúc .+, người theo dõi sẽ thấy hai lần\. Nên sửa vài chữ cho khác đi\.$/);
    expect(fb).toContain('text-warning');
    expect(fb).not.toContain('<button');
    const threads = text(render(<DuplicateNote provider="threads" of={{ at, status: 'published' }} rewriteTarget="social-rewrite-c1" />, 'en'));
    expect(threads).toMatch(/^The same text is already published on this channel, on .+, so followers would see it twice\. Consider changing a few words\. Rewrite it with Vy$/);
  });

  it('explains the refusal and the possible duplicate on the post page, in both languages', () => {
    expect(vi.social.outcome.duplicateContent).toContain('{platform} từ chối vì nội dung trùng');
    expect(en.social.outcome.duplicateContent).toContain('{platform} refused the post because the same text');
    expect(vi.social.outcome.possibleDuplicate).toContain('Facebook báo bài này bị trùng');
    expect(en.social.outcome.possibleDuplicate).toContain('Facebook called this post a duplicate');
  });
});
