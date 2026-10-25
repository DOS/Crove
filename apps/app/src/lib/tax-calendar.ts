// The tax calendar on the multi-client home screen (issue #921): every client's obligations due in the next 30 days or
// overdue, in one list by due date, and how a period reads. The dues themselves come from me.clients (each read in its
// own org on the server); nothing here decides what is due.
import type { TaxDueView, TaxObligation } from '@crove/kernel-contract';
import { periodParts } from './clients.ts';

export interface TaxDueRow extends TaxDueView {
  orgId: string;
  slug: string;
  name: string;
  role: string;
}

// Every client's dues in one list: the earliest due date first, then by client name and obligation.
export function dueAcrossClients(
  clients: ReadonlyArray<{ orgId: string; slug: string; name: string; role: string; overview: { taxDues?: readonly TaxDueView[] } | null }>,
  locale: string,
): TaxDueRow[] {
  const byName = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const rows = clients.flatMap((c) => (c.overview?.taxDues ?? []).map((d) => ({ ...d, orgId: c.orgId, slug: c.slug, name: c.name, role: c.role })));
  return rows.sort((a, b) => (a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : byName.compare(a.name, b.name) || a.obligation.localeCompare(b.obligation) || a.period.localeCompare(b.period)));
}

// A period as its parts: a year ("2026"), or a month or quarter as clients.ts reads them.
export function taxPeriodParts(period: string): { kind: 'year'; year: number } | { kind: 'month' | 'quarter'; index: number; year: number } | null {
  if (/^\d{4}$/.test(period)) return { kind: 'year', year: Number(period) };
  return periodParts(period);
}

// Who may mark an obligation done (kernel.tax_obligation.done): owners, admins and members. With the finance module on,
// the VAT return's mark records the return as filed (finance.vat.return_mark, #1400), which only owners and admins do.
export function canMarkTaxDone(role: string | null | undefined, obligation?: TaxObligation, financeOn = false): boolean {
  if (obligation === 'vat_return' && financeOn) return role === 'owner' || role === 'admin';
  return role === 'owner' || role === 'admin' || role === 'member';
}

// Which legal entity a due row's "done" marks (#1553): each entity marks its own obligations, and the row stays until
// every entity it lists as open has. The Overview marks the entity chosen in the shell, and only while it is still
// open, so a user working in one entity never marks another's due. Without a choice (the multi-client home,
// chosen === undefined, or an entity list not known yet, null) a single open entity is marked, and several send the
// user to that org's Overview instead.
export function entityToMark(open: readonly { id: string }[], chosen: string | null | undefined): string | null {
  if (chosen === undefined || chosen === null) return open.length === 1 ? (open[0]?.id ?? null) : null;
  return open.some((e) => e.id === chosen) ? chosen : null;
}

export type { TaxObligation };
