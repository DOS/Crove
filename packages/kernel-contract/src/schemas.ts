import { z } from 'zod';

// Wire conventions: snake_case is not used on the wire for the MVP API; decimals are strings,
// accounting dates are YYYY-MM-DD, ids are UUIDs.
export const zId = z.uuid();
// At most 16 integer digits, the size of the numeric(20,4) money columns.
export const zMoney = z.string().regex(/^-?\d{1,16}(\.\d{1,8})?$/, 'decimal string');
// YYYY-MM-DD that names a real day. Never throws (toISOString() does on an Invalid Date).
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}
// Same rule as isCalendarDate in @crove/l10n-vn, which does not depend on this package.
export const zLocalDate = z.string().refine(isCalendarDate, 'YYYY-MM-DD calendar date');
// Failed checks that make an invoice impossible to post as-is; confirming them does not help.
export const BLOCKING_CHECK_IDS: readonly string[] = ['currency', 'lines_sum', 'total'];
export const zAccountCode = z.string().regex(/^\d{3,5}$/);
export const zRole = z.enum(['owner', 'admin', 'member', 'viewer']);
export const zSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/);

export const zCheck = z.object({
  id: z.string().max(50),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string().max(1000),
});

export const zPartyRef = z.object({
  name: z.string().max(500),
  taxCode: z.string().max(20).nullable(),
  address: z.string().max(1000).nullable(),
  email: z.string().max(320).nullable(),
  phone: z.string().max(50).nullable(),
});

export const zProposedLine = z.object({
  lineNo: z.number().int().positive(),
  description: z.string().max(2000),
  unit: z.string().max(100).nullable(),
  quantity: zMoney.nullable(),
  unitPrice: zMoney.nullable(),
  amount: zMoney,
  vatRate: z.string().max(20).nullable(),
  debitAccount: zAccountCode,
  reason: z.string().max(500),
});

export const zJournalLineDraft = z.object({
  lineNo: z.number().int().positive(),
  accountCode: zAccountCode,
  debit: zMoney,
  credit: zMoney,
  memo: z.string().max(1000),
});

// Payload stored on a finance.purchase proposal and executed by finance.purchase.record.
export const zPurchaseProposal = z.object({
  seller: zPartyRef,
  buyer: zPartyRef,
  invoice: z.object({
    template: z.string().max(50).nullable(),
    series: z.string().max(50),
    number: z.string().max(50),
    issueDate: zLocalDate,
    currency: z.string().max(10),
    paymentMethod: z.string().max(100).nullable(),
    taxAuthorityCode: z.string().max(100).nullable(),
    subtotal: zMoney,
    vatTotal: zMoney,
    total: zMoney,
  }),
  lines: z.array(zProposedLine).min(1).max(1000),
  journal: z.array(zJournalLineDraft).min(2).max(1010),
  checks: z.array(zCheck).max(50),
  sourceFileId: zId,
  extractionMethod: z.enum(['einvoice_xml', 'pdf_text_ai', 'image_ai']),
});
export type PurchaseProposal = z.infer<typeof zPurchaseProposal>;

export const zOrgSummary = z.object({ orgId: zId, slug: z.string(), name: z.string(), role: zRole });
export const zMe = z.object({
  userId: zId,
  email: z.string(),
  displayName: z.string().nullable(),
  orgs: z.array(zOrgSummary),
});

export const zOrgDetail = z.object({
  orgId: zId,
  slug: z.string(),
  name: z.string(),
  role: zRole,
  inboundAddress: z.string().nullable(),
  members: z.array(z.object({ userId: zId, email: z.string(), displayName: z.string().nullable(), role: zRole })),
});

// Invites (issue #35). The invited address is trimmed and lower-cased, the form invites are stored and matched in.
export const zInviteEmail = z.string().trim().toLowerCase().max(320).pipe(z.email());
export const zInviteRole = zRole.exclude(['owner']);

// An invite as the org's owners and admins see it. `expired` and `declined` invites stay listed so the inviter knows
// to send a new one; accepted and revoked invites are only in the audit trail.
export const zOrgInvite = z.object({
  inviteId: zId,
  email: z.string(),
  role: zInviteRole,
  status: z.enum(['pending', 'expired', 'declined']),
  invitedBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

// A pending invite as the invitee sees it: only what they need to decide.
export const zMyInvite = z.object({
  orgId: zId,
  inviteId: zId,
  orgName: z.string(),
  role: zInviteRole,
  invitedBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

// A Supabase Auth session as Crove tracks it (ADR-0028).
export const zSession = z.object({
  sessionId: zId,
  status: z.enum(['active', 'revoked']),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  revokedAt: z.string().nullable(),
});

// Revoke one session (device) of a user, or every session with all: true.
export const zSessionRevoke = z
  .object({
    userId: zId,
    sessionId: zId.optional(),
    all: z.literal(true).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((input) => (input.sessionId === undefined) !== (input.all === undefined), {
    message: 'Chọn một phiên (sessionId) hoặc tất cả (all)',
  });

export const zProposalStatus = z.enum(['pending', 'executed', 'rejected', 'failed']);

export const zInboxItem = z.object({
  id: zId,
  kind: z.string(),
  status: zProposalStatus,
  title: z.string(),
  sellerName: z.string().nullable(),
  total: zMoney.nullable(),
  issueDate: zLocalDate.nullable(),
  failedChecks: z.number().int(),
  warnChecks: z.number().int(),
  duplicateOf: zId.nullable(),
  createdAt: z.string(),
});

export const zInboxDetail = zInboxItem.extend({
  revision: z.number().int(),
  payload: zPurchaseProposal.nullable(),
  error: z.string().nullable(),
  file: z.object({ id: zId, filename: z.string(), contentType: z.string(), sizeBytes: z.string() }).nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  result: z.object({ documentId: zId, journalEntryId: zId }).nullable(),
  // The server's approval decision for the caller (plan §4.7 P10, P12): 'four_eyes' means the caller wrote
  // part of this revision and another eligible approver must approve it.
  canApprove: z.boolean(),
  approveReason: z.enum(['ok', 'not_pending', 'not_eligible', 'four_eyes']),
  canEdit: z.boolean(),
  canReject: z.boolean(),
});

export const zFileStatus = z.object({
  id: zId,
  filename: z.string(),
  contentType: z.string(),
  status: z.enum(['processing', 'proposed', 'failed', 'duplicate']),
  error: z.string().nullable(),
  proposalId: zId.nullable(),
  createdAt: z.string(),
});

export const zParty = z.object({
  id: zId,
  name: z.string(),
  taxCode: z.string().nullable(),
  address: z.string().nullable(),
  documentCount: z.number().int(),
});

export const zPurchaseDocument = z.object({
  id: zId,
  partyId: zId,
  partyName: z.string(),
  series: z.string(),
  number: z.string(),
  issueDate: zLocalDate,
  subtotal: zMoney,
  vatAmount: zMoney,
  total: zMoney,
  journalEntryId: zId.nullable(),
  sourceFileId: zId.nullable(),
});

export const zJournalEntry = z.object({
  id: zId,
  entryDate: zLocalDate,
  description: z.string(),
  sourceType: z.string(),
  sourceId: zId,
  lines: z.array(
    z.object({ lineNo: z.number().int(), accountCode: z.string(), accountName: z.string(), debit: zMoney, credit: zMoney }),
  ),
});

export const zAccount = z.object({ code: z.string(), name: z.string(), parentCode: z.string().nullable() });
