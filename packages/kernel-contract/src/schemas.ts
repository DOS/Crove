import { z } from 'zod';
import { ACCOUNT_CODE_PATTERN } from './accounts.ts';
import { VAT_FILING_PERIODS } from './vat-deadline.ts';

// Wire conventions: snake_case is not used on the wire for the MVP API; decimals are strings,
// accounting dates are YYYY-MM-DD, ids are UUIDs.
export const zId = z.uuid();
// At most 16 integer digits, the size of the numeric(20,4) money columns.
export const zMoney = z.string().regex(/^-?\d{1,16}(\.\d{1,8})?$/, 'decimal string');
// YYYY-MM-DD that names a real day, year 0001 or later (PostgreSQL rejects year 0000 in date input).
// Never throws (toISOString() does on an Invalid Date).
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value < '0001-01-01') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}
// Same rule as isCalendarDate in @crove/l10n-vn, which does not depend on this package.
export const zLocalDate = z.string().refine(isCalendarDate, 'YYYY-MM-DD calendar date');
// Failed checks that make an invoice impossible to post as-is; confirming them does not help.
export const BLOCKING_CHECK_IDS: readonly string[] = ['currency', 'lines_sum', 'total'];
// A TT133 account code or one of the org's sub-accounts (11211, 1121.VCB; see accounts.ts).
export const zAccountCode = z.string().regex(ACCOUNT_CODE_PATTERN);
export const zRole = z.enum(['owner', 'admin', 'member', 'viewer']);
export const zSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/);

// The outcomes of the deterministic invoice checks (@crove/l10n-vn checkInvoice, issue #677), one code per wording.
// A check stores its code and parameters, and the SPA renders the sentence in the reader's language from them. The
// Vietnamese `message` is kept: it is what payloads written before #677 carry, and what the SPA falls back to for a
// code it does not know.
export const INVOICE_CHECK_CODES = [
  'currency.unsupported',
  'lines_sum.ok',
  'lines_sum.mismatch',
  'total.ok',
  'total.mismatch',
  'vat_breakdown.ok',
  'vat_breakdown.mismatch',
  'seller_tax_code.unreadable',
  'seller_tax_code.checksum',
  'seller_tax_code.ok',
  'issue_date.invalid',
  'issue_date.future',
  'issue_date.ok',
  'tax_authority_code.present',
  'tax_authority_code.missing',
  'signature.unverified',
  'signature.missing',
  // The signature verification in crove-extract (#674): verified (params.signer when a certificate names one), or the
  // reason it is unverified or not applicable (SIGNATURE_REASONS in @crove/l10n-vn; missing is signature.missing).
  'signature.verified',
  'signature.malformed',
  'signature.ambiguous',
  'signature.not_covering',
  'signature.digest_mismatch',
  'signature.bad_signature',
  'signature.unsupported_algorithm',
  'signature.no_certificate',
  'signature.untrusted_certificate',
  'signature.certificate_expired',
  'signature.signer_mismatch',
  'signature.tax_authority_missing',
  'signature.tax_authority_invalid',
  'signature.tax_authority_untrusted',
  'signature.cash_register',
  'source.ai',
  'duplicate.found',
  // A replacement or an adjustment invoice (#916): its original in the books, or not found.
  'related.replaces',
  'related.adjusts',
  'related.replaces_missing',
  'related.adjusts_missing',
] as const;
export type InvoiceCheckCode = (typeof INVOICE_CHECK_CODES)[number];

export const zCheck = z.object({
  id: z.string().max(50),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string().max(1000),
  // Absent on payloads written before #677. Any string is kept, so a newer code still parses in an older reader.
  code: z.string().max(80).optional(),
  params: z.record(z.string().max(40), z.string().max(200)).optional(),
});
export type Check = z.infer<typeof zCheck>;

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
  // The account the line is posted to: the debit (cost or asset) account of a purchase line, the credit (revenue)
  // account of a sale line (direction 'sale', issue #313). The name predates sales.
  debitAccount: zAccountCode,
  reason: z.string().max(500),
});

// A purchase invoice (the org is the buyer) or a sales invoice (the org is the seller, issue #313).
export const DOCUMENT_DIRECTIONS = ['purchase', 'sale'] as const;
export const zDocumentDirection = z.enum(DOCUMENT_DIRECTIONS);
export type DocumentDirection = z.infer<typeof zDocumentDirection>;

export const zJournalLineDraft = z.object({
  lineNo: z.number().int().positive(),
  accountCode: zAccountCode,
  debit: zMoney,
  credit: zMoney,
  memo: z.string().max(1000),
});

// The digital signature verification of an e-invoice XML (#674), as crove-extract reported it: verified, unverified
// (a reason says why) or not applicable (an invoice read by AI, an unsigned cash register invoice). An unverified
// signature is a warning; the Inbox asks the approver to confirm it.
export const SIGNATURE_STATUSES = ['verified', 'unverified', 'not_applicable'] as const;
export const zSignatureStatus = z.enum(SIGNATURE_STATUSES);
export type SignatureStatus = z.infer<typeof zSignatureStatus>;
export const zProposalSignature = z.object({ status: zSignatureStatus, reason: z.string().max(50).nullable() });

export const CORRECTION_KINDS = ['replacement', 'adjustment'] as const;
export const zRelatedInvoiceRef = z.object({
  kind: z.enum(CORRECTION_KINDS),
  template: z.string().max(50).nullable(),
  series: z.string().min(1).max(50),
  number: z.string().min(1).max(50),
  issueDate: zLocalDate.nullable(),
  documentId: zId.nullable(),
});
export type RelatedInvoiceRef = z.infer<typeof zRelatedInvoiceRef>;

// Payload stored on a finance.purchase proposal and executed by finance.purchase.record. direction 'sale' (issue #313):
// the seller is the org itself (its tax code), the buyer is the customer, and the journal is Dr 131, Cr revenue, Cr
// 3331. Absent on purchases, including every proposal raised before sales existed.
export const zPurchaseProposal = z.object({
  direction: z.literal('sale').optional(),
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
    // The invoice's own VAT table (THTTLTSuat, #685): for each rate as the invoice writes it, the taxable value and the
    // VAT. Only from e-invoice XML; absent on proposals read from a PDF or an image, and on those raised before #685.
    taxBreakdown: z
      .array(z.object({ rate: z.string().max(20), taxableAmount: zMoney, vatAmount: zMoney }))
      .max(100)
      .optional(),
    // The invoice this one corrects (#916), from the e-invoice's TTHDLQuan: a replacement (thay thế) or an adjustment
    // (điều chỉnh). documentId is the original's document when extraction found it in force; recording looks it up
    // again. Absent on every other invoice.
    related: zRelatedInvoiceRef.optional(),
  }),
  lines: z.array(zProposedLine).min(1).max(1000),
  journal: z.array(zJournalLineDraft).min(2).max(1010),
  checks: z.array(zCheck).max(50),
  sourceFileId: zId,
  extractionMethod: z.enum(['einvoice_xml', 'pdf_text_ai', 'image_ai']),
  // Absent on proposals read before #674.
  signature: zProposalSignature.optional(),
});
export type PurchaseProposal = z.infer<typeof zPurchaseProposal>;

export const zOrgSummary = z.object({ orgId: zId, slug: z.string(), name: z.string(), role: zRole });
export const zMe = z.object({
  userId: zId,
  email: z.string(),
  displayName: z.string().nullable(),
  orgs: z.array(zOrgSummary),
});

// How often an org files its VAT return (issue #318).
export const zVatFilingPeriod = z.enum(VAT_FILING_PERIODS);

