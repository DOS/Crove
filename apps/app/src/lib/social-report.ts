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

// The sections of a client report (#1259). The blocks have a place on the page, in this order when a link chooses
// none; the extras (the period before, the Story counts, the short link clicks) go along with the numbers.
export const REPORT_BLOCKS = ['note', 'goals', 'totals', 'reels', 'channels', 'top', 'audience'] as const;
export const REPORT_EXTRAS = ['comparison', 'stories', 'clicks'] as const;
export type ReportBlock = (typeof REPORT_BLOCKS)[number];
export type ReportExtra = (typeof REPORT_EXTRAS)[number];
export type ReportSection = ReportBlock | ReportExtra;
export const REPORT_TOP_DEFAULT = 10;
const isBlock = (s: unknown): s is ReportBlock => (REPORT_BLOCKS as readonly unknown[]).includes(s);

// The blocks a report page shows, in its order: the link's, or every one when it chose none (null, or a server before
// sections). Anything else in the list is left out.
export function pageBlocks(sections: unknown): ReportBlock[] {
  if (!Array.isArray(sections)) return [...REPORT_BLOCKS];
  return [...new Set(sections.filter(isBlock))];
}

// The sections picked in a form: the blocks in their order, whether each is on, and the extras on.
export interface SectionsDraft {
  order: ReportBlock[];
  on: ReadonlySet<ReportSection>;
  topCount: number;
}

export const defaultSections = (): SectionsDraft => ({ order: [...REPORT_BLOCKS], on: new Set<ReportSection>([...REPORT_BLOCKS, ...REPORT_EXTRAS]), topCount: REPORT_TOP_DEFAULT });

// A draft from what a link or schedule has saved (null for every section, 10 best posts).
export function draftOf(sections: readonly string[] | null, topCount: number | null): SectionsDraft {
  if (!sections) return { ...defaultSections(), topCount: topCount ?? REPORT_TOP_DEFAULT };
  const chosen = pageBlocks(sections);
  return {
    order: [...chosen, ...REPORT_BLOCKS.filter((b) => !chosen.includes(b))],
    on: new Set(sections.filter((s): s is ReportSection => isBlock(s) || (REPORT_EXTRAS as readonly string[]).includes(s))),
    topCount: topCount ?? REPORT_TOP_DEFAULT,
  };
}

// What a form saves: null when every section is on in the page's own order (the report as before), else the chosen
// blocks in order and then the extras. An empty list means nothing is chosen, which the form refuses.
export function sectionsOf(draft: SectionsDraft): ReportSection[] | null {
  const blocks = draft.order.filter((b) => draft.on.has(b));
  const extras = REPORT_EXTRAS.filter((e) => draft.on.has(e));
  const all = blocks.length === REPORT_BLOCKS.length && extras.length === REPORT_EXTRAS.length && blocks.every((b, i) => b === REPORT_BLOCKS[i]);
  return all ? null : [...blocks, ...extras];
}

// Whether the draft shows anything: at least one block, since the extras alone make an empty report.
export const hasBlock = (draft: SectionsDraft): boolean => draft.order.some((b) => draft.on.has(b));

// The best posts' count to save: null for the default, so an untouched form saves the report as before.
export const topCountOf = (draft: SectionsDraft): number | null => (draft.topCount === REPORT_TOP_DEFAULT || !draft.on.has('top') ? null : draft.topCount);

// A block moved one place up (-1) or down (+1); unchanged at either end.
export function moveBlock(order: readonly ReportBlock[], block: ReportBlock, by: -1 | 1): ReportBlock[] {
  const i = order.indexOf(block);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const next = [...order];
  [next[i], next[j]] = [next[j] as ReportBlock, next[i] as ReportBlock];
  return next;
}
