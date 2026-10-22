// Client report links (#643): the period a report covers, from the dates a person picks in their own time zone, and
// the counts a report shows, in order.

// linkClicks: the clicks on Crove's short links (#724), shown only when a post went out with one. The Story counts
// (#1082) show when the report has them.
export const REPORT_METRICS = ['impressions', 'reach', 'views', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'linkClicks', 'replies', 'tapsForward', 'tapsBack', 'exits', 'nextStory', 'follows', 'profileVisits'] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The first and the last day of the previous calendar month, as date inputs: what an agency reports on most often.
export function lastMonth(now: Date): { from: string; to: string } {
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: dateInput(first), to: dateInput(last) };
}

// From the start of the first day to the end of the last one (both in the browser's zone), as instants; null when a
// date is missing or the last day comes before the first.
export function reportPeriod(from: string, to: string): { periodStart: string; periodEnd: string } | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to);
  if (!a || !b) return null;
  const start = new Date(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const end = new Date(Number(b[1]), Number(b[2]) - 1, Number(b[3]) + 1);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

// Recipients typed one per line or separated by commas, semicolons or spaces: the addresses that look valid
// (lower-cased, without duplicates) and the ones that do not.
export function parseRecipients(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const address = part.trim().toLowerCase();
    if (!address) continue;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) && address.length <= 320) {
      if (!valid.includes(address)) valid.push(address);
    } else if (!invalid.includes(part.trim())) invalid.push(part.trim());
  }
  return { valid, invalid };
}

// The page a client opens; the token stays after the #, so browsers never send it to a server in the address.
export const reportUrl = (origin: string, token: string) => `${origin}/-/report#${token}`;