export const zOrgDetail = z.object({
  orgId: zId,
  slug: z.string(),
  name: z.string(),
  role: zRole,
  // The org's own tax code (MST), normalized; null until an owner or admin sets it. An e-invoice whose seller has this
  // tax code is a sale (issue #313).
  taxCode: z.string().nullable(),
  // How often the org files its VAT return (issue #318); null until an owner or admin chooses.
  vatFilingPeriod: zVatFilingPeriod.nullable(),
  // The org's address as the tax registry records it (issue #324); null until an owner or admin sets it.
  address: z.string().nullable(),
  inboundAddress: z.string().nullable(),
  // Messages to the org's addresses retired in the last 30 days that were dropped (#139); null when inboundAddress is.
  inboundDroppedCount: z.number().int().nonnegative().nullable(),
  members: z.array(z.object({ userId: zId, email: z.string(), displayName: z.string().nullable(), role: zRole })),
});

// One org on the multi-client home screen (issue #318): the org as me.get lists it, and its figures read in its own
// context. pendingProposals: proposals waiting in the Inbox. failedFiles: files that could not be read among the ones
// the Inbox lists. lastActivityAt: the newest entry of the org's activity feed. vatDeadline: the next VAT return due,
// from the org's filing period (null while none is chosen).
export const zClientOverview = zOrgSummary.extend({
  overview: z.object({
    pendingProposals: z.number().int().nonnegative(),
    failedFiles: z.number().int().nonnegative(),
    lastActivityAt: z.string().nullable(),
    vatFilingPeriod: zVatFilingPeriod.nullable(),
    vatDeadline: z
      .object({
        period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
        dueDate: zLocalDate,
        daysLeft: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
});
// The home screen's answer (#495): at most 200 orgs, and how many the user has, so a cut list says so.
export const zClientOverviews = z.object({ clients: z.array(zClientOverview), total: z.number().int().nonnegative() });
// What the public tax registry says about a tax code (issue #324), to prefill a new org: the normalized tax code, the
// registered name and the address (null when the registry has none).
export const zTaxRegistryEntry = z.object({ taxCode: z.string(), name: z.string(), address: z.string().nullable() });

// Org offboarding and its export (issue #38, #212). Each table downloads as NDJSON (one row per line) from
// GET /api/org-export/<table>, and the manifest (the parts with their sha256 and row counts) as JSON from
// GET /api/org-export/manifest, until expiresAt.
export const zOrgStatus = z.enum(['active', 'offboarding', 'closed']);
export const zOrgExport = z.object({
  status: zOrgStatus,
  requestedAt: z.string().nullable(),
  export: z
    .object({
      createdAt: z.string(),
      expiresAt: z.string(),
      expired: z.boolean(),
      encryption: z.enum(['aes-256-gcm', 'none']),
      manifestSha256: z.string(),
      fileCount: z.number().int().nonnegative(),
      tables: z.array(
        z.object({ table: z.string(), rows: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), chunks: z.number().int().nonnegative() }),
      ),
    })
    .nullable(),
});

// Member invites (issue #35). The token is 32 random bytes in base64url; only its SHA-256 is stored.
export const zInviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invite token');
export const zInviteRole = zRole.exclude(['owner']);
export const zInviteStatus = z.enum(['pending', 'expired', 'accepted', 'revoked']);

// What the inviter gets back. Never says whether the email has an account. acceptPath (a path on this server,
// with the token in the fragment so it stays out of server logs and Referer headers) is shown once, to the inviter.
export const zInviteCreated = z.object({
  inviteId: zId,
  email: z.string(),
  role: zInviteRole,
  expiresAt: z.string(),
  acceptPath: z.string(),
});

// What became of an invite's mail (#538, #539), from its mail_message row: null when no row exists (an invite made
// before mail was logged).
export const zInviteMailStatus = z.enum(['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'ambiguous']);

export const zInvite = z.object({
  id: zId,
  email: z.string(),
  role: zInviteRole,
  status: zInviteStatus,
  invitedBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  mail: zInviteMailStatus.nullable(),
});

// What the invitee consents to before accepting.
export const zInvitePreview = z.object({
  orgName: z.string(),
  role: zInviteRole,
  invitedBy: z.string(),
  expiresAt: z.string(),
});

// A connected channel account (ADR-0025). Never carries a credential.
export const zChannelConnection = z.object({
  id: zId,
  provider: z.string(),
  externalAccountId: z.string(),
  displayName: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(['active', 'expired', 'revoked', 'error']),
  statusReason: z.string().nullable(),
  connectedBy: zId,
  expiresAt: z.string().nullable(),
  connectedAt: z.string(),
});

// Providers connected through an OAuth dialog (Social plan S6), and the attempt's state: 32 random bytes, base64url.
export const OAUTH_CHANNEL_PROVIDERS = ['facebook_page', 'instagram', 'zalo_oa', 'threads', 'linkedin', 'youtube', 'tiktok', 'x', 'google_business', 'pinterest'] as const;
// Accounts one OAuth grant connects in a request, one command each (#375): a Meta user may manage hundreds of Pages.
export const OAUTH_MAX_ACCOUNTS_PER_GRANT = 100;
export const zOAuthProvider = z.enum(OAUTH_CHANNEL_PROVIDERS);
export const zOAuthState = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

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

// 'approved' is not committed today: kernel.proposal.approve moves a proposal through it and ends 'executed' in the
// same transaction (plan §8.3 states; P13 will keep approved proposals for system execution).
export const zProposalStatus = z.enum(['pending', 'approved', 'executed', 'rejected', 'failed']);

export const zExtractionStatus = z.enum(['pending', 'done', 'failed']);

// The most proposals one bulk approval takes (issue #315); the Inbox sends a larger selection in several batches.
export const MAX_BULK_APPROVE = 50;

// The proposals of one bulk approval, each named once with the revision the caller saw. Shared by the RPC contract
// and kernel.proposal.approve_many, so the route and the command accept the same input.
export const zBulkApproveItems = z
  // acceptUnverifiedSignature: the approver confirmed this revision of an invoice whose signature is unverified (#674).
  .array(z.object({ id: zId, revision: z.number().int().positive(), acceptUnverifiedSignature: z.boolean().optional() }))
  .min(1)
  .max(MAX_BULK_APPROVE)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'each proposal once');

export const zInboxItem = z.object({
  id: zId,
  kind: z.string(),
  status: zProposalStatus,
  title: z.string(),
  // An invoice proposal's direction (a sale or a purchase, issue #313); null for other kinds.
  direction: zDocumentDirection.nullable(),
  revision: z.number().int().positive(),
  sellerName: z.string().nullable(),
  // The customer of a sale (the seller is the org itself); null otherwise.
  buyerName: z.string().nullable(),
  total: zMoney.nullable(),
  issueDate: zLocalDate.nullable(),
  failedChecks: z.number().int(),
  warnChecks: z.number().int(),
  // The invoice's signature verification (#674); null for other kinds and for invoices read before it.
  signatureStatus: zSignatureStatus.nullable(),
  duplicateOf: zId.nullable(),
  createdAt: z.string(),
  // The AI agent that asked for the proposal (#435); null for a proposal a person or an upload made.
  requestedByAgent: z.object({ id: zId, name: z.string() }).nullable(),
  // Whether an extraction run read the proposal's source (so its invoice checks ran); an agent's proposal has none.
  extracted: z.boolean(),
});

// Cash and bank vouchers (issue #327; cash-voucher.ts has the rest).
// cash_receipt: phiếu thu (money into the cash box, 111); cash_payment: phiếu chi (out of it); bank_credit: giấy báo
// Có (money into a bank account, 112); bank_debit: giấy báo Nợ (out of it).
export const VOUCHER_TYPES = ['cash_receipt', 'cash_payment', 'bank_credit', 'bank_debit'] as const;
export const zVoucherType = z.enum(VOUCHER_TYPES);
export type VoucherType = z.infer<typeof zVoucherType>;

export const VOUCHER_MAX_LINES = 20;

// A whole number of VND above zero, at most 15 digits (the money columns hold 16 integer digits).
export const zVoucherAmount = z
  .string()
  .regex(/^\d{1,15}$/, 'whole VND amount')
  .refine((v) => /[1-9]/.test(v), 'amount above zero');

// One line of the voucher: the account the money settles (131 a customer's debt, 331 a vendor's, 6422 an expense, ...)
// and how much of the voucher's total goes to it.
export const zVoucherLine = z.object({
  account: zAccountCode,
  amount: zVoucherAmount,
  // Diễn giải of the line; the voucher's reason when empty.
  memo: z.string().trim().max(300).optional(),
});
export type VoucherLine = z.infer<typeof zVoucherLine>;

// The payload of a finance.cash_voucher proposal, built by the server from the request (the party as found, the total
// computed). finance.voucher.record checks it all again when the proposal is approved.
export const zCashVoucherProposal = z.object({
  type: zVoucherType,
  date: zLocalDate,
  cashAccount: zAccountCode,
  party: z.object({ id: zId, name: z.string().max(500), taxCode: z.string().max(20).nullable() }).nullable(),
  personName: z.string().max(200).nullable(),
  description: z.string().min(1).max(300),
  lines: z.array(zVoucherLine).min(1).max(VOUCHER_MAX_LINES),
  total: zVoucherAmount,
  // The bank statement line the voucher settles (#326); absent on vouchers entered by hand.
  bankLineId: zId.optional(),
});
export type CashVoucherProposal = z.infer<typeof zCashVoucherProposal>;

// General journal vouchers (issue #888; journal-voucher.ts has the rest). A whole number of VND, at most 15 digits; 0
// on the side a line does not use.
export const zJournalAmount = z.string().regex(/^\d{1,15}$/, 'whole VND amount');
export const JOURNAL_VOUCHER_MAX_LINES = 50;

// The payload of a finance.journal_voucher proposal, built by the server from the request (each party as found, the
// total of the debits). finance.journal_voucher.record checks it all again when the proposal is approved.
export const zJournalVoucherProposal = z.object({
  date: zLocalDate,
  description: z.string().min(1).max(300),
  lines: z
    .array(
      z.object({
        account: zAccountCode,
        party: z.object({ id: zId, name: z.string().max(500), taxCode: z.string().max(20).nullable() }).nullable(),
        debit: zJournalAmount,
        credit: zJournalAmount,
        memo: z.string().max(300).optional(),
      }),
    )
    .min(2)
    .max(JOURNAL_VOUCHER_MAX_LINES),
  total: zJournalAmount,
});
export type JournalVoucherProposal = z.infer<typeof zJournalVoucherProposal>;

// Payload of a finance.journal_reversal proposal (#138), asked for with inbox.request and executed by
// finance.journal.reverse on approval.
export const zJournalReversal = z.object({
  entryId: zId,
  // The reversal's own date: on or after the original's, usually the day the mistake is corrected.
  entryDate: zLocalDate,
  reason: z.string().trim().min(1).max(500),
});
export type JournalReversal = z.infer<typeof zJournalReversal>;

export const zInboxDetail = zInboxItem.extend({
  revision: z.number().int(),
  // Parsed by kind: a purchase (kind finance.purchase), a reversal (kind finance.journal_reversal) or a cash or bank
  // voucher (kind finance.cash_voucher, #327); the others are null.
  payload: zPurchaseProposal.nullable(),
  reversal: zJournalReversal.nullable(),
  voucher: zCashVoucherProposal.nullable(),
  // A general journal voucher (kind finance.journal_voucher, #888).
  journalVoucher: zJournalVoucherProposal.nullable(),
  error: z.string().nullable(),
  file: z.object({ id: zId, filename: z.string(), contentType: z.string(), sizeBytes: z.string() }).nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  // A purchase returns its document, and the posting date when its invoice month was locked and the approver posted
  // it in an open month (#478); a reversal returns the entry it reversed and, for a purchase entry, the document it
  // voided (#165); a voucher returns the voucher and the code it was given (PC00001 and the like; #327).
  result: z
    .object({
      documentId: zId.optional(),
      postingDate: zLocalDate.optional(),
      journalEntryId: zId,
      reversedEntryId: zId.optional(),
      voidedDocumentId: zId.optional(),
      voucherId: zId.optional(),
      voucherCode: z.string().optional(),
    })
    .nullable(),
  // An executed purchase whose document was voided by reversing its journal entry (#165): the file may be read again
  // and the invoice recorded anew.
  voided: z.boolean(),
  // The server's approval decision for the caller (plan §4.7 P10, P12): 'four_eyes' means the caller wrote
  // part of this revision and another eligible approver must approve it.
  canApprove: z.boolean(),
  approveReason: z.enum(['ok', 'not_pending', 'not_eligible', 'four_eyes']),
  canEdit: z.boolean(),
  canReject: z.boolean(),
  // The source file's newest extraction run (issue #40). inFlight: a re-extraction is running, so approve, edit and
  // reject wait for it. proposalVersion: the run this revision was read from; a newer failed run left it unchanged.
  extraction: z
    .object({
      version: z.number().int(),
      status: zExtractionStatus,
      error: z.string().nullable(),
      inFlight: z.boolean(),
      proposalVersion: z.number().int().nullable(),
    })
    .nullable(),
  // The caller may ask for the source file to be read again (files.reextract).
  canReextract: z.boolean(),
});

export const zFileStatus = z.object({
  id: zId,
  filename: z.string(),
  contentType: z.string(),
  // expanded: a ZIP archive whose entries were filed as documents of their own (#314).
  status: z.enum(['processing', 'proposed', 'failed', 'duplicate', 'expanded']),
  // The newest run's error, when that run failed.
  error: z.string().nullable(),
  proposalId: zId.nullable(),
  // The newest extraction run's number (1 for the first read), null while the file has not been read yet.
  version: z.number().int().nullable(),
  canReextract: z.boolean(),
  createdAt: z.string(),
});
export type FileStatus = z.infer<typeof zFileStatus>;

// Why an entry of a ZIP archive was not filed (#314): what the sandbox refused (encrypted, a compression other than
// stored or deflate, an archive inside the archive, larger than a document may be, bytes that do not match the
// archive's directory), or what the server refused (not XML, PDF, JPG, PNG or WEBP; empty).
// email_limit: past the documents an emailed ZIP files (MAX_EMAIL_ARCHIVE_DOCUMENTS, #432).
export const ARCHIVE_ENTRY_REASONS = ['encrypted', 'unsupported_method', 'nested_archive', 'too_large', 'corrupt', 'unsupported_type', 'empty', 'email_limit'] as const;
export type ArchiveEntryReason = (typeof ARCHIVE_ENTRY_REASONS)[number];

// One entry of an opened archive: filed as a new document (stored, with that file's status), the same bytes as a
// document the org already has (duplicate, with that file), or not filed (rejected, with the reason).
export const zArchiveEntry = z.object({
  name: z.string(),
  outcome: z.enum(['stored', 'duplicate', 'rejected']),
  reason: z.enum(ARCHIVE_ENTRY_REASONS).nullable(),
  file: zFileStatus.nullable(),
});
export type ArchiveEntry = z.infer<typeof zArchiveEntry>;

// A file of an upload batch (#314): its status and, for a ZIP archive that has been opened, its entries.
// entryCount: how many entries the archive was opened into (null for any other file). An answer holds a bounded number
// of entries in all; an archive past it comes with its first entries only and entriesTruncated, to be asked about alone.
export const zBatchFile = zFileStatus.extend({
  entries: z.array(zArchiveEntry).nullable(),
  entryCount: z.number().int().nonnegative().nullable(),
  entriesTruncated: z.boolean(),
});
// Entries of opened archives one batch answer holds in all (four full archives of 500).
export const MAX_BATCH_ENTRIES = 2000;
export type BatchFile = z.infer<typeof zBatchFile>;
// Files one batch query may ask about (the SPA asks about the files of its current upload batch).
export const MAX_BATCH_FILES = 500;

export const zParty = z.object({
  id: zId,
  name: z.string(),
  taxCode: z.string().nullable(),
  address: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  // The version an edit sends back (kernel.party.update, #887): a save made meanwhile by someone else refuses it.
  version: z.number().int(),
  documentCount: z.number().int(),
  // The debit account proposed first for this vendor's invoices (set by approving one, or by hand), or null.
  defaultAccount: z.string().nullable(),
  // The parties marked as duplicates of this one (#887): hidden from lists and search, their documents counted here.
  duplicates: z.array(z.object({ id: zId, name: z.string(), taxCode: z.string().nullable() })),
});
export type Party = z.infer<typeof zParty>;

const zPartyName = z.object({ id: zId, name: z.string(), taxCode: z.string().nullable() });
// Two parties that look like one (#887), and why: one enterprise's tax codes, the same phone, or names alike. keep is
// the one to keep (the one with a tax code, else the older).
export const zDuplicateHint = z.object({ keep: zPartyName, duplicate: zPartyName, reasons: z.array(z.enum(['tax_code', 'phone', 'name'])) });

// An export a recorded document went out in (issue #878): the journal, or the MISA file of its direction, whose date
// range took in the document's entry date; from and to are null for an open end.
export const zDocumentExport = z.object({
  id: zId,
  at: z.string(),
  format: z.enum(['journal', 'misa_sme_purchases', 'misa_sme_sales']),
  from: zLocalDate.nullable(),
  to: zLocalDate.nullable(),
  actorName: z.string().nullable(),
});
export type DocumentExport = z.infer<typeof zDocumentExport>;

// Customers (#670): the parties on the org's sales documents, and any party with a line on 131 (an opening balance or
// a receipt). The list goes by name, CUSTOMER_PAGE_SIZE at a time; a page starts after the last customer shown.
export const CUSTOMER_PAGE_SIZE = 50;
export const zCustomerCursor = z.object({ name: z.string().max(2000), id: zId });
export type CustomerCursor = z.infer<typeof zCustomerCursor>;
// A customer is a party (with its contact details, version and duplicates, for the editor shared with vendors) and
// its sales: the documents still in the books (a voided one, #165, no longer counts) and the latest invoice date among
// them, and what it owes today: debit minus credit of every posted line on 131 and its sub-accounts naming it or one
// of its duplicates (#887). Negative when the customer paid ahead.
export const zCustomer = zParty.omit({ documentCount: true, defaultAccount: true }).extend({
  invoiceCount: z.number().int(),
  lastInvoiceDate: zLocalDate.nullable(),
  receivable: zMoney,
});
export type Customer = z.infer<typeof zCustomer>;
export const zCustomerPage = z.object({ items: z.array(zCustomer), more: z.boolean() });
export type CustomerPage = z.infer<typeof zCustomerPage>;

export const zPurchaseDocument = z.object({
  id: zId,
  // A purchase (partyId is the supplier) or a sale (partyId is the customer), issue #313.
  direction: zDocumentDirection,
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
  // Voided by reversing its journal entry (#165): Crove's record no longer counts; the supplier's invoice is untouched.
  voided: z.object({ reversalEntryId: zId, reason: z.string(), voidedAt: z.string() }).nullable(),
  // The voided document of the same invoice that this one replaces, when the invoice was recorded again.
  replacesDocumentId: zId.nullable(),
});

const zEntryRef = z.object({ id: zId, entryDate: zLocalDate });

export const zJournalEntry = z.object({
  id: zId,
  entryDate: zLocalDate,
  description: z.string(),
  sourceType: z.string(),
  sourceId: zId,
  lines: z.array(
    z.object({ lineNo: z.number().int(), accountCode: z.string(), accountName: z.string(), debit: zMoney, credit: zMoney }),
  ),
  // The reversal link, both ways (#138): the entry this one reverses, and the entry that reversed this one.
  reverses: zEntryRef.nullable(),
  reversedBy: zEntryRef.nullable(),
  // The reversal proposal of this entry waiting for approval, if any (#204); another request is refused meanwhile.
  pendingReversalId: zId.nullable(),
  // The purchase document this entry records, when it does (absent otherwise).
  document: z
    .object({ id: zId, direction: zDocumentDirection, series: z.string(), number: z.string(), issueDate: zLocalDate, partyName: z.string(), voided: z.boolean() })
    .optional(),
  // The cash or bank voucher this entry posts, when it does (#327; absent otherwise).
  voucher: z.object({ id: zId, type: zVoucherType, code: z.string(), partyName: z.string().nullable() }).optional(),
});

// What the command palette's search found (#673): at most 8 rows per group. A party that is customerOnly (a customer of
// sales that never sold to the org) is not among the vendors. A document's proposalId opens it in the Inbox.
export const zSearchResult = z.object({
  parties: z.array(z.object({ id: zId, name: z.string(), taxCode: z.string().nullable(), customerOnly: z.boolean() })),
  documents: z.array(
    z.object({
      id: zId,
      direction: zDocumentDirection,
      series: z.string(),
      number: z.string(),
      issueDate: zLocalDate,
      partyName: z.string(),
      total: zMoney,
      proposalId: zId.nullable(),
      voided: z.boolean(),
    }),
  ),
  entries: z.array(z.object({ id: zId, entryDate: zLocalDate, description: z.string(), amount: zMoney })),
});

// One account of the org's chart: a TT133 account (custom false, always active) or one of the org's sub-accounts
// (#319). rootCode is the TT133 account it rolls up to (its own code for a TT133 account).
export const zAccount = z.object({
  code: z.string(),
  name: z.string(),
  parentCode: z.string().nullable(),
  rootCode: z.string(),
  active: z.boolean(),
  custom: z.boolean(),
});

// VAT working for a month ("2026-09") or a quarter ("2026-Q3") (issue #316): the period's input and output invoices
// by VAT rate and the form 01/GTGT indicators they feed. The rules are in @crove/mod-finance (domain/vat-return.ts).
// The year is bounded (2000 to 2100) here, at the edge, so an out-of-range period is a 4xx, never a server error.
export const VAT_PERIOD_PATTERN = /^(20\d{2}|2100)-(0[1-9]|1[0-2]|Q[1-4])$/;
export const zVatPeriod = z.string().regex(VAT_PERIOD_PATTERN, 'YYYY-MM or YYYY-Qn');
export const VAT_RATES = ['0', '5', '8', '10', 'KCT', 'KKKNT', 'other'] as const;
export const zVatRate = z.enum(VAT_RATES);
// declared_late (#478): a purchase invoice of an earlier period, recorded late (its own month was locked), so it is
// declared in the period of its posting date.
export const VAT_WARNINGS = ['rate_unknown', 'rate_split', 'reduced_rate_outside_period', 'lines_mismatch', 'vat_mismatch', 'declared_late'] as const;
export const zVatWarning = z.enum(VAT_WARNINGS);
const zRateAmounts = z.object({ rate: zVatRate, taxable: zMoney, vat: zMoney });
export const zVatInvoice = z.object({
  id: zId,
  issueDate: zLocalDate,
  // The date its journal entry is posted on: the issue date, or a later date in an open month for a purchase invoice
  // whose own month was locked (#478). The period is chosen by this date.
  postingDate: zLocalDate,
  series: z.string(),
  number: z.string(),
  partyName: z.string(),
  partyTaxCode: z.string().nullable(),
  subtotal: zMoney,
  vatAmount: zMoney,
  total: zMoney,
  rates: z.array(zRateAmounts),
  warnings: z.array(zVatWarning),
});
const zVatSide = z.object({
  // false: Crove has no source for this side yet (sales invoices); documents and totals are empty.
  available: z.boolean(),
  documents: z.array(zVatInvoice),
  totals: z.object({ byRate: z.array(zRateAmounts), taxable: zMoney, vat: zMoney, documents: z.number().int().nonnegative() }),
});
export const zVatReport = z.object({
  period: z.object({ period: zVatPeriod, kind: z.enum(['month', 'quarter']), from: zLocalDate, to: zLocalDate }),
  input: zVatSide,
  output: zVatSide,
  indicators: z.array(z.object({ code: z.string(), label: z.string(), amount: zMoney })),
});

// Ledger reports for a month ("2026-09"), a quarter ("2026-Q3") or a year ("2026") (issue #321): the trial balance,
// the general ledger of one account, and the receivables (131) and payables (331) per party. The rules are in
// @crove/mod-finance (domain/ledger-reports.ts). Balances of the general ledger are signed: debit minus credit.
export const LEDGER_PERIOD_PATTERN = /^(20\d{2})(?:-(0[1-9]|1[0-2]|Q[1-4]))?$/;
export const zLedgerPeriod = z.string().regex(LEDGER_PERIOD_PATTERN, 'YYYY-MM, YYYY-Qn or YYYY');
const zLedgerPeriodRange = z.object({ period: zLedgerPeriod, kind: z.enum(['month', 'quarter', 'year']), from: zLocalDate, to: zLocalDate });
const zTrialBalanceAmounts = z.object({
  openingDebit: zMoney,
  openingCredit: zMoney,
  debit: zMoney,
  credit: zMoney,
  closingDebit: zMoney,
  closingCredit: zMoney,
});
export const zTrialBalanceRow = zTrialBalanceAmounts.extend({
  accountCode: z.string(),
  accountName: z.string(),
  parentCode: z.string().nullable(),
  // 0 for an account at the top of the chart, 1 for its sub-accounts, and so on.
  level: z.number().int().nonnegative(),
});
export const zPartyBalance = z.object({
  partyId: zId.nullable(),
  partyName: z.string().nullable(),
  partyTaxCode: z.string().nullable(),
  opening: zMoney,
  increase: zMoney,
  decrease: zMoney,
  closing: zMoney,
});
const zPartyLedger = z.object({
  accountCode: z.string(),
  rows: z.array(zPartyBalance),
  totals: z.object({ opening: zMoney, increase: zMoney, decrease: zMoney, closing: zMoney }),
});
export const zLedgerReport = z.object({
  period: zLedgerPeriodRange,
  trialBalance: z.object({ rows: z.array(zTrialBalanceRow), totals: zTrialBalanceAmounts, balanced: z.boolean() }),
  receivables: zPartyLedger,
  payables: zPartyLedger,
});
// Period lock (issue #329): the org's books are locked from lockedFrom to lockedThrough (YYYY-MM-DD, both null when
// nothing is locked). Months are YYYY-MM; nextMonth is the only month a lock may name (null: any month that has
// ended), lastMonth the only one an unlock may name. updatedBy and updatedAt describe the last lock or unlock
// (updatedBy null once that person left the org).
export const zPeriodMonth = z.string().regex(/^(20\d{2})-(0[1-9]|1[0-2])$/, 'YYYY-MM');
export const zPeriodLockInput = z.object({ month: zPeriodMonth });
export const zPeriodUnlockInput = z.object({ month: zPeriodMonth, reason: z.string().trim().min(1).max(500) });
export const zPeriodLockState = z.object({
  lockedFrom: zLocalDate.nullable(),
  lockedThrough: zLocalDate.nullable(),
  nextMonth: zPeriodMonth.nullable(),
  lastMonth: zPeriodMonth.nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
  // The date of the org's opening entry in force (#366): no other entry posts on or before it.
  openingDate: zLocalDate.nullable(),
});
export type PeriodLockState = z.infer<typeof zPeriodLockState>;

// Financial statements for a period (issue #154): B01-DNN at its last day and B02-DNN for the period, with the DRAFT
// TT133 line codes and mapping an accountant has not verified. `unmapped` lists balances no line reads (the statement
// is then incomplete); `balanced` is whether B01's total assets equal its total sources.
const zStatementLine = z.object({ code: z.string(), label: z.string(), amount: zMoney, total: z.boolean() });
const zUnmappedRow = z.object({ accountCode: z.string(), accountName: z.string().nullable(), partyName: z.string().nullable(), amount: zMoney });
export const zFinancialStatements = z.object({
  period: zLedgerPeriodRange,
  b01: z.object({ asOf: zLocalDate, lines: z.array(zStatementLine), unmapped: z.array(zUnmappedRow), balanced: z.boolean() }),
  b02: z.object({ from: zLocalDate, to: zLocalDate, lines: z.array(zStatementLine), unmapped: z.array(zUnmappedRow) }),
});

export const zAccountLedger = z.object({
  period: zLedgerPeriodRange,
  account: z.object({ code: z.string(), name: z.string() }),
  opening: zMoney,
  lines: z.array(
    z.object({
      entryId: zId,
      entryDate: zLocalDate,
      reference: z.string().nullable(),
      description: z.string(),
      reversal: z.boolean(),
      accountCode: z.string(),
      counterAccounts: z.array(z.string()),
      partyName: z.string().nullable(),
      debit: zMoney,
      credit: zMoney,
      balance: zMoney,
    }),
  ),
  debit: zMoney,
  credit: zMoney,
  closing: zMoney,
});

// AI agents as org members (ADR-0029): the chart, the agents, their tasks, budgets and the "Stop AI" kill switch.
export const zModuleId = z.string().regex(/^[a-z][a-z0-9_]*$/).max(50);
export const zAgentRoleKey = z.string().regex(/^[a-z][a-z0-9_.]*$/).max(100);
export const zAgentRisk = z.enum(['R0', 'R1', 'R2']);
export const zAgentStatus = z.enum(['active', 'paused', 'retired']);
export const zPositionStatus = z.enum(['active', 'paused', 'archived']);
export const zAgentScope = z.enum(['org', 'module', 'agent']);
export const zTaskStatus = z.enum(['todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled']);
// A non-negative amount with up to 6 decimals (ai_run cost), as a decimal string.
export const zAiAmount = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'decimal string');
export const zJobDescription = z.record(z.string(), z.unknown());

// Who holds a position: a member, or an agent, which the chart always labels as AI (ADR-0029 section 9).
export const zPositionHolder = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('user'), userId: zId, email: z.string().nullable(), displayName: z.string().nullable(), ai: z.literal(false) }),
    z.object({ type: z.literal('agent'), agentId: zId, name: z.string().nullable(), status: z.string().nullable(), ai: z.literal(true) }),
  ])
  .nullable();

