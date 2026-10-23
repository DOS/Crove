// A channel's signature (#1190) in the app: the Channels page editor as owners and admins and as members see it, the
// composer's "Bỏ chữ ký" toggle and what it does to the settings, and the counter and checks counting the text with
// its signature, in natural Vietnamese and in English. Rendered on the server.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { withChannelSignature, withSignature } from '@crove/mod-social/contract';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

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
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { SignatureEditor, SignatureToggle, signatureSettings } = await import('../src/components/social-signature.tsx');
const { draftIssues, textBudget } = await import('../src/lib/social.ts');

const CONN = '00000000-0000-4000-8000-0000000000fb';
const SIGNATURE = 'Hotline 0901 234 567\n#TiemBanhAnNhien';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

function wrap(node: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={(locale === 'vi' ? viMessages : enMessages) as never} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the signature editor on the Channels page', () => {
  it('lets owners and admins write, save and remove it, with its length against the cap', () => {
    const html = wrap(<SignatureEditor connectionId={CONN} revoked={false} signature={SIGNATURE} canEdit />);
    expect(text(html)).toContain('Chữ ký cuối bài');
    expect(text(html)).toContain('Bài mới đăng lên kênh này tự thêm đoạn chữ ký ở cuối, sau một dòng trống. Đổi chữ ký sau này không làm thay đổi bài đã viết hay đã duyệt.');
    expect(html).toContain(`${[...SIGNATURE].length}/500`);
    expect(text(html)).toContain('Lưu chữ ký');
    expect(text(html)).toContain('Bỏ chữ ký của kênh');
    expect(html).toContain('Hotline 0901 234 567');
    // Unchanged: nothing to save yet.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Lưu chữ ký/);
  });

  it('shows members the signature read-only, and says who may change it', () => {
    const html = wrap(<SignatureEditor connectionId={CONN} revoked={false} signature={SIGNATURE} canEdit={false} />, 'en');
    expect(text(html)).toContain('Only owners and admins change the signature.');
    expect(html).not.toContain('Save signature');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });
});

describe('"Bỏ chữ ký" in the composer', () => {
  it('shows the signature a channel adds, and nothing on a channel without one', () => {
    const on = text(wrap(<SignatureToggle settings={{ signature: SIGNATURE }} disabled={false} onChange={() => undefined} />));
    expect(on).toContain('Bỏ chữ ký');
    expect(on).toContain('Cuối bài sẽ thêm chữ ký của kênh: Hotline 0901 234 567 #TiemBanhAnNhien');
    expect(wrap(<SignatureToggle settings={{}} disabled={false} onChange={() => undefined} />)).toBe('');
    expect(wrap(<SignatureToggle settings={{ signature: 4 }} disabled={false} onChange={() => undefined} />)).toBe('');
  });

  it('says when this post goes out without it, in both languages', () => {
    expect(text(wrap(<SignatureToggle settings={{ signature: false }} disabled={false} onChange={() => undefined} />))).toContain('Bài này không thêm chữ ký của kênh ở cuối.');
    const en = text(wrap(<SignatureToggle settings={{ signature: false }} disabled={false} onChange={() => undefined} />, 'en'));
    expect(en).toContain('Leave out the signature');
    expect(en).toContain('This post goes out without the channel\'s signature.');
  });

  it('leaves it off with false and puts back the channel signature as it is now', () => {
    expect(signatureSettings({ firstComment: 'a', signature: SIGNATURE }, true, SIGNATURE)).toEqual({ firstComment: 'a', signature: false });
    expect(signatureSettings({ signature: false }, false, 'Hotline mới')).toEqual({ signature: 'Hotline mới' });
    // No signature on the channel any more: back to none.
    expect(signatureSettings({ firstComment: 'a', signature: false }, false, null)).toEqual({ firstComment: 'a' });
  });
});

describe('the counter and the checks count the text with its signature', () => {
  it('pushes an X post over 280 with it, and not without', () => {
    const body = 'a'.repeat(260);
    const settings = withChannelSignature({}, 'Hotline 0901 234 567 · Ghé tiệm nhé!');
    expect(textBudget('x', withSignature(body, settings))).toEqual({ used: 299, max: 280 });
    expect(draftIssues('x', { body, title: null, settings }).map((i) => i.code)).toContain('TEXT_TOO_LONG');
    expect(draftIssues('x', { body, title: null, settings: { signature: false } })).toEqual([]);
  });

  it('flags an Instagram caption whose signature brings its 31st hashtag', () => {
    const body = Array.from({ length: 30 }, (_, i) => `#banh${i}`).join(' ');
    const media = [{ mime: 'image/jpeg', sizeBytes: 1000 }];
    expect(draftIssues('instagram', { body, title: null, media })).toEqual([]);
    expect(draftIssues('instagram', { body, title: null, media, settings: { signature: '#TiemBanh' } }).map((i) => i.code)).toEqual(['IG_TOO_MANY_HASHTAGS']);
  });
});
