// The figures an AI summary of a period is written from (#1237), as Sprout's AI Assist and Metricool Studio write one
// for a report: the period's totals, the change from the period before, the engagement rate, the channels, the best
// posts and the month's goals, each one a labelled number. The writer may cite these numbers and no other (the check
// after the model call refuses a summary that does), so this list is everything a summary can say in figures. Pure:
// the query reads the totals, this turns them into the list, and the API hands the list to the writer.
//
// Labels are English, for the prompt; the writer formats each value in the summary's language. A change is given as
// its size in percent with the direction in its label (the model writes "giảm 12%", never "-12%"), rounded as the
// Metrics tab's change chips round it. A rate is compared only over the same basis, as the tab does. Nothing here
// carries a number that is not a figure: the best posts are named by rank in words, and a label's name never appears
// (a campaign report never shows it, #1159).
import { comparableRate, engagementRateOfBases, engagementRatePercent, rateBasesOf, type RateBases } from './engagement-rate.ts';
import { goalEngagement, type GoalMetric, type GoalStatus } from './goals.ts';

export interface SummaryTotals {
  posts: number;
  metrics: Readonly<Record<string, number>>;
  // Clicks on Crove's short links, null when nothing went out with one.
  clicks: number | null;
  rateBases: RateBases;
}

export interface SummaryChannel {
  name: string;
  provider: string;
  current: SummaryTotals;
}

export interface SummaryTopPost {
  channel: string;
  // The post's opening words, tainted text: what it was about, never a source of figures.
  excerpt: string;
  metrics: Readonly<Record<string, number>>;
}

export interface SummaryGoal {
  // The channel's name, null for the org's own goals.
  channel: string | null;
  metric: GoalMetric;
  target: number;
  actual: number | null;
  status: GoalStatus;
}

export interface PeriodSummaryData {
  // Calendar dates (YYYY-MM-DD) in the reader's zone: the period's first and last day, and the previous period's.
  dates: { from: string; to: string; previousFrom: string; previousTo: string };
  days: number;
  current: SummaryTotals;
  previous: SummaryTotals;
  channels: readonly SummaryChannel[];
  top: readonly SummaryTopPost[];
  // The month's goals, for a period of exactly one month; null otherwise.
  goals: readonly SummaryGoal[] | null;
}

// One figure: a label saying what it is, and its value (a percent when percent is set).
export interface SummaryFigure {
  label: string;
  value: number;
  percent?: boolean;
}

export interface PeriodSummaryInput {
  period: { from: string; to: string; previousFrom: string; previousTo: string; days: number };
  figures: SummaryFigure[];
  // The channel names the summary may write (their own digits are allowed, "Shop 24h").
  channels: string[];
  // The best posts, by rank in words, with their tainted opening words.
  posts: { rank: string; channel: string; excerpt: string }[];
}

// The counts a summary may cite, in the order the Metrics tab shows them, with what they are called in the prompt.
export const SUMMARY_COUNTS = [
  ['reach', 'Reach (people reached)'],
  ['impressions', 'Impressions'],
  ['views', 'Video views'],
  ['engagement', 'Engagement (reactions, comments, shares, saves and clicks counted by the platforms)'],
  ['reactions', 'Reactions'],
  ['comments', 'Comments'],
  ['shares', 'Shares'],
  ['saves', 'Saves'],
  ['clicks', 'Clicks counted by the platforms'],
  ['linkClicks', "Clicks on the posts' short links"],
] as const;
// The most channels and best posts a summary is told about.
export const SUMMARY_CHANNELS_MAX = 8;
export const SUMMARY_TOP_MAX = 3;
const RANKS = ['Best post', 'Second best post', 'Third best post'];
const GOAL_LABELS: Record<GoalMetric, string> = { posts: 'posts published', reach: 'reach', impressions: 'impressions', engagement: 'engagement', followersGained: 'followers gained' };
const STATUS: Record<GoalStatus, string> = { met: 'met', missed: 'missed', on_track: 'on track', behind: 'behind', no_data: 'no data yet' };
const BASIS = { reach: 'reach', impressions: 'impressions' } as const;

