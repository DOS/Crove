import { z } from 'zod';
import { sql } from 'kysely';
import {
  zId,
  zJournalReversal,
  zLocalDate,
  zMoney,
  zProposalStatus,
  zPurchaseProposal,
  type JournalReversal,
  type PurchaseProposal,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { EDITOR_ROLES, decideApproval, proposalEditable } from './approval.ts';
import { MAX_EXTRACTION_VERSIONS, REEXTRACT_STALE_MINUTES, STALE_RUN_ERROR, executedButVoided, latestExtraction } from './extraction.ts';
import { agentQueries } from './agents.ts';
import { inviteQueries } from './invites.ts';
import { offboardingQueries } from './offboarding.ts';
import { memberProfiles } from './profiles.ts';

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
        .select(['org_id', 'slug', 'name', 'inbound_token'])
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

function toInboxItem(row: {
  id: string;
  kind: string;
  status: z.infer<typeof zProposalStatus>;
  title: string;
  payload: unknown;
  duplicate_of: string | null;
  created_at: Date;
}) {
  const payload = parsePayload(row.kind, row.payload);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    sellerName: payload?.seller.name ?? null,
    total: payload?.invoice.total ?? null,
    issueDate: payload?.invoice.issueDate ?? null,
    failedChecks: countChecks(payload, 'fail'),
    warnChecks: countChecks(payload, 'warn'),
    duplicateOf: row.duplicate_of,
    createdAt: row.created_at.toISOString(),
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
      .select(['id', 'kind', 'status', 'title', 'duplicate_of', 'created_at'])
      .select([
        sql<string | null>`left(payload #>> '{seller,name}', 500)`.as('seller_name'),
        sql<string | null>`left(payload #>> '{invoice,total}', 30)`.as('total'),
        sql<string | null>`left(payload #>> '{invoice,issueDate}', 10)`.as('issue_date'),
        countChecksSql('fail').as('failed_checks'),
        countChecksSql('warn').as('warn_checks'),
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
      sellerName: row.seller_name,
      total: row.total && zMoney.safeParse(row.total).success ? row.total : null,
      issueDate: row.issue_date && zLocalDate.safeParse(row.issue_date).success ? row.issue_date : null,
      failedChecks: Number(row.failed_checks),
      warnChecks: Number(row.warn_checks),
      duplicateOf: row.duplicate_of,
      createdAt: row.created_at.toISOString(),
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
    const result = row.result as { documentId?: string; journalEntryId?: string; reversedEntryId?: string; voidedDocumentId?: string } | null;
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
    const canChange = row.status === 'pending' && editor && !reading;
    // The purchase this proposal recorded was voided by a reversal (#165); its file may then be read again.
    const voided = await executedButVoided(ctx, row);
    const newestReopened = newest?.id === row.id ? voided : await executedButVoided(ctx, newest);
    return {
      ...toInboxItem(row),
      revision: row.revision,
      payload: parsePayload(row.kind, row.payload),
      reversal: parseReversal(row.kind, row.payload),
      error: null,
      file: file ? { id: file.id, filename: file.filename, contentType: file.content_type, sizeBytes: file.size_bytes } : null,
      decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
      decisionNote: row.decision_note,
      result: result?.journalEntryId
        ? {
            journalEntryId: result.journalEntryId,
            ...(result.documentId ? { documentId: result.documentId } : {}),
            ...(result.reversedEntryId ? { reversedEntryId: result.reversedEntryId } : {}),
            ...(result.voidedDocumentId ? { voidedDocumentId: result.voidedDocumentId } : {}),
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
  handler: async (ctx) => {
    // Per file: its newest extraction run and its newest proposal (a file read again after a rejection has more
    // than one).
    const rows = await ctx.trx
      .selectFrom('crove_kernel.file as f')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('crove_kernel.extraction as x')
            .select([
              'x.status',
              'x.error',
              'x.version',
              sql<boolean>`x.status = 'pending' AND x.created_at > pg_catalog.now() - pg_catalog.make_interval(mins => ${REEXTRACT_STALE_MINUTES}::int)`.as(
                'in_flight',
              ),
            ])
            .whereRef('x.org_id', '=', 'f.org_id')
            .whereRef('x.file_id', '=', 'f.id')
            .orderBy('x.version', 'desc')
            .limit(1)
            .as('e'),
        (join) => join.onTrue(),
      )
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('crove_kernel.proposal as q')
            .select(['q.id', 'q.status', 'q.duplicate_of'])
            // An executed purchase whose document was voided by a reversal (#165) may be read again.
            .select(({ exists, selectFrom }) =>
              exists(
                selectFrom('crove_finance.purchase_document as d')
                  .innerJoin('crove_finance.purchase_document_void as v', (join) =>
                    join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'),
                  )
                  .select('d.id')
                  .whereRef('d.org_id', '=', 'q.org_id')
                  .whereRef('d.proposal_id', '=', 'q.id'),
              ).as('voided'),
            )
            .whereRef('q.org_id', '=', 'f.org_id')
            .whereRef('q.source_file_id', '=', 'f.id')
            .orderBy('q.created_at', 'desc')
            .orderBy('q.id', 'desc')
            .limit(1)
            .as('p'),
        (join) => join.onTrue(),
      )
      .select([
        'f.id',
        'f.filename',
        'f.content_type',
        'f.created_at',
        'e.status as extraction_status',
        'e.error',
        'e.version',
        'e.in_flight',
        'p.id as proposal_id',
        'p.status as proposal_status',
        'p.duplicate_of',
        'p.voided',
      ])
      .where('f.org_id', '=', ctx.orgId)
      .orderBy('f.created_at', 'desc')
      .limit(50)
      .execute();
    const editor = ctx.actor.type === 'user' && ctx.role !== null && EDITOR_ROLES.includes(ctx.role);
    return rows.map((r) => {
      const status =
        !r.extraction_status || r.in_flight
          ? ('processing' as const)
          : r.proposal_id
            ? r.duplicate_of
              ? ('duplicate' as const)
              : ('proposed' as const)
            : ('failed' as const);
      return {
        id: r.id,
        filename: r.filename,
        contentType: r.content_type,
        status,
        error: r.extraction_status === 'failed' ? r.error : r.extraction_status === 'pending' && !r.in_flight ? STALE_RUN_ERROR : null,
        proposalId: r.proposal_id,
        version: r.version ?? null,
        // The same checks kernel.file.reextract makes.
        canReextract:
          editor &&
          Boolean(r.extraction_status) &&
          !r.in_flight &&
          (r.proposal_status !== 'executed' || r.voided === true) &&
          (r.version ?? 0) < MAX_EXTRACTION_VERSIONS,
        createdAt: r.created_at.toISOString(),
      };
    });
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

export function kernelQueries(options: OrgDetailOptions) {
  return [orgDetailQuery(options), inboxList, inboxGet, filesRecent, fileGet, sessionsList, ...inviteQueries, ...offboardingQueries, ...agentQueries];
}
