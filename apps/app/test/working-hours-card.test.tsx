// The working hours card in Settings (issue #1313), rendered on the server with the calendar answered from a seeded
// cache: the seven days with their times, the days off ahead, and what a viewer may not change.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyCalendar } from '@crove/kernel-contract';
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

const { WorkingHoursCard } = await import('../src/routes/working-hours.tsx');

const calendar: MyCalendar = {
  saved: true,
  hours: { timeZone: 'Asia/Ho_Chi_Minh', windows: [{ weekday: 1, start: 540, end: 1020 }, { weekday: 3, start: 480, end: 720 }] },
  events: [
    { id: '00000000-0000-7000-8000-000000000001', startsAt: '2026-11-01T17:00:00.000Z', endsAt: '2026-11-03T17:00:00.000Z', timeZone: 'Asia/Ho_Chi_Minh', title: null, kind: 'time_off' },
    { id: '00000000-0000-7000-8000-000000000002', startsAt: '2026-11-04T02:00:00.000Z', endsAt: '2026-11-04T03:00:00.000Z', timeZone: 'Asia/Ho_Chi_Minh', title: 'Họp', kind: 'manual' },
  ],
};

function card(canEdit: boolean, data: MyCalendar = calendar): string {
  const qc = client.current;
  qc.setQueryData(['calendar', 'get'], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={catalog('en')} timeZone="UTC">
        <WorkingHoursCard canEdit={canEdit} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('WorkingHoursCard', () => {
  beforeEach(() => client.current.clear());

  it('shows each day on or off with its times, and the days off ahead', () => {
    const html = card(true);
    const days = html.split('<li').slice(1, 8);
    expect(days[0]).toContain(en.workingHours.weekdays.mon);
    expect(days[0]).toContain('value="09:00"');
    expect(days[0]).toContain('value="17:00"');
    expect(days[1]).toContain(`>${en.workingHours.off}<`);
    expect(days[2]).toContain('value="08:00"');
    expect(days[2]).toContain('value="12:00"');
    expect(html).toContain('>Asia/Ho_Chi_Minh<');
    // The two-day day off, not the meeting.
    expect(html).toContain('11/2/2026 to 11/3/2026');
    expect(html).not.toContain('Họp');
    expect(html).toContain(`>${en.workingHours.save}<`);
    expect(html).toContain(`aria-label="${en.workingHours.addDayOff}"`);
    expect(html).not.toContain(en.workingHours.defaultHint);
  });

  it('says when the default hours apply, and offers a viewer nothing to change', () => {
    const html = card(false, { ...calendar, saved: false, events: [] });
    expect(html).toContain(en.workingHours.defaultHint);
    expect(html).toContain(en.workingHours.noDaysOff);
    expect(html).not.toContain(`>${en.workingHours.save}<`);
    expect(html).not.toContain(`aria-label="${en.workingHours.addDayOff}"`);
    expect(html).toContain('disabled=""');
  });
});
