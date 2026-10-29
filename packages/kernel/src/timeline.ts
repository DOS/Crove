// A document's timeline (#672): what happened to a proposal and everything it touched, oldest first (the newest
// TIMELINE_LIMIT entries when there are more). It reads the activity rows of the proposal, of the file it came from,
// of the records its approval produced (the document and journal entry in its result, which is where a later reversal
// leaves its "voided" and "reversed" entries), and of every record a command of the proposal named as its target. So
// received, read, proposed, edited, approved or rejected, recorded and reversed all show. Every member who can open
// the proposal can read it, minus the rows of records of legal entities outside the member's scope (activity's
// le_scope policy, #1716).
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, type TimelineEntry } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The most entries one timeline shows, and the most records it follows.
export const TIMELINE_LIMIT = 200;
const RECORD_LIMIT = 50;
// The records an executed proposal's result names (the same keys the Inbox reads), by the type their activity uses.
const RESULT_RECORDS: Record<string, string> = {
  documentId: 'finance.purchase_document',
  voidedDocumentId: 'finance.purchase_document',
  journalEntryId: 'finance.journal_entry',
  reversedEntryId: 'finance.journal_entry',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const proposalTimeline = defineQuery({
  name: 'kernel.proposal.timeline',
  input: z.object({ id: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<{ items: TimelineEntry[]; more: boolean }> => {
    const proposal = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select(['id', 'source_file_id', 'created_at', 'result'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (!proposal) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy đề xuất');
    // The records the proposal's commands acted on, from its creation on (audit_event_time_idx keeps the scan to that
    // time): its own command's row names it in proposal_id, the commands its edit and execution run in
    // detail.under_proposal (#1706). Only successful commands: a refused one changed nothing.
    const { rows: targets } = await sql<{ target_type: string; target_id: string }>`
      SELECT DISTINCT target_type, target_id FROM crove_kernel.audit_event
      WHERE org_id = ${ctx.orgId}::uuid AND occurred_at >= ${proposal.created_at}
        AND (proposal_id = ${proposal.id}::uuid OR detail ->> 'under_proposal' = ${proposal.id}::uuid::text)
        AND outcome = 'ok' AND target_type IS NOT NULL AND target_id IS NOT NULL
      LIMIT ${RECORD_LIMIT}`.execute(ctx.trx);
    const records = new Map<string, { type: string; id: string }>();
    const add = (type: string, id: string) => records.set(`${type}:${id}`, { type, id });
    add('kernel.proposal', proposal.id);
    if (proposal.source_file_id) add('kernel.file', proposal.source_file_id);
    for (const t of targets) add(t.target_type, t.target_id);
    const result = proposal.result && typeof proposal.result === 'object' && !Array.isArray(proposal.result) ? (proposal.result as Record<string, unknown>) : {};
    for (const [key, type] of Object.entries(RESULT_RECORDS)) {
      const id = result[key];
      if (typeof id === 'string' && UUID.test(id)) add(type, id.toLowerCase());
    }
    const list = [...records.values()];
    const { rows } = await sql<{ id: string; record_type: string; kind: string; summary: string; actor_id: string | null; agent_id: string | null; occurred_at: Date }>`
      SELECT a.id, a.record_type, a.kind, a.summary, a.actor_id, a.agent_id, a.occurred_at
      FROM crove_kernel.activity a
      JOIN unnest(${list.map((r) => r.type)}::text[], ${list.map((r) => r.id)}::uuid[]) AS r(record_type, record_id)
        ON a.record_type = r.record_type AND a.record_id = r.record_id
      WHERE a.org_id = ${ctx.orgId}::uuid
      ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT ${TIMELINE_LIMIT + 1}`.execute(ctx.trx);
    const shown = rows.slice(0, TIMELINE_LIMIT).reverse();
    // Names of the people while they are members (member_profiles answers only for members of the org), and of agents.
    const names = new Map<string, string>();
    const users = [...new Set(shown.map((r) => r.actor_id).filter((u): u is string => u !== null))];
    const agents = [...new Set(shown.map((r) => r.agent_id).filter((a): a is string => a !== null))];
    if (users.length > 0) {
      const { rows: people } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${users}::uuid[])`.execute(ctx.trx);
      for (const p of people) names.set(p.user_id, p.display_name ?? p.email);
    }
    if (agents.length > 0) {
      const found = await ctx.trx.selectFrom('crove_kernel.agent').select(['id', 'display_name']).where('org_id', '=', ctx.orgId).where('id', 'in', agents).execute();
      for (const a of found) names.set(a.id, a.display_name);
    }
    return {
      items: shown.map((r) => ({
        id: r.id,
        at: r.occurred_at.toISOString(),
        kind: r.kind,
        recordType: r.record_type,
        summary: r.summary,
        actorType: r.agent_id ? 'agent' : r.actor_id ? 'user' : 'system',
        actorName: names.get(r.agent_id ?? r.actor_id ?? '') ?? null,
      })),
      more: rows.length > TIMELINE_LIMIT,
    };
  },
});

export const timelineQueries = [proposalTimeline];
