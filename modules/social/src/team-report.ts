// The team report (#1058), for owners and admins on the Metrics tab: per member, over a period [from, to) of at most
// TEAM_REPORT_MAX_DAYS, the posts they created, sent to review, had approved, had published and let run past their due
// date, and per reviewer the decisions they made with the median time from submission to decision; for client review
// links, the median time to the client's answer. A read only query over what the module already records: the posts,
// the decision rows (post_approval), the audit rows of social.post.submit, the channels' publish times, the
// assignments (#640) and the clients' answers (review_feedback). Names come only from crove_kernel.member_profiles,
// which answers for members of the org; anyone else who appears (a member who left) is shown as left, without a name.
//
// The submission a decision answers is the latest successful social.post.submit of its post at or before it; a post
// that went to review when it was made (an import or a copy with submit) has none, and its creation stands for it.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { TEAM_REPORT_DST_SLACK_MS, TEAM_REPORT_MAX_DAYS, medianOrNull, type TeamMemberRow, type TeamReport } from './domain/team-report.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
// Members of these roles are listed even without anything in the period; a viewer only with something.
const LISTED: readonly string[] = ['owner', 'admin', 'member'];
const DAY_MS = 86_400_000;
const zInstant = z.iso.datetime({ offset: true });

const count = (v: string | number | null | undefined) => Number(v ?? 0);

