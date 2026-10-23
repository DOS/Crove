import { describe, expect, it } from 'vitest';
import { addRateBases, engagementRateOf, engagementRateOfBases, rateBasesOf } from '../src/contract.ts';
import { changeFigure, periodSummaryInput, type PeriodSummaryData } from '../src/index.ts';

describe('rate sums (#1164)', () => {
  it('sums engagement and each denominator over the posts that report it', () => {
    const posts = [{ reach: 2000, reactions: 40 }, { reactions: 20 }, { impressions: 500, comments: 5 }, { reach: 0, reactions: 9 }, { views: 300 }];
    expect(rateBasesOf(posts)).toEqual({ reach: { engagement: 40, denominator: 2000 }, impressions: { engagement: 5, denominator: 500 } });
    // The rate of those posts is 2%, where the plain sums (65 over 2000) would read 3.25%.
    expect(engagementRateOf(posts)).toMatchObject({ rate: 0.02, basis: 'reach' });
    expect(rateBasesOf([])).toEqual({});
  });

  it('adds channels basis by basis, and gives the same rate as the posts together', () => {
    const a = [{ reach: 100, reactions: 50 }, { reactions: 1000 }];
    const b = [{ reach: 10_000, reactions: 100 }, { impressions: 50, reactions: 25 }];
    const sums = addRateBases([rateBasesOf(a), rateBasesOf(b), undefined, {}]);
    expect(sums).toEqual({ reach: { engagement: 150, denominator: 10_100 }, impressions: { engagement: 25, denominator: 50 } });
    expect(engagementRateOfBases([rateBasesOf(a), rateBasesOf(b)])).toEqual(engagementRateOf([...a, ...b]));
    // Impressions only when nothing reports reach; none without either.
    expect(engagementRateOfBases([{ impressions: { engagement: 5, denominator: 500 } }])).toMatchObject({ rate: 0.01, basis: 'impressions' });
    expect(engagementRateOfBases([{}, null])).toBeNull();
    // A zero or broken denominator adds nothing, never Infinity or NaN.
    expect(engagementRateOfBases([{ reach: { engagement: 5, denominator: 0 } }, { reach: { engagement: Number.NaN, denominator: 10 } }])).toBeNull();
  });
});

const data = (over: Partial<PeriodSummaryData> = {}): PeriodSummaryData => ({
  dates: { from: '2026-09-01', to: '2026-09-30', previousFrom: '2026-08-02', previousTo: '2026-08-31' },
  days: 30,
  current: { posts: 12, metrics: { reach: 45_210, reactions: 300, comments: 40, views: 900 }, clicks: 25, rateBases: { reach: { engagement: 340, denominator: 40_000 } } },
  previous: { posts: 10, metrics: { reach: 48_000, reactions: 200 }, clicks: null, rateBases: { reach: { engagement: 200, denominator: 48_000 } } },
  channels: [
    { name: 'Trang 24h', provider: 'facebook_page', current: { posts: 8, metrics: { reach: 45_210, reactions: 300 }, clicks: 25, rateBases: { reach: { engagement: 300, denominator: 40_000 } } } },
    { name: 'Kênh cũ', provider: 'x', current: { posts: 0, metrics: {}, clicks: null, rateBases: {} } },
  ],
  top: [{ channel: 'Trang 24h', excerpt: '  Giảm 50%\n mọi món  ', metrics: { reach: 5000, reactions: 120, comments: 10 } }],
  goals: [
    { channel: null, metric: 'posts', target: 15, actual: 12, status: 'missed' },
    { channel: 'Trang 24h', metric: 'reach', target: 40_000, actual: 45_210, status: 'met' },
  ],
  ...over,
});

describe('period summary figures (#1237)', () => {
  it('rounds a change as the change chips do, with its direction', () => {
    expect(changeFigure(12, 10)).toEqual({ size: 20, direction: 'up' });
    expect(changeFigure(45_210, 48_000)).toEqual({ size: 5.8, direction: 'down' });
    expect(changeFigure(10, 10)).toEqual({ size: 0, direction: 'no change' });
    expect(changeFigure(5, 0)).toBeNull();
    expect(changeFigure(5, undefined)).toBeNull();
  });

  it('lists the totals, the change, the rate, the channels that posted, the best posts and the goals', () => {
    const input = periodSummaryInput(data());
    const byLabel = new Map(input.figures.map((f) => [f.label, f]));
    expect(byLabel.get('Days in the period')).toEqual({ label: 'Days in the period', value: 30 });
    expect(byLabel.get('Posts published, this period')?.value).toBe(12);
    expect(byLabel.get('Posts published, change from the previous period (up)')).toEqual({ label: 'Posts published, change from the previous period (up)', value: 20, percent: true });
    expect(byLabel.get('Reach (people reached), change from the previous period (down)')?.value).toBe(5.8);
    // Engagement adds the platforms' counts; Crove's own link clicks are a count of their own.
    expect(byLabel.get('Engagement (reactions, comments, shares, saves and clicks counted by the platforms), this period')?.value).toBe(340);
    expect(byLabel.get("Clicks on the posts' short links, this period")?.value).toBe(25);
    expect(byLabel.has("Clicks on the posts' short links, previous period")).toBe(false);
    // The rate from the rate sums (0.85%), and the one before over the same basis.
    expect(byLabel.get('Engagement rate (engagement over reach), this period')).toMatchObject({ value: 0.85, percent: true });
    expect(byLabel.get('Engagement rate (engagement over reach), previous period')?.value).toBe(0.42);
    // A channel that did not post this period is left out.
    expect(byLabel.get('Channel Trang 24h (facebook_page): engagement rate over reach this period')?.value).toBe(0.75);
    expect([...byLabel.keys()].some((l) => l.includes('Kênh cũ'))).toBe(false);
    // The best post by rank in words, its opening words cleaned up.
    expect(byLabel.get('Best post: engagement')?.value).toBe(130);
    expect(input.posts).toEqual([{ rank: 'Best post', channel: 'Trang 24h', excerpt: 'Giảm 50% mọi món' }]);
    expect(byLabel.get('Monthly goal for the whole account: posts published, actual (missed)')?.value).toBe(12);
    expect(byLabel.get('Monthly goal for channel Trang 24h: reach, target')?.value).toBe(40_000);
    expect(input.channels).toEqual(['Trang 24h']);
    expect(input.period).toEqual({ from: '2026-09-01', to: '2026-09-30', previousFrom: '2026-08-02', previousTo: '2026-08-31', days: 30 });
    // No figure label carries a digit of its own but the channel names', so the check reads only the values.
    for (const f of input.figures) expect(f.label.replace('24h', '')).not.toMatch(/\d/);
  });

  it('compares a rate only over the same basis, and gives no goals when there are none', () => {
    const input = periodSummaryInput(data({ previous: { posts: 2, metrics: { impressions: 100, reactions: 4 }, clicks: null, rateBases: { impressions: { engagement: 4, denominator: 100 } } }, goals: null, top: [] }));
    const labels = input.figures.map((f) => f.label);
    expect(labels).toContain('Engagement rate (engagement over reach), this period');
    expect(labels.some((l) => l.startsWith('Engagement rate') && l.includes('previous period'))).toBe(false);
    expect(labels.some((l) => l.startsWith('Monthly goal'))).toBe(false);
    expect(input.posts).toEqual([]);
  });
});
