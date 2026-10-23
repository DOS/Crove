// The weekly email digest for the team (#1104), as Buffer, Later and Sprout send on Monday morning: last week's posts
// per channel, the three with the most engagement and the failures; this week's posts per day, the queue days still
// empty, and for owners and admins the posts waiting for their review.
//
// The worker's hourly sweep pages through crove_social.digest_due (active orgs with Social activity, past Monday 08:00
// in their zone, without a marker for that week) and runs social.digest.send for each in the org's system context.
// The command works the zone and the ISO week out again from its own clock, in its transaction, with the same rule as
// the scan (the org-wide goal's zone, else a report schedule's, else Asia/Ho_Chi_Minh; only a zone PostgreSQL knows),
// checks it is past Monday 08:00 and that the database's clock is in the same ISO week (so a skew between the two
// clocks can never send last week after this one, or claim next week early: it only delays), and claims the week with INSERT ... ON CONFLICT (org_id, iso_week) DO NOTHING: only
// the command whose row went in queues the mails, so two sweeps at once send one digest. One mail per recipient
// through the kernel's queued mail (the suppression list, the mail log), source social.digest.week and source_id the
// marker's id.
//
// Recipients: the owners, admins and members (never viewers) who have not turned the digest off (a weekly_digest mute)
// or Social mail off. A member limited to some channels (#1081) reads only those; the review part is only for those
// who may approve (owners and admins), without the posts they already approved or may not approve (their own, on a
// four-eyes channel, #740). Nobody gets an empty mail. Links are app paths built here; nothing secret is in the mail.
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '@crove/db';
import { createMailMessage } from '@crove/kernel';
import { DomainError, defineCommand, type CommandContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { approvalsInRound } from './domain/approval.ts';
import { digestFor, emptyQueueDays, type DigestContent, type DigestReviewItem, type DigestWeekData } from './domain/digest.ts';
import type { QueueSpec } from './domain/queue.ts';
import { decisionsOf, fourEyesOn } from './policy.ts';
import { SLOT_FREED } from './variants.ts';

const ACTOR: SystemActor = { type: 'system', component: 'social.digest' };
// How often the worker looks for orgs whose digest is due, and how many it reads per page of the scan.
export const DIGEST_SWEEP_MS = 60 * 60_000;
export const DIGEST_PAGE = 200;
// The most pages one pass reads (100,000 orgs); the next pass starts from the first again.
export const DIGEST_MAX_PAGES = 500;
export const DIGEST_MAIL_TEMPLATE = 'social.digest';
export const DIGEST_MAIL_SOURCE = 'social.digest.week';
export const DIGEST_KIND = 'weekly_digest';
// The zone when the org names none PostgreSQL knows.
export const DIGEST_DEFAULT_ZONE = 'Asia/Ho_Chi_Minh';
// The most rows each part of the week reads; an org posting more still gets its digest, from these.
const SCAN_MAX = 5000;
const REVIEW_SCAN_MAX = 500;
const TEXT_MAX = 120;

export type DigestState = 'not_due' | 'claimed' | 'sent';

const textOf = (title: string | null, body: string | null) => {
  const flat = (title?.trim() || body || '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join('')}…` : flat;
};
const dayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

interface DigestWeek {
  zone: string;
  isoWeek: string;
  due: boolean;
  lastStart: Date;
  thisStart: Date;
  nextStart: Date;
  // The local dates of this week, Monday first, and last week's Monday.
  days: string[];
  lastMonday: string;
}

// The org's digest zone and week at the command's clock, by the scan's rule. Due only past Monday 08:00 local and when
// the database's now(), the scan's clock, falls in the same ISO week of that zone.
async function weekOf(ctx: CommandContext): Promise<DigestWeek> {
  const { rows } = await sql<{ zone: string; iso_week: string; db_week: string; due: boolean; last_start: Date; this_start: Date; next_start: Date; this_monday: string; last_monday: string }>`
    WITH zones AS MATERIALIZED (SELECT z.name FROM pg_catalog.pg_timezone_names z),
    picked AS (
      SELECT coalesce(
        (SELECT g.time_zone FROM crove_social.goal g WHERE g.org_id = ${ctx.orgId}::uuid AND g.connection_id IS NULL AND g.time_zone IN (SELECT zones.name FROM zones)),
        (SELECT s.time_zone FROM crove_social.report_schedule s WHERE s.org_id = ${ctx.orgId}::uuid AND s.time_zone IN (SELECT zones.name FROM zones) ORDER BY s.created_at, s.id LIMIT 1),
        ${DIGEST_DEFAULT_ZONE}::text) AS zone
    ),
    here AS (SELECT p.zone, pg_catalog.timezone(p.zone, ${ctx.now}::timestamptz) AS local_at FROM picked p)
    SELECT h.zone,
           pg_catalog.to_char(h.local_at, 'IYYY-"W"IW') AS iso_week,
           pg_catalog.to_char(pg_catalog.timezone(h.zone, pg_catalog.now()), 'IYYY-"W"IW') AS db_week,
           h.local_at >= pg_catalog.date_trunc('week', h.local_at) + interval '8 hours' AS due,
           pg_catalog.timezone(h.zone, pg_catalog.date_trunc('week', h.local_at) - interval '7 days') AS last_start,
           pg_catalog.timezone(h.zone, pg_catalog.date_trunc('week', h.local_at)) AS this_start,
           pg_catalog.timezone(h.zone, pg_catalog.date_trunc('week', h.local_at) + interval '7 days') AS next_start,
           pg_catalog.to_char(pg_catalog.date_trunc('week', h.local_at), 'YYYY-MM-DD') AS this_monday,
           pg_catalog.to_char(pg_catalog.date_trunc('week', h.local_at) - interval '7 days', 'YYYY-MM-DD') AS last_monday
    FROM here h`.execute(ctx.trx);
  const row = rows[0];
  // The query always answers one row.
  if (!row) throw new Error('digest week not resolved');
  const monday = Date.UTC(Number(row.this_monday.slice(0, 4)), Number(row.this_monday.slice(5, 7)) - 1, Number(row.this_monday.slice(8, 10)));
  const days = Array.from({ length: 7 }, (_, i) => new Date(monday + i * 86_400_000).toISOString().slice(0, 10));
  return { zone: row.zone, isoWeek: row.iso_week, due: row.due && row.iso_week === row.db_week, lastStart: row.last_start, thisStart: row.this_start, nextStart: row.next_start, days, lastMonday: row.last_monday };
}

// What happened last week and what is planned this week, on every channel of the org.
async function weekData(ctx: CommandContext, week: DigestWeek): Promise<DigestWeekData> {
  const org = ctx.orgId;
  const channelRows = await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['id', 'display_name', 'provider', 'status']).where('org_id', '=', org).execute();
  const channels = new Map(channelRows.map((c) => [c.id, { name: c.display_name, provider: c.provider }] as const));
  const [published, failures, planned] = await Promise.all([
    sql<{ variant_id: string; post_id: string; connection_id: string; title: string | null; body: string | null; status: string; metrics: Record<string, number> | null }>`
      SELECT v.id AS variant_id, v.post_id, v.channel_connection_id AS connection_id, coalesce(v.title, p.title) AS title,
             coalesce(v.body, p.body) AS body, v.status, s.metrics
      FROM crove_social.post_variant v
      JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
      LEFT JOIN LATERAL (
        SELECT m.metrics FROM crove_social.metric_snapshot m
        WHERE m.org_id = v.org_id AND m.variant_id = v.id
        ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
      ) s ON true
      WHERE v.org_id = ${org}::uuid AND v.status IN ('published', 'removed')
        AND v.published_at >= ${week.lastStart}::timestamptz AND v.published_at < ${week.thisStart}::timestamptz
      ORDER BY v.published_at, v.id
      LIMIT ${SCAN_MAX}::int`.execute(ctx.trx),
    sql<{ variant_id: string; post_id: string; connection_id: string; title: string | null; body: string | null }>`
      SELECT v.id AS variant_id, v.post_id, v.channel_connection_id AS connection_id, coalesce(v.title, p.title) AS title, coalesce(v.body, p.body) AS body
      FROM crove_social.post_variant v
      JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
      WHERE v.org_id = ${org}::uuid AND v.status IN ('failed', 'needs_attention')
        AND v.updated_at >= ${week.lastStart}::timestamptz AND v.updated_at < ${week.thisStart}::timestamptz
      ORDER BY v.updated_at DESC, v.id
      LIMIT ${SCAN_MAX}::int`.execute(ctx.trx),
    // The org's local day of each channel post planned this week.
    sql<{ connection_id: string; day: string }>`
      SELECT v.channel_connection_id AS connection_id,
             pg_catalog.to_char(pg_catalog.timezone(${week.zone}::text, coalesce(v.queue_slot_at, v.scheduled_at)), 'YYYY-MM-DD') AS day
      FROM crove_social.post_variant v
      WHERE v.org_id = ${org}::uuid AND v.status IN ('scheduled', 'publishing', 'processing', 'published')
        AND coalesce(v.queue_slot_at, v.scheduled_at) >= ${week.thisStart}::timestamptz
        AND coalesce(v.queue_slot_at, v.scheduled_at) < ${week.nextStart}::timestamptz
      LIMIT ${SCAN_MAX}::int`.execute(ctx.trx),
  ]);
  // The queues of active channels, not paused: their posting days left this week with no post.
  const queues = await ctx.trx
    .selectFrom('crove_social.queue as q')
    .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'q.org_id').onRef('c.id', '=', 'q.channel_connection_id'))
    .select(['q.id', 'q.channel_connection_id', 'q.time_zone'])
    .where('q.org_id', '=', org)
    .where('q.paused', '=', false)
    .where('c.status', '=', 'active')
    .execute();
  const emptyDays: { connectionId: string; days: string[] }[] = [];
  if (queues.length > 0) {
    const slots = await ctx.trx
      .selectFrom('crove_social.queue_slot')
      .select(['queue_id', 'weekday', 'minute', 'label_id'])
      .where('org_id', '=', org)
      .where(
        'queue_id',
        'in',
        queues.map((q) => q.id),
      )
      .where('active', '=', true)
      .execute();
    const held = await ctx.trx
      .selectFrom('crove_social.post_variant')
      .select(['channel_connection_id', 'queue_slot_at'])
      .where('org_id', '=', org)
      .where(
        'channel_connection_id',
        'in',
        queues.map((q) => q.channel_connection_id),
      )
      .where('queue_slot_at', '>', ctx.now)
      .where('queue_slot_at', '<=', week.nextStart)
      .where('status', 'not in', [...SLOT_FREED])
      .execute();
    for (const q of queues) {
      const spec: QueueSpec = { timeZone: q.time_zone, slots: slots.filter((s) => s.queue_id === q.id).map((s) => ({ weekday: s.weekday, minute: s.minute, labelId: s.label_id })) };
      const taken = held.filter((h) => h.channel_connection_id === q.channel_connection_id && h.queue_slot_at).map((h) => (h.queue_slot_at as Date).getTime());
      const days = emptyQueueDays(spec, taken, ctx.now.getTime(), week.nextStart.getTime() - 1);
      if (days.length > 0) emptyDays.push({ connectionId: q.channel_connection_id, days });
    }
  }
  return {
    channels,
    published: published.rows.map((r) => ({ variantId: r.variant_id, postId: r.post_id, connectionId: r.connection_id, text: textOf(r.title, r.body), removed: r.status === 'removed', metrics: r.metrics })),
    failures: failures.rows.map((r) => ({ variantId: r.variant_id, postId: r.post_id, connectionId: r.connection_id, text: textOf(r.title, r.body) })),
    planned: planned.rows.map((r) => ({ connectionId: r.connection_id, day: r.day })),
    days: week.days,
    emptyDays,
  };
}

