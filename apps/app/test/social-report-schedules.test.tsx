// The scheduled report card on the Metrics tab (#704) as each role sees it: owners and admins see their schedules, the
// next send, the recent sends with each mail's status and the controls; members see nothing. Rendered on the server,
// with the queries answered from a seeded cache.
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
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ slug: 'tiem-banh' }) }));

const { ReportSchedules } = await import('../src/components/social-report-schedules.tsx');
const t = viMessages.social.reportSchedules;

const schedule = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Báo cáo tuần cho Tiệm Bánh',
  cadence: 'weekly',
  weekday: 1,
  monthDay: null,
  sendHour: 8,
  timeZone: 'Asia/Ho_Chi_Minh',
  period: 'previous_week',
  connectionIds: [],
  recipients: ['khach@example.vn', 'sep@example.vn'],
  paused: false,
  nextRunAt: '2026-10-26T01:00:00.000Z',
  lastRunAt: '2026-10-19T01:02:00.000Z',
  runs: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      kind: 'scheduled',
      periodStart: '2026-10-11T17:00:00.000Z',
      periodEnd: '2026-10-18T17:00:00.000Z',
      createdAt: '2026-10-19T01:02:00.000Z',
      mails: [
        { to: 'khach@example.vn', status: 'delivered', errorCode: null },
        { to: 'sep@example.vn', status: 'failed', errorCode: 'MAIL_OFF' },
      ],
    },
  ],
};

function card(role: string): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['me', 'get'], { orgs: [{ slug: 'tiem-banh', role }] });
  qc.setQueryData(['social', 'reportSchedules', 'list'], [schedule]);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="vi" messages={viMessages as never} timeZone="Asia/Ho_Chi_Minh">
        <ReportSchedules channels={[]} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('ReportSchedules', () => {
  beforeEach(() => client.current.clear());

  it('shows owners the schedule, its recipients, the recent send with each status, and the controls', () => {
    const html = card('owner');
    expect(html).toContain(t.title);
    expect(html).toContain('Báo cáo tuần cho Tiệm Bánh');
    expect(html).toContain('Thứ Hai hằng tuần, 08:00');
    expect(html).toContain('Gửi tới: khach@example.vn, sep@example.vn');
    expect(html).toContain(`khach@example.vn: ${t.status.delivered}`);
    expect(html).toContain(`sep@example.vn: ${t.status.failed} (${t.mailOff})`);
    for (const control of [t.test, t.pause, t.remove, t.add]) expect(html).toContain(`>${control}<`);
  });

  it('shows admins the same card, and members nothing', () => {
    expect(card('admin')).toContain(t.title);
    expect(card('member')).toBe('');
    expect(card('viewer')).toBe('');
  });
});