// A count of a totals object by its summary name; undefined when not reported.
function countOf(totals: SummaryTotals, name: string): number | undefined {
  if (name === 'engagement') return goalEngagement(totals.metrics) ?? undefined;
  if (name === 'linkClicks') return totals.clicks ?? undefined;
  const value = totals.metrics[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The change of a count against the period before, in percent, rounded as the Metrics tab's change chips round it
 * (whole percents from 10, one decimal below); null when the period before has no such count or zero.
 */
export function changeFigure(current: number | undefined, previous: number | undefined): { size: number; direction: 'up' | 'down' | 'no change' } | null {
  if (previous === undefined || !Number.isFinite(previous) || previous === 0) return null;
  const now = current === undefined || !Number.isFinite(current) ? 0 : current;
  const raw = ((now - previous) / Math.abs(previous)) * 100;
  const size = Math.abs(raw) >= 10 ? Math.round(Math.abs(raw)) : Math.round(Math.abs(raw) * 10) / 10;
  return { size, direction: size === 0 ? 'no change' : raw > 0 ? 'up' : 'down' };
}

/** The structured input of a period's AI summary: every figure it may cite, the channel names and the best posts. */
export function periodSummaryInput(data: PeriodSummaryData): PeriodSummaryInput {
  const figures: SummaryFigure[] = [];
  const add = (label: string, value: number | undefined | null, percent = false) => {
    if (value === undefined || value === null || !Number.isFinite(value)) return;
    figures.push(percent ? { label, value, percent } : { label, value });
  };
  add('Days in the period', data.days);
  const counted = (label: string, now: number | undefined, before: number | undefined) => {
    add(`${label}, this period`, now);
    add(`${label}, previous period`, before);
    const change = now === undefined ? null : changeFigure(now, before);
    if (change) add(`${label}, change from the previous period (${change.direction})`, change.size, true);
  };
  counted('Posts published', data.current.posts, data.previous.posts);
  for (const [name, label] of SUMMARY_COUNTS) counted(label, countOf(data.current, name), countOf(data.previous, name));
  const rate = engagementRateOfBases([data.current.rateBases]);
  const before = comparableRate(rate, engagementRateOfBases([data.previous.rateBases]));
  if (rate) add(`Engagement rate (engagement over ${BASIS[rate.basis]}), this period`, engagementRatePercent(rate), true);
  if (rate && before) add(`Engagement rate (engagement over ${BASIS[before.basis]}), previous period`, engagementRatePercent(before), true);
  const channels = data.channels.filter((c) => c.current.posts > 0).slice(0, SUMMARY_CHANNELS_MAX);
  for (const c of channels) {
    const name = `Channel ${c.name} (${c.provider})`;
    add(`${name}: posts published this period`, c.current.posts);
    add(`${name}: reach this period`, countOf(c.current, 'reach'));
    add(`${name}: engagement this period`, countOf(c.current, 'engagement'));
    const r = engagementRateOfBases([c.current.rateBases]);
    if (r) add(`${name}: engagement rate over ${BASIS[r.basis]} this period`, engagementRatePercent(r), true);
  }
  const top = data.top.slice(0, SUMMARY_TOP_MAX);
  const posts = top.map((p, i) => {
    const rank = RANKS[i] ?? 'Another good post';
    add(`${rank}: engagement`, goalEngagement(p.metrics));
    add(`${rank}: reach`, typeof p.metrics.reach === 'number' ? p.metrics.reach : undefined);
    const r = engagementRateOfBases([rateBasesOf([p.metrics])]);
    if (r) add(`${rank}: engagement rate over ${BASIS[r.basis]}`, engagementRatePercent(r), true);
    return { rank, channel: p.channel, excerpt: p.excerpt.replace(/\s+/g, ' ').trim().slice(0, 160) };
  });
  for (const g of data.goals ?? []) {
    const name = `Monthly goal for ${g.channel === null ? 'the whole account' : `channel ${g.channel}`}: ${GOAL_LABELS[g.metric]}`;
    add(`${name}, target`, g.target);
    add(`${name}, actual (${STATUS[g.status]})`, g.actual);
  }
  const names = [...new Set([...channels.map((c) => c.name), ...top.map((p) => p.channel), ...(data.goals ?? []).flatMap((g) => (g.channel === null ? [] : [g.channel]))])];
  return { period: { ...data.dates, days: data.days }, figures, channels: names, posts };
}
