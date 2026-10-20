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
  // Outbound mail (#538).
  'NOT_SUPPRESSED',
  'MAIL_COMPLAINT_LIFT',
  // Proposals and extraction.
  'PROPOSAL_DECIDED',
  'STALE_REVISION',
  'NOT_EDITABLE',
  'NOT_ELIGIBLE',
  'FOUR_EYES_REQUIRED',
  'CONTENT_CHANGED',
  'EXTRACTION_PENDING',
  'REEXTRACT_LIMIT',
  'ARCHIVE_NOT_READ',
  // Recording purchases and journal reversals (finance module).
  'CHECKS_BLOCKING',
  'CHECKS_FAILED',
  'DUPLICATE_INVOICE',
  'UNBALANCED',
  'UNKNOWN_ACCOUNT',
  'UNKNOWN_LINE',
  'UNSUPPORTED_CURRENCY',
  'TOTAL_MISMATCH',
  // Sales invoices and the org's tax code (#313).
  'NOT_OWN_SALE',
  'OWN_INVOICE',
  'NOT_REVENUE_ACCOUNT',
  'REVENUE_ACCOUNT_ON_PURCHASE',
  'INVALID_TAX_CODE',
  // Onboarding by tax code and the org's address (#324).
  'TAX_CODE_NOT_FOUND',
  'TAX_LOOKUP_UNAVAILABLE',
  'TAX_LOOKUP_DISABLED',
  'INVALID_ADDRESS',
  'ALREADY_REVERSED',
  'ENTRY_IS_REVERSAL',
  'ENTRY_NOT_FOUND',
  'REVERSAL_DATE_BEFORE_ENTRY',
  'REVERSAL_PENDING',
  // Opening balances (#320).
  'OPENING_BALANCE_EXISTS',
  'OPENING_BALANCE_AFTER_ENTRIES',
  'OPENING_BALANCE_INVALID',
  'OPENING_REVERSAL_DATE',
  // An entry dated on or before the opening entry (#366).
  'BEFORE_OPENING_BALANCE',
  // The tax portal's purchase list (#465).
  'PORTAL_LIST_EXISTS',
  'PORTAL_LIST_LIMIT',
  // Period lock (#329).
  'PERIOD_LOCKED',
  'PERIOD_ALREADY_LOCKED',
  'EARLIER_PERIOD_OPEN',
  'PERIOD_NOT_LOCKED',
  'LATER_PERIOD_LOCKED',
  'PERIOD_NOT_ENDED',
  // A late purchase invoice posted in an open month (#478).
  'POSTING_DATE_NOT_ALLOWED',
  'POSTING_DATE_IN_FUTURE',
  // Bank statements (#326).
  'NOT_A_BANK_ACCOUNT',
  'BANK_IMPORT_INVALID',
  // The chart of accounts and vendor defaults (#319).
  'ACCOUNT_CODE_TAKEN',
  'ACCOUNT_HAS_SUB_ACCOUNTS',
  'ACCOUNT_INACTIVE',
  'ACCOUNT_IN_USE',
  'ACCOUNT_IS_VENDOR_DEFAULT',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_READ_ONLY',
  'INVALID_SUB_ACCOUNT_CODE',
  'PARENT_INACTIVE',
  'PARENT_NOT_FOUND',
  'PARENT_TAGGED',
  'PARENT_NOT_DEEPEST',
  'PARTY_NOT_FOUND',
  // Cash and bank vouchers (#327), and bank vouchers made from a statement line (#326).
  'VOUCHER_INVALID',
  'BANK_LINE_NOT_FOUND',
  'BANK_LINE_MISMATCH',
  'BANK_LINE_PROPOSED',
  'BANK_LINE_MATCHED',
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
  'PERIOD_TOO_LARGE',
  'TAX_CODE_REQUIRED',
  'PERIOD_KIND_MISMATCH',
  'TAXPAYER_NAME_REQUIRED',
  'SLUG_MISMATCH',
  // AI agents: the chart, templates, agents, budgets and tasks (ADR-0029, issue #258).
  'MODULE_DISABLED',
  'TEMPLATE_NOT_FOUND',
  'POSITION_NOT_FOUND',
  'POSITION_ARCHIVED',
  'POSITION_CYCLE',
  'AGENT_NOT_FOUND',
  'AGENT_NOT_ACTIVE',
  'AGENT_ROLE_MISMATCH',
  'AGENT_ALREADY_PLACED',
  'AGENT_RETIRED',
  'INVALID_TARGET',
  'TASK_NOT_FOUND',
  // Crove Social and connected channels.
  'POST_NOT_FOUND',
  'VARIANT_NOT_FOUND',
  'ASSIGNEE_NOT_MEMBER',
  'SNIPPET_NOT_FOUND',
  'SNIPPET_NAME_TAKEN',
  'SNIPPET_LIMIT',
  'LABEL_NOT_FOUND',
  'IDEA_NOT_FOUND',
  'BIO_SLUG_TAKEN',
  'FEED_LIMIT',
  'FEED_EXISTS',
  'FEED_NOT_FOUND',
  'IDEA_DRAFTED',
  'IDEA_ARCHIVED',
  'LABEL_NAME_TAKEN',
  'LABEL_LIMIT',
  'REVIEW_LINK_NOT_FOUND',
  'REVIEW_LINK_LIMIT',
  'REVIEW_LINK_INVALID',
  'REVIEW_ANSWER_INVALID',
  'REVIEW_ANSWER_LIMIT',
  'REPORT_PERIOD_INVALID',
  'REPORT_LINK_LIMIT',
  'REPORT_LINK_NOT_FOUND',
  'REPORT_LINK_INVALID',
  'LINK_INVALID',
  'LINK_PREVIEW_LIMIT',
  'COMMENT_NOT_FOUND',
  'COMMENT_EDIT_CLOSED',
  'VARIANTS_OF_SEVERAL_POSTS',
  'VARIANT_STATE',
  'VARIANT_INVALID',
  'VARIANT_IN_FLIGHT',
  'APPROVAL_REQUIRED',
  'QUEUE_PAUSED',
  'APPROVALS_MISSING',
  'VARIANT_MEDIA_INVALID',
  'CHANNEL_ALREADY_IN_POST',
  'CHANNEL_PROVIDER_UNSUPPORTED',
  'TOO_MANY_CHANNELS',
  'NOTHING_TO_SUBMIT',
  'NOTHING_TO_SCHEDULE',
  'NOTHING_TO_REPOST',
  'COMMENT_NOT_RETRYABLE',
  'NOTHING_TO_DUPLICATE',
  'ALREADY_APPROVED',
  'SCHEDULE_REQUIRED',
  'SCHEDULE_IN_PAST',
  'QUEUE_EMPTY',
  'QUEUE_FULL',
  'DUPLICATE_SLOT',
  'SLOT_TAKEN',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NOT_ACTIVE',
  'CHANNEL_OWNER_LEFT',
  'CHANNEL_PROVIDER_DISABLED',
  'BROKER_NOT_CONFIGURED',
  'AI_NOT_CONFIGURED',
  'AI_DRAFT_FAILED',
  'AI_DRAFT_EMPTY',
  'AI_REWRITE_EMPTY',
  'BLUESKY_APP_PASSWORD',
  'BLUESKY_APP_PASSWORD_PRIVILEGED',
  'BLUESKY_PDS_UNSUPPORTED',
  'BLUESKY_LOGIN_FAILED',
  'OAUTH_TOO_MANY',
  'OAUTH_STATE_INVALID',
  'OAUTH_STATE_USED',
  'OAUTH_STATE_EXPIRED',
  'OAUTH_CODE_REJECTED',
  'OAUTH_PERMISSION_MISSING',
  'OAUTH_PROVIDER_FAILED',
  'CHANNEL_NO_ACCOUNTS',
  'MEDIA_NOT_FOUND',
  'MEDIA_TYPE_UNSUPPORTED',
  'COVER_INVALID',
  'COVER_TYPE_UNSUPPORTED',
  'COVER_TOO_LARGE',
  'FILE_IS_DOCUMENT',
  'FILE_IS_IMPORT',
  'FILE_IS_NOT_IMPORT',
  'VIDEO_TOO_LONG',
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
  // An entry dated on or before the opening balances (#366), worded by what the user can do about it.
  before_opening_posting_date: 'BEFORE_OPENING_BALANCE',
  before_opening_fixed: 'BEFORE_OPENING_BALANCE',
  before_opening_later_date: 'BEFORE_OPENING_BALANCE',
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
