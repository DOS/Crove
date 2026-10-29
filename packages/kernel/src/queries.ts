import { z } from 'zod';
import { sql } from 'kysely';
import {
  JOURNAL_VOUCHER_KIND,
  VOUCHER_KIND,
  zCashVoucherProposal,
  zJournalVoucherProposal,
  zId,
  zJournalReversal,
  zLocalDate,
  zMoney,
  zProposalStatus,
  zPurchaseProposal,
  zSignatureStatus,
  zVoucherCode,
  type CashVoucherProposal,
  type JournalReversal,
  type JournalVoucherProposal,
  type PurchaseProposal,
  type SignatureStatus,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { EDITOR_ROLES, decideApproval, proposalEditable } from './approval.ts';
import { MAX_EXTRACTION_VERSIONS, executedButVoided, latestExtraction } from './extraction.ts';
import { archiveQueries } from './archives.ts';
import { fileStatuses } from './file-status.ts';
import { agentQueries } from './agents.ts';
import { channelQueries } from './channels.ts';
import { inviteQueries } from './invites.ts';
import { mailQueries } from './mail.ts';
import { timelineQueries } from './timeline.ts';
import { auditLogQueries } from './audit-log.ts';
import { personalDataQueries } from './personal-data.ts';
import { notificationQueries } from './notifications.ts';
import { inboxItemQueries } from './inbox-items.ts';
import { offboardingQueries } from './offboarding.ts';
import { memberProfiles } from './profiles.ts';
import { orgOverviewQuery, RECENT_FILES, type OverviewContribution } from './overview.ts';
import { proposalReminderQueries } from './proposal-reminders.ts';
import { mayResubmit, resubmitSource } from './proposal-resubmit.ts';
import { taxCalendarQueries } from './tax-calendar.ts';
import { legalEntityQueries } from './legal-entities.ts';
import { numberingQueries } from './numbering.ts';
import { myPermissions, roleQueries } from './roles.ts';
import { calendarQueries } from './calendar.ts';
import { partyQueries } from './parties.ts';
import { usageQueries } from './usage-limits.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export interface OrgDetailOptions {
  inboundDomain: string | null;
}

export function orgDetailQuery(options: OrgDetailOptions) {
  return defineQuery({
    name: 'kernel.org.get',
    input: z.object({}),
    access: ALL,
    handler: async (ctx) => {
      const tenant = await ctx.trx
        .selectFrom('crove_kernel.tenant')
        .select(['org_id', 'slug', 'name', 'inbound_token', 'tax_code', 'vat_filing_period', 'address', 'contact_email', 'approval_preset', 'approval_policy_version'])
        .where('org_id', '=', ctx.orgId)
        .executeTakeFirstOrThrow();
      const memberRows = await ctx.trx
        .selectFrom('crove_kernel.tenant_member')
        .select(['user_id', 'role'])
        .where('org_id', '=', ctx.orgId)
        .orderBy('created_at')
        .execute();
      // Names and emails come from the control plane through a definer (plan §3.6, #169), never a join.
      const profiles = await memberProfiles(ctx.trx, memberRows.map((m) => m.user_id));
      const members = memberRows.flatMap((m) => {
        const profile = profiles.get(m.user_id);
        return profile ? [{ user_id: m.user_id, email: profile.email, display_name: profile.displayName, role: m.role }] : [];
      });
      // Owners and admins see the inbound address, and how many messages to the org's addresses retired in the last
      // 30 days were dropped (#139).
      const seesInbound = Boolean(options.inboundDomain) && (ctx.role === 'owner' || ctx.role === 'admin');
      let inboundDroppedCount: number | null = null;
      if (seesInbound) {
        const { rows } = await sql<{ n: string }>`SELECT crove_kernel.inbound_drop_count() AS n`.execute(ctx.trx);
        inboundDroppedCount = Number(rows[0]?.n ?? 0);
      }
      return {
        orgId: tenant.org_id,
        slug: tenant.slug,
        name: tenant.name,
        role: ctx.role ?? 'viewer',
        taxCode: tenant.tax_code,
        vatFilingPeriod: tenant.vat_filing_period,
        address: tenant.address,
        contactEmail: tenant.contact_email,
        inboundAddress: seesInbound ? `${tenant.inbound_token}@${options.inboundDomain}` : null,
        inboundDroppedCount,
        members: members.map((m) => ({ userId: m.user_id, email: m.email, displayName: m.display_name, role: m.role })),
        // What the signed-in member holds through org-wide role assignments (#1279).
        permissions: await myPermissions(ctx),
        approvalPreset: tenant.approval_preset,
        approvalPolicyVersion: tenant.approval_policy_version,
      };
    },
  });
}