export const zChart = z.object({
  // The owners, at the root of the chart: positions without reportsTo report to them.
  root: z.array(z.object({ userId: zId, email: z.string().nullable(), displayName: z.string().nullable() })),
  positions: z.array(
    z.object({
      id: zId,
      title: z.string(),
      module: z.string(),
      roleKey: z.string(),
      reportsTo: zId.nullable(),
      status: zPositionStatus,
      jobDescription: z.unknown(),
      holder: zPositionHolder,
    }),
  ),
  agents: z.array(
    z.object({ id: zId, templateKey: z.string(), displayName: z.string(), status: zAgentStatus, maxRisk: zAgentRisk, dailyRunCap: z.number().int() }),
  ),
  // Kill switches that are on.
  killSwitches: z.array(z.object({ id: zId, scope: zAgentScope, target: z.string(), reason: z.string().nullable(), engagedAt: z.string() })),
});

export const zAgentTemplate = z.object({
  key: z.string(),
  module: z.string(),
  title: z.string(),
  roleKey: z.string(),
  maxRisk: zAgentRisk,
  dailyRunCap: z.number().int(),
  jobDescription: z.unknown(),
  // false: this deployment does not enable the template's module (CROVE_MODULES), so installing it answers MODULE_DISABLED.
  moduleEnabled: z.boolean(),
});

