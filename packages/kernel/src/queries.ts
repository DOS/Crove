import { z } from 'zod';
import { sql } from 'kysely';
import {
  zId,
  zLocalDate,
  zMoney,
  zProposalStatus,
  zPurchaseProposal,
  type PurchaseProposal,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { EDITOR_ROLES, decideApproval } from './approval.ts';
import { MAX_EXTRACTION_VERSIONS, REEXTRACT_STALE_MINUTES, latestExtraction } from './extraction.ts';
import { inviteQueries } from './invites.ts';

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
      const members = await ctx.trx
        .selectFrom('crove_kernel.tenant_member as m')
        .innerJoin('crove_kernel.user_account as u', 'u.id', 'm.user_id')
        .select(['m.user_id', 'u.email', 'u.display_name', 'm.role'])
        .where('m.org_id', '=', ctx.orgId)
        .orderBy('m.created_at')
        .execute();
      return {
        orgId: tenant.org_id,
        slug: tenant.slug,
        name: tenant.name,
        role: ctx.role ?? 'viewer',
        inboundAddress:
          options.inboundDomain && (ctx.role === 'owner' || ctx.role === 'admin') ? `${tenant.inbound_token}@${options.inboundDomain}` : null,
        members: members.map((m) => ({ userId: m.user_id, email: m.email, displayName: m.display_name, role: m.role })),
      };
    },
  });
}

function countChecks(payload: PurchaseProposal | null, status: 'fail' | 'warn'): number {
  return payload?.checks.filter((c) => c.status === status).length ?? 0;
}

function parsePayload(raw: unknown): PurchaseProposal | null {
  const result = zPurchaseProposal.safeParse(raw);
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
  const payload = parsePayload(row.payload);
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
    const result = row.result as { documentId?: string; journalEntryId?: string } | null;
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
    const canChange = row.status === 'pending' && editor && !reading;
    return {
      ...toInboxItem(row),
      revision: row.revision,
      payload: parsePayload(row.payload),
      error: null,
      file: file ? { id: file.id, filename: file.filename, contentType: file.content_type, sizeBytes: file.size_bytes } : null,
      decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
      decisionNote: row.decision_note,
      result: result?.documentId && result.journalEntryId ? { documentId: result.documentId, journalEntryId: result.journalEntryId } : null,
      canApprove: approval.reason === 'ok' && !reading,
      approveReason: approval.reason,
      canEdit: canChange,
      canReject: canChange,
      extraction: latest
        ? { version: latest.version, status: latest.status, error: latest.error, inFlight: reading, proposalVersion: own?.version ?? null }
        : null,
      // The same checks kernel.file.reextract makes.
      canReextract: editor && latest !== undefined && !reading && row.status !== 'executed' && latest.version < MAX_EXTRACTION_VERSIONS,
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
        error: r.extraction_status === 'failed' ? r.error : null,
        proposalId: r.proposal_id,
        version: r.version ?? null,
        // The same checks kernel.file.reextract makes.
        canReextract:
          editor && Boolean(r.extraction_status) && !r.in_flight && r.proposal_status !== 'executed' && (r.version ?? 0) < MAX_EXTRACTION_VERSIONS,
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
      .select(['id', 'filename', 'content_type', 'storage_key', 'size_bytes'])
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
  return [orgDetailQuery(options), inboxList, inboxGet, filesRecent, fileGet, sessionsList, ...inviteQueries];
}
