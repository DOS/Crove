// Who a bank statement line paid or was paid by (issue #326, stage 2a). The module reads the org's parties, the invoices
// of the line's amount and the party balances that equal it; this ranks them by what the line's description and amount
// say. Pure and deterministic: a person confirms the suggestion when entering the voucher, and an approver checks the
// voucher again (R3, four-eyes), so a suggestion never posts anything by itself.
//
// Reasons, strongest first:
// - tax_code: a party's tax code (mã số thuế) is written in the description;
// - invoice: an invoice of the line's direction (a sale for money in, a purchase for money out) for exactly the line's
//   amount, whose number is written in the description;
// - name: a party's name, without its legal form (Công ty TNHH ...), is written in the description;
// - balance: a party's open balance (receivable on 131 for money in, payable on 331 for money out) equals the amount.
// The line's suggestion is the party of the strongest reason when no other party shares that reason; otherwise the
// candidates are listed and none is chosen.
import { BANK_MATCH_REASONS, type BankMatchReason } from '@crove/kernel-contract';
import { Decimal } from '@crove/l10n-vn';
import { foldVietnamese } from './portal-status.ts';

export interface MatchParty {
  id: string;
  name: string;
  taxCode: string | null;
}

export interface MatchInvoice {
  partyId: string;
  series: string;
  number: string;
  total: string;
}

export interface MatchBalance {
  partyId: string;
  // The open amount the party owes (131) or is owed (331), positive.
  balance: string;
}

export interface MatchCandidate {
  partyId: string;
  reason: BankMatchReason;
  // The invoice found in the description, for the invoice reason.
  invoice?: { series: string; number: string };
}

export interface LineMatch {
  suggested: MatchCandidate | null;
  candidates: MatchCandidate[];
}

// At most this many candidates are listed.
export const MAX_CANDIDATES = 5;

// Legal forms a name starts or ends with, folded (no diacritics, lower case), longest first so "cong ty tnhh mtv" is
// taken whole. They say nothing about which party it is.
const LEADING_FORMS = [
  'cong ty trach nhiem huu han mot thanh vien',
  'cong ty trach nhiem huu han',
  'cong ty tnhh mot thanh vien',
  'doanh nghiep tu nhan',
  'cong ty tnhh mtv',
  'cong ty co phan',
  'cong ty tnhh',
  'cty tnhh mtv',
  'ho kinh doanh',
  'cong ty cp',
  'chi nhanh',
  'cty tnhh',
  'cty cp',
  'cong ty',
  'cty',
  'dntn',
  'hkd',
].map((f) => f.split(' '));
const TRAILING_FORMS = ['company limited', 'joint stock company', 'co ltd', 'corporation', 'company', 'corp', 'jsc', 'ltd'].map((f) => f.split(' '));

const startsWith = (list: string[], form: string[]) => form.every((w, i) => list[i] === w);
const endsWith = (list: string[], form: string[]) => form.every((w, i) => list[list.length - form.length + i] === w);

// Folded words of a text, letters and digits only.
function words(text: string): string[] {
  return foldVietnamese(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

// Tax codes written in a text: 10 digits, or 10 digits, a dash and 3 digits (a branch), not part of a longer number.
export function taxCodesIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<![0-9])([0-9]{10})(?:\s*-\s*([0-9]{3}))?(?![0-9])/g)) {
    found.add(m[2] ? `${m[1]}-${m[2]}` : (m[1] as string));
  }
  return [...found];
}

// Whole numbers written in a text, without leading zeros: "HD 0000123" and "HĐ123" both give 123.
export function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/[0-9]+/g)) {
    const n = m[0].replace(/^0+(?=[0-9])/, '');
    if (n !== '0') found.add(n);
  }
  return found;
}

// A party's name as a description would write it: its folded words without the legal form it starts or ends with,
// or null when nothing distinctive is left (fewer than four letters in all).
export function nameKey(name: string): string[] | null {
  let core = words(name);
  for (let changed = true; changed; ) {
    changed = false;
    const lead = LEADING_FORMS.find((f) => core.length >= f.length && startsWith(core, f));
    if (lead) {
      core = core.slice(lead.length);
      changed = true;
    }
    const trail = TRAILING_FORMS.find((f) => core.length >= f.length && endsWith(core, f));
    if (trail) {
      core = core.slice(0, core.length - trail.length);
      changed = true;
    }
  }
  return core.join('').length >= 4 ? core : null;
}

// Whether the description writes the name's distinctive words in order, as words or run together ("ABC TRADING" or
// "ABCTRADING"). Run together, the name must have at least six letters, so a short name inside a longer word does not
// count.
function namedIn(key: string[], descriptionWords: string[], compact: string): boolean {
  const text = ` ${descriptionWords.join(' ')} `;
  if (text.includes(` ${key.join(' ')} `)) return true;
  const joined = key.join('');
  return joined.length >= 6 && compact.includes(joined);
}

const sameTaxCode = (a: string, b: string) => a.replace(/\s/g, '') === b.replace(/\s/g, '');

// Ranks the parties a line may be about. amount: the line's amount without its sign; invoices: invoices of the line's
// direction for exactly that amount; balances: parties whose open balance on the line's side equals it.
export function matchLine(
  line: { description: string; amount: string },
  parties: readonly MatchParty[],
  invoices: readonly MatchInvoice[],
  balances: readonly MatchBalance[],
): LineMatch {
  const amount = new Decimal(line.amount).abs();
  const known = new Set(parties.map((p) => p.id));
  const byReason = new Map<BankMatchReason, MatchCandidate[]>(BANK_MATCH_REASONS.map((r) => [r, []]));
  const seen = new Set<string>();
  const add = (candidate: MatchCandidate) => {
    if (!known.has(candidate.partyId) || seen.has(candidate.partyId)) return;
    seen.add(candidate.partyId);
    byReason.get(candidate.reason)?.push(candidate);
  };

  const codes = taxCodesIn(line.description);
  for (const party of parties) {
    if (party.taxCode && codes.some((c) => sameTaxCode(c, party.taxCode as string))) add({ partyId: party.id, reason: 'tax_code' });
  }
  const numbers = numbersIn(line.description);
  for (const invoice of invoices) {
    const number = invoice.number.replace(/^0+(?=[0-9])/, '');
    if (numbers.has(number) && new Decimal(invoice.total).equals(amount)) {
      add({ partyId: invoice.partyId, reason: 'invoice', invoice: { series: invoice.series, number: invoice.number } });
    }
  }
  const descriptionWords = words(line.description);
  const compact = descriptionWords.join('');
  for (const party of parties) {
    const key = nameKey(party.name);
    if (key && namedIn(key, descriptionWords, compact)) add({ partyId: party.id, reason: 'name' });
  }
  for (const b of balances) {
    if (new Decimal(b.balance).equals(amount)) add({ partyId: b.partyId, reason: 'balance' });
  }

  const candidates = BANK_MATCH_REASONS.flatMap((r) => byReason.get(r) ?? []).slice(0, MAX_CANDIDATES);
  const strongest = BANK_MATCH_REASONS.map((r) => byReason.get(r) ?? []).find((list) => list.length > 0) ?? [];
  return { suggested: strongest.length === 1 ? (strongest[0] as MatchCandidate) : null, candidates };
}
