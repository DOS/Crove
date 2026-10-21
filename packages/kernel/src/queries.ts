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
import { offboardingQueries } from './offboarding.ts';
import { memberProfiles } from './profiles.ts';
import { orgOverview, RECENT_FILES } from './overview.ts';
import { proposalReminderQueries } from './proposal-reminders.ts';
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
        .select(['org_id', 'slug', 'name', 'inbound_token', 'tax_code', 'vat_filing_period', 'address', 'contact_email'])
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

function toInboxItem(row: {
  id: string;
  kind: string;
  status: z.infer<typeof zProposalStatus>;
  title: string;
  payload: unknown;
  duplicate_of: string | null;
  created_at: Date;
  extraction_id: string | null;
  requested_by_agent: string | null;
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
    ...agentFields(row, agentName),
  };
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
      .select(['id', 'kind', 'status', 'title', 'revision', 'duplicate_of', 'created_at', 'extraction_id', 'requested_by_agent'])
      .select([
        sql<string | null>`left(payload #>> '{seller,name}', 500)`.as('seller_name'),
        sql<boolean>`coalesce(payload ->> 'direction' = 'sale', false)`.as('is_sale'),
        sql<string | null>`left(payload #>> '{buyer,name}', 500)`.as('buyer_name'),
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
      total: row.total && zMoney.safeParse(row.total).success ? row.total : null,
      issueDate: row.issue_date && zLocalDate.safeParse(row.issue_date).success ? row.issue_date : null,
      failedChecks: Number(row.failed_checks),
      warnChecks: Number(row.warn_checks),
      signatureStatus: row.kind === PURCHASE_KIND ? signatureStatusOf(row.signature_status) : null,
      duplicateOf: row.duplicate_of,
      createdAt: row.created_at.toISOString(),
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
      extraction: latest
        ? { version: latest.version, status: latest.status, error: latest.error, inFlight: reading, proposalVersion: own?.version ?? null }
        : null,
      // The same checks kernel.file.reextract makes.
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

// The re-check of an open invalidation stream (issue #69): the same session check (for the org), context entry and
// membership as every other read, returning only the caller's role. Runs every STREAM_RECHECK_SECONDS per stream.
export const streamCheck = defineQuery({
  name: 'kernel.stream.check',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) => ({ role: ctx.role }),
});

export function kernelQueries(options: OrgDetailOptions) {
  return [orgDetailQuery(options), orgOverview, streamCheck, inboxList, inboxGet, filesRecent, fileGet, ...archiveQueries, sessionsList, ...inviteQueries, ...offboardingQueries, ...agentQueries, ...channelQueries, ...mailQueries, ...proposalReminderQueries, ...timelineQueries, ...auditLogQueries, ...personalDataQueries, ...partyQueries, ...notificationQueries, ...usageQueries];
}
