// The event types card in Settings (issue #1314), rendered on the server with the list answered from a seeded cache:
// each type with its length, format and host, what a member may change, and nothing to change for a viewer.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventType } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions() / key(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { EventTypesCard } = await import('../src/routes/event-types.tsx');

const ME = '00000000-0000-7000-8000-000000000001';
const OWNER = '00000000-0000-7000-8000-000000000002';
const members = [
  { userId: ME, email: 'me@example.test', displayName: 'Lan', role: 'member' as const },
  { userId: OWNER, email: 'owner@example.test', displayName: 'Minh', role: 'owner' as const },
];
const at = '2026-10-24T00:00:00.000Z';
const base = { description: null, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 240, horizonDays: 60, dailyLimit: null, locationValue: null, assignment: 'single' as const, coHostUserIds: [], createdAt: at, updatedAt: at };
const types: EventType[] = [
  { ...base, id: '00000000-0000-7000-8000-0000000000a1', slug: 'tu-van-thue', title: 'Tư vấn thuế', durationMin: 30, locationKind: 'video', hostUserId: ME, active: true },
  { ...base, id: '00000000-0000-7000-8000-0000000000a2', slug: 'doi-soat', title: 'Đối soát', durationMin: 60, locationKind: 'in_person', hostUserId: OWNER, active: false },
];

function card(role: 'owner' | 'member' | 'viewer'): string {
  const qc = client.current;
  qc.setQueryData(['crm', 'eventTypes', 'list'], types);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <EventTypesCard members={members} me={ME} role={role} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('EventTypesCard', () => {
  beforeEach(() => client.current.clear());

  it('lists each type with its link, length, format and host, archived ones marked', () => {
    const rows = card('owner').split('<li').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Tư vấn thuế');
    expect(rows[0]).toContain('/tu-van-thue');
    expect(rows[0]).toContain('30 min');
    expect(rows[0]).toContain(en.eventTypes.locations.video);
    expect(rows[0]).toContain('hosted by Lan');
    expect(rows[1]).toContain(`>${en.eventTypes.archived}<`);
    expect(rows[1]).toContain(`>${en.eventTypes.restore}<`);
  });

  it('lets a member change only what they host, and a viewer nothing', () => {
    const member = card('member').split('<li').slice(1);
    expect(member[0]).toContain(`>${en.eventTypes.edit}<`);
    expect(member[1]).not.toContain(`>${en.eventTypes.edit}<`);
    expect(card('member')).toContain(`aria-label="${en.eventTypes.addTitle}"`);
    const viewer = card('viewer');
    expect(viewer).not.toContain(`>${en.eventTypes.edit}<`);
    expect(viewer).not.toContain(`aria-label="${en.eventTypes.addTitle}"`);
  });
});
