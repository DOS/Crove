// What a Google Business Profile location brought (#1477), as the Metrics tab and the client report show it: its calls,
// direction requests, website clicks and profile views. Google gives these days late, so the latest day with figures is
// shown next to them.

export const PERFORMANCE_FIGURES = ['calls', 'directions', 'websiteClicks', 'views'] as const;
export type PerformanceFigure = (typeof PERFORMANCE_FIGURES)[number];
export type PerformanceTotals = Record<PerformanceFigure, number>;

export interface PerformanceDay extends PerformanceTotals {
  day: string;
}

// One channel's figures in a report: the sums over the period's days with figures, the latest such day, and the same of
// the period before when the report compares.
export interface ChannelPerformance {
  channel: string;
  provider: string;
  days: number;
  lastDay: string | null;
  totals: PerformanceTotals;
  previous: { days: number; totals: PerformanceTotals } | null;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const totalsOf = (v: unknown): PerformanceTotals => {
  const t = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  return { calls: count(t.calls), directions: count(t.directions), websiteClicks: count(t.websiteClicks), views: count(t.views) };
};

// A channel's days on the Metrics tab, summed, with the latest; null when it has none.
export function sumDays(days: readonly PerformanceDay[]): { totals: PerformanceTotals; lastDay: string } | null {
  if (days.length === 0) return null;
  const totals: PerformanceTotals = { calls: 0, directions: 0, websiteClicks: 0, views: 0 };
  let lastDay = '';
  for (const d of days) {
    for (const f of PERFORMANCE_FIGURES) totals[f] += count(d[f]);
    if (d.day > lastDay) lastDay = d.day;
  }
  return { totals, lastDay };
}

// A report's list as the server sent it, read again; a channel with no day in the period is left out.
export function reportPerformance(value: unknown): ChannelPerformance[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((e: unknown) => {
    if (typeof e !== 'object' || e === null) return [];
    const r = e as Record<string, unknown>;
    if (typeof r.channel !== 'string' || typeof r.provider !== 'string' || count(r.days) === 0) return [];
    const p = typeof r.previous === 'object' && r.previous !== null ? (r.previous as Record<string, unknown>) : null;
    return [
      {
        channel: r.channel,
        provider: r.provider,
        days: count(r.days),
        lastDay: typeof r.lastDay === 'string' ? r.lastDay : null,
        totals: totalsOf(r.totals),
        previous: p ? { days: count(p.days), totals: totalsOf(p.totals) } : null,
      },
    ];
  });
}
