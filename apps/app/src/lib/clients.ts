// The multi-client home screen (issue #318): where a signed-in user lands, the order of the orgs, how a VAT deadline
// reads, and which Social figures a client shows (#1261). The figures themselves come from me.clients; nothing here
// decides access.

export interface ClientDeadline {
  period: string;
  dueDate: string;
  daysLeft: number;
}

// overview is null for an org whose figures could not be read (#495).
export interface ClientRow {
  slug: string;
  name: string;
  overview: { vatDeadline: ClientDeadline | null } | null;
}

// A user with several orgs lands on the home screen; with one, in its Inbox; with none, on onboarding.
export type Landing = { to: 'clients' } | { to: 'inbox'; slug: string } | { to: 'onboarding' };

export function landingFor(orgs: ReadonlyArray<{ slug: string }>): Landing {
  const [first] = orgs;
  if (!first) return { to: 'onboarding' };
  return orgs.length > 1 ? { to: 'clients' } : { to: 'inbox', slug: first.slug };
}

// The nearest deadline first, orgs with no filing period chosen last, then by name.
export function sortClients<T extends ClientRow>(rows: readonly T[], locale: string): T[] {
  const byName = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  return [...rows].sort((a, b) => {
    const da = a.overview?.vatDeadline ?? null;
    const db = b.overview?.vatDeadline ?? null;
    if (da && db && da.dueDate !== db.dueDate) return da.dueDate < db.dueDate ? -1 : 1;
    if (da && !db) return -1;
    if (!da && db) return 1;
    return byName.compare(a.name, b.name) || a.slug.localeCompare(b.slug);
  });
}

// How loudly a deadline is shown: due within 3 days, within 7, or later.
export type DeadlineTone = 'urgent' | 'soon' | 'later';

export function deadlineTone(daysLeft: number): DeadlineTone {
  if (daysLeft <= 3) return 'urgent';
  if (daysLeft <= 7) return 'soon';
  return 'later';
}

// "2026-09" or "2026-Q3" as its parts, for a label like "Tháng 9/2026" or "Quý 3/2026".
export function periodParts(period: string): { kind: 'month' | 'quarter'; index: number; year: number } | null {
  const match = /^(\d{4})-(?:(0[1-9]|1[0-2])|Q([1-4]))$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  return match[3] ? { kind: 'quarter', index: Number(match[3]), year } : { kind: 'month', index: Number(match[2]), year };
}

// An org's Social figures as me.clients returns them (zSocialClientFigures).
export interface SocialFigures {
  review: number;
  waitingClient: number;
  attention: number;
  reconnect: number;
  upcoming: number;
  lastPostAt: string | null;
}

// Where a figure leads on the org's Social screens: a tab of the Social home, or the channels page.
export type SocialFigureLink = { to: 'social'; tab?: 'review' | 'attention' | 'done' } | { to: 'channels' };

export interface SocialFigure {
  key: 'review' | 'waitingClient' | 'attention' | 'reconnect' | 'upcoming';
  count: number;
  // urgent: someone must act (a failed post, a channel to reconnect); waiting: work queued for a person.
  tone: 'urgent' | 'waiting' | 'plain';
  link: SocialFigureLink;
}

// The figures a client shows, in the order an agency acts on them: what needs a person now, then what waits for the
// team or the client, then the next 7 days (always shown, 0 included, so a quiet week reads as one). A figure at 0
// other than the week's is left out.
export function socialFigures(figures: SocialFigures): SocialFigure[] {
  const all: SocialFigure[] = [
    { key: 'attention', count: figures.attention, tone: 'urgent', link: { to: 'social', tab: 'attention' } },
    { key: 'reconnect', count: figures.reconnect, tone: 'urgent', link: { to: 'channels' } },
    { key: 'review', count: figures.review, tone: 'waiting', link: { to: 'social', tab: 'review' } },
    { key: 'waitingClient', count: figures.waitingClient, tone: 'waiting', link: { to: 'social', tab: 'review' } },
    { key: 'upcoming', count: figures.upcoming, tone: 'plain', link: { to: 'social' } },
  ];
  return all.filter((f) => f.count > 0 || f.key === 'upcoming');
}

// Whole days since the last post went out, counted by local calendar day (today 0, yesterday 1); null when none has.
export function daysSince(at: string | null, now: Date = new Date()): number | null {
  if (!at) return null;
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) return null;
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.max(0, Math.round((day(now) - day(then)) / 86_400_000));
}
