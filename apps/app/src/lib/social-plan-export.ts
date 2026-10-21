// The content plan export (#978): the range the calendar offers, the address of the print layout, and saving the file
// the server built. Days are the browser's, as the calendar shows them and as the import reads them back.
import { reportPeriod } from './social-report.ts';

// What the server takes (social.plan.export): days in one export, rows in one answer.
export const PLAN_EXPORT_MAX_DAYS = 92;
export const PLAN_EXPORT_MAX_ROWS = 500;
// A range picked in a zone with daylight saving can be an hour longer than its days, as the server allows.
const DST_SLACK_MS = 2 * 3_600_000;
const DAY_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The first and the last day of the month a day is in, as date inputs: what the dialog starts with.
export function monthOf(day: Date): { from: string; to: string } {
  return { from: dateInput(new Date(day.getFullYear(), day.getMonth(), 1)), to: dateInput(new Date(day.getFullYear(), day.getMonth() + 1, 0)) };
}

// The days from and to, both included, as the instants [from, to) the server takes; null when the end comes before
// the start or the range is longer than the server allows.
export function planRange(from: string, to: string): { from: string; to: string } | null {
  const period = reportPeriod(from, to);
  if (!period) return null;
  if (Date.parse(period.periodEnd) - Date.parse(period.periodStart) > PLAN_EXPORT_MAX_DAYS * DAY_MS + DST_SLACK_MS) return null;
  return { from: period.periodStart, to: period.periodEnd };
}

export interface PlanFilter {
  from: string;
  to: string;
  channels: string[];
  labels: string[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A comma list, or the same parameter given more than once (the router then hands an array).
const ids = (value: unknown, max: number) => {
  const parts = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value.flatMap((v) => (typeof v === 'string' ? v.split(',') : [])) : [];
  return [...new Set(parts.map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)))].slice(0, max);
};

// The print layout's address: /o/<slug>/print/social-plan?from=&to=&channels=&labels=.
export function planPrintPath(slug: string, filter: PlanFilter): string {
  const q = new URLSearchParams({ from: filter.from, to: filter.to });
  if (filter.channels.length > 0) q.set('channels', filter.channels.join(','));
  if (filter.labels.length > 0) q.set('labels', filter.labels.join(','));
  return `/o/${encodeURIComponent(slug)}/print/social-plan?${q.toString()}`;
}

// The print layout's search as the router hands it over; days that are not dates are left out, so the page says so.
export function parsePlanSearch(search: Record<string, unknown>): Partial<PlanFilter> {
  return {
    ...(typeof search.from === 'string' && DAY.test(search.from) ? { from: search.from } : {}),
    ...(typeof search.to === 'string' && DAY.test(search.to) ? { to: search.to } : {}),
    channels: ids(search.channels, 50),
    labels: ids(search.labels, 20),
  };
}

// Saves a file the server built through a link the browser clicks.
export function saveCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Some browsers still read the link a moment after the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