export const zAgentBudget = z.object({
  id: zId,
  scope: zAgentScope,
  target: z.string(),
  monthlyLimit: z.string(),
  warnPercent: z.number().int(),
  hardStop: z.boolean(),
  // What this month's runs it covers cost so far.
  spent: z.string(),
  updatedAt: z.string(),
});

export const zTask = z.object({
  id: zId,
  title: z.string(),
  kind: z.string(),
  status: zTaskStatus,
  assigneePositionId: zId.nullable(),
  parentTaskId: zId.nullable(),
  source: z.string(),
  sourceRef: z.unknown(),
  requestDepth: z.number().int(),
  // Made from untrusted content (an email, an AI run that read one).
  tainted: z.boolean(),
  createdByType: z.string(),
  due: z.string().nullable(),
  createdAt: z.string(),
});

export const zTaskDetail = z.object({
  task: zTask.extend({ description: z.string().nullable(), fence: z.string(), checkedOut: z.boolean() }),
  comments: z.array(z.object({ id: zId, body: z.string(), authorType: z.string(), authorId: zId.nullable(), tainted: z.boolean(), createdAt: z.string() })),
  // The proposal a review task is about, with what its deterministic checks found (null when none are readable).
  proposal: z.object({ id: zId, title: z.string(), status: z.string(), checks: z.array(zCheck).nullable() }).nullable(),
});

