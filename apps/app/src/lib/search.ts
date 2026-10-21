// Where a search result of the command palette (#673) opens, and the URL search params those screens read. No React
// imports, so it is unit tested.
import { fold } from './palette.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ?q= of the vendors and documents screens: the text their filter starts with. The router reads a digits-only value
// as a number (a tax code typed in the URL), so a whole number counts as its digits.
export function parseTextSearch(search: Record<string, unknown>): { q?: string } {
  const q = typeof search.q === 'number' && Number.isSafeInteger(search.q) ? String(search.q) : search.q;
  return typeof q === 'string' && q.trim() !== '' ? { q: q.trim().slice(0, 100) } : {};
}

// ?from=&to= of the journal: the date range shown (an entry is opened with #entry-<id>, as the other links do).
export function parseJournalSearch(search: Record<string, unknown>): { from?: string; to?: string } {
  const pick = (value: unknown) => (typeof value === 'string' && DATE.test(value) ? value : undefined);
  const from = pick(search.from);
  const to = pick(search.to);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

// The documents screen's filter: every typed word in the number (with its series), the party or the date.
export function matchesDocument(doc: { series: string; number: string; partyName: string; issueDate: string }, q: string): boolean {
  const haystack = fold(`${doc.series}-${doc.number} ${doc.number.replace(/^0+(?=\d)/, '')} ${doc.partyName} ${doc.issueDate}`);
  return fold(q)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

// A document as the palette and the documents screen write it: series-number, or the number alone.
export const documentNumber = (doc: { series: string; number: string }) => (doc.series ? `${doc.series}-${doc.number}` : doc.number);
