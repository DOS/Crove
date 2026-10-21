// Kysely types for the Crove schemas: the types generated from the migrated database (./generated/database.ts,
// `pnpm db:types`, issue #48) with the refinements the catalog cannot express, such as CHECK-constraint unions and
// columns only a trigger or a definer writes. numeric, int8 and date columns are strings (see the pool type parsers);
// timestamptz is Date.
//
// The generated Database holds only the tables crove_tenant may read. crove_kernel.user_account (identity) and the
// other control-plane tables (plan §3.6, Decision 14) have no Kysely type on purpose: tenant code reaches them only
// through definers (crove_kernel.member_profiles, identity_resolve, my_orgs and the like), so a direct selectFrom does
// not compile. The invariant test control-plane-reads.test.ts catches raw SQL.
import type { ColumnType, Generated, InsertType, SelectType, UpdateType } from 'kysely';
import type * as G from './generated/database.ts';

// A refinement narrows what a column holds (a CHECK-constraint union) or restricts how it is written (never, insert
// only); it never contradicts the database. Each refined column must exist in the generated table, its select type
// must fit the generated one, it is nullable exactly when the column is, and it is optional on insert only when the
// column has a default or is nullable, unless the column is listed as assigned by a trigger (the third parameter).
// A migration that renames, retypes, changes the nullability or drops the default of a refined column fails
// typecheck here until the refinement follows (the default check means little for a column crove_tenant may not
// insert, whose insert type is undefined). The generated write types follow crove_tenant's privileges (issue #266):
// a column the role may not insert or update has the write type G.NotGranted there, which a refinement keeps
// whatever it says, so a refinement cannot make a forbidden write compile; a refinement's never is treated the same.
//
// Each CHECK-constraint union is a const array below with the type derived from it; check-unions.db.test.ts
// compares every such array with the values its CHECK constraint allows on a freshly migrated database, and fails
// when a migration widens or narrows the constraint without the union following.

// Kysely lets an insert omit a column whose insert type takes undefined or null.
type Optional<T> = undefined extends T ? true : null extends T ? true : false;
type NullMismatch<Column, Refined> = unknown extends SelectType<Column> // json: null is part of unknown
  ? never
  : null extends SelectType<Column>
    ? null extends SelectType<Refined>
      ? never
      : 'the column is nullable in the database'
    : never;
type DefaultMismatch<Column, Refined, ByTrigger extends boolean> = Optional<InsertType<Refined>> extends true
  ? Optional<InsertType<Column>> extends true
    ? never
    : ByTrigger extends true
      ? never
      : 'the column has no default in the database (list it as assigned by a trigger if one sets it)'
  : never;
type Mismatch<Column, Refined, ByTrigger extends boolean> = [SelectType<Refined>] extends [SelectType<Column>]
  ? NullMismatch<Column, Refined> | DefaultMismatch<Column, Refined, ByTrigger>
  : 'the select type does not fit the database column';
type Refinement<Table, R, ByTrigger> = {
  [K in keyof R]: K extends keyof Table
    ? [Mismatch<Table[K], R[K], K extends ByTrigger ? true : false>] extends [never]
      ? R[K]
      : Mismatch<Table[K], R[K], K extends ByTrigger ? true : false>
    : 'not a column of the generated table';
};
// The refined column under the generated column's privileges: an insert or update crove_tenant is not granted
// (G.NotGranted) stays NotGranted whatever the refinement says, and a refinement's never becomes NotGranted too
// (Kysely drops a never column, so an object carrying it, or a table left with no writable column, would pass).
type WriteType<Column, Refined> = [Column] extends [G.NotGranted] ? G.NotGranted : [Refined] extends [never] ? G.NotGranted : Refined;
type Granted<Column, Refined> = ColumnType<
  SelectType<Refined>,
  WriteType<InsertType<Column>, InsertType<Refined>>,
  WriteType<UpdateType<Column>, UpdateType<Refined>>