// ---------------------------------------------------------------------------------------------------------------------
// Crove Social (Social plan §3.3). The commands in @crove/mod-social check every input again, strictly: time zones
// (IANA names), channel rules and the choice of a time or the queue are checked there, not here.
// ---------------------------------------------------------------------------------------------------------------------

export const SOCIAL_VARIANT_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'rejected',
  'approved',
  'scheduled',
  'publishing',
  'processing',
  'published',
  'failed',
  'ambiguous',
  'needs_attention',
  'paused',
  'cancelled',
  // Taken down from its platform (#860).
  'removed',
] as const;
export const SOCIAL_POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled'] as const;
export const SOCIAL_DECISIONS = ['approved', 'changes_requested', 'rejected'] as const;
// The palette a label's colour comes from (#639).
export const SOCIAL_LABEL_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
// The corner of an image the org's logo watermark goes in (#834); the same list as crove_social.watermark's CHECK.
export const SOCIAL_WATERMARK_CORNERS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const;
// The org's team chat for Social alerts (#863): where it is, and the kinds of alert it may get; the same lists as
// crove_social.chat_alert's CHECKs.
export const SOCIAL_CHAT_ALERT_TARGETS = ['telegram', 'discord'] as const;
export const SOCIAL_CHAT_ALERT_KINDS = ['needs_approval', 'failed', 'published', 'client_answered'] as const;
// The stages of an idea on the ideas board (#701).
export const SOCIAL_IDEA_STAGES = ['new', 'planned', 'drafted', 'archived'] as const;

