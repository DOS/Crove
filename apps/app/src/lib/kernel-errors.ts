// Kernel error codes the SPA words itself (issue #215). The kernel writes its messages in Vietnamese and sends a
// stable `code` (plus `details` on the RPC path) with each; the SPA maps the code, and for rate limits the rule in
// the details, to a message of its catalogs, so the user reads it in their language. The kernel's own message stays
// the fallback for codes not listed here. test/kernel-errors.test.ts checks that every code the kernel raises is
// either listed here or named there as one the SPA never shows.
import type { Locale } from '../i18n/locale.ts';
import type { Translate } from '../i18n/runtime.ts';

// The language the kernel writes its messages in.
export const KERNEL_LOCALE: Locale = 'vi';

export const KERNEL_ERROR_CODES = [
  // Sessions, membership and the org.
  'UNAUTHENTICATED',
  'OAUTH_CLIENT_TOKEN_REFUSED',
  'MFA_REQUIRED',
  'SESSION_REVOKED_IN_ORG',
  'STEP_UP_REQUIRED',
  'NOT_A_MEMBER',
  'USER_DISABLED',
  'AUTH_UNAVAILABLE',
  'AUTH_NOT_READY',
  'ORG_REQUIRED',
  'ORG_CLOSED',
  // Refusals the kernel words differently per command; the kernel's Vietnamese message says which case it was.
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID',
  'VALIDATION',
  'CONFLICT',
  'INTERNAL',
  'RETRY',
  'OVERLOADED',
  'RATE_LIMITED',
  'IDEMPOTENCY_MISMATCH',
  // oRPC's own answers (input validation, an unexpected failure), worded in English by the library.
  'BAD_REQUEST',
  'INTERNAL_SERVER_ERROR',
  // Members and invites.
  'LAST_OWNER',
  'MEMBER_NOT_FOUND',
  'CANNOT_REMOVE_SELF',
  'ALREADY_MEMBER',
  'INVITE_EMAIL_MISMATCH',
  'INVITE_EMAIL_UNCONFIRMED',
  'INVITE_EXPIRED',
  'INVITE_NOT_FOUND',
  'INVITE_NOT_PENDING',
  'INVITE_PENDING_BY_OWNER',
  'INVITE_REVOKED',
  'INVITE_USED',
  'INVITE_RATE_LIMITED',
  'TOO_MANY_INVITES',
  // Proposals and extraction.
  'PROPOSAL_DECIDED',
  'STALE_REVISION',
  'NOT_EDITABLE',
  'NOT_ELIGIBLE',
  'FOUR_EYES_REQUIRED',
  'CONTENT_CHANGED',
  'EXTRACTION_PENDING',
  'REEXTRACT_LIMIT',
  // Recording purchases and journal reversals (finance module).
  'CHECKS_BLOCKING',
  'CHECKS_FAILED',
  'DUPLICATE_INVOICE',
  'UNBALANCED',
  'UNKNOWN_ACCOUNT',
  'UNKNOWN_LINE',
  'UNSUPPORTED_CURRENCY',
  'TOTAL_MISMATCH',
  'ALREADY_REVERSED',
  'ENTRY_IS_REVERSAL',
  'ENTRY_NOT_FOUND',
  'REVERSAL_DATE_BEFORE_ENTRY',
  'REVERSAL_PENDING',
  // Files, uploads and exports.
  'TOO_LARGE',
  'TOO_MANY_FILES',
  'UNSUPPORTED_TYPE',
  'NO_FILE',
  'UPLOAD_BUSY',
  'UPLOAD_EXPIRED',
  'UPLOAD_MISSING',
  'UPLOAD_USED',
  'BLOB_INTEGRITY',
  'EXPORT_EXPIRED',
  'EXPORT_PENDING',
  'EXPORT_TOO_LARGE',
  'SLUG_MISMATCH',
] as const;

export type KernelErrorCode = (typeof KERNEL_ERROR_CODES)[number];

// The `details.rule` of a rate limit refusal, and the code it comes with.
export const KERNEL_ERROR_RULES = {
  org_create_busy: 'RATE_LIMITED',
  org_create_total: 'RATE_LIMITED',
  org_create_per_day: 'RATE_LIMITED',
  inbound_rotate_busy: 'RATE_LIMITED',
  inbound_rotate_total: 'RATE_LIMITED',
  inbound_rotate_per_day: 'RATE_LIMITED',
  invite_busy: 'INVITE_RATE_LIMITED',
  invite_org_per_day: 'INVITE_RATE_LIMITED',
  invite_email_per_day: 'INVITE_RATE_LIMITED',
  invite_recipient_per_day: 'INVITE_RATE_LIMITED',
} as const satisfies Record<string, KernelErrorCode>;

type KernelErrorRule = keyof typeof KERNEL_ERROR_RULES;

// Codes whose kernel message is not the kernel's Vietnamese: the SPA words them in every locale.
const LIBRARY_CODES: ReadonlySet<KernelErrorCode> = new Set(['BAD_REQUEST', 'INTERNAL_SERVER_ERROR']);

export function isKernelErrorCode(code: string): code is KernelErrorCode {
  return (KERNEL_ERROR_CODES as readonly string[]).includes(code);
}

function ruleOf(code: KernelErrorCode, details: unknown): KernelErrorRule | null {
  const rule = (details as { rule?: unknown } | null | undefined)?.rule;
  if (typeof rule !== 'string' || !Object.hasOwn(KERNEL_ERROR_RULES, rule)) return null;
  return KERNEL_ERROR_RULES[rule as KernelErrorRule] === code ? (rule as KernelErrorRule) : null;
}

// The message for a known code, or null for a code the SPA does not word. `server` is the kernel's message when the
// caller wants it shown as is (the user reads the kernel's language); it is then returned for every kernel-worded
// code.
export function kernelErrorMessage(code: string, details: unknown, t: Translate, options: { server: string | null }): string | null {
  if (!isKernelErrorCode(code)) return null;
  if (options.server && !LIBRARY_CODES.has(code)) return options.server;
  const rule = ruleOf(code, details);
  return rule ? t(`kernelErrors.rules.${rule}`) : t(`kernelErrors.codes.${code}`);
}
