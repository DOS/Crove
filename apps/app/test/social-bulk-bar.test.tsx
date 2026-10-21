// The bulk bar over the Social lists (#635, #945) as each role sees it: owners and admins get the move by days or hours,
// members do not (social.variant.reschedule is theirs alone, and the server refuses anyone else anyway). Rendered on the
// server.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import type { BulkAction, BulkPost } from '../src/lib/social-bulk.ts';

vi.mock('../src/lib/api.ts', () => ({ client: {}, queryClient: { invalidateQueries: () => undefined }, errorMessage: (e: unknown) => String(e) }));

const { BulkBar } = await import('../src/components/social-bulk.tsx');
const t = viMessages.social.bulk;

const posts: BulkPost[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    timeZone: 'Asia/Ho_Chi_Minh',
    variants: [{ id: '00000000-0000-4000-8000-000000000002', connectionId: 'c', status: 'scheduled', revision: 1, contentHash: `sha256:${'a'.repeat(64)}`, effectiveAt: '2026-11-02T02:00:00.000Z', queueSlotAt: null }],
  },
];

function bar(canDecide: boolean, actions: readonly BulkAction[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="vi" messages={viMessages as never} timeZone="Asia/Ho_Chi_Minh">
        <BulkBar posts={posts} actions={actions} canDecide={canDecide} excerptOf={() => 'Khai trương'} channelName={() => 'Fanpage'} onClear={() => undefined} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('BulkBar', () => {
  it('offers owners and admins the move', () => {
    const html = bar(true, ['approve', 'move', 'cancel']);
    expect(html).toContain(t.action.move);
    expect(html).toContain(t.action.approve);
  });

  it('hides the move from members even when a list asks for it', () => {
    const html = bar(false, ['move', 'cancel']);
    expect(html).not.toContain(t.action.move);
    expect(html).toContain(t.action.cancel);
  });
});