function countChecks(payload: PurchaseProposal | null, status: 'fail' | 'warn'): number {
  return payload?.checks.filter((c) => c.status === status).length ?? 0;
}

// Payloads are parsed by the proposal's kind: a purchase read from a file, or a reversal a user asked for (#138).
const PURCHASE_KIND = 'finance.purchase';
const REVERSAL_KIND = 'finance.journal_reversal';

function parsePayload(kind: string, raw: unknown): PurchaseProposal | null {
  if (kind !== PURCHASE_KIND) return null;
  const result = zPurchaseProposal.safeParse(raw);
  return result.success ? result.data : null;
}

function parseReversal(kind: string, raw: unknown): JournalReversal | null {
  if (kind !== REVERSAL_KIND) return null;
  const result = zJournalReversal.safeParse(raw);
  return result.success ? result.data : null;
}

// A cash or bank voucher entered by hand (#327).
function parseVoucher(kind: string, raw: unknown): CashVoucherProposal | null {
  if (kind !== VOUCHER_KIND) return null;
  const result = zCashVoucherProposal.safeParse(raw);
  return result.success ? result.data : null;
}

// The stored signature status of an invoice proposal (#674), or null when it has none or holds anything else.
function signatureStatusOf(value: string | null): SignatureStatus | null {
  const parsed = zSignatureStatus.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// A general journal voucher entered by hand (#888).
function parseJournalVoucher(kind: string, raw: unknown): JournalVoucherProposal | null {
  if (kind !== JOURNAL_VOUCHER_KIND) return null;
  const result = zJournalVoucherProposal.safeParse(raw);
  return result.success ? result.data : null;
}

// The kinds whose revision names the legal entity it posts to (#1543): an invoice, a cash voucher and a general journal
// voucher. No other kind's payload is read for it.
const ENTITY_NAMING_KINDS: ReadonlySet<string> = new Set([PURCHASE_KIND, VOUCHER_KIND, JOURNAL_VOUCHER_KIND]);

// The legal entity a proposal shows, the same in kernel.inbox.list and kernel.inbox.get (#1625): the one its revision
// names (`named`, the payload's legalEntityId) when its kind names one and the value is an id, else the proposal's own
// (#1538), the entity row security scopes it by, which an edit never moves (#1764). Shown only: who sees the proposal
// is decided by its own entity, never by this.
export function revisionLegalEntity(kind: string, named: unknown, own: string): string {
  if (ENTITY_NAMING_KINDS.has(kind) && typeof named === 'string') {
    const id = zId.safeParse(named);
    if (id.success) return id.data.toLowerCase();
  }
  return own;
}

// A top-level key of a stored payload, whatever the rest of it holds.
function payloadKey(payload: unknown, key: string): unknown {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)[key] : undefined;
}

function toInboxItem(row: {
  id: string;
  kind: string;
  status: z.infer<typeof zProposalStatus>;
  title: string;
  payload: unknown;
  duplicate_of: string | null;
  created_at: Date;
  decided_at: Date | null;
  extraction_id: string | null;
  requested_by_agent: string | null;
  legal_entity_id: string;
}, agentName: string | null) {
  const payload = parsePayload(row.kind, row.payload);
  const voucher = parseVoucher(row.kind, row.payload) ?? parseJournalVoucher(row.kind, row.payload);
  const direction = payload ? (payload.direction ?? 'purchase') : null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    direction,
    sellerName: payload?.seller.name ?? null,
    buyerName: direction === 'sale' ? (payload?.buyer.name ?? null) : null,
    // The legal entity the revision names (#1543), else the proposal's own (#1764), as the list gives it (#1625).
    legalEntityId: revisionLegalEntity(row.kind, payloadKey(row.payload, 'legalEntityId'), row.legal_entity_id),
    total: payload?.invoice.total ?? voucher?.total ?? null,
    issueDate: payload?.invoice.issueDate ?? voucher?.date ?? null,
    failedChecks: countChecks(payload, 'fail'),
    warnChecks: countChecks(payload, 'warn'),
    // As the approval decides: an invoice read from XML whose signature is not verified is unverified (#674).
    signatureStatus: payload
      ? payload.extractionMethod === 'einvoice_xml' && payload.signature?.status !== 'verified'
        ? 'unverified'
        : (payload.signature?.status ?? null)
      : null,
    duplicateOf: row.duplicate_of,
    createdAt: row.created_at.toISOString(),
    expiredAfterDays: expiredAfterDays(row),
    ...agentFields(row, agentName),
  };
}

