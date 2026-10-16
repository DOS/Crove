// Asking for a journal entry reversal from the journal screen, and showing reversal proposals (#165). The server
// checks every rule again (kernel.proposal.request, finance.journal.prepare_reversal, then the approval); these
// helpers only keep the screens from offering what the server will refuse and explain its refusals.
import { isCalendarDate } from '@crove/kernel-contract';
import type { Locale } from '../i18n/locale.ts';
import type { Translate } from '../i18n/runtime.ts';
import { describeError } from './errors.ts';

export const REVERSAL_KIND = 'finance.journal_reversal';
// The roles that may ask for a proposal (kernel.proposal.request). Approving needs owner or admin.
const REQUESTERS = ['owner', 'admin', 'member'];
export const MAX_REASON_LENGTH = 500;

interface EntryLinks {
  reverses: { id: string } | null;
  reversedBy: { id: string } | null;
  // A reversal proposal of the entry waiting for approval (#204).
  pendingReversalId?: string | null | undefined;
}

// Whether the journal screen offers the reversal: not for a reversal (it cannot be reversed; post a new entry), not
// for an entry already reversed or with a reversal waiting for approval (the server refuses a second request), and not
// for viewers.
export function canAskReversal(entry: EntryLinks, role: string | null | undefined): boolean {
  return (
    Boolean(role && REQUESTERS.includes(role)) && entry.reverses === null && entry.reversedBy === null && !entry.pendingReversalId
  );
}

// Today as YYYY-MM-DD in the user's time zone, the default date of a reversal.
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The default reversal date: today, or the original's date when that is later (a reversal is never dated before it).
export function defaultReversalDate(originalDate: string, today: string = localToday()): string {
  return today < originalDate ? originalDate : today;
}

// The first problem with the form, or null when it can be sent. formatDate shows the original's date in the locale.
export function reversalFormError(
  form: { entryDate: string; reason: string },
  originalDate: string,
  t: Translate,
  formatDate: (value: string) => string,
): string | null {
  if (!isCalendarDate(form.entryDate)) return t('reversal.errors.date');
  // Both are YYYY-MM-DD, so string order is date order.
  if (form.entryDate < originalDate) return t('reversal.errors.dateBefore', { date: formatDate(originalDate) });
  const reason = form.reason.trim();
  if (!reason) return t('reversal.errors.reasonRequired');
  if (reason.length > MAX_REASON_LENGTH) return t('reversal.errors.reasonTooLong', { max: MAX_REASON_LENGTH });
  return null;
}

// A refusal of a reversal (asking or approving) in words the user can act on. The partial mirror refusal (the
// approver cannot see every line of the entry) is explained from its code and reason; other refusals are worded like
// any kernel error (describeError).
export function reversalErrorMessage(error: unknown, t: Translate, locale: Locale): string {
  const e = error as { code?: unknown; message?: unknown; data?: unknown } | null;
  const data = e?.data as { reason?: unknown } | null | undefined;
  if (e?.code === 'INVALID' && data?.reason === 'partial_mirror') return t('reversal.errors.partialMirror');
  return describeError(error, t, locale);
}
