// The bulk bar over the Social lists (#635, #945) as each role sees it: owners and admins get the move by days or hours,
// members do not (social.variant.reschedule is theirs alone, and the server refuses anyone else anyway). Labels and the
// assignee (#1057) are offered to members too; labels only once the org has one. Find and replace (#1144) is offered to
// members, and its preview shows each match with what replaces it and why a post is left out. Sending drafts to review
// and adding a channel (#1178) are offered to members, the latter once there is a channel they may add. Rendered on the
// server.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { SOCIAL_BULK_SKIP_REASONS, SOCIAL_REPLACE_FIELDS } from '@crove/kernel-contract';
import { en as enMessages } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import type { BulkAction, BulkPost, ReplacePreviewPost } from '../src/lib/social-bulk.ts';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ client: {}, queryClient: { invalidateQueries: () => undefined }, errorMessage: (e: unknown) => String(e) }));

const { BulkBar, ReplacePreview } = await import('../src/components/social-bulk.tsx');
const t = viMessages.social.bulk;

const posts: BulkPost[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    timeZone: 'Asia/Ho_Chi_Minh',
    variants: [{ id: '00000000-0000-4000-8000-000000000002', connectionId: 'c', status: 'scheduled', revision: 1, contentHash: `sha256:${'a'.repeat(64)}`, effectiveAt: '2026-11-02T02:00:00.000Z', queueSlotAt: null }],
  },
];

const spring = { id: '00000000-0000-4000-8000-000000000003', name: 'Mùa xuân', color: 'green' as const };

const threads = { id: '00000000-0000-4000-8000-000000000004', name: 'Threads của tiệm' };

function bar(canDecide: boolean, actions: readonly BulkAction[], labelOptions: readonly (typeof spring)[] = [], channelOptions: readonly (typeof threads)[] = []): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
        <BulkBar
          posts={posts}
          actions={actions}
          canDecide={canDecide}
          excerptOf={() => 'Khai trương'}
          channelName={() => 'Fanpage'}
          labelOptions={labelOptions}
          members={[]}
          channelOptions={channelOptions}
          onClear={() => undefined}
        />
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

  it('offers members find and replace', () => {
    const html = bar(false, ['labels', 'assign', 'replace']);
    expect(html).toContain(t.action.replace);
  });

  it('offers members sending drafts to review, and adding a channel once there is one they may add', () => {
    const html = bar(false, ['submit', 'cancel', 'labels', 'assign', 'replace', 'addChannel'], [], [threads]);
    expect(html).toContain(t.action.submit);
    expect(html).toContain(t.action.addChannel);
    // The channel form opens on a click; its button says whether it is open.
    expect(html).toMatch(new RegExp('aria-expanded="false"[^>]*>' + t.action.addChannel));
    const none = bar(false, ['submit', 'addChannel']);
    expect(none).toContain(t.action.submit);
    expect(none).not.toContain(t.action.addChannel);
  });

  it('previews each match with what replaces it, and says why a post is left out', () => {
    const vb = '00000000-0000-4000-8000-000000000010';
    const posts: ReplacePreviewPost[] = [
      {
        postId: 'p1',
        skip: null,
        matches: [
          { variantId: null, connectionId: null, field: 'body', count: 2, before: 'Mua tại ', match: 'XUAN2026', after: ' nhé' },
          { variantId: vb, connectionId: 'cb', field: 'first_comment', count: 1, before: '', match: 'XUAN2026', after: '' },
        ],
      },
      { postId: 'p2', skip: 'banned_words', matches: [{ variantId: null, connectionId: null, field: 'title', count: 1, before: '', match: 'XUAN2026', after: '' }] },
      { postId: 'p3', skip: 'no_match', matches: [] },
    ];
    const html = renderToStaticMarkup(
      <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
        <ReplacePreview posts={posts} replacement="HE2026" postName={(id) => 'Bài ' + id} channelName={() => 'Fanpage'} />
      </IntlProvider>,
    );
    expect(html).toContain('1 bài sẽ được thay (3 chỗ), 2 bài giữ nguyên.');
    expect(html).toContain('Nội dung của bài (2 chỗ):');
    expect(html).toContain('Bình luận đầu tiên riêng của Fanpage (1 chỗ):');
    expect(html).toContain('<del class="rounded-sm bg-destructive/10 line-through decoration-destructive">XUAN2026</del><ins class="rounded-sm bg-success/15 text-foreground no-underline">HE2026</ins> nhé');
    expect(html).toContain('giữ nguyên vì ' + t.edit.skip.banned_words);
    expect(html).toContain('giữ nguyên vì ' + t.edit.skip.no_match);
    // A post left out shows its match, and no replacement.
    expect(html.match(/<ins/g)).toHaveLength(2);
  });

  it('names every field a match can be in, in both languages', () => {
    for (const field of SOCIAL_REPLACE_FIELDS) {
      expect(t.replace.field[field]).toBeTruthy();
      expect(enMessages.social.bulk.replace.field[field]).toBeTruthy();
    }
  });

  it('names every skip reason the server gives, in both languages', () => {
    for (const reason of SOCIAL_BULK_SKIP_REASONS) {
      expect(t.edit.skip[reason]).toBeTruthy();
      expect(enMessages.social.bulk.edit.skip[reason]).toBeTruthy();
    }
  });
});