// The posts waiting for review, per owner or admin: without those they approved in the current round, or that they
// may not approve (their own post on a four-eyes channel).
async function reviewsFor(ctx: CommandContext, approvers: readonly string[]): Promise<Map<string, DigestReviewItem[]>> {
  const out = new Map<string, DigestReviewItem[]>(approvers.map((u) => [u, []]));
  if (approvers.length === 0) return out;
  const rows = await ctx.trx
    .selectFrom('crove_social.post_variant as v')
    .innerJoin('crove_social.post as p', (j) => j.onRef('p.org_id', '=', 'v.org_id').onRef('p.id', '=', 'v.post_id'))
    .select(['v.id as variant_id', 'v.post_id', 'v.revision', 'v.content_hash', 'v.channel_connection_id', 'p.title', 'p.body', 'p.author_user_id'])
    .where('v.org_id', '=', ctx.orgId)
    .where('v.status', '=', 'in_review')
    .orderBy('v.review_since', 'asc')
    .orderBy('v.id', 'asc')
    .limit(REVIEW_SCAN_MAX)
    .execute();
  if (rows.length === 0) return out;
  const decisions = await decisionsOf(
    ctx.trx,
    ctx.orgId,
    rows.map((r) => r.variant_id),
  );
  const fourEyes = await fourEyesOn(ctx.trx, ctx.orgId, [...new Set(rows.map((r) => r.channel_connection_id))]);
  for (const user of approvers) {
    const seen = new Set<string>();
    const list = out.get(user) ?? [];
    for (const r of rows) {
      if (seen.has(r.post_id)) continue;
      if (r.author_user_id === user && fourEyes.has(r.channel_connection_id)) continue;
      if (approvalsInRound(decisions.get(r.variant_id) ?? [], { revision: r.revision, contentHash: r.content_hash }).includes(user)) continue;
      seen.add(r.post_id);
      list.push({ postId: r.post_id, text: textOf(r.title, r.body) });
    }
    out.set(user, list);
  }
  return out;
}