// How many whole days an expired proposal waited before it expired (#876), the reason the Inbox shows; null otherwise.
function expiredAfterDays(row: { status: string; created_at: Date; decided_at: Date | null }): number | null {
  if (row.status !== 'expired' || !row.decided_at) return null;
  return Math.max(0, Math.floor((row.decided_at.getTime() - row.created_at.getTime()) / 86_400_000));
}

// Whether an AI agent asked for the proposal and whether an extraction run read it (#435). An agent's proposal has no
// extraction, so no invoice checks ran and the Inbox must not show it as matched.
function agentFields(row: { extraction_id: string | null; requested_by_agent: string | null }, agentName: string | null) {
  return {
    requestedByAgent: row.requested_by_agent ? { id: row.requested_by_agent, name: agentName ?? '' } : null,
    extracted: row.extraction_id !== null,
  };
}

export const inboxList = defineQuery({
  name: 'kernel.inbox.list',
  input: z.object({ status: zProposalStatus.optional() }),
  access: ALL,
  handler: async (ctx, input) => {
    const countChecksSql = (status: 'fail' | 'warn') =>
      sql<string>`(SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload -> 'checks') = 'array' THEN payload -> 'checks' ELSE '[]'::jsonb END) c WHERE c ->> 'status' = ${status})`;
    let query = ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select(['id', 'kind', 'status', 'title', 'revision', 'duplicate_of', 'created_at', 'decided_at', 'extraction_id', 'requested_by_agent'])
      .select([
        sql<string | null>`left(payload #>> '{seller,name}', 500)`.as('seller_name'),
        sql<boolean>`coalesce(payload ->> 'direction' = 'sale', false)`.as('is_sale'),
        sql<string | null>`left(payload #>> '{buyer,name}', 500)`.as('buyer_name'),
        // The legal entity the revision names (#1543), read as kernel.inbox.get reads it (revisionLegalEntity, #1625),
        // and the proposal's own (#1538): the entity of its reading or of its request, which an edit never moves (#1764).
        // Cut at 64 characters, which no longer value can make a uuid of.
        sql<string | null>`left(payload ->> 'legalEntityId', 64)`.as('named_entity'),
        'legal_entity_id',
        // A voucher (#327) and a general journal voucher (#888) keep their total and date at the top of their payload.
        sql<string | null>`left(CASE WHEN kind IN (${VOUCHER_KIND}, ${JOURNAL_VOUCHER_KIND}) THEN payload ->> 'total' ELSE payload #>> '{invoice,total}' END, 30)`.as('total'),
        sql<string | null>`left(CASE WHEN kind IN (${VOUCHER_KIND}, ${JOURNAL_VOUCHER_KIND}) THEN payload ->> 'date' ELSE payload #>> '{invoice,issueDate}' END, 10)`.as('issue_date'),
        // The requesting agent's name, read in the same org under the agent table's own row security (no cross-org read).
        sql<string | null>`(SELECT a.display_name FROM crove_kernel.agent a WHERE a.org_id = crove_kernel.proposal.org_id AND a.id = crove_kernel.proposal.requested_by_agent)`.as('agent_name'),
        countChecksSql('fail').as('failed_checks'),
        countChecksSql('warn').as('warn_checks'),
        // As the approval decides (kernel.proposal.approve): an invoice read from XML whose signature is not verified is
        // unverified, one read before #674 (no verification stored) included.
        sql<string | null>`left(CASE WHEN payload ->> 'extractionMethod' = 'einvoice_xml' AND coalesce(payload #>> '{signature,status}', '') <> 'verified' THEN 'unverified' ELSE payload #>> '{signature,status}' END, 20)`.as('signature_status'),
      ])
      .where('org_id', '=', ctx.orgId)
      .orderBy('created_at', 'desc')
      .limit(200);
    if (input.status) query = query.where('status', '=', input.status);
    return (await query.execute()).map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      direction: row.kind === PURCHASE_KIND ? (row.is_sale ? ('sale' as const) : ('purchase' as const)) : null,
      // The revision the list shows, which a bulk approval names (it refuses a proposal edited since: STALE_REVISION).
      revision: row.revision,
      sellerName: row.seller_name,
      buyerName: row.kind === PURCHASE_KIND && row.is_sale ? row.buyer_name : null,
      legalEntityId: revisionLegalEntity(row.kind, row.named_entity, row.legal_entity_id),
      total: row.total && zMoney.safeParse(row.total).success ? row.total : null,
      issueDate: row.issue_date && zLocalDate.safeParse(row.issue_date).success ? row.issue_date : null,
      failedChecks: Number(row.failed_checks),
      warnChecks: Number(row.warn_checks),
      signatureStatus: row.kind === PURCHASE_KIND ? signatureStatusOf(row.signature_status) : null,
      duplicateOf: row.duplicate_of,
      createdAt: row.created_at.toISOString(),
      expiredAfterDays: expiredAfterDays(row),
      ...agentFields(row, row.agent_name),
    }));
  },
});

