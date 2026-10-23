// One calendar chip per post (#1220) as people see it: a post on six channels is one chip naming how many channels and
// their status in words, a day with twelve posts shows three chips and a "+9" button, and the day's dialog lists every
// post with its time, each channel with its status, and the row's actions. Under a channel filter the board names a
// card's other channels, which a move acts on too (#1044). Rendered on the server from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { addDays, calendarGroups, calendarItems, dayId, startOfDay, type CalendarPost } from '../src/lib/social-calendar.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

// Query keys are the procedure's path, with the calendar's two post lists told apart.
vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions')
          return (o?: { input?: { undated?: boolean } }) => ({ queryKey: o?.input?.undated ? [...path, 'undated'] : path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e), fetchFile: () => Promise.reject(new Error('not fetched')) };
});
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to: _to, params: _params, ...rest }: { children?: ReactNode; to?: string; params?: unknown } & Record<string, unknown>) => <a {...rest}>{children}</a>,
  useNavigate: () => () => undefined,
}));

const { DayDialog, SocialCalendar } = await import('../src/components/social-calendar.tsx');
const { SocialBoard } = await import('../src/components/social-board.tsx');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const render = (node: ReactNode) => {
  setActiveLocale('vi');
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
};
const count = (html: string, needle: string) => html.split(needle).length - 1;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const channel = (n: number, status: string, effectiveAt: string | null, connection = n) =>
  ({
    id: uuid(1000 + n),
    connectionId: uuid(connection),
    provider: 'sandbox',
    status,
    effectiveAt,
    queueSlotAt: null,
    queuePaused: false,
    error: null,
    effective: { body: '' },
  }) as unknown as CalendarPost['variants'][number];
const post = (n: number, body: string, variants: CalendarPost['variants'], scheduledAt: string | null = null) =>
  ({
    id: uuid(n),
    revision: 1,
    title: null,
    body,
    scheduledAt,
    labelIds: [],
    recurrence: null,
    recurrenceSourceId: null,
    assigneeUserId: null,
    dueAt: null,
    openComments: 0,
    variants: variants.map((v) => ({ ...v, effective: { body } })),
  }) as unknown as CalendarPost;

// Two days ahead is always in the month view; times in the zone the tests run in, as the calendar draws.
const day = addDays(startOfDay(new Date()), 2);
const at = (hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).toISOString();
const names = new Map(Array.from({ length: 8 }, (_, i) => [uuid(i + 1), `Trang ${i + 1}`]));
// A post on six channels at 08:00, then eleven posts on one channel, all scheduled that day.
const six = post(1, 'Khai trương sáu kênh', [1, 2, 3, 4, 5, 6].map((c) => channel(c * 10, 'scheduled', at(8), c)));
const eleven = Array.from({ length: 11 }, (_, i) => post(100 + i, `Bài thứ ${i + 2}`, [channel(100 + i, 'scheduled', at(9 + i), 1)]));
const day12 = [six, ...eleven];

describe('one calendar chip per post (#1220)', () => {
  beforeEach(() => client.current.clear());

  it('draws a post on six channels as one chip, and a day of twelve posts as three chips and "+9"', () => {
    client.current.setQueryData(['social', 'posts', 'list'], day12);
    const html = render(<SocialCalendar slug="hoa-mai" names={names} canDecide canWrite />);
    expect(count(html, 'data-testid="calendar-chip"')).toBe(3);
    expect(count(html, 'data-channels="6"')).toBe(1);
    expect(text(html)).toContain('Khai trương sáu kênh 6 kênh · Đã lên lịch');
    // The chips hidden past the first three open in the day's list, from a button that says so.
    expect(count(html, 'data-testid="calendar-more"')).toBe(1);
    expect(text(html)).toContain(`+9 bài nữa, xem cả ngày ${dayId(day).split('-').reverse().join('/')}`);
    expect(html).toContain('aria-haspopup="dialog"');
    // Every channel of the six with its status, for the pointer's tooltip.
    expect(html).toContain('Sandbox (Trang 1): Đã lên lịch; Sandbox (Trang 2): Đã lên lịch');
  });

  it('names mixed statuses in words, what needs a person first, and keeps a dashed chip for a planned draft', () => {
    const mixed = post(200, 'Bài hai trạng thái', [channel(201, 'scheduled', at(10), 1), channel(202, 'failed', at(10), 2)]);
    const draft = post(300, 'Bản nháp dự kiến', [channel(301, 'draft', at(11), 3), channel(302, 'draft', at(11), 4)], at(11));
    client.current.setQueryData(['social', 'posts', 'list'], [mixed, draft]);
    const html = render(<SocialCalendar slug="hoa-mai" names={names} canDecide canWrite />);
    expect(text(html)).toContain('Bài hai trạng thái 2 kênh · Đăng lỗi, Đã lên lịch');
    expect(text(html)).toContain('Bản nháp dự kiến 2 kênh · Nháp');
    expect(count(html, 'border-dashed bg-background')).toBe(1);
    // Under a channel filter only that channel's chip is drawn.
    const filtered = render(<SocialCalendar slug="hoa-mai" names={names} canDecide canWrite filters={{ connectionId: uuid(2) }} />);
    expect(count(filtered, 'data-testid="calendar-chip"')).toBe(1);
    expect(text(filtered)).toContain('Bài hai trạng thái Sandbox · Đăng lỗi');
  });

  it('lists every post and channel of the day in a dialog named by its heading, with each row’s actions', () => {
    const groups = calendarGroups(calendarItems(day12));
    const html = render(
      <DayDialog title="Các bài ngày 25/10/2026" groups={groups} slug="hoa-mai" names={names} editing={false} actions={(g, t) => <button type="button">{`Đặt ngày cho bài: ${t}`}</button>} onClose={() => undefined}>
        {null}
      </DayDialog>,
    );
    expect(count(html, 'data-testid="day-post"')).toBe(12);
    // The heading names the dialog and takes the focus when it opens.
    const id = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${id}" tabindex="-1"`);
    expect(html.startsWith('<dialog')).toBe(true);
    for (const p of day12) expect(text(html)).toContain(`Đặt ngày cho bài: ${p.body}`);
    expect(count(html, 'Sandbox (Trang 1) · Đã lên lịch')).toBe(12);
    expect(text(html)).toContain('Sandbox (Trang 6) · Đã lên lịch');
    expect(text(html)).toContain('Đóng');
    // A day emptied meanwhile says so.
    const empty = render(
      <DayDialog title="Các bài ngày 25/10/2026" groups={[]} slug="hoa-mai" names={names} editing={false} actions={() => null} onClose={() => undefined}>
        {null}
      </DayDialog>,
    );
    expect(text(empty)).toContain('Ngày này không còn bài nào.');
  });
});

describe('the board under a channel filter (#1044)', () => {
  beforeEach(() => client.current.clear());

  it('names the channels outside the filter that a move of the card acts on too', () => {
    const both = post(400, 'Bài hai kênh', [channel(401, 'draft', null, 1), channel(402, 'draft', null, 2), channel(403, 'cancelled', null, 3)]);
    const board = (connectionId?: string) =>
      render(<SocialBoard posts={[both] as never} slug="hoa-mai" names={names} labels={[]} canWrite canDecide={false} connectionId={connectionId} />);
    expect(text(board(uuid(1)))).toContain('Bài này còn đăng trên Sandbox (Trang 2); chuyển cột cũng áp dụng cho các kênh đó.');
    expect(text(board())).not.toContain('Bài này còn đăng trên');
  });
});