const zSocialText = z.string().max(100_000);
const zSocialTitle = z.string().max(500);
const zSocialLink = z.url({ protocol: /^https?$/ }).max(2000);
const zSocialSettings = z.record(z.string().max(100), z.json());
const zInstant = z.iso.datetime({ offset: true });

// A post's images in order (#372): files uploaded with purpose=social.
export const zSocialMediaInput = z.array(z.strictObject({ fileId: zId, altText: z.string().trim().max(1000).nullable().optional() })).max(20);
export const zSocialChannelInput = z.strictObject({
  connectionId: zId,
  body: zSocialText.nullable().optional(),
  title: zSocialTitle.nullable().optional(),
  linkUrl: zSocialLink.nullable().optional(),
  settings: zSocialSettings.optional(),
  // The channel's own images or video instead of the post's (#581).
  media: zSocialMediaInput.nullable().optional(),
});

export const zSocialMedia = z.object({ fileId: zId, altText: z.string().nullable(), mime: z.string(), sizeBytes: z.number().int(), durationMs: z.number().int().nullable(), width: z.number().int().nullable(), height: z.number().int().nullable() });

export const zSocialPostCreate = z.strictObject({
  body: zSocialText,
  title: zSocialTitle.nullable().optional(),
  linkUrl: zSocialLink.nullable().optional(),
  timeZone: z.string().min(1).max(64).optional(),
  scheduledAt: zInstant.nullable().optional(),
  media: zSocialMediaInput.optional(),
  channels: z.array(zSocialChannelInput).min(1).max(20),
  // The member accepted an AI rewrite into the text (#583): the post is tainted. Never cleared.
  aiAssisted: z.literal(true).optional(),
  // The idea the post is made from (#701): linked to it, its labels copied, moved to drafted.
  ideaId: zId.optional(),
});

export const zSocialPostUpdate = z.strictObject({
  postId: zId,
  revision: z.number().int().positive(),
  body: zSocialText.optional(),
  title: zSocialTitle.nullable().optional(),
  linkUrl: zSocialLink.nullable().optional(),
  timeZone: z.string().min(1).max(64).optional(),
  scheduledAt: zInstant.nullable().optional(),
  media: zSocialMediaInput.optional(),
  aiAssisted: z.literal(true).optional(),
});

export const zSocialVariantUpdate = z.strictObject({
  variantId: zId,
  revision: z.number().int().positive(),
  aiAssisted: z.literal(true).optional(),
  body: zSocialText.nullable().optional(),
  title: zSocialTitle.nullable().optional(),
  linkUrl: zSocialLink.nullable().optional(),
  settings: zSocialSettings.optional(),
  // The channel's own images or video (#581); null goes back to the post's.
  media: zSocialMediaInput.nullable().optional(),
});

export const zSocialDecide = z.strictObject({
  postId: zId,
  decision: z.enum(SOCIAL_DECISIONS),
  comment: z.string().trim().max(2000).optional(),
  variants: z
    .array(z.strictObject({ variantId: zId, revision: z.number().int().positive(), contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/) }))
    .min(1)
    .max(20),
});

export const zSocialSchedule = z.strictObject({
  postId: zId,
  variantIds: z.array(zId).min(1).max(20).optional(),
  at: zInstant.optional(),
  queue: z.literal(true).optional(),
  // A time per channel (#576), instead of variantIds and at.
  times: z
    .array(z.strictObject({ variantId: zId, at: zInstant }))
    .min(1)
    .max(20)
    .optional(),
});

export const zSocialQueueSet = z.strictObject({
  connectionId: zId,
  timeZone: z.string().min(1).max(64),
  paused: z.boolean().optional(),
  slots: z
    .array(z.strictObject({ weekday: z.number().int().min(1).max(7), minute: z.number().int().min(0).max(1439), label: z.string().trim().max(100).optional(), labelId: zId.nullable().optional() }))
    .max(100),
});

export const zSocialIssue = z.object({ code: z.string(), field: z.string(), limit: z.number().nullable(), actual: z.number().nullable() });

const zContent = z.object({ body: z.string(), title: z.string().nullable(), linkUrl: z.string().nullable() });