export const inboxGet = defineQuery({
  name: 'kernel.inbox.get',
  input: z.object({ id: zId }),
  access: ALL,
  handler: async (ctx, input) => {
    const row = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy đề xuất');
    const file = row.source_file_id
      ? await ctx.trx
          .selectFrom('crove_kernel.file')
          .select(['id', 'filename', 'content_type', 'size_bytes'])
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', row.source_file_id)
          .executeTakeFirst()
      : undefined;
    const result = row.result as {
      documentId?: string;
      journalEntryId?: string;
      postingDate?: unknown;
      reversedEntryId?: string;
      voidedDocumentId?: string;
      voucherId?: string;
      code?: unknown;
    } | null;
    // The same decision kernel.proposal.approve makes (without its locks), so the Inbox shows Approve only
    // to users the server will accept.
    const approval = await decideApproval(ctx.trx, ctx.orgId, ctx.actor, row, { lock: false });
    const editor = ctx.actor.type === 'user' && ctx.role !== null && EDITOR_ROLES.includes(ctx.role);
    // The file's newest extraction run, and the run this revision was read from (issue #40). While a re-extraction
    // is in flight, approve, edit and reject are refused (EXTRACTION_PENDING), so they are not offered.
    const latest = file ? await latestExtraction(ctx, file.id) : undefined;
    const own = row.extraction_id
      ? await ctx.trx
          .selectFrom('crove_kernel.extraction')
          .select('version')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', row.extraction_id)
          .executeTakeFirst()
      : undefined;
    const reading = latest?.inFlight === true;
    // kernel.file.reextract acts on the file's newest proposal, so only that one offers it.
    const newest = file
      ? await ctx.trx
          .selectFrom('crove_kernel.proposal')
          .select(['id', 'status'])
          .where('org_id', '=', ctx.orgId)
          .where('source_file_id', '=', file.id)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(1)
          .executeTakeFirst()
      : undefined;
    const agent = row.requested_by_agent
      ? await ctx.trx.selectFrom('crove_kernel.agent').select('display_name').where('org_id', '=', ctx.orgId).where('id', '=', row.requested_by_agent).executeTakeFirst()
      : undefined;
    const canChange = row.status === 'pending' && editor && !reading;
    // An expired proposal (#876): the one asked for again from it, if any, and whether the caller may ask for it again,
    // by the same checks kernel.proposal.resubmit makes.
    const resubmittedAs =
      row.status === 'expired'
        ? ((await ctx.trx.selectFrom('crove_kernel.proposal').select('id').where('org_id', '=', ctx.orgId).where('resubmitted_from', '=', row.id).executeTakeFirst())?.id ?? null)
        : null;
    const source = resubmitSource(row);
    const canResubmit =
      row.status === 'expired' &&
      editor &&
      ctx.actor.type === 'user' &&
      resubmittedAs === null &&
      source !== null &&
      mayResubmit(row, ctx.actor.userId) &&
      (source === 'request' || (newest?.id === row.id && !reading));
    // The purchase this proposal recorded was voided by a reversal (#165); its file may then be read again.
    const voided = await executedButVoided(ctx, row);
    const newestReopened = newest?.id === row.id ? voided : await executedButVoided(ctx, newest);
    return {
      ...toInboxItem(row, agent?.display_name ?? null),
      revision: row.revision,
      payload: parsePayload(row.kind, row.payload),
      reversal: parseReversal(row.kind, row.payload),
      voucher: parseVoucher(row.kind, row.payload),
      journalVoucher: parseJournalVoucher(row.kind, row.payload),
      error: null,
      file: file ? { id: file.id, filename: file.filename, contentType: file.content_type, sizeBytes: file.size_bytes } : null,
      decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
      decisionNote: row.decision_note,
      result: result?.journalEntryId
        ? {
            journalEntryId: result.journalEntryId,
            ...(result.documentId ? { documentId: result.documentId } : {}),
            // A purchase posted later than its invoice date, in an open month (#478): the date its entry is on.
            ...(result.documentId && typeof result.postingDate === 'string' && zLocalDate.safeParse(result.postingDate).success
              ? { postingDate: result.postingDate }
              : {}),
            ...(result.reversedEntryId ? { reversedEntryId: result.reversedEntryId } : {}),
            ...(result.voidedDocumentId ? { voidedDocumentId: result.voidedDocumentId } : {}),
            ...(result.voucherId ? { voucherId: result.voucherId } : {}),
            // The code finance.voucher.record gave the voucher (it returns it with the voucher's id); a number never
            // changes once given, so the stored result stays true.
            ...(result.voucherId && zVoucherCode.safeParse(result.code).success ? { voucherCode: result.code as string } : {}),
          }
        : null,
      voided,
      canApprove: approval.reason === 'ok' && !reading,
      approveReason: approval.reason,
      // The same checks kernel.proposal.edit makes before it edits (NOT_EDITABLE otherwise).
      canEdit: canChange && proposalEditable(ctx, row),
      canReject: canChange,
      canResubmit,
      resubmittedAs,
      resubmittedFrom: row.resubmitted_from,
      extraction: latest
        ? { version: latest.version, status: latest.status, error: latest.error, inFlight: reading, proposalVersion: own?.version ?? null }
        : null,
      // The same checks kernel.file.reextract makes. An expired file proposal offers both ways back (#876): reading the
      // file again (a new reading, as after a rejection) and asking for it again from the same reading (canResubmit).
      canReextract:
        editor &&
        latest !== undefined &&
        !reading &&
        newest?.id === row.id &&
        (newest.status !== 'executed' || newestReopened) &&
        latest.version < MAX_EXTRACTION_VERSIONS,
    };
  },
});