// The merge data of one mail: the content with each post's app path.
function payloadOf(content: DigestContent, org: { slug: string; name: string }, week: DigestWeek) {
  const base = `/o/${org.slug}/social`;
  const post = (postId: string) => `${base}/${postId}`;
  return {
    org: org.name,
    week: week.isoWeek,
    lastWeek: { from: week.lastMonday, to: week.days[0] ?? week.lastMonday },
    thisWeek: { from: week.days[0] ?? '', to: week.days[6] ?? '' },
    home: base,
    settings: `${base}/notifications`,
    last: {
      published: content.last.published,
      channels: content.last.channels,
      top: content.last.top.map((t) => ({ text: t.text, channel: t.channel, engagement: t.engagement, path: post(t.postId) })),
      failures: { total: content.last.failures.total, items: content.last.failures.items.map((f) => ({ text: f.text, channel: f.channel, path: post(f.postId) })) },
    },
    next: content.next,
    review: content.review ? { total: content.review.total, items: content.review.items.map((r) => ({ text: r.text, path: post(r.postId) })) } : null,
  };
}

export const digestSend = defineCommand({
  name: 'social.digest.send',
  input: z.strictObject({}),
  risk: 'R1',
  access: 'system',
  handler: async (ctx): Promise<{ state: DigestState; week: string; mails: number; suppressed: number }> => {
    const week = await weekOf(ctx);
    const none = { week: week.isoWeek, mails: 0, suppressed: 0 };
    if (!week.due) return { state: 'not_due', ...none };
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name', 'status']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (org?.status !== 'active') return { state: 'not_due', ...none };
    // The claim: one command per org and week gets the row, and only it sends.
    const marker = await ctx.trx
      .insertInto('crove_social.digest_week')
      .values({ org_id: ctx.orgId, iso_week: week.isoWeek, sent_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'iso_week']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!marker) return { state: 'claimed', ...none };
    const { rows: recipients } = await sql<{ user_id: string; role: string }>`
      SELECT m.user_id, m.role FROM crove_kernel.tenant_member m
      WHERE m.org_id = ${ctx.orgId}::uuid AND m.role IN ('owner', 'admin', 'member')
        AND NOT EXISTS (SELECT 1 FROM crove_social.notification_mute x WHERE x.org_id = m.org_id AND x.user_id = m.user_id AND x.kind = ${DIGEST_KIND})
        AND NOT EXISTS (SELECT 1 FROM crove_social.notification_mail_off o WHERE o.org_id = m.org_id AND o.user_id = m.user_id)
      ORDER BY m.user_id`.execute(ctx.trx);
    if (recipients.length === 0) return { state: 'sent', ...none };
    const ids = recipients.map((r) => r.user_id);
    const { rows: people } = await sql<{ user_id: string; email: string | null }>`
      SELECT user_id, email FROM crove_kernel.member_emails(${ids}::uuid[])`.execute(ctx.trx);
    const emails = new Map(people.filter((p) => p.email).map((p) => [p.user_id, p.email as string]));
    const data = await weekData(ctx, week);
    // A member's channel list (#1081); owners and admins are never limited.
    const limited = recipients.filter((r) => r.role === 'member').map((r) => r.user_id);
    const lists = new Map<string, Set<string>>();
    if (limited.length > 0) {
      const access = await ctx.trx.selectFrom('crove_social.channel_access').select(['user_id', 'channel_connection_id']).where('org_id', '=', ctx.orgId).where('user_id', 'in', limited).execute();
      for (const a of access) lists.set(a.user_id, (lists.get(a.user_id) ?? new Set<string>()).add(a.channel_connection_id));
    }
    const reviews = await reviewsFor(
      ctx,
      recipients.filter((r) => r.role === 'owner' || r.role === 'admin').map((r) => r.user_id),
    );
    const subject = `Bản tin tuần ${dayMonth(week.days[0] ?? '')} - ${dayMonth(week.days[6] ?? '')} của ${[...org.name.replace(/\s+/g, ' ').trim()].slice(0, 80).join('')}`;
    let mails = 0;
    let suppressed = 0;
    for (const r of recipients) {
      const email = emails.get(r.user_id);
      if (!email) continue;
      const content = digestFor(data, r.role === 'member' ? (lists.get(r.user_id) ?? null) : null, reviews.get(r.user_id) ?? null);
      if (!content) continue;
      const mail = await createMailMessage(ctx, {
        stream: 'transactional',
        source: DIGEST_MAIL_SOURCE,
        sourceId: marker.id,
        templateKey: DIGEST_MAIL_TEMPLATE,
        to: email,
        subject,
        payload: payloadOf(content, org, week),
        status: 'queued',
      });
      if (mail.status === 'queued') mails += 1;
      else suppressed += 1;
    }
    return { state: 'sent', ...none, mails, suppressed };
  },
});

// One pass over the orgs whose digest is due; returns how many sent theirs.
export async function sweepDigests(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  let after: string | null = null;
  let sent = 0;
  for (let page = 0; page < DIGEST_MAX_PAGES; page++) {
    const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_social.digest_due(${after}::uuid, ${DIGEST_PAGE}::int)`.execute(deps.workerDb);
    for (const row of rows) {
      try {
        const done = await deps.runtime.execute<{ state: DigestState }>('social.digest.send', {}, { actor: ACTOR, orgId: row.org_id });
        if (done.state === 'sent') sent += 1;
      } catch (error) {
        console.warn(`[social-digest] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
      }
    }
    const last = rows.at(-1);
    if (rows.length < DIGEST_PAGE || !last) break;
    after = last.org_id;
  }
  return sent;
}

export const digestCommands = [digestSend];
