// The queue editor's helpers in the app (#1166): "Gợi ý từ giờ đẹp" disabled with its reason under five posts with
// metrics, and the copy to other channels as each role sees it, its confirmation (each target's slots now and the
// queued posts placed again, before anything changes) and its outcome per channel in words. Rendered on the server,
// with the queries answered from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
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

const { QueueCopy, QueueCopyConfirm, QueueCopyResults, QueueSuggestButton } = await import('../src/components/social-queue-tools.tsx');
const t = viMessages.social.queueTools;

const HCM = 'Asia/Ho_Chi_Minh';
const FB = { id: '00000000-0000-4000-8000-0000000000fb', provider: 'facebook', displayName: 'Tiệm bánh' };
const ZALO = { id: '00000000-0000-4000-8000-00000000000a', provider: 'zalo_oa', displayName: 'Tiệm bánh OA' };
const sample = (publishedAt: string) => ({ connectionId: FB.id, publishedAt, metrics: { reactions: 12 } });

function wrap(node: React.ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={(locale === 'vi' ? viMessages : enMessages) as never} timeZone={HCM}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function suggestButton(history: unknown[]): string {
  client.current.clear();
  client.current.setQueryData(['social', 'metrics', 'summary'], history);
  return wrap(<QueueSuggestButton connectionId={FB.id} timeZone={HCM} slots={[]} onSuggest={() => undefined} />);
}

describe('"Gợi ý từ giờ đẹp" in the queue editor', () => {
  it('is disabled and says why under five posts with metrics', () => {
    const html = suggestButton(['2026-10-06T13:00:00Z', '2026-10-13T13:00:00Z', '2026-10-20T13:00:00Z'].map(sample));
    expect(html).toContain(t.suggest);
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain('Cần ít nhất 5 bài có số liệu trên kênh này (hiện có 3 bài)');
  });

  it('is ready with enough history, its hint naming the queue\'s time zone', () => {
    const html = suggestButton(['2026-09-29T13:00:00Z', '2026-10-06T13:00:00Z', '2026-10-13T13:00:00Z', '2026-10-20T13:00:00Z', '2026-10-01T02:00:00Z'].map(sample));
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain('theo múi giờ Asia/Ho_Chi_Minh của hàng đợi');
  });
});

describe('copying a queue to other channels', () => {
  const saved = { timeZone: HCM, slots: [{ weekday: 1, minute: 540 }, { weekday: 3, minute: 1200, labelId: '00000000-0000-4000-8000-0000000000aa' }] };

  it('is for owners and admins only', () => {
    expect(wrap(<QueueCopy source={FB} saved={saved} targets={[ZALO]} unsaved={false} canEdit={false} />)).toBe('');
    const html = wrap(<QueueCopy source={FB} saved={saved} targets={[ZALO]} unsaved={false} canEdit />);
    expect(html).toContain(t.copy);
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });

  it('waits for the editor\'s draft to be saved, and needs saved slots and another channel', () => {
    expect(wrap(<QueueCopy source={FB} saved={saved} targets={[ZALO]} unsaved canEdit />)).toContain(viMessages.social.saveQueueFirst);
    expect(wrap(<QueueCopy source={FB} saved={{ timeZone: HCM, slots: [] }} targets={[ZALO]} unsaved={false} canEdit />)).toContain(t.copyEmpty);
    expect(wrap(<QueueCopy source={FB} saved={saved} targets={[]} unsaved={false} canEdit />)).toContain(t.copyNoTargets);
  });

  it('confirms with each target\'s slots now and the queued posts placed again', () => {
    const rows = [
      { connectionId: ZALO.id, name: 'Zalo OA · Tiệm bánh OA', loading: false, error: null, slots: 3, replaced: 2, partial: false },
      { connectionId: 'x', name: 'Bluesky · tiembanh', loading: false, error: null, slots: 0, replaced: 0, partial: false },
      { connectionId: 'y', name: 'Threads · tiembanh', loading: false, error: null, slots: 7, replaced: 200, partial: true },
    ];
    const html = wrap(<QueueCopyConfirm source="Tiệm bánh" zone={HCM} slots={2} rows={rows} pending={false} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain('Thay khung giờ của 3 kênh bằng 2 khung giờ của Tiệm bánh (múi giờ Asia/Ho_Chi_Minh):');
    expect(html).toContain('Zalo OA · Tiệm bánh OA</span>: đang có 3 khung giờ; 2 bài đang chờ sẽ được xếp lại vào khung giờ mới.');
    expect(html).toContain('Bluesky · tiembanh</span>: chưa có khung giờ nào; không bài nào phải xếp lại.');
    expect(html).toContain('ít nhất 200 bài đang chờ sẽ được xếp lại');
    expect(html).toContain('Thay khung giờ của 3 kênh</button>');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Thay khung giờ/);
  });

  it('holds the confirmation until every target is read', () => {
    const rows = [
      { connectionId: ZALO.id, name: 'Zalo OA · Tiệm bánh OA', loading: true, error: null, slots: null, replaced: null, partial: false },
      { connectionId: 'x', name: 'Bluesky · tiembanh', loading: false, error: 'CHANNEL_NOT_ALLOWED', slots: null, replaced: null, partial: false },
    ];
    const html = wrap(<QueueCopyConfirm source="Tiệm bánh" zone={HCM} slots={2} rows={rows} pending={false} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain(t.copyLoading);
    expect(html).toContain('CHANNEL_NOT_ALLOWED');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Thay khung giờ của 2 kênh/);
  });

  it('reports each channel in words', () => {
    const names = new Map([
      [ZALO.id, 'Zalo OA · Tiệm bánh OA'],
      ['x', 'Bluesky · tiembanh'],
      ['y', 'Threads · tiembanh'],
    ]);
    const results = [
      { connectionId: ZALO.id, ok: true as const, moved: 2, unqueued: 1 },
      { connectionId: 'x', ok: true as const, moved: 0, unqueued: 0 },
      { connectionId: 'y', ok: false as const, message: 'Có kênh không tồn tại hoặc đã ngắt kết nối' },
    ];
    const html = wrap(<QueueCopyResults results={results} names={names} />);
    expect(html).toContain('Zalo OA · Tiệm bánh OA: đã sao chép, 2 bài được xếp lại. 1 bài không còn khung giờ trống trong năm tới nên được rút khỏi hàng đợi, chờ bạn lên lịch lại.');
    expect(html).toContain('Bluesky · tiembanh: đã sao chép, không bài nào phải xếp lại.');
    expect(html).toContain('Threads · tiembanh: chưa sao chép được (Có kênh không tồn tại hoặc đã ngắt kết nối).');
    const english = wrap(<QueueCopyResults results={results} names={names} />, 'en');
    expect(english).toContain('Zalo OA · Tiệm bánh OA: copied, 2 posts placed again. 1 post found no free slot within a year and left the queue; schedule it again.');
  });
});