export const filesRecent = defineQuery({
  name: 'kernel.files.recent',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) => (await fileStatuses(ctx, { recent: RECENT_FILES })).map((row) => row.status),
});

// Mails forwarded to the org's inbound address (#779), newest first, for the Inbox's *Soạn bài đăng từ thư này*: who
// sent it, its subject, when it came, whether its text was kept and how many attachments it had. Those who write posts
// only (owners, admins, members), as the AI draft is theirs, and only in a context that sees every legal entity: a
// mail has no entity, so a member limited to some entities (an external accountant) gets no mail and no mail's text.
const MAIL_READERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const RECENT_MAILS = 20;
// The caller's context sees every legal entity (the wildcard in enter_context's le_scope); fetched once per statement.
const unscoped = sql<boolean>`coalesce('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]), false)`;
export const inboundRecent = defineQuery({
  name: 'kernel.inbound.recent',
  input: z.object({}),
  access: MAIL_READERS,
  handler: async (ctx) => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.inbound_message')
      .select(['id', 'from_address', 'subject', 'attachment_count', 'received_at', sql<boolean>`body_text IS NOT NULL`.as('has_text')])
      .where('org_id', '=', ctx.orgId)
      .where(unscoped)
      .orderBy('received_at', 'desc')
      .orderBy('id', 'desc')
      .limit(RECENT_MAILS)
      .execute();
    return rows.map((r) => ({ id: r.id, from: r.from_address, subject: r.subject, attachmentCount: r.attachment_count, receivedAt: r.received_at.toISOString(), hasText: r.has_text }));
  },
});

// One mail's subject and text (#779), for an AI draft started from it; NOT_FOUND for a mail of another org, none, or a
// caller limited to some legal entities.
export const inboundText = defineQuery({
  name: 'kernel.inbound.text',
  input: z.object({ id: zId }),
  access: MAIL_READERS,
  handler: async (ctx, input) => {
    const row = await ctx.trx.selectFrom('crove_kernel.inbound_message').select(['subject', 'body_text']).where('org_id', '=', ctx.orgId).where('id', '=', input.id).where(unscoped).executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy thư này');
    return { subject: row.subject, text: row.body_text };
  },
});

