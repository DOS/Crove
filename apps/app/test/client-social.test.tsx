// Social figures on the multi-client home (#1261): which figures a client shows and where each leads, how the days since
// the last post read, and the cell as people read it in Vietnamese and English. An org whose figures could not be read
// (#495) sorts and lists like an org with no deadline. Rendered on the server.
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import { daysSince, socialFigures, sortClients, type SocialFigures } from '../src/lib/clients.ts';
import { dueAcrossClients } from '../src/lib/tax-calendar.ts';

// A link as an anchor that names where it leads: the route, the org and the Social tab.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params, search, className }: { children?: ReactNode; to: string; params?: { slug?: string }; search?: { tab?: string }; className?: string }) => (
    <a data-to={to.replace('$slug', params?.slug ?? '')} data-tab={search?.tab ?? ''} className={className}>
      {children}
    </a>
  ),
}));

const { ClientSocialFigures } = await import('../src/components/client-social.tsx');

const NOW = new Date(2026, 9, 24, 15, 0);
const figures = (over: Partial<SocialFigures> = {}): SocialFigures => ({ review: 0, waitingClient: 0, attention: 0, reconnect: 0, upcoming: 0, lastPostAt: null, ...over });
const render = (node: ReactNode, locale: 'vi' | 'en' = 'vi') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
};
const links = (html: string) =>
  [...html.matchAll(/<a data-to="([^"]*)" data-tab="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ to: m[1], tab: m[2], text: (m[3] ?? '').replace(/&#x27;/g, "'") }));

describe('socialFigures', () => {
  it('lists what needs a person first, then what waits, then the next 7 days, each with where it leads', () => {
    expect(socialFigures(figures({ review: 3, waitingClient: 1, attention: 2, reconnect: 1, upcoming: 5 }))).toEqual([
      { key: 'attention', count: 2, tone: 'urgent', link: { to: 'social', tab: 'attention' } },
      { key: 'reconnect', count: 1, tone: 'urgent', link: { to: 'channels' } },
      { key: 'review', count: 3, tone: 'waiting', link: { to: 'social', tab: 'review' } },
      { key: 'waitingClient', count: 1, tone: 'waiting', link: { to: 'social', tab: 'review' } },
      { key: 'upcoming', count: 5, tone: 'plain', link: { to: 'social' } },
    ]);
  });

  it('leaves out figures at 0 but always says what the next 7 days hold', () => {
    expect(socialFigures(figures()).map((f) => [f.key, f.count])).toEqual([['upcoming', 0]]);
    expect(socialFigures(figures({ review: 2 })).map((f) => f.key)).toEqual(['review', 'upcoming']);
  });
});

describe('daysSince', () => {
  it('counts local calendar days, today being 0, and nothing when no post went out', () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince('not a date', NOW)).toBeNull();
    expect(daysSince(new Date(2026, 9, 24, 0, 5).toISOString(), NOW)).toBe(0);
    expect(daysSince(new Date(2026, 9, 23, 23, 59).toISOString(), NOW)).toBe(1);
    expect(daysSince(new Date(2026, 9, 10, 9, 0).toISOString(), NOW)).toBe(14);
    // A post a moment in the future (clock skew) reads as today.
    expect(daysSince(new Date(2026, 9, 25, 9, 0).toISOString(), NOW)).toBe(0);
  });
});

describe('ClientSocialFigures', () => {
  it('shows each figure as a link to the org’s filtered Social list, in Vietnamese', () => {
    const html = render(<ClientSocialFigures slug="an-binh" figures={figures({ review: 3, waitingClient: 1, attention: 2, reconnect: 1, upcoming: 5, lastPostAt: new Date(2026, 9, 20, 10).toISOString() })} now={NOW} />);
    expect(links(html)).toEqual([
      { to: '/o/an-binh/social', tab: 'attention', text: '2 bài cần xử lý' },
      { to: '/o/an-binh/social/channels', tab: '', text: '1 kênh cần kết nối lại' },
      { to: '/o/an-binh/social', tab: 'review', text: '3 bài chờ duyệt' },
      { to: '/o/an-binh/social', tab: 'review', text: 'trong đó 1 bài chờ khách duyệt' },
      { to: '/o/an-binh/social', tab: '', text: '5 bài sẽ đăng trong 7 ngày tới' },
      { to: '/o/an-binh/social', tab: 'done', text: 'Bài gần nhất đăng 4 ngày trước' },
    ]);
    expect(html).toContain('text-destructive');
  });

  it('says a quiet client has nothing planned and has not posted, in Vietnamese and English', () => {
    expect(links(render(<ClientSocialFigures slug="binh-minh" figures={figures()} now={NOW} />)).map((l) => l.text)).toEqual(['Chưa có bài nào sẽ đăng trong 7 ngày tới', 'Chưa đăng bài nào']);
    expect(links(render(<ClientSocialFigures slug="binh-minh" figures={figures({ review: 1, lastPostAt: new Date(2026, 9, 23, 8).toISOString() })} now={NOW} />, 'en')).map((l) => l.text)).toEqual([
      '1 post in review',
      'Nothing going out in the next 7 days',
      'Last post yesterday',
    ]);
  });
});

describe('an org whose figures could not be read', () => {
  it('sorts with the orgs that have no deadline and adds nothing to the tax calendar', () => {
    const ok = { orgId: 'o1', slug: 'b', name: 'Bình Minh', role: 'owner', overview: { vatDeadline: { period: '2026-09', dueDate: '2026-10-20', daysLeft: 1 }, taxDues: [] } };
    const failed = { orgId: 'o2', slug: 'a', name: 'An Phát', role: 'owner', overview: null };
    expect(sortClients([failed, ok], 'vi').map((r) => r.slug)).toEqual(['b', 'a']);
    expect(dueAcrossClients([failed, ok], 'vi')).toEqual([]);
  });
});