export const zSocialVariant = z.object({
  id: zId,
  connectionId: zId,
  provider: z.string(),
  position: z.number().int(),
  overrides: z.object({ body: z.string().nullable(), title: z.string().nullable(), linkUrl: z.string().nullable() }),
  // The channel keeps its own images or video (#581), not the post's.
  ownMedia: z.boolean(),
  effective: zContent,
  media: z.array(zSocialMedia),
  settings: z.record(z.string(), z.unknown()),
  revision: z.number().int(),
  contentHash: z.string(),
  status: z.enum(SOCIAL_VARIANT_STATUSES),
  effectiveAt: z.string().nullable(),
  queueSlotAt: z.string().nullable(),
  // The first comment of a published channel (#587): pending, posted, failed, unknown; null without one.
  commentStatus: z.enum(['pending', 'posted', 'failed', 'reconnect', 'unknown']).nullable(),
  // The thread of a published channel (#742): parts out (the post is one) of the total, and the next part's state.
  threadStatus: z.object({ state: z.enum(['pending', 'posted', 'failed', 'unknown']), posted: z.number().int().min(1), total: z.number().int().min(2) }).nullable(),
  // Waiting on a slot of a queue a person paused.
  queuePaused: z.boolean(),
  attempt: z.number().int(),
  externalUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  // Taken down from its platform (#860): when, who asked and why; removal: where an ask on a published channel stands.
  removedAt: z.string().nullable(),
  removedBy: zId.nullable(),
  removeReason: z.string().nullable(),
  removal: z.object({ state: z.enum(['pending', 'failed', 'unknown']), code: z.string().nullable() }).nullable(),
  error: z
    .object({ kind: z.string().nullable(), code: z.string().nullable(), action: z.string().nullable(), message: z.string().nullable(), retryAt: z.string().nullable() })
    .nullable(),
  issues: z.array(zSocialIssue),
  latestDecision: z
    .object({ decision: z.enum(SOCIAL_DECISIONS), comment: z.string().nullable(), decidedBy: zId, at: z.string(), revision: z.number().int(), current: z.boolean() })
    .nullable(),
  // Approvals the channel needs (S9) and who approved the current content in the open review round.
  // client: the channel also waits for the client's approval on a review link (#770); clientVerdict: the client's
  // standing answer for the content as it is now.
  review: z.object({ required: z.number().int(), approvedBy: z.array(zId), fourEyes: z.boolean(), client: z.boolean(), clientVerdict: z.enum(['approved', 'changes_requested']).nullable() }),
});

export const zSocialPost = z.object({
  id: zId,
  body: z.string(),
  title: z.string().nullable(),
  linkUrl: z.string().nullable(),
  media: z.array(zSocialMedia),
  evergreenDays: z.number().int().nullable(),
  repostOf: zId.nullable(),
  timeZone: z.string(),
  scheduledAt: z.string().nullable(),
  revision: z.number().int(),
  status: z.enum(SOCIAL_POST_STATUSES),
  origin: z.string(),
  tainted: z.boolean(),
  authorUserId: zId.nullable(),
  assigneeUserId: zId.nullable(),
  dueAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  variants: z.array(zSocialVariant),
  // The post's labels (#639), by label name.
  labelIds: z.array(zId),
  // The idea it was made from (#701); on a single post's read only.
  idea: z.object({ id: zId, title: z.string() }).nullable().optional(),
});

// The latest metrics of a published variant (S8): counts by normalized name; absent when the platform does not say.
// A media library item (S9): an image of the org uploaded for posts, how many posts show it and its tags (#904).
export const zSocialLibraryItem = z.object({ fileId: zId, filename: z.string(), mime: z.string(), sizeBytes: z.number().int(), durationMs: z.number().int().nullable(), width: z.number().int().nullable(), height: z.number().int().nullable(), createdAt: z.string(), usedIn: z.number().int(), tags: z.array(z.string()) });
// A tag of the library and how many files carry it (#904).
export const zSocialMediaTagCount = z.object({ tag: z.string(), files: z.number().int() });
// A saved snippet (#584): hashtags, a signature, or a whole post to start from (isTemplate).
export const zSocialSnippet = z.object({
  id: zId,
  name: z.string(),
  body: z.string(),
  provider: z.string().nullable(),
  isTemplate: z.boolean(),
  createdBy: zId,
  updatedAt: z.string(),
  mine: z.boolean(),
});
const zSnippetFields = { name: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(10_000), provider: z.string().min(1).max(32).nullable(), isTemplate: z.boolean() };
export const zSocialSnippetCreate = z.strictObject({ ...zSnippetFields, provider: zSnippetFields.provider.optional(), isTemplate: z.boolean().optional() });
export const zSocialSnippetUpdate = z.strictObject({ snippetId: zId, ...zSnippetFields });
// What works (#705): a group of a channel's posts and its median engagement against the channel's.
const zInsightGroup = z.object({ key: z.string(), posts: z.number().int(), median: z.number(), ratio: z.number().nullable() });
const zInsightPost = z.object({ variantId: zId, postId: zId, excerpt: z.string(), publishedAt: z.string().nullable(), externalUrl: z.string().nullable(), engagement: z.number() });
export const zSocialChannelInsights = z.object({
  connectionId: zId,
  provider: z.string(),
  posts: z.number().int(),
  median: z.number(),
  best: z.array(zInsightPost),
  worst: z.array(zInsightPost),
  byLabel: z.array(zInsightGroup),
  byFormat: z.array(zInsightGroup),
  byWeekday: z.array(zInsightGroup),
  byHour: z.array(zInsightGroup),
  byHashtag: z.array(zInsightGroup),
});
// An idea on the ideas board (#701), with the library files it still has.
export const zSocialIdea = z.object({
  id: zId,
  title: z.string(),
  note: z.string().nullable(),
  linkUrl: z.string().nullable(),
  media: z.array(z.object({ fileId: zId, mime: z.string(), sizeBytes: z.number().int(), durationMs: z.number().int().nullable(), width: z.number().int().nullable(), height: z.number().int().nullable() })),
  labelIds: z.array(zId),
  stage: z.enum(SOCIAL_IDEA_STAGES),
  postId: zId.nullable(),
  createdBy: zId,
  createdAt: z.string(),
  updatedAt: z.string(),
});
const zIdeaFields = {
  title: z.string().trim().min(1).max(200),
  note: z.string().max(5000).nullable().optional(),
  linkUrl: zSocialLink.nullable().optional(),
  fileIds: z.array(zId).max(10).optional(),
  labelIds: z.array(zId).max(10).optional(),
};
export const zSocialIdeaCreate = z.strictObject({ ...zIdeaFields, stage: z.enum(['new', 'planned']).optional() });
export const zSocialIdeaUpdate = z.strictObject({ ideaId: zId, ...zIdeaFields });
// An org's link-in-bio page (#707) and its clicks of the last 30 days, by button:<index> or post:<id>.
export const zSocialBioPage = z.object({
  id: zId,
  slug: z.string(),
  title: z.string(),
  about: z.string().nullable(),
  avatarFileId: zId.nullable(),
  buttons: z.array(z.object({ label: z.string(), url: z.string() })),
  showPosts: z.boolean(),
  published: z.boolean(),
  updatedAt: z.string(),
  clicks: z.record(z.string(), z.number()),
});
export const zSocialBioSave = z.strictObject({
  slug: z.string().trim().min(3).max(40),
  title: z.string().trim().min(1).max(100),
  about: z.string().max(300).nullable().optional(),
  avatarFileId: zId.nullable().optional(),
  buttons: z.array(z.strictObject({ label: z.string().trim().min(1).max(60), url: z.url({ protocol: /^https?$/ }).max(2000) })).max(12),
  showPosts: z.boolean(),
  published: z.boolean(),
});
// A blog feed an org drafts posts from (#708), and how its reads went.
export const zSocialFeed = z.object({
  id: zId,
  url: z.string(),
  title: z.string().nullable(),
  connectionIds: z.array(zId),
  paused: z.boolean(),
  failures: z.number().int(),
  lastCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  drafts: z.number().int(),
  createdAt: z.string(),
});
// A label for posts (#639) and how many posts carry it.
export const zSocialLabel = z.object({ id: zId, name: z.string(), color: z.enum(SOCIAL_LABEL_COLORS), createdBy: zId, postCount: z.number().int() });
const zLabelName = z.string().trim().min(1).max(50);
export const zSocialLabelCreate = z.strictObject({ name: zLabelName, color: z.enum(SOCIAL_LABEL_COLORS).optional() });
export const zSocialLabelUpdate = z.strictObject({ labelId: zId, name: zLabelName, color: z.enum(SOCIAL_LABEL_COLORS) });
// Client review links (#589): the team's view of a post's links and what clients said through them.
// A plan link (#902) the post is in is listed too, with the posts it covers and its own cap of answers per post.
export const zSocialReviewLinks = z.object({
  links: z.array(
    z.object({
      id: zId,
      kind: z.enum(['post', 'plan']),
      posts: z.number().int().min(1),
      answers: z.number().int().min(0),
      answersMax: z.number().int().min(1),
      createdBy: zId,
      createdAt: z.string(),
      expiresAt: z.string(),
      revokedAt: z.string().nullable(),
      changed: z.boolean(),
    }),
  ),
  feedback: z.array(
    z.object({ id: zId, linkId: zId, name: z.string(), verdict: z.enum(['approved', 'changes_requested', 'comment']), body: z.string().nullable(), changed: z.boolean(), createdAt: z.string() }),
  ),
});
// One client review link for a content plan (#902): the posts picked in the posts list, or those going out in a
// date range [from, to) on the chosen channels (none: all).
export const zSocialReviewPlanCreate = z.strictObject({
  postIds: z.array(zId).min(1).max(50).optional(),
  range: z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), connectionIds: z.array(zId).min(1).max(50).optional() }).optional(),
  days: z.number().int().min(1).max(30).optional(),
});
export const zSocialReviewPlanLink = z.object({
  id: zId,
  createdBy: zId,
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  posts: z.number().int().min(0),
  answered: z.number().int().min(0),
  gone: z.number().int().min(0),
});

