// Kysely types for the Crove schemas: the types generated from the migrated database (./generated/database.ts,
// `pnpm db:types`, issue #48) with the refinements the catalog cannot express, such as CHECK-constraint unions and
// columns only a trigger or a definer writes. numeric, int8 and date columns are strings (see the pool type parsers);
// timestamptz is Date.
//
// The generated Database holds only the tables crove_tenant may read. crove_kernel.user_account (identity) and the
// other control-plane tables (plan §3.6, Decision 14) have no Kysely type on purpose: tenant code reaches them only
// through definers (crove_kernel.member_profiles, identity_resolve, my_orgs and the like), so a direct selectFrom does
// not compile. The invariant test control-plane-reads.test.ts catches raw SQL.
import type { ColumnType, Generated, InsertType, SelectType } from 'kysely';
import type * as G from './generated/database.ts';

// A refinement narrows what a column holds (a CHECK-constraint union) or restricts how it is written (never, insert
// only); it never contradicts the database. Each refined column must exist in the generated table, its select type
// must fit the generated one, it is nullable exactly when the column is, and it is optional on insert only when the
// column has a default or is nullable, unless the column is listed as assigned by a trigger (the third parameter).
// A migration that renames, retypes, changes the nullability or drops the default of a refined column fails
// typecheck here until the refinement follows. The members of a CHECK-constraint union are not compared with the
// database.

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
export type Refine<Table, R extends Refinement<Table, R, ByTrigger>, ByTrigger extends keyof R = never> = {
  [K in keyof Table]: K extends keyof R ? R[K] : Table[K];
};
type Tables<R extends { [K in keyof R]: K extends keyof G.Database ? unknown : 'not a table of the generated Database' }> = R;

export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer';
type ActorType = 'user' | 'system' | 'agent';

export type TenantTable = Refine<
  G.KernelTenantTable,
  {
    // 'offboarding': only owners may enter (kernel.org.offboard, issue #38); 'closed' is set by staff.
    status: Generated<'active' | 'offboarding' | 'closed'>;
    // inbound_token is the active inbound token. Every token ever issued, retired ones included, is in
    // crove_kernel.inbound_address, which only definers read and write; rotation is the command kernel.inbound.rotate.
  }
>;

export type TenantMemberTable = Refine<G.KernelTenantMemberTable, { role: MemberRole }>;

// A pending, accepted or revoked invite (issue #35). Tenant roles insert invites and may only set status,
// revoked_at and revoked_by; crove_kernel.invite_accept() is the only writer of accepted_at and accepted_by.
export type MemberInviteTable = Refine<
  G.KernelMemberInviteTable,
  {
    role: 'admin' | 'member' | 'viewer';
    token_sha256: string;
    status: Generated<'pending' | 'accepted' | 'revoked'>;
    expires_at: ColumnType<Date, Date | string, Date | string>;
    accepted_at: ColumnType<Date | null, never, never>;
    accepted_by: ColumnType<string | null, never, never>;
  }
>;

export type AuditEventTable = Refine<
  G.KernelAuditEventTable,
  {
    actor_type: ActorType;
    outcome: 'ok' | 'pending_approval' | 'denied' | 'failed';
  }
>;

export type PartyTable = Refine<
  G.KernelPartyTable,
  {
    kind: Generated<'organization' | 'person'>;
    source_trust: Generated<'external' | 'user' | 'system'>;
  }
>;

// generation is the object version the bytes were written as (ADR-0013); null only on rows from before it.
export type FileTable = Refine<G.KernelFileTable, { source: 'upload' | 'email' }>;

export type ExtractionMethod = 'einvoice_xml' | 'pdf_text_ai' | 'image_ai' | 'unsupported';

export type ExtractionStatus = 'pending' | 'done' | 'failed';

// requested_by is the user who asked for a re-extraction; NULL for the first extraction.
export type ExtractionTable = Refine<
  G.KernelExtractionTable,
  {
    // NULL only while a re-extraction is pending (or for one that timed out before it was read).
    method: ExtractionMethod | null;
    status: ExtractionStatus;
    // 1, 2, 3, ... per file; assigned by the database on insert (trigger extraction_assign_version).
    version: Generated<number>;
  },
  'version'
>;

// 'approved' exists only inside the transaction of kernel.proposal.approve today: it marks the proposal approved for
// its command while that command runs (the runtime's proposal state gate), and the same transaction ends 'executed'.
export type ProposalStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'failed';

// eligible_approvers is set on every new proposal; NULL only on proposals decided before the approval policy existed.
export type ProposalTable = Refine<G.KernelProposalTable, { status: Generated<ProposalStatus> }>;

// ADR-0029 Phase 1 (issue #79): agents in an org chart shared with humans. See the migration
// 20261018050000_crove_kernel_agents_org_chart.sql for the rules the database enforces.
export type AgentRisk = 'R0' | 'R1' | 'R2';

export type AgentTemplateTable = Refine<
  G.KernelAgentTemplateTable,
  {
    max_risk: AgentRisk;
    subscribes: string[];
    daily_run_cap: number;
  }
>;

export type AgentStatus = 'active' | 'paused' | 'retired';

export type AgentTable = Refine<
  G.KernelAgentTable,
  {
    runtime: Generated<'builtin' | 'external'>;
    status: Generated<AgentStatus>;
    max_risk: Generated<AgentRisk>;
  }
>;

export type PositionStatus = 'active' | 'paused' | 'archived';

export type PositionTable = Refine<G.KernelPositionTable, { status: Generated<PositionStatus> }>;

export type AiRunStatus = 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled';

export type AiRunTable = Refine<G.KernelAiRunTable, { status: Generated<AiRunStatus> }>;

export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'in_review' | 'done' | 'cancelled';
export type TaskKind = 'general' | 'proposal_review' | 'escalation' | 'delegation';
export type TaskSource = 'event' | 'proposal' | 'human' | 'schedule';

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

export type ChannelConnectionStatus = 'active' | 'expired' | 'revoked' | 'error';

// A connected social or messaging account (ADR-0025). Its sealed tokens live in crove_kernel.credential, which has
// no Kysely type: only the credential_* definers reach it.
export type ChannelConnectionTable = Refine<G.KernelChannelConnectionTable, { status: Generated<ChannelConnectionStatus> }>;

export type AgentWakeupTable = Refine<G.KernelAgentWakeupTable, { status: Generated<'pending' | 'claimed' | 'done'> }>;

export type AgentScope = 'org' | 'module' | 'agent';

export type KillSwitchTable = Refine<G.KernelKillSwitchTable, { scope: AgentScope }>;

export type BudgetPolicyTable = Refine<G.KernelBudgetPolicyTable, { scope: AgentScope }>;

export type PurchaseDocumentTable = Refine<
  G.FinancePurchaseDocumentTable,
  {
    // The voided document of the same supplier invoice that this one replaces (#165), or null for the first one.
    replaces_document_id: ColumnType<string | null, string | null | undefined, never>;
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
  'crove_finance.purchase_document': PurchaseDocumentTable;
  'crove_finance.journal_entry': JournalEntryTable;
}>;

// Every table crove_tenant may read: the generated table type, or its refinement above.
export type Database = { [K in keyof G.Database]: K extends keyof Refined ? Refined[K] : G.Database[K] };
