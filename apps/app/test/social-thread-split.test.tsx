// A long text split into a thread (#1222) in the channel editor: the panel with its preview and counts on X, Threads,
// Bluesky and the sandbox only while the text is too long, the warnings for a first comment and for text left over,
// *Gộp lại* once the channel has thread parts, and what the two buttons do to the channel's edit, in natural
// Vietnamese and in English. Rendered on the server; nothing is fetched.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { splitThread, validateVariant, type ThreadSplit } from '@crove/mod-social/contract';
import { catalog } from '../src/i18n/runtime.ts';
import { ThreadSplitField, applySplit, joinSplit, type SplitValue } from '../src/components/social-thread-split.tsx';

function render(node: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      {node}
    </IntlProvider>,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

const sentence = (i: number) => `Câu thứ ${i} kể về bánh mì nóng giòn của tiệm, ăn kèm pa tê và rau thơm.`;
const LONG = Array.from({ length: 8 }, (_, i) => sentence(i + 1)).join(' ');
const SHARED: SplitValue = { custom: false, body: '', settings: {} };

function field(props: Partial<Parameters<typeof ThreadSplitField>[0]> = {}, locale: 'vi' | 'en' = 'vi') {
  return render(
    <ThreadSplitField provider="x" value={SHARED} baseBody={LONG} settings={{}} linkUrl={null} mediaCount={0} tooLong disabled={false} onChange={() => undefined} {...props} />,
    locale,
  );
}

describe('the split panel', () => {
  it('shows each post of the thread with its count, and the button, while the text is too long', () => {
    const split = splitThread('x', LONG) as ThreadSplit;
    const html = text(field());
    expect(html).toContain(`Nội dung dài quá một bài của kênh này. Có thể tách thành ${split.posts.length} phần: phần 1 là bài chính, các phần sau được đăng nối tiếp thành trả lời.`);
    expect(html).toContain('không cắt đôi liên kết, hashtag, tên được nhắc hay emoji');
    expect(html).toContain('Xem trước chuỗi bài');
    expect(html).toContain(`Phần 1 · ${split.counts[0]}/280`);
    expect(html).toContain(`Phần ${split.posts.length} · ${split.counts.at(-1)}/280`);
    expect(html).toContain('Đánh số 1/n ở cuối mỗi phần');
    expect(html).toContain('Tách thành chuỗi bài');
    expect(html).not.toContain('Gộp lại');
  });

  it('says it in English', () => {
    const html = text(field({}, 'en'));
    expect(html).toContain('The text is longer than one post on this channel.');
    expect(html).toContain('Thread preview');
    expect(html).toContain('Split into a thread');
    expect(html).toContain('Number the parts 1/n at the end');
  });

  it('shows the signature and link in the first post, as it goes out', () => {
    const html = field({ settings: { signature: 'Hotline 0901 234 567' }, linkUrl: 'https://tiembanh.vn/menu' });
    const first = html.split('</li>')[0] as string;
    expect(first).toContain('Hotline 0901 234 567');
    expect(first).toContain('https://tiembanh.vn/menu');
    // With the channel's UTM tags (#585).
    expect(field({ settings: { utm: { campaign: 'tet' } }, linkUrl: 'https://tiembanh.vn/menu' })).toContain('https://tiembanh.vn/menu?utm_source=x');
  });

  it('shows nothing while the text fits, on a channel without threads, or when the post cannot be edited', () => {
    expect(field({ tooLong: false })).toBe('');
    expect(field({ provider: 'facebook_page' })).toBe('');
    expect(field({ provider: 'mastodon' })).toBe('');
    expect(field({ disabled: true })).toBe('');
  });

  it('warns that a thread takes no first comment', () => {
    const html = text(field({ value: { ...SHARED, settings: { firstComment: 'Đặt hàng tại đây' } } }));
    expect(html).toContain('Kênh này đang có bình luận đầu tiên. Bài dạng chuỗi không kèm bình luận đầu tiên');
    expect(text(field({ value: { ...SHARED, settings: { firstComment: 'Order here' } } }, 'en'))).toContain('A thread takes no first comment');
  });

  it('says how much is left over past the last part', () => {
    const long = Array.from({ length: 60 }, (_, i) => sentence(i + 1)).join(' ');
    const split = splitThread('x', long) as ThreadSplit;
    const html = text(field({ baseBody: long }));
    expect(html).toContain(`Một chuỗi có tối đa 10 phần nên vẫn còn dư ${split.leftoverCount.toLocaleString('vi')} ký tự.`);
    expect(text(field({ baseBody: long }, 'en'))).toContain(`${split.leftoverCount.toLocaleString('en')} characters are left over`);
  });

  it('offers Gộp lại once the channel has thread parts', () => {
    const html = text(field({ tooLong: false, value: { custom: true, body: 'Một', settings: { threadParts: ['Hai'] } } }));
    expect(html).toContain('Gộp lại');
    expect(html).not.toContain('Tách thành chuỗi bài');
    expect(text(field({ tooLong: false, value: { custom: true, body: 'One', settings: { threadParts: ['Two'] } } }, 'en'))).toContain('Merge back');
  });
});

describe('what the buttons change', () => {
  it('puts the first post in the own text and the rest in the thread parts, and the edit passes the checks', () => {
    const split = splitThread('x', LONG, { numbered: true }) as ThreadSplit;
    const after = applySplit({ custom: false, body: '', settings: { utm: { campaign: 'tet' } } }, split);
    expect(after.custom).toBe(true);
    expect(after.body).toBe(split.posts[0]);
    expect(after.settings).toEqual({ utm: { campaign: 'tet' }, threadParts: split.posts.slice(1) });
    expect(validateVariant({ provider: 'x', body: after.body, title: null, linkUrl: null, media: [], settings: after.settings })).toEqual([]);
  });

  it('keeps the text left over in the last part, where validation flags it', () => {
    const long = Array.from({ length: 60 }, (_, i) => sentence(i + 1)).join(' ');
    const split = splitThread('x', long) as ThreadSplit;
    const after = applySplit(SHARED, split);
    const parts = after.settings.threadParts as string[];
    expect(parts.at(-1)?.endsWith(split.leftover)).toBe(true);
    expect(validateVariant({ provider: 'x', body: after.body, title: null, linkUrl: null, media: [], settings: after.settings }).map((i) => i.code)).toEqual(['THREAD_PART_TOO_LONG']);
  });

  it('goes back to the text as it was when nothing changed since the split, else joins the parts', () => {
    const before: SplitValue = { custom: false, body: '', settings: { firstComment: 'x' } };
    const split = splitThread('x', LONG, { numbered: true }) as ThreadSplit;
    const after = applySplit(before, split);
    expect(joinSplit(after, LONG, { before, after })).toBe(before);
    // Edited since: the parts are joined, numbers off.
    const edited = { ...after, body: after.body.replace('Câu thứ 1 ', 'Câu số 1 ') };
    const joined = joinSplit(edited, LONG, { before, after });
    expect(joined.custom).toBe(true);
    expect(joined.settings).toEqual({ firstComment: 'x' });
    expect(joined.body).not.toMatch(/ \d+\/\d+/);
    expect(joined.body.replace(/\s+/g, ' ')).toBe(LONG.replace('Câu thứ 1 ', 'Câu số 1 '));
    // A thread on the shared text, after a reload: the shared text is part 1.
    expect(joinSplit({ custom: false, body: '', settings: { threadParts: ['Hai.'] } }, 'Một.', null)).toEqual({ custom: true, body: 'Một.\n\nHai.', settings: {} });
  });
});