// One entry of a post's timeline (#582): a comment, a decision, or what happened to the post or one of its channels.
export const zSocialActivityItem = z.object({
  id: z.string(),
  kind: z.enum(['created', 'comment', 'edited', 'channels_added', 'submitted', 'decision', 'scheduled', 'rescheduled', 'evergreen', 'published', 'failed', 'cancelled', 'auto_replied', 'auto_reply_failed', 'reposted', 'repost_failed', 'removed']),
  at: z.string(),
  userId: zId.nullable(),
  name: z.string().nullable(),
  variantId: zId.nullable(),
  body: z.string().nullable(),
  decision: z.string().nullable(),
  editedAt: z.string().nullable(),
  editable: z.boolean(),
  url: z.string().nullable(),
  code: z.string().nullable(),
});

export const zSocialLibraryUse = z.object({ postId: zId, status: z.string(), excerpt: z.string(), updatedAt: z.string() });

export const zSocialMetricsRow = z.object({
  variantId: zId,
  postId: zId,
  provider: z.string(),
  connectionId: zId,
  excerpt: z.string(),
  publishedAt: z.string().nullable(),
  externalUrl: z.string().nullable(),
  metrics: z.record(z.string(), z.number()),
  capturedAt: z.string().nullable(),
  // Clicks on its short link (#706); null when it went out without one.
  clicks: z.number().int().nullable(),
});

export const zSocialQueue = z.object({
  connectionId: zId,
  queueId: zId.nullable(),
  timeZone: z.string().nullable(),
  paused: z.boolean(),
  slots: z.array(z.object({ weekday: z.number().int(), minute: z.number().int(), label: z.string().nullable(), labelId: zId.nullable(), active: z.boolean() })),
  nextFree: z.array(z.string()),
});

// A client report link of a period (#643); its token is in the create answer only.
export const zSocialReportLink = z.object({
  id: zId,
  title: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  connectionIds: z.array(zId),
  createdBy: zId,
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});
export const zSocialReportLinkCreate = z.strictObject({
  periodStart: z.iso.datetime({ offset: true }),
  periodEnd: z.iso.datetime({ offset: true }),
  connectionIds: z.array(zId).max(50).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  days: z.number().int().min(1).max(90).optional(),
});

// A schedule that mails the client report (#704), with its latest sends and each mail's delivery status.
export const zSocialReportSchedule = z.object({
  id: zId,
  name: z.string(),
  cadence: z.enum(['weekly', 'monthly']),
  weekday: z.number().int().nullable(),
  monthDay: z.number().int().nullable(),
  sendHour: z.number().int(),
  timeZone: z.string(),
  period: z.enum(['previous_week', 'previous_month', 'last_7_days', 'last_30_days']),
  connectionIds: z.array(zId),
  recipients: z.array(z.string()),
  paused: z.boolean(),
  nextRunAt: z.string(),
  lastRunAt: z.string().nullable(),
  runs: z.array(
    z.object({
      id: zId,
      kind: z.enum(['scheduled', 'test']),
      periodStart: z.string(),
      periodEnd: z.string(),
      createdAt: z.string(),
      mails: z.array(z.object({ to: z.string().nullable(), status: z.string(), errorCode: z.string().nullable() })),
    }),
  ),
});
export const zSocialReportScheduleSave = z.strictObject({
  scheduleId: zId.optional(),
  name: z.string().trim().min(1).max(120),
  cadence: z.enum(['weekly', 'monthly']),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  monthDay: z.number().int().min(1).max(28).nullable().optional(),
  sendHour: z.number().int().min(0).max(23),
  timeZone: z.string().min(1).max(64),
  period: z.enum(['previous_week', 'previous_month', 'last_7_days', 'last_30_days']),
  connectionIds: z.array(zId).max(50),
  recipients: z.array(z.email().max(320)).min(1).max(10),
  paused: z.boolean().optional(),
});

// A link's preview card (#641): pending until the worker read the page; failed with why.
export const zSocialLinkPreview = z.object({
  url: z.string(),
  status: z.enum(['pending', 'ready', 'failed']),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteName: z.string().nullable(),
  error: z.string().nullable(),
  fetchedAt: z.string().nullable(),
});

// In-app notifications (#637): the viewer's newest, how many are unread, and the kinds they turned off.
export const SOCIAL_NOTIFICATION_KINDS = ['review_requested', 'decided', 'failed', 'needs_attention', 'channel_expired', 'comment', 'client_answer', 'assigned', 'review_reminder', 'feed_paused', 'mention'] as const;
export const zSocialNotificationKind = z.enum(SOCIAL_NOTIFICATION_KINDS);
export const zSocialNotifications = z.object({
  items: z.array(
    z.object({
      id: zId,
      kind: zSocialNotificationKind,
      postId: zId.nullable(),
      postText: z.string().nullable(),
      connectionId: zId.nullable(),
      channel: z.string().nullable(),
      actorName: z.string().nullable(),
      detail: z.record(z.string(), z.string()),
      createdAt: z.string(),
      read: z.boolean(),
    }),
  ),
  unread: z.number().int(),
  muted: z.array(zSocialNotificationKind),
  // Social emails turned off by the viewer (#579).
  mailOff: z.boolean(),
});

// A channel's daily account snapshots (#645), oldest first.
export const zSocialAccountTrend = z.object({
  connectionId: zId,
  provider: z.string(),
  points: z.array(z.object({ day: z.string(), followers: z.number().int().nullable(), reach: z.number().int().nullable() })),
});
