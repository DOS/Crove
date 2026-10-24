// The team report on the Metrics tab (#1058): the period picked as the instants the server takes, a review time in the
// unit that reads best, and the name of the file saved.
import { TEAM_REPORT_DST_SLACK_MS, TEAM_REPORT_MAX_DAYS } from '@crove/mod-social/contract';
import { reportPeriod } from './social-report.ts';
import { brandFileName } from '../i18n/brand.ts';

const DAY_MS = 86_400_000;

// The days from and to, both included in the browser's zone, as the instants [from, to) of social.team.report; null
// when the end comes before the start or the range is longer than the server allows.
export function teamRange(from: string, to: string): { from: string; to: string } | null {
  const period = reportPeriod(from, to);
  if (!period) return null;
  if (Date.parse(period.periodEnd) - Date.parse(period.periodStart) > TEAM_REPORT_MAX_DAYS * DAY_MS + TEAM_REPORT_DST_SLACK_MS) return null;
  return { from: period.periodStart, to: period.periodEnd };
}

export type DurationUnit = 'minutes' | 'hours' | 'days';

// Under an hour in whole minutes, under two days in hours, else in days; hours and days with one decimal.
export function durationOf(seconds: number): { unit: DurationUnit; value: number } {
  const s = Math.max(0, seconds);
  if (s < 3600) return { unit: 'minutes', value: Math.round(s / 60) };
  if (s < 2 * DAY_MS / 1000) return { unit: 'hours', value: Math.round(s / 360) / 10 };
  return { unit: 'days', value: Math.round(s / 8640) / 10 };
}

// The file's name, with the days picked, prefixed by the product name (BRAND_NAME, #1045).
export const teamFilename = (from: string, to: string) => brandFileName(`crove-nhom-${from}-den-${to}.csv`);
