// Kysely table types for the Crove schemas. Keep in sync with supabase/migrations.
// numeric, int8 and date columns are strings (see the pool type parsers); timestamptz is Date.
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
// A timestamptz with a database default (insert is optional).
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;

export interface UserAccountTable {
  id: Generated<string>;
  issuer: string;
  subject: string;
  email: string;
  display_name: string | null;
  created_at: DefaultTimestamp;
  last_seen_at: DefaultTimestamp;
  // Set by staff to block the user in Crove (ADR-0028): 403 on every request.
  disabled_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface TenantTable {
  org_id: Generated<string>;
  slug: string;
  name: string;
  // 'offboarding': only owners may enter (kernel.org.offboard, issue #38); 'closed' is set by staff.
  status: Generated<'active' | 'offboarding' | 'closed'>;
  // The active inbound token. Every token ever issued, retired ones included, is in crove_kernel.inbound_address,
  // which only definers read and write; rotation is the command kernel.inbound.rotate.
  inbound_token: Generated<string>;
  base_currency: Generated<string>;
  created_by: string;
  created_at: DefaultTimestamp;
}

export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface TenantMemberTable {
  org_id: string;
  user_id: string;
  role: MemberRole;
  created_at: DefaultTimestamp;
}

// A pending, accepted or revoked invite (issue #35). Tenant roles insert invites and may only set status,
// revoked_at and revoked_by; crove_kernel.invite_accept() is the only writer of accepted_at and accepted_by.
export interface MemberInviteTable {
  org_id: string;
  id: Generated<string>;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  token_sha256: string;
  status: Generated<'pending' | 'accepted' | 'revoked'>;
  invited_by: string;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
  accepted_at: ColumnType<Date | null, never, never>;
  accepted_by: ColumnType<string | null, never, never>;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  revoked_by: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface IdempotencyKeyTable {
  org_id: string;
  actor_key: string;
  key: string;
  command: string;
  request_sha256: string;
  response: Json | null;
  created_at: DefaultTimestamp;
}

export interface OutboxEventTable {
  org_id: string;
  id: Generated<string>;
  type: string;
  payload: Json;
  actor_id: string | null;
  command_id: string | null;
  created_at: DefaultTimestamp;
}

export interface AuditEventTable {
  org_id: string;
  id: Generated<string>;
  occurred_at: DefaultTimestamp;
  actor_type: 'user' | 'system';
  actor_id: string | null;
  command: string;
  command_id: string;
  outcome: 'ok' | 'pending_approval' | 'denied' | 'failed';
  target_type: string | null;
  target_id: string | null;
  input_sha256: string;
  proposal_id: string | null;
  detail: Json | null;
}

export interface PartyTable {
  org_id: string;
  id: Generated<string>;
  kind: Generated<'organization' | 'person'>;
  name: string;
  tax_code: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  source_trust: Generated<'external' | 'user' | 'system'>;
  verified_at: Timestamp | null;
  verified_by: string | null;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface FileTable {
  org_id: string;
  id: Generated<string>;
  sha256: string;
  storage_key: string;
  filename: string;
  content_type: string;
  size_bytes: string;
  source: 'upload' | 'email';
  created_by: string | null;
  created_at: DefaultTimestamp;
}

export interface InboundMessageTable {
  org_id: string;
  id: Generated<string>;
  message_id: string;
  from_address: string | null;
  subject: string | null;
  attachment_count: Generated<number>;
  received_at: DefaultTimestamp;
}

export type ExtractionMethod = 'einvoice_xml' | 'pdf_text_ai' | 'image_ai' | 'unsupported';

export type ExtractionStatus = 'pending' | 'done' | 'failed';

export interface ExtractionTable {
  org_id: string;
  id: Generated<string>;
  file_id: string;
  // NULL only while a re-extraction is pending (or for one that timed out before it was read).
  method: ExtractionMethod | null;
  status: ExtractionStatus;
  // 1, 2, 3, ... per file; assigned by the database on insert (trigger extraction_assign_version).
  version: Generated<number>;
  result: Json | null;
  checks: ColumnType<unknown, string | undefined, string>;
  error: string | null;
  tainted: Generated<boolean>;
  // The user who asked for a re-extraction; NULL for the first extraction.
  requested_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: DefaultTimestamp;
  completed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

// 'approved' exists only inside the transaction of kernel.proposal.approve today: it marks the proposal approved for
// its command while that command runs (the runtime's proposal state gate), and the same transaction ends 'executed'.
export type ProposalStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'failed';

export interface ProposalTable {
  org_id: string;
  id: Generated<string>;
  kind: string;
  command: string;
  status: Generated<ProposalStatus>;
  title: string;
  payload: Json;
  revision: Generated<number>;
  source_file_id: string | null;
  extraction_id: string | null;
  duplicate_of: string | null;
  created_at: DefaultTimestamp;
  decided_by: string | null;
  decided_at: Timestamp | null;
  decision_note: string | null;
  executed_command_id: string | null;
  result: Json | null;
  // Set on every new proposal; NULL only on proposals decided before the approval policy existed.
  eligible_approvers: string[] | null;
  authors: Json | null;
}

export interface ActivityTable {
  org_id: string;
  id: Generated<string>;
  record_type: string;
  record_id: string;
  kind: string;
  summary: string;
  actor_id: string | null;
  occurred_at: DefaultTimestamp;
}

export interface AccountTable {
  code: string;
  name: string;
  parent_code: string | null;
  standard: Generated<string>;
}

export interface PurchaseDocumentTable {
  org_id: string;
  id: Generated<string>;
  party_id: string;
  invoice_series: Generated<string>;
  invoice_number: string;
  invoice_date: string;
  currency: Generated<string>;
  subtotal: string;
  vat_amount: string;
  total: string;
  payment_method: string | null;
  tax_authority_code: string | null;
  source_file_id: string | null;
  proposal_id: string | null;
  created_by: string | null;
  created_at: DefaultTimestamp;
}

export interface PurchaseLineTable {
  org_id: string;
  document_id: string;
  line_no: number;
  description: string;
  unit: string | null;
  quantity: string | null;
  unit_price: string | null;
  amount: string;
  vat_rate: string | null;
  vat_amount: Generated<string>;
  debit_account: string;
}

export interface JournalEntryTable {
  org_id: string;
  id: Generated<string>;
  entry_date: string;
  description: string;
  source_type: string;
  source_id: string;
  created_by: string | null;
  created_at: DefaultTimestamp;
  // xid8 stamped by a trigger; entries are written only by crove_finance.post_journal_entry().
  created_xact_id: ColumnType<string | null, never, never>;
  // Start of that transaction, stamped by the same trigger: xid8 alone repeats after a logical restore.
  created_xact_start: ColumnType<Date | null, never, never>;
  // The entry this one reverses (its mirror), or null; set only by the posting function.
  reverses_entry_id: ColumnType<string | null, never, never>;
}

export interface JournalLineTable {
  org_id: string;
  entry_id: string;
  line_no: number;
  account_code: string;
  debit: Generated<string>;
  credit: Generated<string>;
  party_id: string | null;
  memo: string | null;
}

export interface VendorAccountRuleTable {
  org_id: string;
  party_id: string;
  debit_account: string;
  confirmed_by: string | null;
  updated_at: DefaultTimestamp;
}

export interface Database {
  'crove_kernel.user_account': UserAccountTable;
  'crove_kernel.tenant': TenantTable;
  'crove_kernel.tenant_member': TenantMemberTable;
  'crove_kernel.member_invite': MemberInviteTable;
  'crove_kernel.idempotency_key': IdempotencyKeyTable;
  'crove_kernel.outbox_event': OutboxEventTable;
  'crove_kernel.audit_event': AuditEventTable;
  'crove_kernel.party': PartyTable;
  'crove_kernel.file': FileTable;
  'crove_kernel.inbound_message': InboundMessageTable;
  'crove_kernel.extraction': ExtractionTable;
  'crove_kernel.proposal': ProposalTable;
  'crove_kernel.activity': ActivityTable;
  'crove_finance.account': AccountTable;
  'crove_finance.purchase_document': PurchaseDocumentTable;
  'crove_finance.purchase_line': PurchaseLineTable;
  'crove_finance.journal_entry': JournalEntryTable;
  'crove_finance.journal_line': JournalLineTable;
  'crove_finance.vendor_account_rule': VendorAccountRuleTable;
}