export const teamReport = defineQuery({
  name: 'social.team.report',
  input: z.strictObject({ from: zInstant, to: zInstant }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<TeamReport> => {
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > TEAM_REPORT_MAX_DAYS * DAY_MS + TEAM_REPORT_DST_SLACK_MS) {
      throw new DomainError('TEAM_RANGE_INVALID', 422, `Khoảng ngày phải kết thúc sau ngày bắt đầu và dài tối đa ${TEAM_REPORT_MAX_DAYS} ngày`);
    }
    const org = ctx.orgId;
    const [created, submitted, approved, published, assigned, decisions, answers, members] = await Promise.all([
      sql<{ user_id: string; n: string }>`
        SELECT p.author_user_id AS user_id, pg_catalog.count(*) AS n FROM crove_social.post p
        WHERE p.org_id = ${org}::uuid AND p.author_user_id IS NOT NULL AND p.created_at >= ${from} AND p.created_at < ${to}
        GROUP BY p.author_user_id`.execute(ctx.trx),
      // On the org's audit rows of the period (audit_event_time_idx).
      sql<{ user_id: string; n: string }>`
        SELECT e.actor_id AS user_id, pg_catalog.count(DISTINCT e.target_id) AS n FROM crove_kernel.audit_event e
        WHERE e.org_id = ${org}::uuid AND e.occurred_at >= ${from} AND e.occurred_at < ${to}
          AND e.command = 'social.post.submit' AND e.outcome = 'ok' AND e.actor_type = 'user' AND e.actor_id IS NOT NULL
          AND e.target_type = 'social.post'
        GROUP BY e.actor_id`.execute(ctx.trx),
      sql<{ user_id: string; n: string }>`
        SELECT p.author_user_id AS user_id, pg_catalog.count(DISTINCT a.post_id) AS n FROM crove_social.post_approval a
        JOIN crove_social.post p ON p.org_id = a.org_id AND p.id = a.post_id
        WHERE a.org_id = ${org}::uuid AND a.decision = 'approved' AND a.created_at >= ${from} AND a.created_at < ${to}
          AND p.author_user_id IS NOT NULL
        GROUP BY p.author_user_id`.execute(ctx.trx),
      // A channel taken down later (#860) still went out.
      sql<{ user_id: string; n: string }>`
        SELECT p.author_user_id AS user_id, pg_catalog.count(DISTINCT v.post_id) AS n FROM crove_social.post_variant v
        JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
        WHERE v.org_id = ${org}::uuid AND v.status IN ('published', 'removed') AND v.published_at >= ${from} AND v.published_at < ${to}
          AND p.author_user_id IS NOT NULL
        GROUP BY p.author_user_id`.execute(ctx.trx),
      // Overdue: the due date has passed and no channel went out by it, so a post published late still counts.
      sql<{ user_id: string; assigned: string; overdue: string }>`
        SELECT p.assignee_user_id AS user_id, pg_catalog.count(*) AS assigned,
               pg_catalog.count(*) FILTER (WHERE p.due_at < pg_catalog.now() AND NOT EXISTS (
                 SELECT 1 FROM crove_social.post_variant v
                 WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status IN ('published', 'removed') AND v.published_at <= p.due_at
               )) AS overdue
        FROM crove_social.post p
        WHERE p.org_id = ${org}::uuid AND p.assignee_user_id IS NOT NULL AND p.due_at >= ${from} AND p.due_at < ${to} AND p.status <> 'cancelled'
        GROUP BY p.assignee_user_id`.execute(ctx.trx),
      // One decision per reviewer, post, verdict and moment: a decision on several channels writes a row per channel in
      // one transaction. The submissions are read once, for the decided posts, from the first one's creation on.
      sql<{ user_id: string; seconds: number }>`
        WITH d AS (
          SELECT DISTINCT a.decided_by, a.post_id, a.decision, a.created_at FROM crove_social.post_approval a
          WHERE a.org_id = ${org}::uuid AND a.created_at >= ${from} AND a.created_at < ${to}
        ), p AS (
          SELECT p.id, p.created_at FROM crove_social.post p
          WHERE p.org_id = ${org}::uuid AND p.id IN (SELECT d.post_id FROM d)
        ), s AS MATERIALIZED (
          SELECT e.target_id AS post_id, e.occurred_at FROM crove_kernel.audit_event e
          WHERE e.org_id = ${org}::uuid AND e.occurred_at >= (SELECT pg_catalog.min(p.created_at) FROM p) AND e.occurred_at < ${to}
            AND e.command = 'social.post.submit' AND e.outcome = 'ok' AND e.target_type = 'social.post'
            AND e.target_id IN (SELECT p.id FROM p)
        )
        SELECT d.decided_by AS user_id,
               pg_catalog.date_part('epoch', d.created_at - coalesce(
                 (SELECT pg_catalog.max(s.occurred_at) FROM s WHERE s.post_id = d.post_id AND s.occurred_at <= d.created_at), p.created_at))::float8 AS seconds
        FROM d JOIN p ON p.id = d.post_id`.execute(ctx.trx),
      // A client's first answer per link and post; only one given in the period counts.
      sql<{ verdict: string; seconds: number }>`
        WITH f AS (
          SELECT DISTINCT ON (f.link_id, f.post_id) f.link_id, f.verdict, f.created_at FROM crove_social.review_feedback f
          WHERE f.org_id = ${org}::uuid AND f.verdict IN ('approved', 'changes_requested') AND f.created_at < ${to}
          ORDER BY f.link_id, f.post_id, f.created_at, f.id
        )
        SELECT f.verdict, pg_catalog.date_part('epoch', f.created_at - l.created_at)::float8 AS seconds
        FROM f JOIN crove_social.review_link l ON l.org_id = ${org}::uuid AND l.id = f.link_id
        WHERE f.created_at >= ${from}`.execute(ctx.trx),
      ctx.trx.selectFrom('crove_kernel.tenant_member').select(['user_id', 'role']).where('org_id', '=', org).execute(),
    ]);

    const rows = new Map<string, TeamMemberRow>();
    const row = (userId: string): TeamMemberRow => {
      let r = rows.get(userId);
      if (!r) {
        r = { userId, name: null, left: true, created: 0, submitted: 0, approved: 0, published: 0, assigned: 0, overdue: 0, decisions: 0, decisionSeconds: null };
        rows.set(userId, r);
      }
      return r;
    };
    for (const m of members) if (LISTED.includes(m.role)) row(m.user_id);
    for (const r of created.rows) row(r.user_id).created = count(r.n);
    for (const r of submitted.rows) row(r.user_id).submitted = count(r.n);
    for (const r of approved.rows) row(r.user_id).approved = count(r.n);
    for (const r of published.rows) row(r.user_id).published = count(r.n);
    for (const r of assigned.rows) Object.assign(row(r.user_id), { assigned: count(r.assigned), overdue: count(r.overdue) });
    const waits = new Map<string, number[]>();
    for (const d of decisions.rows) waits.set(d.user_id, [...(waits.get(d.user_id) ?? []), Number(d.seconds)]);
    for (const [userId, seconds] of waits) Object.assign(row(userId), { decisions: seconds.length, decisionSeconds: medianOrNull(seconds) });

    // Names while they are members; anyone member_profiles does not answer for has left.
    const ids = [...rows.keys()];
    if (ids.length > 0) {
      const { rows: profiles } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${ids}::uuid[])`.execute(ctx.trx);
      for (const p of profiles) Object.assign(row(p.user_id), { name: p.display_name ?? p.email, left: false });
    }
    const list = [...rows.values()].sort((a, b) => Number(a.left) - Number(b.left) || (a.name ?? '').localeCompare(b.name ?? '', 'vi') || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

    const clientWaits = answers.rows.map((a) => Number(a.seconds));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      members: list,
      client: {
        answers: answers.rows.length,
        approved: answers.rows.filter((a) => a.verdict === 'approved').length,
        changesRequested: answers.rows.filter((a) => a.verdict === 'changes_requested').length,
        medianSeconds: medianOrNull(clientWaits),
      },
    };
  },
});

export const teamReportQueries = [teamReport];