>;
export type Refine<Table, R extends Refinement<Table, R, ByTrigger>, ByTrigger extends keyof R = never> = {
  [K in keyof Table]: K extends keyof R ? Granted<Table[K], R[K]> : Table[K];
};
type Tables<R extends { [K in keyof R]: K extends keyof G.Database ? unknown : 'not a table of the generated Database' }> = R;

export const MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const ACTOR_TYPES = ['user', 'system', 'agent'] as const;
type ActorType = (typeof ACTOR_TYPES)[number];

export const TENANT_STATUSES = ['active', 'offboarding', 'closed'] as const;
// How often the org files its VAT return (issue #318); null until an owner or admin chooses.
export const VAT_FILING_PERIODS = ['month', 'quarter'] as const;

export type TenantTable = Refine<
  G.KernelTenantTable,
  {
    // 'offboarding': only owners may enter (kernel.org.offboard, issue #38); 'closed' is set by staff.
    status: Generated<(typeof TENANT_STATUSES)[number]>;
    vat_filing_period: (typeof VAT_FILING_PERIODS)[number] | null;
    // inbound_token is the active inbound token. Every token ever issued, retired ones included, is in
    // crove_kernel.inbound_address, which only definers read and write; rotation is the command kernel.inbound.rotate.
  }
>;

export type TenantMemberTable = Refine<G.KernelTenantMemberTable, { role: MemberRole }>;

// A pending, accepted or revoked invite (issue #35). Tenant roles insert invites and may only set status,
// revoked_at and revoked_by; crove_kernel.invite_accept() is the only writer of accepted_at and accepted_by.
export const INVITE_ROLES = ['admin', 'member', 'viewer'] as const;
export const INVITE_STATUSES = ['pending', 'accepted', 'revoked'] as const;
export type MemberInviteTable = Refine<
  G.KernelMemberInviteTable,
  {
    role: (typeof INVITE_ROLES)[number];
    token_sha256: string;
    status: Generated<(typeof INVITE_STATUSES)[number]>;
    expires_at: ColumnType<Date, Date | string, Date | string>;
    accepted_at: ColumnType<Date | null, never, never>;
    accepted_by: ColumnType<string | null, never, never>;
  }
>;

export const AUDIT_OUTCOMES = ['ok', 'pending_approval', 'denied', 'failed'] as const;

export type AuditEventTable = Refine<
  G.KernelAuditEventTable,
  {
    actor_type: ActorType;
    outcome: (typeof AUDIT_OUTCOMES)[number];
  }
>;

export const PARTY_KINDS = ['organization', 'person'] as const;
export const PARTY_SOURCE_TRUSTS = ['external', 'user', 'system'] as const;

export type PartyTable = Refine<
  G.KernelPartyTable,
  {
    kind: Generated<(typeof PARTY_KINDS)[number]>;
    source_trust: Generated<(typeof PARTY_SOURCE_TRUSTS)[number]>;
  }
>;

// generation is the object version the bytes were written as (ADR-0013); null only on rows from before it.
// A file row never changes, for every role (trigger file_guard; a move to another org is refused by RLS): crove_tenant
// keeps UPDATE only to lock the row (SELECT ... FOR UPDATE), so no column has an update type here.
// social: an image uploaded for a Social post (#372); import: a spreadsheet for a module's import (#465). Neither is
// extracted or shown in the Inbox.
export const FILE_SOURCES = ['upload', 'email', 'social', 'import'] as const;
type Frozen<T> = ColumnType<SelectType<T>, InsertType<T>, G.NotGranted>;
export type FileTable = Refine<
  G.KernelFileTable,
  { [K in Exclude<keyof G.KernelFileTable, 'source'>]: Frozen<G.KernelFileTable[K]> } & { source: Frozen<(typeof FILE_SOURCES)[number]> }
>;

