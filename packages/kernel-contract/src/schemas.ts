import { z } from 'zod';
import { ACCOUNT_CODE_PATTERN } from './accounts.ts';

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
// A TT133 account code or one of the org's sub-accounts (11211, 1121.VCB; see accounts.ts).
export const zAccountCode = z.string().regex(ACCOUNT_CODE_PATTERN);
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
  // Messages to the org's addresses retired in the last 30 days that were dropped (#139); null when inboundAddress is.
  inboundDroppedCount: z.number().int().nonnegative().nullable(),
  members: z.array(z.object({ userId: zId, email: z.string(), displayName: z.string().nullable(), role: zRole })),
});

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

export const zInvite = z.object({
  id: zId,
  email: z.string(),
  role: zInviteRole,
  status: zInviteStatus,
  invitedBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
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
export const OAUTH_CHANNEL_PROVIDERS = ['facebook_page', 'instagram'] as const;
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
  // Parsed by kind: a purchase (kind finance.purchase) or a reversal (kind finance.journal_reversal); the other is null.
  payload: zPurchaseProposal.nullable(),
  reversal: zJournalReversal.nullable(),
  error: z.string().nullable(),
  file: z.object({ id: zId, filename: z.string(), contentType: z.string(), sizeBytes: z.string() }).nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  // A purchase returns its document; a reversal returns the entry it reversed and, for a purchase entry, the
  // document it voided (#165).
  result: z
    .object({ documentId: zId.optional(), journalEntryId: zId, reversedEntryId: zId.optional(), voidedDocumentId: zId.optional() })
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
  status: z.enum(['processing', 'proposed', 'failed', 'duplicate']),
  // The newest run's error, when that run failed.
  error: z.string().nullable(),
  proposalId: zId.nullable(),
  // The newest extraction run's number (1 for the first read), null while the file has not been read yet.
  version: z.number().int().nullable(),
  canReextract: z.boolean(),
  createdAt: z.string(),
});

export const zParty = z.object({
  id: zId,
  name: z.string(),
  taxCode: z.string().nullable(),
  address: z.string().nullable(),
  documentCount: z.number().int(),
  // The debit account proposed first for this vendor's invoices (set by approving one, or by hand), or null.
  defaultAccount: z.string().nullable(),
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
    .object({ id: zId, series: z.string(), number: z.string(), issueDate: zLocalDate, partyName: z.string(), voided: z.boolean() })
    .optional(),
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
export const VAT_PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2]|Q[1-4])$/;
export const zVatPeriod = z.string().regex(VAT_PERIOD_PATTERN, 'YYYY-MM or YYYY-Qn');
export const VAT_RATES = ['0', '5', '8', '10', 'KCT', 'KKKNT', 'other'] as const;
export const zVatRate = z.enum(VAT_RATES);
export const VAT_WARNINGS = ['rate_unknown', 'rate_split', 'reduced_rate_outside_period', 'lines_mismatch'] as const;
export const zVatWarning = z.enum(VAT_WARNINGS);
const zRateAmounts = z.object({ rate: zVatRate, taxable: zMoney, vat: zMoney });
export const zVatInvoice = z.object({
  id: zId,
  issueDate: zLocalDate,
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
] as const;
export const SOCIAL_POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled'] as const;
export const SOCIAL_DECISIONS = ['approved', 'changes_requested', 'rejected'] as const;

const zSocialText = z.string().max(100_000);
const zSocialTitle = z.string().max(500);
const zSocialLink = z.url({ protocol: /^https?$/ }).max(2000);
const zSocialSettings = z.record(z.string().max(100), z.json());
const zInstant = z.iso.datetime({ offset: true });

export const zSocialChannelInput = z.strictObject({
  connectionId: zId,
  body: zSocialText.nullable().optional(),
  title: zSocialTitle.nullable().optional(),
  linkUrl: zSocialLink.nullable().optional(),
  settings: zSocialSettings.optional(),
});

// A post's images in order (#372): files uploaded with purpose=social.
export const zSocialMediaInput = z.array(z.strictObject({ fileId: zId, altText: z.string().trim().max(1000).nullable().optional() })).max(20);
export const zSocialMedia = z.object({ fileId: zId, altText: z.string().nullable(), mime: z.string(), sizeBytes: z.number().int() });

export const zSocialPostCreate = z.strictObject({
  body: zSocialText,
  title: zSocialTitle.nullable().optional(),
  linkUrl: zSocialLink.nullable().optional(),
  timeZone: z.string().min(1).max(64).optional(),
  scheduledAt: zInstant.nullable().optional(),
  media: zSocialMediaInput.optional(),
  channels: z.array(zSocialChannelInput).min(1).max(20),
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
});

export const zSocialVariantUpdate = z.strictObject({
  variantId: zId,
  revision: z.number().int().positive(),
  body: zSocialText.nullable().optional(),
  title: zSocialTitle.nullable().optional(),
  linkUrl: zSocialLink.nullable().optional(),
  settings: zSocialSettings.optional(),
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
});

export const zSocialQueueSet = z.strictObject({
  connectionId: zId,
  timeZone: z.string().min(1).max(64),
  paused: z.boolean().optional(),
  slots: z
    .array(z.strictObject({ weekday: z.number().int().min(1).max(7), minute: z.number().int().min(0).max(1439), label: z.string().trim().max(100).optional() }))
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
  effective: zContent,
  media: z.array(zSocialMedia),
  settings: z.record(z.string(), z.unknown()),
  revision: z.number().int(),
  contentHash: z.string(),
  status: z.enum(SOCIAL_VARIANT_STATUSES),
  effectiveAt: z.string().nullable(),
  queueSlotAt: z.string().nullable(),
  attempt: z.number().int(),
  externalUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  error: z
    .object({ kind: z.string().nullable(), code: z.string().nullable(), action: z.string().nullable(), message: z.string().nullable(), retryAt: z.string().nullable() })
    .nullable(),
  issues: z.array(zSocialIssue),
  latestDecision: z
    .object({ decision: z.enum(SOCIAL_DECISIONS), comment: z.string().nullable(), decidedBy: zId, at: z.string(), revision: z.number().int(), current: z.boolean() })
    .nullable(),
});

export const zSocialPost = z.object({
  id: zId,
  body: z.string(),
  title: z.string().nullable(),
  linkUrl: z.string().nullable(),
  media: z.array(zSocialMedia),
  timeZone: z.string(),
  scheduledAt: z.string().nullable(),
  revision: z.number().int(),
  status: z.enum(SOCIAL_POST_STATUSES),
  origin: z.string(),
  tainted: z.boolean(),
  authorUserId: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  variants: z.array(zSocialVariant),
});

export const zSocialQueue = z.object({
  connectionId: zId,
  queueId: zId.nullable(),
  timeZone: z.string().nullable(),
  paused: z.boolean(),
  slots: z.array(z.object({ weekday: z.number().int(), minute: z.number().int(), label: z.string().nullable(), active: z.boolean() })),
  nextFree: z.array(z.string()),
});
