// LinkedIn Company Pages (#1077) in the app: listed to connect only where the deployment offers them, named apart from
// the member channel, previewed like a LinkedIn post. Rendered on the server; nothing is fetched.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { parseCsv } from '../src/lib/bank-statement.ts';
import { connectPlatforms, providerName } from '../src/lib/social.ts';
import { importRows } from '../src/lib/social-import.ts';
import { previewRule } from '../src/lib/social-preview.ts';

vi.mock('../src/lib/api.ts', () => ({
  client: {},
  orpc: {},
  queryClient: null,
  errorMessage: (e: unknown) => String(e),
  fetchFile: () => Promise.reject(new Error('not fetched')),
  uploadFiles: () => Promise.reject(new Error('not uploaded')),
}));

const { PlatformPreview } = await import('../src/components/social-preview.tsx');

describe('LinkedIn Company Pages in the app', () => {
  it('lists LinkedIn Page to connect only when the deployment offers it, and the member channel either way', () => {
    expect(connectPlatforms([])).not.toContain('linkedin_page');
    expect(connectPlatforms(['linkedin'])).not.toContain('linkedin_page');
    expect(connectPlatforms([])).toContain('linkedin');
    const offered = connectPlatforms(['linkedin', 'linkedin_page']);
    expect(offered.indexOf('linkedin_page')).toBe(offered.indexOf('linkedin') + 1);
  });

  it('names the page channel apart from the member, with a hint in both languages', () => {
    expect(providerName('linkedin_page')).toBe('LinkedIn Page');
    expect(providerName('linkedin')).toBe('LinkedIn');
    expect(viMessages.social.linkedinPageHint).toContain('quản trị viên');
    expect(enMessages.social.linkedinPageHint).toContain('Company Page');
  });

  it('previews a page post as a LinkedIn post, naming a signed-in audience', () => {
    expect(previewRule('linkedin_page')).toEqual(previewRule('linkedin'));
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
          <PlatformPreview channel="Tiệm Bánh B" provider="linkedin_page" content={{ body: 'Khai trương chi nhánh mới.', title: '', linkUrl: '', media: [], visibility: 'loggedIn' }} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain('Chỉ người đã đăng nhập LinkedIn mới xem được');
  });

  it('reads "LinkedIn Page" in a sheet as the page channel, and "LinkedIn" as the member', () => {
    const channels = [
      { id: 'li-page', provider: 'linkedin_page', displayName: 'Tiệm Bánh B', status: 'active' },
      { id: 'li-member', provider: 'linkedin', displayName: 'Nguyễn Văn A', status: 'active' },
    ];
    const rows = importRows(parseCsv('text,channels\nA,LinkedIn Page\nB,linkedin\n'), channels) ?? [];
    expect(rows.map((r) => r.connectionIds)).toEqual([['li-page'], ['li-member']]);
  });
});
