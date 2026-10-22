// Monthly goals in the app (#1056): the Metrics tab card as each role sees it, the goals and the agency note of a
// one-month client report, and a report answer without them, which renders as before. Rendered on the server, with
// the queries answered from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e), fetchFile: () => Promise.reject(new Error('not fetched')) };
});
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ slug: 'tiem-banh' }) }));

const { GoalsCard } = await import('../src/components/social-goals.tsx');
const { ReportGoalsSection, ReportNote } = await import('../src/routes/social-report.tsx');
const { reportGoalGroups, shiftMonth } = await import('../src/lib/social-goals.ts');
const t = viMessages.social.goals;

const FB = '00000000-0000-4000-8000-0000000000fb';
const progress = {
  timeZone: 'Asia/Ho_Chi_Minh',
  month: '2026-09',
  periodStart: '2026-08-31T17:00:00.000Z',
  periodEnd: '2026-09-30T17:00:00.000Z',
  goals: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      connectionId: null,
      timeZone: 'Asia/Ho_Chi_Minh',
      targets: { posts: 12, reach: 50_000, impressions: null, engagement: null, followersGained: null },
      updatedBy: '00000000-0000-4000-8000-000000000009',
      updatedAt: '2026-09-01T00:00:00.000Z',
      progress: [
        { metric: 'posts', target: 12, actual: 12, projected: 12, ratio: 1, status: 'met' },
        { metric: 'reach', target: 50_000, actual: 45_000, projected: 45_000, ratio: 0.9, status: 'missed' },
      ],
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      connectionId: FB,
      timeZone: 'Asia/Ho_Chi_Minh',
      targets: { posts: null, reach: null, impressions: null, engagement: null, followersGained: 100 },
      updatedBy: '00000000-0000-4000-8000-000000000009',
      updatedAt: '2026-09-01T00:00:00.000Z',
      progress: [{ metric: 'followersGained', target: 100, actual: null, projected: null, ratio: null, status: 'no_data' }],
    },
  ],
};

function wrap(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale="vi" messages={viMessages as never} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function card(role: string, data: unknown = progress): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['me', 'get'], { orgs: [{ slug: 'tiem-banh', role }] });
  qc.setQueryData(['social', 'goals', 'progress'], data);
  return wrap(<GoalsCard channels={[{ id: FB, displayName: 'Trang Facebook', provider: 'facebook' }]} />);
}

describe('GoalsCard', () => {
  beforeEach(() => client.current.clear());

  it('shows each scope with its counts, a bar and met or missed', () => {
    const html = card('member');
    expect(html).toContain(t.title);
    expect(html).toContain('Tháng 09/2026');
    expect(html).toContain(t.org);
    expect(html).toContain('Trang Facebook');
    expect(html).toContain('12 / 12');
    expect(html).toMatch(/45[.,]000 \/ 50[.,]000/);
    expect(html).toContain(`>${t.status.met}<`);
    expect(html).toContain(`>${t.status.missed}<`);
    expect(html).toContain(`>${t.status.no_data}<`);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('width:90%');
    // Members read; they cannot set goals.
    expect(html).not.toContain(`>${t.edit}<`);
  });

  it('shows the projection while the month runs', () => {
    const now = Date.now();
    const running = {
      ...progress,
      periodStart: new Date(now - 10 * 86_400_000).toISOString(),
      periodEnd: new Date(now + 20 * 86_400_000).toISOString(),
      goals: [{ ...progress.goals[0], progress: [{ metric: 'posts', target: 12, actual: 3, projected: 9, ratio: 0.25, status: 'behind' }] }],
    };
    const html = card('owner', running);
    expect(html).toContain('Dự kiến cuối tháng: 9');
    expect(html).toContain(`>${t.status.behind}<`);
    expect(html).toContain('Còn 20 ngày');
  });

  it('lets owners and admins set goals, and hides an empty card from members', () => {
    expect(card('owner')).toContain(`>${t.edit}<`);
    expect(card('admin')).toContain(`>${t.edit}<`);
    const none = { ...progress, timeZone: null, goals: [] };
    expect(card('admin', none)).toContain(t.empty);
    expect(card('member', none)).toBe('');
    expect(card('viewer', none)).toBe('');
  });
});

describe('client report goals and note', () => {
  const period = { periodStart: '2026-08-31T17:00:00.000Z', periodEnd: '2026-09-30T17:00:00.000Z' };
  const goals = {
    month: '2026-09',
    timeZone: 'Asia/Ho_Chi_Minh',
    groups: [
      { channel: null, provider: null, items: [{ metric: 'posts', target: 12, actual: 13 }] },
      { channel: 'Zalo OA', provider: 'zalo', items: [{ metric: 'reach', target: 1000, actual: null }, { metric: 'bogus', target: 1, actual: 1 }] },
    ],
  };

  it('judges the goals of a month that is over', () => {
    const html = wrap(<ReportGoalsSection data={{ ...period, goals: goals as never }} nowMs={Date.parse('2026-10-05T00:00:00Z')} />);
    expect(html).toContain('Mục tiêu tháng 09/2026');
    expect(html).toContain(t.org);
    expect(html).toContain('13 / 12');
    expect(html).toContain('Zalo OA');
    expect(html).toContain(`>${t.status.met}<`);
    expect(html).toContain(`>${t.status.no_data}<`);
    // An item the page does not know is left out.
    expect(html).not.toContain('bogus');
  });

  it('renders nothing for an answer without goals, as before', () => {
    expect(wrap(<ReportGoalsSection data={period} nowMs={Date.now()} />)).toBe('');
    expect(wrap(<ReportGoalsSection data={{ ...period, goals: null }} nowMs={Date.now()} />)).toBe('');
    expect(reportGoalGroups({ month: 'x', groups: [] }, period, Date.now())).toBeNull();
    expect(reportGoalGroups({ month: '2026-09', groups: [{ items: [] }] }, period, Date.now())).toBeNull();
  });

  it('shows the note as text, never as markup', () => {
    const html = wrap(<ReportNote org="Agency A" note={'Tháng này tốt.\n<script>alert(1)</script><b>x</b>'} />);
    expect(html).toContain('Nhận xét của Agency A');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('whitespace-pre-line');
  });
});

describe('months', () => {
  it('steps across a year end', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-10', -13)).toBe('2025-09');
  });
});