// archive: a ZIP whose entries were filed as files of their own (#314); such a run never has a proposal.
export const EXTRACTION_METHODS = ['einvoice_xml', 'pdf_text_ai', 'image_ai', 'unsupported', 'archive'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const EXTRACTION_STATUSES = ['pending', 'done', 'failed'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

// requested_by is the user who asked for a re-extraction; NULL for the first extraction.
export type ExtractionTable = Refine<
  G.KernelExtractionTable,
  {
    // NULL only while a re-extraction is pending (or for one that timed out before it was read).
    method: ExtractionMethod | null;
    status: ExtractionStatus;
    // 1, 2, 3, ... per file; assigned by the database on insert (trigger extraction_assign_version).
    version: Generated<number>;
    // How many entries an archive run's result lists (#432); NULL for every other run. Set by the database from the
    // result on every insert and update (trigger extraction_entry_count), never by the code.
    entry_count: ColumnType<number | null, never, never>;
  },
  'version'
>;

// 'approved' exists only inside the transaction of kernel.proposal.approve today: it marks the proposal approved for
// its command while that command runs (the runtime's proposal state gate), and the same transaction ends 'executed'.
export const PROPOSAL_STATUSES = ['pending', 'approved', 'executed', 'rejected', 'failed'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

// eligible_approvers is set on every new proposal; NULL only on proposals decided before the approval policy existed.
export type ProposalTable = Refine<G.KernelProposalTable, { status: Generated<ProposalStatus> }>;

// ADR-0029 Phase 1 (issue #79): agents in an org chart shared with humans. See the migration
// 20261018050000_crove_kernel_agents_org_chart.sql for the rules the database enforces.
export const AGENT_RISKS = ['R0', 'R1', 'R2'] as const;
export type AgentRisk = (typeof AGENT_RISKS)[number];

export type AgentTemplateTable = Refine<
  G.KernelAgentTemplateTable,
  {
    max_risk: AgentRisk;
    subscribes: string[];
    daily_run_cap: number;
  }
>;

export const AGENT_STATUSES = ['active', 'paused', 'retired'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const AGENT_RUNTIMES = ['builtin', 'external'] as const;

export type AgentTable = Refine<
  G.KernelAgentTable,
  {
    runtime: Generated<(typeof AGENT_RUNTIMES)[number]>;
    status: Generated<AgentStatus>;
    max_risk: Generated<AgentRisk>;
  }
>;

export const POSITION_STATUSES = ['active', 'paused', 'archived'] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

export type PositionTable = Refine<G.KernelPositionTable, { status: Generated<PositionStatus> }>;

export const AI_RUN_STATUSES = ['running', 'succeeded', 'failed', 'expired', 'cancelled'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

export type AiRunTable = Refine<G.KernelAiRunTable, { status: Generated<AiRunStatus> }>;

export const TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_KINDS = ['general', 'proposal_review', 'escalation', 'delegation'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_SOURCES = ['event', 'proposal', 'human', 'schedule'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export type TaskTable = Refine<
  G.KernelTaskTable,
  {
    kind: Generated<TaskKind>;
    source: TaskSource;
    // Stamped from the context by a trigger, with created_by_id and created_by_run.
    created_by_type: ActorType;
    status: Generated<TaskStatus>;
    fence: ColumnType<string, string | number | undefined, string | number>;
  }
>;

export type TaskCommentTable = Refine<
  G.KernelTaskCommentTable,
  {
    // Stamped from the context by a trigger, with author_id and run_id.
    author_type: ActorType;
  }
>;

export const CHANNEL_CONNECTION_STATUSES = ['active', 'expired', 'revoked', 'error'] as const;
export type ChannelConnectionStatus = (typeof CHANNEL_CONNECTION_STATUSES)[number];

// A connected social or messaging account (ADR-0025). Its sealed tokens live in crove_kernel.credential, which has
// no Kysely type: only the credential_* definers reach it.
export type ChannelConnectionTable = Refine<G.KernelChannelConnectionTable, { status: Generated<ChannelConnectionStatus> }>;

// The ledger of visible calls to outside services (Social plan §3.4): a call is recorded as started before it is made.
export const EXTERNAL_CALL_STATES = ['started', 'succeeded', 'failed', 'ambiguous'] as const;
export type ExternalCallState = (typeof EXTERNAL_CALL_STATES)[number];
export const EXTERNAL_CALL_RETRY_SAFETIES = ['safe', 'idempotent', 'reconcile_only', 'never'] as const;
export const EXTERNAL_CALL_ERROR_KINDS = ['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown'] as const;
export type ExternalCallTable = Refine<
  G.KernelExternalCallTable,
  {
    retry_safety: (typeof EXTERNAL_CALL_RETRY_SAFETIES)[number];
    state: Generated<ExternalCallState>;
    error_kind: (typeof EXTERNAL_CALL_ERROR_KINDS)[number] | null;
  }
>;

// Outbound mail (Email plan §3.2-3.3, #538): one row per mail, and the addresses an org must not mail.
export const MAIL_STREAMS = ['system', 'transactional', 'marketing'] as const;
export const MAIL_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'ambiguous'] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];
export type MailMessageTable = Refine<
  G.KernelMailMessageTable,
  { stream: (typeof MAIL_STREAMS)[number]; status: Generated<MailStatus> }
>;
export const MAIL_SUPPRESSION_SCOPES = ['all', 'marketing'] as const;
export const MAIL_SUPPRESSION_REASONS = ['hard_bounce', 'complaint', 'unsubscribe_all', 'manual', 'provider'] as const;
export type MailSuppressionTable = Refine<
  G.KernelMailSuppressionTable,
  { scope: (typeof MAIL_SUPPRESSION_SCOPES)[number]; reason: (typeof MAIL_SUPPRESSION_REASONS)[number] }
>;
// Delivery events from the mail provider (Email plan §3.3, #539), one row per provider event.
export const MAIL_EVENT_KINDS = ['delivered', 'deferred', 'bounce_hard', 'bounce_soft', 'complaint'] as const;
export type MailEventTable = Refine<G.KernelMailEventTable, { kind: (typeof MAIL_EVENT_KINDS)[number] }>;

export const AGENT_WAKEUP_STATUSES = ['pending', 'claimed', 'done'] as const;
export type AgentWakeupTable = Refine<G.KernelAgentWakeupTable, { status: Generated<(typeof AGENT_WAKEUP_STATUSES)[number]> }>;

export const AGENT_SCOPES = ['org', 'module', 'agent'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export type KillSwitchTable = Refine<G.KernelKillSwitchTable, { scope: AgentScope }>;

export type BudgetPolicyTable = Refine<G.KernelBudgetPolicyTable, { scope: AgentScope }>;

// A purchase (the org bought; party_id is the seller) or a sale (the org issued the invoice; party_id is the
// customer), issue #313. Both live in purchase_document; the table keeps its name.
export const DOCUMENT_DIRECTIONS = ['purchase', 'sale'] as const;
export type DocumentDirection = (typeof DOCUMENT_DIRECTIONS)[number];

export type PurchaseDocumentTable = Refine<
  G.FinancePurchaseDocumentTable,
  {
    // The voided document of the same invoice that this one replaces (#165), or null for the first one.
    replaces_document_id: ColumnType<string | null, string | null | undefined, never>;
    direction: ColumnType<DocumentDirection, DocumentDirection | undefined, never>;
  }
>;

// Entries are written only by crove_finance.post_journal_entry().
export type JournalEntryTable = Refine<
  G.FinanceJournalEntryTable,
  {
    // xid8 stamped by a trigger.
    created_xact_id: ColumnType<string | null, never, never>;
    // Start of that transaction, stamped by the same trigger: xid8 alone repeats after a logical restore.
    created_xact_start: ColumnType<Date | null, never, never>;
    // The entry this one reverses (its mirror), or null; set only by the posting function.
    reverses_entry_id: ColumnType<string | null, never, never>;
  }
>;

// An org's sub-accounts under the TT133 chart (#319). The insert trigger fills root_code (the TT133 account the code
// rolls up to) and makes every new sub-account active; code, parent and root never change.
export type OrgAccountTable = Refine<
  G.FinanceOrgAccountTable,
  {
    root_code: ColumnType<string, never, never>;
    active: ColumnType<boolean, never, boolean>;
  },
  'root_code'
>;

// Cash and bank vouchers (#327): phiếu thu, phiếu chi, giấy báo Có, giấy báo Nợ. The insert trigger numbers each one
// per org and type (any number given is replaced), and rows never change.
export const VOUCHER_TYPES = ['cash_receipt', 'cash_payment', 'bank_credit', 'bank_debit'] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];
export type CashVoucherTable = Refine<
  G.FinanceCashVoucherTable,
  {
    voucher_type: ColumnType<VoucherType, VoucherType, never>;
    number: ColumnType<number, never, never>;
  },
  'number'
>;

// The tax portal's purchase-invoice lists (#465). A list starts pending; the insert trigger stamps created_at and the
// update trigger stamps recorded_at and removed_at with the database clock. Rows are append-only.
export const PORTAL_LIST_STATUSES = ['pending', 'done', 'failed'] as const;
export const PORTAL_INVOICE_STATUSES = ['original', 'replacement', 'adjustment', 'replaced', 'adjusted', 'cancelled', 'unknown'] as const;

export type PortalInvoiceListTable = Refine<
  G.FinancePortalInvoiceListTable,
  {
    status: ColumnType<(typeof PORTAL_LIST_STATUSES)[number], (typeof PORTAL_LIST_STATUSES)[number] | undefined, (typeof PORTAL_LIST_STATUSES)[number]>;
  }
>;

export type PortalInvoiceRowTable = Refine<G.FinancePortalInvoiceRowTable, { status: ColumnType<(typeof PORTAL_INVOICE_STATUSES)[number], (typeof PORTAL_INVOICE_STATUSES)[number], never> }>;

// Crove Social (Social plan §3.2, S3).
export const SOCIAL_POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled'] as const;
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
export const SOCIAL_ORIGINS = ['human', 'ai'] as const;
export const SOCIAL_ACTOR_ORIGINS = ['ui', 'api', 'mcp', 'agent', 'system'] as const;
export const SOCIAL_DECISIONS = ['approved', 'changes_requested', 'rejected'] as const;
// What a client said through a review link (#589): a signal for the team, never an approval.
export const SOCIAL_REVIEW_VERDICTS = ['approved', 'changes_requested', 'comment'] as const;
// A review link of one post (#589), or of a content plan's posts (#902).
export const SOCIAL_REVIEW_LINK_KINDS = ['post', 'plan'] as const;
// What an in-app notification is about (#637); a member may turn each kind off.
export const SOCIAL_NOTIFICATION_KINDS = ['review_requested', 'decided', 'failed', 'needs_attention', 'channel_expired', 'comment', 'client_answer', 'assigned', 'review_reminder', 'feed_paused', 'mention'] as const;
// Why a channel's daily account snapshot has no counts (#645).
export const SOCIAL_ACCOUNT_SNAPSHOT_ERRORS = ['no_answer', 'token_expired', 'permission'] as const;
export const SOCIAL_ERROR_KINDS = ['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown'] as const;
// A link preview card (#641): waiting for the worker, read, or not readable and why.
export const SOCIAL_LINK_PREVIEW_STATUSES = ['pending', 'ready', 'failed'] as const;
export const SOCIAL_LINK_PREVIEW_ERRORS = ['invalid_url', 'blocked', 'dns', 'timeout', 'too_large', 'redirects', 'encoding', 'network', 'http', 'not_html'] as const;
export type SocialLinkPreviewStatus = (typeof SOCIAL_LINK_PREVIEW_STATUSES)[number];
export type SocialLinkPreviewError = (typeof SOCIAL_LINK_PREVIEW_ERRORS)[number];
// The palette a label's colour comes from (#639); the app maps each name to a theme tone.
export const SOCIAL_LABEL_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
// The corner of an image the org's logo watermark goes in (#834).
export const SOCIAL_WATERMARK_CORNERS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const;
// The org's team chat for Social alerts (#863): where it is, and the kinds of alert it may get.
export const SOCIAL_CHAT_ALERT_TARGETS = ['telegram', 'discord'] as const;
export const SOCIAL_CHAT_ALERT_KINDS = ['needs_approval', 'failed', 'published', 'client_answered'] as const;
// The stages of an idea on the ideas board (#701).
export const SOCIAL_IDEA_STAGES = ['new', 'planned', 'drafted', 'archived'] as const;
// Scheduled client report mail (#704): how often, the period each mail covers, and a run's kind.
export const SOCIAL_REPORT_CADENCES = ['weekly', 'monthly'] as const;
export const SOCIAL_REPORT_PERIODS = ['previous_week', 'previous_month', 'last_7_days', 'last_30_days'] as const;
export const SOCIAL_REPORT_RUN_KINDS = ['scheduled', 'test'] as const;
export type SocialVariantStatus = (typeof SOCIAL_VARIANT_STATUSES)[number];
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];
export type SocialActorOrigin = (typeof SOCIAL_ACTOR_ORIGINS)[number];
export type SocialDecision = (typeof SOCIAL_DECISIONS)[number];
export type SocialReviewVerdict = (typeof SOCIAL_REVIEW_VERDICTS)[number];
export type SocialReviewLinkKind = (typeof SOCIAL_REVIEW_LINK_KINDS)[number];
export type SocialAccountSnapshotError = (typeof SOCIAL_ACCOUNT_SNAPSHOT_ERRORS)[number];
export type SocialNotificationKind = (typeof SOCIAL_NOTIFICATION_KINDS)[number];
export type SocialLabelColor = (typeof SOCIAL_LABEL_COLORS)[number];
export type SocialIdeaStage = (typeof SOCIAL_IDEA_STAGES)[number];
export type SocialWatermarkCorner = (typeof SOCIAL_WATERMARK_CORNERS)[number];
export type SocialChatAlertTarget = (typeof SOCIAL_CHAT_ALERT_TARGETS)[number];
export type SocialChatAlertKind = (typeof SOCIAL_CHAT_ALERT_KINDS)[number];
export type SocialReportCadence = (typeof SOCIAL_REPORT_CADENCES)[number];
export type SocialReportPeriod = (typeof SOCIAL_REPORT_PERIODS)[number];
export type SocialReportRunKind = (typeof SOCIAL_REPORT_RUN_KINDS)[number];

export type SocialPostTable = Refine<
  G.SocialPostTable,
  {
    origin: Generated<(typeof SOCIAL_ORIGINS)[number]>;
    actor_origin: Generated<SocialActorOrigin>;
    status: Generated<SocialPostStatus>;
  }
>;
export type SocialPostVariantTable = Refine<
  G.SocialPostVariantTable,
  {
    status: Generated<SocialVariantStatus>;
    error_kind: (typeof SOCIAL_ERROR_KINDS)[number] | null;
  }
>;
export type SocialReviewFeedbackTable = Refine<G.SocialReviewFeedbackTable, { verdict: ColumnType<SocialReviewVerdict, never, never> }>;
export type SocialReviewLinkTable = Refine<G.SocialReviewLinkTable, { kind: ColumnType<SocialReviewLinkKind, SocialReviewLinkKind | undefined, never> }>;
export type SocialAccountSnapshotTable = Refine<G.SocialAccountSnapshotTable, { error: ColumnType<SocialAccountSnapshotError | null, SocialAccountSnapshotError | null | undefined, never> }>;
export type SocialLinkPreviewTable = Refine<
  G.SocialLinkPreviewTable,
  {
    status: ColumnType<SocialLinkPreviewStatus, SocialLinkPreviewStatus, SocialLinkPreviewStatus>;
    error: ColumnType<SocialLinkPreviewError | null, SocialLinkPreviewError | null | undefined, SocialLinkPreviewError | null>;
  }
>;
export type SocialNotificationTable = Refine<G.SocialNotificationTable, { kind: ColumnType<SocialNotificationKind, SocialNotificationKind, never> }>;
export type SocialNotificationMuteTable = Refine<G.SocialNotificationMuteTable, { kind: ColumnType<SocialNotificationKind, SocialNotificationKind, never> }>;
export type SocialCalendarNoteTable = Refine<G.SocialCalendarNoteTable, { color: Generated<SocialLabelColor> }>;
export type SocialWatermarkTable = Refine<G.SocialWatermarkTable, { corner: SocialWatermarkCorner }>;
export type SocialChatAlertTable = Refine<G.SocialChatAlertTable, { kind: SocialChatAlertTarget; events: SocialChatAlertKind[] }>;
export type SocialLabelTable = Refine<G.SocialLabelTable, { color: Generated<SocialLabelColor> }>;
export type SocialIdeaTable = Refine<G.SocialIdeaTable, { stage: Generated<SocialIdeaStage> }>;
export type SocialReportScheduleTable = Refine<G.SocialReportScheduleTable, { cadence: SocialReportCadence; period: SocialReportPeriod }>;
export type SocialReportScheduleRunTable = Refine<G.SocialReportScheduleRunTable, { kind: SocialReportRunKind }>;

export type SocialPostApprovalTable = Refine<
  G.SocialPostApprovalTable,
  {
    decision: ColumnType<SocialDecision, SocialDecision, never>;
    actor_origin: ColumnType<SocialActorOrigin, SocialActorOrigin | undefined, never>;
  }
>;

type Refined = Tables<{
  'crove_kernel.tenant': TenantTable;
  'crove_kernel.tenant_member': TenantMemberTable;
  'crove_kernel.member_invite': MemberInviteTable;
  'crove_kernel.audit_event': AuditEventTable;
  'crove_kernel.party': PartyTable;
  'crove_kernel.file': FileTable;
  'crove_kernel.extraction': ExtractionTable;
  'crove_kernel.proposal': ProposalTable;
  'crove_kernel.agent_template': AgentTemplateTable;
  'crove_kernel.agent': AgentTable;
  'crove_kernel.position': PositionTable;
  'crove_kernel.ai_run': AiRunTable;
  'crove_kernel.task': TaskTable;
  'crove_kernel.task_comment': TaskCommentTable;
  'crove_kernel.agent_wakeup': AgentWakeupTable;
  'crove_kernel.kill_switch': KillSwitchTable;
  'crove_kernel.budget_policy': BudgetPolicyTable;
  'crove_kernel.channel_connection': ChannelConnectionTable;
  'crove_kernel.external_call': ExternalCallTable;
  'crove_kernel.mail_message': MailMessageTable;
  'crove_kernel.mail_suppression': MailSuppressionTable;
  'crove_kernel.mail_event': MailEventTable;
  'crove_finance.purchase_document': PurchaseDocumentTable;
  'crove_finance.journal_entry': JournalEntryTable;
  'crove_finance.org_account': OrgAccountTable;
  'crove_finance.cash_voucher': CashVoucherTable;
  'crove_finance.portal_invoice_list': PortalInvoiceListTable;
  'crove_finance.portal_invoice_row': PortalInvoiceRowTable;
  'crove_social.post': SocialPostTable;
  'crove_social.post_variant': SocialPostVariantTable;
  'crove_social.post_approval': SocialPostApprovalTable;
  'crove_social.review_feedback': SocialReviewFeedbackTable;
  'crove_social.review_link': SocialReviewLinkTable;
  'crove_social.account_snapshot': SocialAccountSnapshotTable;
  'crove_social.link_preview': SocialLinkPreviewTable;
  'crove_social.notification': SocialNotificationTable;
  'crove_social.notification_mute': SocialNotificationMuteTable;
  'crove_social.calendar_note': SocialCalendarNoteTable;
  'crove_social.watermark': SocialWatermarkTable;
  'crove_social.chat_alert': SocialChatAlertTable;
  'crove_social.label': SocialLabelTable;
  'crove_social.idea': SocialIdeaTable;
  'crove_social.report_schedule': SocialReportScheduleTable;
  'crove_social.report_schedule_run': SocialReportScheduleRunTable;
}>;

// Every table crove_tenant may read: the generated table type, or its refinement above.
export type Database = { [K in keyof G.Database]: K extends keyof Refined ? Refined[K] : G.Database[K] };
