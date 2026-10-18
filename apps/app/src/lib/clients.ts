// The multi-client home screen (issue #318): where a signed-in user lands, the order of the orgs, and how a VAT
// deadline reads. The figures themselves come from me.clients; nothing here decides access.

export interface ClientDeadline {
  period: string;
  dueDate: string;
  daysLeft: number;
}

export interface ClientRow {
  slug: string;
  name: string;
  overview: { vatDeadline: ClientDeadline | null };
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
    const da = a.overview.vatDeadline;
    const db = b.overview.vatDeadline;
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
