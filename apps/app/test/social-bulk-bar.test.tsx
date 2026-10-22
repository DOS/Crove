// The bulk bar over the Social lists (#635, #945) as each role sees it: owners and admins get the move by days or hours,
// members do not (social.variant.reschedule is theirs alone, and the server refuses anyone else anyway). Labels and the
// assignee (#1057) are offered to members too; labels only once the org has one. Rendered on the server.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { SOCIAL_BULK_SKIP_REASONS } from '@crove/kernel-contract';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import type { BulkAction, BulkPost } from '../src/lib/social-bulk.ts';
import { catalog } from '../src/i18n/runtime.ts';

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

const spring = { id: '00000000-0000-4000-8000-000000000003', name: 'Mùa xuân', color: 'green' as const };

function bar(canDecide: boolean, actions: readonly BulkAction[], labelOptions: readonly (typeof spring)[] = []): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
        <BulkBar posts={posts} actions={actions} canDecide={canDecide} excerptOf={() => 'Khai trương'} channelName={() => 'Fanpage'} labelOptions={labelOptions} members={[]} onClear={() => undefined} />
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

  it('offers members labels and the assignee next to what they may do', () => {
    const html = bar(false, ['cancel', 'labels', 'assign'], [spring]);
    expect(html).toContain(t.action.labels);
    expect(html).toContain(t.action.assign);
    expect(html).toContain(t.action.cancel);
  });

  it('offers labels only once the org has one', () => {
    const html = bar(false, ['labels', 'assign']);
    expect(html).not.toContain(t.action.labels);
    expect(html).toContain(t.action.assign);
  });

  it('names every skip reason the server gives, in both languages', () => {
    for (const reason of SOCIAL_BULK_SKIP_REASONS) {
      expect(t.edit.skip[reason]).toBeTruthy();
      expect(enMessages.social.bulk.edit.skip[reason]).toBeTruthy();
    }
  });
});