export const fileGet = defineQuery({
  name: 'kernel.file.get',
  input: z.object({ id: zId }),
  access: ALL,
  handler: async (ctx, input) => {
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'filename', 'content_type', 'storage_key', 'generation', 'sha256', 'size_bytes'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (!file) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp');
    return file;
  },
});

// Sessions of a user (ADR-0028), for the revoke-device screen: the user's own sessions, or for the org owner the
// member's sessions seen in that org only. Enforced by the definer, with the same rule as kernel.session.revoke.
export const sessionsList = defineQuery({
  name: 'kernel.sessions.list',
  input: z.object({ userId: zId }),
  access: ALL,
  handler: async (ctx, input) => {
    const { rows } = await sql<{
      session_id: string;
      status: 'active' | 'revoked';
      first_seen_at: Date;
      last_seen_at: Date;
      revoked_at: Date | null;
    }>`SELECT session_id, status, first_seen_at, last_seen_at, revoked_at FROM crove_kernel.session_list(${input.userId}::uuid)`.execute(ctx.trx);
    return rows.map((r) => ({
      sessionId: r.session_id,
      status: r.status,
      firstSeenAt: r.first_seen_at.toISOString(),
      lastSeenAt: r.last_seen_at.toISOString(),
      revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    }));
  },
});

// The legal entities a stream may hear about (#1692): '*' for every entity of the org, else the ids its context's
// le_scope names (none for an empty or missing scope, which is deny, never "everything").
export type StreamLegalEntities = '*' | string[];

// The re-check of an open invalidation stream (issue #69): the same session check (for the org), context entry and
// membership as every other read, returning the caller's role and the legal-entity scope of its sealed context, by
// which the API drops the hints of entity-scoped rows outside it (#1692), and whether the caller reads the org's shared
// notes, by which it drops the hints of other members' shared notes (#1753). Runs every STREAM_RECHECK_SECONDS per
// stream.
export const streamCheck = defineQuery({
  name: 'kernel.stream.check',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) => {
    // shared_notes is note_read's rule for a shared note of another author (20261103130000_crove_notes_core.sql):
    // owners, admins and members whose scope is the whole org, as the policy reads tenant_member in this context. A
    // migration that changes note_read changes this too: stream-notes-audience.db.test.ts compares the two for each
    // role and for a member limited to one entity, and fails when they drift apart.
    const { rows } = await sql<{ scope: string[] | null; shared_notes: boolean | null }>`
      SELECT crove_kernel.ctx_le_scope() AS scope,
             '*' = ANY (crove_kernel.ctx_le_scope()::text[]) AND EXISTS (
               SELECT 1 FROM crove_kernel.tenant_member m
               WHERE m.org_id = crove_kernel.ctx_org_id() AND m.user_id = crove_kernel.ctx_user_id()
                 AND m.role IN ('owner', 'admin', 'member')) AS shared_notes`.execute(ctx.trx);
    // As stored by enter_context (uuid::text); the API refuses anything that is not an id (streamScopeOf).
    const scope = rows[0]?.scope ?? [];
    const legalEntities: StreamLegalEntities = scope.includes('*') ? '*' : scope;
    return { role: ctx.role, legalEntities, sharedNotes: rows[0]?.shared_notes === true };
  },
});

// overview: the home screen's figures of the modules this deployment enables (#1261), from the composition root.
export function kernelQueries(options: OrgDetailOptions & { overview?: readonly OverviewContribution[] }) {
  return [orgDetailQuery(options), orgOverviewQuery({ contributions: options.overview ?? [] }), streamCheck, inboxList, inboxGet, filesRecent, inboundRecent, inboundText, fileGet, ...archiveQueries, sessionsList, ...inviteQueries, ...offboardingQueries, ...agentQueries, ...channelQueries, ...mailQueries, ...proposalReminderQueries, ...taxCalendarQueries, ...legalEntityQueries, ...numberingQueries, ...roleQueries, ...calendarQueries, ...timelineQueries, ...auditLogQueries, ...personalDataQueries, ...partyQueries, ...notificationQueries, ...inboxItemQueries, ...usageQueries];
}
