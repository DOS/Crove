// The multi-client home screen's helpers (issue #318).
import { describe, expect, it } from 'vitest';
import { deadlineTone, landingFor, periodParts, sortClients, type ClientRow } from '../src/lib/clients.ts';

const row = (slug: string, name: string, dueDate: string | null): ClientRow => ({
  slug,
  name,
  overview: { vatDeadline: dueDate ? { period: '2026-09', dueDate, daysLeft: 1 } : null },
});

describe('landingFor', () => {
  it('sends a user with several orgs to the home screen, with one to its Inbox, with none to onboarding', () => {
    expect(landingFor([{ slug: 'a' }, { slug: 'b' }])).toEqual({ to: 'clients' });
    expect(landingFor([{ slug: 'a' }])).toEqual({ to: 'inbox', slug: 'a' });
    expect(landingFor([])).toEqual({ to: 'onboarding' });
  });
});

describe('sortClients', () => {
  it('puts the nearest deadline first, orgs without a filing period last, then sorts by name', () => {
    const rows = [row('d', 'Đông Á', null), row('b', 'Bình Minh', '2026-11-02'), row('a', 'An Phát', null), row('c', 'Cát Tường', '2026-10-20')];
    expect(sortClients(rows, 'vi').map((r) => r.slug)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('orders the same deadline by name, Vietnamese letters included', () => {
    const rows = [row('z', 'Ánh Dương', '2026-10-20'), row('y', 'An Khang', '2026-10-20')];
    expect(sortClients(rows, 'vi').map((r) => r.slug)).toEqual(['y', 'z']);
  });

  it('does not change the list it is given', () => {
    const rows = [row('b', 'B', null), row('a', 'A', null)];
    sortClients(rows, 'en');
    expect(rows.map((r) => r.slug)).toEqual(['b', 'a']);
  });
});

describe('deadlineTone', () => {
  it('is urgent within 3 days, soon within a week, later after that', () => {
    expect([0, 3, 4, 7, 8, 40].map(deadlineTone)).toEqual(['urgent', 'urgent', 'soon', 'soon', 'later', 'later']);
  });
});

describe('periodParts', () => {
  it('reads a month or a quarter', () => {
    expect(periodParts('2026-09')).toEqual({ kind: 'month', index: 9, year: 2026 });
    expect(periodParts('2026-Q4')).toEqual({ kind: 'quarter', index: 4, year: 2026 });
    expect(periodParts('2026-13')).toBeNull();
    expect(periodParts('2026-Q5')).toBeNull();
  });
});
