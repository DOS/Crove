// Scheduled client report mail (issue #704), as SocialPilot, Agorapulse, Sprout and Metricool schedule it: an agency
// sends each client the report of the week or the month without having to remember. Owners and admins set a schedule
// (weekly on a weekday or monthly on a day, at an hour of their time zone), the period each mail covers, the channels
// and up to 10 recipients. When it is due the worker runs it: one transactional mail per recipient is queued through
// the kernel's mail pipeline (Email E1b), with the period's headline numbers (and its monthly goals, #1056) as merge data. The link to the full
// report carries a secret token, so it is not in the queue: social.report_schedule.mint_link makes one per recipient
// when the mail goes out (the mail template calls it). Removing a schedule revokes the links it sent. "Send a test" mails the person
// who asks, for the latest period. A schedule has a report link's options (#1259): the agency's note, one label's posts
// (a campaign report, #1159), the audience (#1155), and the sections the report shows with how many best posts; the
// mail carries only the chosen sections' numbers, and each mail's link takes the options when it is minted.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zSocialReportSections, zSocialReportTopCount } from '@crove/kernel-contract';
import type { Db, MemberRole, SocialReportSection } from '@crove/db';
import { createMailMessage } from '@crove/kernel';
import { DomainError, defineCommand, defineQuery, type CommandContext, type Runtime } from '@crove/kernel-runtime';
import { isValidTimeZone } from './domain/queue.ts';
import { storedZone } from './zones.ts';
import { nextReportRun, reportPeriodAt, type ReportScheduleSpec } from './domain/report-schedule.ts';
import { audienceOf, newReportToken, reportTokenHash, zReportNote } from './report-links.ts';
import { reportGoals } from './goals.ts';
import { reportBrandingOf } from './report-branding.ts';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const REPORT_SCHEDULE_LIMIT = 5;
export const REPORT_RECIPIENTS_MAX = 10;
// Test sends a schedule allows per hour.
const TEST_SENDS_PER_HOUR = 5;
const DAY_MS = 86_400_000;
export const REPORT_MAIL_TEMPLATE = 'social.report';
// Goals one report mail lists at most; the report link shows them all.
export const REPORT_MAIL_GOALS_MAX = 20;
const MAIL_SOURCE = 'social.report_schedule.run';

const zSchedule = z.strictObject({
  name: z.string().trim().min(1).max(120),
  cadence: z.enum(['weekly', 'monthly']),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  monthDay: z.number().int().min(1).max(28).nullable().optional(),
  sendHour: z.number().int().min(0).max(23),
  timeZone: z.string().min(1).max(64),
  period: z.enum(['previous_week', 'previous_month', 'last_7_days', 'last_30_days']),
  connectionIds: z.array(zId).max(50),
  recipients: z.array(z.email().max(320)).min(1).max(REPORT_RECIPIENTS_MAX),
  paused: z.boolean().optional(),
  // The link options (#1259). Left out, a change keeps the schedule's own and a new one has none; null clears one.
  note: zReportNote.nullable().optional(),
  labelId: zId.nullable().optional(),
  includeAudience: z.boolean().optional(),
  sections: zSocialReportSections.nullable().optional(),
  topCount: zSocialReportTopCount.nullable().optional(),
});

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}
function requireSystem(ctx: CommandContext): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình nền mới gửi được báo cáo theo lịch');
}

const specOf = (r: { cadence: 'weekly' | 'monthly'; weekday: number | null; month_day: number | null; send_hour: number; time_zone: string }): ReportScheduleSpec => ({
  cadence: r.cadence,
  weekday: r.weekday,
  monthDay: r.month_day,
  sendHour: r.send_hour,
  timeZone: r.time_zone,
});

// Owners and admins create a schedule, or change one (scheduleId): its next send is worked out again from now.
export const reportScheduleSave = defineCommand({
  name: 'social.report_schedule.save',
  input: zSchedule.extend({ scheduleId: zId.optional() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    if (!isValidTimeZone(input.timeZone)) throw new DomainError('VALIDATION', 422, 'Múi giờ không hợp lệ');
    // As PostgreSQL spells it (#1115), so the digest's zone rule finds it.
    const timeZone = await storedZone(ctx.trx, input.timeZone);
    const weekly = input.cadence === 'weekly';
    const weekday = weekly ? (input.weekday ?? null) : null;
    const monthDay = weekly ? null : (input.monthDay ?? null);
    if (weekly ? weekday === null : monthDay === null) throw new DomainError('VALIDATION', 422, weekly ? 'Hãy chọn ngày trong tuần' : 'Hãy chọn ngày trong tháng');
    const recipients = [...new Set(input.recipients.map((r) => r.trim().toLowerCase()))];
    const ids = [...new Set(input.connectionIds)];
    if (ids.length > 0) {
      const found = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    }
    const spec: ReportScheduleSpec = { cadence: input.cadence, weekday, monthDay, sendHour: input.sendHour, timeZone };
    // The link options as saved: what the input says, else the schedule's own (a change) or none (a new one).
    const current = input.scheduleId
      ? await ctx.trx
          .selectFrom('crove_social.report_schedule')
          .select(['note', 'label_id', 'include_audience', 'sections', 'top_count'])
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', input.scheduleId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (input.scheduleId && !current) throw new DomainError('REPORT_SCHEDULE_NOT_FOUND', 404, 'Không tìm thấy lịch gửi báo cáo này');
    const labelId = input.labelId !== undefined ? input.labelId : (current?.label_id ?? null);
    if (labelId && labelId !== current?.label_id) {
      // Held until the commit, so the label cannot go between this check and the write (its FK cascades to the schedule).
      const label = await ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where('id', '=', labelId).forShare().executeTakeFirst();
      if (!label) throw new DomainError('LABEL_NOT_FOUND', 404, 'Không tìm thấy nhãn này');
    }
    const sections = input.sections !== undefined ? input.sections : (current?.sections ?? null);
    // With the sections chosen, the audience is theirs; without, the option or the schedule's own.
    const includeAudience = audienceOf(sections, input.includeAudience ?? (sections ? undefined : current?.include_audience));
    const note = input.note !== undefined ? input.note || null : (current?.note ?? null);
    const values = {
      name: input.name,
      cadence: input.cadence,
      weekday,
      month_day: monthDay,
      send_hour: input.sendHour,
      time_zone: timeZone,
      period: input.period,
      connection_ids: ids,
      recipients,
      paused: input.paused ?? false,
      note,
      label_id: labelId,
      include_audience: includeAudience,
      sections,
      top_count: input.topCount !== undefined ? input.topCount : (current?.top_count ?? null),
      next_run_at: new Date(nextReportRun(spec, ctx.now.getTime())),
      updated_at: ctx.now,
    };
    if (input.scheduleId) {
      const updated = await ctx.trx
        .updateTable('crove_social.report_schedule')
        .set(values)
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.scheduleId)
        .returning('id')
        .executeTakeFirst();
      if (!updated) throw new DomainError('REPORT_SCHEDULE_NOT_FOUND', 404, 'Không tìm thấy lịch gửi báo cáo này');
      ctx.audit({ schedule_id: updated.id, recipients: recipients.length });
      return { scheduleId: updated.id, nextRunAt: values.next_run_at.toISOString() };
    }
    // One at a time per org, so two saves cannot both pass the limit.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.report_schedule:${ctx.orgId}`}))`.execute(ctx.trx);
    const count = await ctx.trx.selectFrom('crove_social.report_schedule').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (Number(count.n) >= REPORT_SCHEDULE_LIMIT) throw new DomainError('REPORT_SCHEDULE_LIMIT', 409, `Mỗi tổ chức có tối đa ${REPORT_SCHEDULE_LIMIT} lịch gửi báo cáo`);
    const row = await ctx.trx
      .insertInto('crove_social.report_schedule')
      .values({ org_id: ctx.orgId, ...values, created_by: userId, created_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ schedule_id: row.id, recipients: recipients.length });
    return { scheduleId: row.id, nextRunAt: values.next_run_at.toISOString() };
  },
});

export const reportScheduleRemove = defineCommand({
  name: 'social.report_schedule.remove',
  input: z.strictObject({ scheduleId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const gone = await ctx.trx.deleteFrom('crove_social.report_schedule').where('org_id', '=', ctx.orgId).where('id', '=', input.scheduleId).returning('id').executeTakeFirst();
    if (!gone) throw new DomainError('REPORT_SCHEDULE_NOT_FOUND', 404, 'Không tìm thấy lịch gửi báo cáo này');
    // The links already mailed stop working with the schedule.
    const revoked = await ctx.trx
      .updateTable('crove_social.report_link')
      .set({ revoked_at: ctx.now, revoked_by: userId })
      .where('org_id', '=', ctx.orgId)
      .where('schedule_id', '=', gone.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    ctx.audit({ schedule_id: gone.id, links_revoked: Number(revoked.numUpdatedRows) });
    return { scheduleId: gone.id };
  },
});

interface ScheduleRow {
  id: string;
  name: string;
  cadence: 'weekly' | 'monthly';
  weekday: number | null;
  month_day: number | null;
  send_hour: number;
  time_zone: string;
  period: 'previous_week' | 'previous_month' | 'last_7_days' | 'last_30_days';
  connection_ids: string[];
  recipients: string[];
  created_by: string;
  note: string | null;
  label_id: string | null;
  sections: readonly SocialReportSection[] | null;
}

// A section of the schedule's report (#1259): in its own list, or every one when it has none.
const shows = (s: { sections: readonly SocialReportSection[] | null }, section: SocialReportSection) => s.sections === null || s.sections.includes(section);

export interface ReportHeadline {
  posts: number;
  reach: number;
  impressions: number;
  engagement: number;
}

// What went out in the period on the schedule's channels, with the totals of the latest counts (as the report link
// adds them up): posts, reach, impressions, and engagement (reactions, comments, shares, saves, clicks). Under a label
// (#1159, #1259), only the posts with it, as the report link counts them.
async function headline(ctx: CommandContext, start: Date, end: Date, ids: readonly string[], labelId: string | null): Promise<ReportHeadline> {
  const { rows } = await sql<{ posts: string; reach: string | null; impressions: string | null; engagement: string | null }>`
    WITH v AS (
      SELECT v.id, coalesce(s.metrics, '{}'::jsonb) AS metrics
      FROM crove_social.post_variant v
      LEFT JOIN LATERAL (
        SELECT m.metrics FROM crove_social.metric_snapshot m
        WHERE m.org_id = v.org_id AND m.variant_id = v.id
        ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
      ) s ON true
      WHERE v.org_id = ${ctx.orgId} AND v.status = 'published' AND v.published_at >= ${start} AND v.published_at < ${end}
        AND (cardinality(${ids}::uuid[]) = 0 OR v.channel_connection_id = ANY (${ids}::uuid[]))
        AND (${labelId}::uuid IS NULL OR EXISTS (
          SELECT 1 FROM crove_social.post_label pl WHERE pl.org_id = v.org_id AND pl.post_id = v.post_id AND pl.label_id = ${labelId}::uuid))
      LIMIT 5000
    ),
    n AS (
      SELECT e.key, (e.value #>> '{}')::numeric AS value FROM v, jsonb_each(v.metrics) e WHERE jsonb_typeof(e.value) = 'number'
    )
    SELECT (SELECT count(*) FROM v) AS posts,
           (SELECT sum(value) FROM n WHERE key = 'reach') AS reach,
           (SELECT sum(value) FROM n WHERE key = 'impressions') AS impressions,
           (SELECT sum(value) FROM n WHERE key IN ('reactions', 'comments', 'shares', 'saves', 'clicks')) AS engagement`.execute(ctx.trx);
  const r = rows[0];
  return { posts: Number(r?.posts ?? 0), reach: Number(r?.reach ?? 0), impressions: Number(r?.impressions ?? 0), engagement: Number(r?.engagement ?? 0) };
}

// Writes a run and queues one mail per recipient; returns the run and how many were queued and suppressed.
// Scheduled report mails one inbox may get in 24 hours from every org together (#735); one over is recorded as
// suppressed (recipient_daily_cap) and not sent. A test goes to its sender and is not counted.
export const REPORT_MAILS_PER_RECIPIENT_PER_DAY = 5;

async function queueRun(ctx: CommandContext, s: ScheduleRow, kind: 'scheduled' | 'test', period: { start: number; end: number }, recipients: readonly string[], createdBy: string | null) {
  const start = new Date(period.start);
  const end = new Date(period.end);
  const numbers = await headline(ctx, start, end, s.connection_ids, s.label_id);
  // Only the chosen sections' numbers (#1259): the posts always, the totals with theirs.
  const counts = shows(s, 'totals') ? numbers : { posts: numbers.posts };
  // The month's goals (#1056) when the period is exactly one month in the goals' zone, as the report shows them; none
  // under a label, as the report link (#1159), or without the goals section.
  const goals = s.label_id === null && shows(s, 'goals') ? await reportGoals(ctx.trx, ctx.orgId, start, end, s.connection_ids, ctx.now.getTime()) : null;
  const note = shows(s, 'note') && s.note ? s.note : null;
  // The sending org, named in the mail's footer.
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('name').where('org_id', '=', ctx.orgId).executeTakeFirst();
  const run = await ctx.trx
    .insertInto('crove_social.report_schedule_run')
    .values({ org_id: ctx.orgId, schedule_id: s.id, kind, period_start: start, period_end: end, created_by: createdBy, created_at: ctx.now })
    .returning('id')
    .executeTakeFirstOrThrow();
  let mails = 0;
  let suppressed = 0;
  // Gated in one order, sorted by address, so two runs holding inbox locks never wait on each other in a cycle.
  const capped = new Set<string>();
  if (kind === 'scheduled') {
    for (const to of [...recipients].sort()) {
      const gate = await sql<{ ok: boolean }>`SELECT crove_social.report_mail_recipient_gate(${to}, ${REPORT_MAILS_PER_RECIPIENT_PER_DAY}::int) AS ok`.execute(ctx.trx);
      if (gate.rows[0]?.ok !== true) capped.add(to);
    }
  }
  for (const to of recipients) {
    const mail = await createMailMessage(ctx, {
      stream: 'transactional',
      source: MAIL_SOURCE,
      sourceId: run.id,
      templateKey: REPORT_MAIL_TEMPLATE,
      to,
      subject: `Báo cáo mạng xã hội: ${s.name}`,
      payload: { name: s.name, periodStart: start.toISOString(), periodEnd: end.toISOString(), timeZone: s.time_zone, test: kind === 'test', ...(org?.name ? { orgName: org.name } : {}), ...counts, ...(note ? { note } : {}), ...(goals ? { goals: { month: goals.month, items: goals.goals.slice(0, REPORT_MAIL_GOALS_MAX) } } : {}) },
      ...(capped.has(to) ? { status: 'suppressed' as const, errorCode: 'recipient_daily_cap' } : { status: 'queued' as const }),
    });
    if (mail.status === 'suppressed') suppressed++;
    else mails++;
  }
  await ctx.trx.updateTable('crove_social.report_schedule_run').set({ mails, suppressed }).where('org_id', '=', ctx.orgId).where('id', '=', run.id).execute();
  return { runId: run.id, mails, suppressed };
}

const SCHEDULE_COLUMNS = ['id', 'name', 'cadence', 'weekday', 'month_day', 'send_hour', 'time_zone', 'period', 'connection_ids', 'recipients', 'created_by', 'note', 'label_id', 'include_audience', 'sections', 'top_count'] as const;

// The worker runs a due schedule: the period before the time it was due, every recipient, then the next send. A
// schedule paused, changed or already run since the scan finds nothing to do.
export const reportScheduleRun = defineCommand({
  name: 'social.report_schedule.run',
  input: z.strictObject({ scheduleId: zId }),
  // Queues mail through the kernel pipeline in its transaction: a send, an effect outside Crove (#1578).
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const s = await ctx.trx
      .selectFrom('crove_social.report_schedule')
      .select([...SCHEDULE_COLUMNS, 'paused', 'next_run_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.scheduleId)
      .forUpdate()
      .executeTakeFirst();
    if (!s || s.paused || s.next_run_at.getTime() > ctx.now.getTime()) return { ran: false as const };
    const due = s.next_run_at.getTime();
    const done = await queueRun(ctx, s, 'scheduled', reportPeriodAt(s.period, due, s.time_zone), s.recipients, null);
    // A send that ran late (the worker was down) is not repeated for each missed time: the next one is after now.
    const next = new Date(nextReportRun(specOf(s), Math.max(due, ctx.now.getTime())));
    await ctx.trx
      .updateTable('crove_social.report_schedule')
      .set({ last_run_at: ctx.now, next_run_at: next, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', s.id)
      .execute();
    ctx.audit({ schedule_id: s.id, run_id: done.runId, mails: done.mails, suppressed: done.suppressed });
    return { ran: true as const, ...done, nextRunAt: next.toISOString() };
  },
});

// An owner or admin sends the schedule's mail of the latest period to themselves.
export const reportScheduleTest = defineCommand({
  name: 'social.report_schedule.test',
  input: z.strictObject({ scheduleId: zId }),
  // Queues mail through the kernel pipeline in its transaction: a send, an effect outside Crove (#1578).
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const s = await ctx.trx.selectFrom('crove_social.report_schedule').select(SCHEDULE_COLUMNS).where('org_id', '=', ctx.orgId).where('id', '=', input.scheduleId).forUpdate().executeTakeFirst();
    if (!s) throw new DomainError('REPORT_SCHEDULE_NOT_FOUND', 404, 'Không tìm thấy lịch gửi báo cáo này');
    const recent = await ctx.trx
      .selectFrom('crove_social.report_schedule_run')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('schedule_id', '=', s.id)
      .where('kind', '=', 'test')
      .where('created_at', '>', new Date(ctx.now.getTime() - 3_600_000))
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= TEST_SENDS_PER_HOUR) throw new DomainError('REPORT_TEST_LIMIT', 429, 'Đã gửi thử nhiều lần trong một giờ; hãy thử lại sau');
    const { rows } = await sql<{ email: string | null }>`SELECT email FROM crove_kernel.member_profiles(${[userId]}::uuid[])`.execute(ctx.trx);
    const email = rows[0]?.email;
    if (!email) throw new DomainError('NO_EMAIL', 422, 'Tài khoản của bạn chưa có email để nhận thư thử');
    const done = await queueRun(ctx, s, 'test', reportPeriodAt(s.period, ctx.now.getTime(), s.time_zone), [email], userId);
    ctx.audit({ schedule_id: s.id, run_id: done.runId });
    return done;
  },
});

// The report link of one mail, made when the mail goes out (the mail template runs this in the worker): only for a
// mail of a schedule run that is being sent now, for the run's period and the schedule's channels, valid two weeks
// for a weekly schedule and six for a monthly one (a week for a test), with the schedule's note, label, audience,
// sections and best posts' count (#1259). The token leaves only in this answer.
export const reportScheduleMintLink = defineCommand({
  name: 'social.report_schedule.mint_link',
  input: z.strictObject({ messageId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const mail = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select(['source_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.messageId)
      .where('source', '=', MAIL_SOURCE)
      .where('status', '=', 'sending')
      .executeTakeFirst();
    if (!mail?.source_id) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy thư báo cáo đang gửi');
    const run = await ctx.trx
      .selectFrom('crove_social.report_schedule_run as r')
      .innerJoin('crove_social.report_schedule as s', (j) => j.onRef('s.org_id', '=', 'r.org_id').onRef('s.id', '=', 'r.schedule_id'))
      .select([
        'r.kind',
        'r.period_start',
        'r.period_end',
        'r.created_by',
        's.id as schedule_id',
        's.name',
        's.cadence',
        's.connection_ids',
        's.created_by as schedule_by',
        's.note',
        's.label_id',
        's.include_audience',
        's.sections',
        's.top_count',
      ])
      .where('r.org_id', '=', ctx.orgId)
      .where('r.id', '=', mail.source_id)
      .executeTakeFirst();
    if (!run) throw new DomainError('REPORT_SCHEDULE_NOT_FOUND', 404, 'Lịch gửi báo cáo này đã bị xóa');
    const days = run.kind === 'test' ? 7 : run.cadence === 'weekly' ? 14 : 42;
    const by = run.created_by ?? run.schedule_by;
    // One live link per mail: a send tried again (a retry, an unknown outcome sent again) revokes the try before's.
    await ctx.trx
      .updateTable('crove_social.report_link')
      .set({ revoked_at: ctx.now, revoked_by: by })
      .where('org_id', '=', ctx.orgId)
      .where('mail_message_id', '=', input.messageId)
      .where('revoked_at', 'is', null)
      .execute();
    const token = newReportToken();
    const expiresAt = new Date(ctx.now.getTime() + days * DAY_MS);
    await ctx.trx
      .insertInto('crove_social.report_link')
      .values({
        org_id: ctx.orgId,
        token_sha256: reportTokenHash(token),
        title: run.name,
        period_start: run.period_start,
        period_end: run.period_end,
        connection_ids: run.connection_ids,
        note: run.note,
        label_id: run.label_id,
        include_audience: run.include_audience,
        sections: run.sections,
        top_count: run.top_count,
        created_by: by,
        created_at: ctx.now,
        expires_at: expiresAt,
        schedule_id: run.schedule_id,
        mail_message_id: input.messageId,
      })
      .execute();
    // The org's white-label branding (#1053) for the mail's header and footer, read when it goes out; the logo stays on
    // the report page (the mailer sends no inline images).
    const brand = await reportBrandingOf(ctx.trx, ctx.orgId);
    return { token, expiresAt: expiresAt.toISOString(), brand: brand ? { name: brand.name, accent: brand.accent, hideCrove: brand.hideCrove } : null };
  },
});

export interface ReportScheduleView {
  id: string;
  name: string;
  cadence: 'weekly' | 'monthly';
  weekday: number | null;
  monthDay: number | null;
  sendHour: number;
  timeZone: string;
  period: 'previous_week' | 'previous_month' | 'last_7_days' | 'last_30_days';
  connectionIds: string[];
  recipients: string[];
  // The link options (#1259).
  note: string | null;
  labelId: string | null;
  includeAudience: boolean;
  sections: SocialReportSection[] | null;
  topCount: number | null;
  paused: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  // The latest sends, newest first, each with its mails' delivery status.
  runs: {
    id: string;
    kind: 'scheduled' | 'test';
    periodStart: string;
    periodEnd: string;
    createdAt: string;
    mails: { to: string | null; status: string; errorCode: string | null }[];
  }[];
}

export const reportScheduleList = defineQuery({
  name: 'social.report_schedule.list',
  input: z.object({}),
  access: ADMINS,
  handler: async (ctx): Promise<ReportScheduleView[]> => {
    const schedules = await ctx.trx
      .selectFrom('crove_social.report_schedule')
      .select([...SCHEDULE_COLUMNS, 'paused', 'next_run_at', 'last_run_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('created_at')
      .execute();
    if (schedules.length === 0) return [];
    const { rows: runs } = await sql<{ id: string; schedule_id: string; kind: 'scheduled' | 'test'; period_start: Date; period_end: Date; created_at: Date }>`
      SELECT r.id, r.schedule_id, r.kind, r.period_start, r.period_end, r.created_at FROM (
        SELECT r.*, row_number() OVER (PARTITION BY r.schedule_id ORDER BY r.created_at DESC) AS n
        FROM crove_social.report_schedule_run r WHERE r.org_id = ${ctx.orgId}
      ) r WHERE r.n <= 5 ORDER BY r.created_at DESC`.execute(ctx.trx);
    const mails =
      runs.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_kernel.mail_message')
            .select(['source_id', 'to_address', 'status', 'error_code'])
            .where('org_id', '=', ctx.orgId)
            .where('source', '=', MAIL_SOURCE)
            .where(
              'source_id',
              'in',
              runs.map((r) => r.id),
            )
            .orderBy('to_address')
            .execute();
    return schedules.map((s) => ({
      id: s.id,
      name: s.name,
      cadence: s.cadence,
      weekday: s.weekday,
      monthDay: s.month_day,
      sendHour: s.send_hour,
      timeZone: s.time_zone,
      period: s.period,
      connectionIds: s.connection_ids,
      recipients: s.recipients,
      note: s.note,
      labelId: s.label_id,
      includeAudience: s.include_audience,
      sections: s.sections,
      topCount: s.top_count,
      paused: s.paused,
      nextRunAt: s.next_run_at.toISOString(),
      lastRunAt: s.last_run_at?.toISOString() ?? null,
      runs: runs
        .filter((r) => r.schedule_id === s.id)
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          periodStart: r.period_start.toISOString(),
          periodEnd: r.period_end.toISOString(),
          createdAt: r.created_at.toISOString(),
          mails: mails.filter((m) => m.source_id === r.id).map((m) => ({ to: m.to_address, status: m.status, errorCode: m.error_code })),
        })),
    }));
  },
});

// A run that failed (#736): the schedule waits RETRY_MINUTES before it is tried again, so a schedule that keeps
// failing moves down the due scan instead of holding its head and starving the others. A run that ends sets the next
// time from the schedule as usual.
export const REPORT_SCHEDULE_RETRY_MINUTES = 30;
export const reportScheduleDefer = defineCommand({
  name: 'social.report_schedule.defer',
  input: z.strictObject({ scheduleId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const done = await sql<{ id: string }>`
      UPDATE crove_social.report_schedule
      SET next_run_at = pg_catalog.now() + pg_catalog.make_interval(mins => ${REPORT_SCHEDULE_RETRY_MINUTES}::int)
      WHERE org_id = ${ctx.orgId} AND id = ${input.scheduleId} AND NOT paused AND next_run_at <= pg_catalog.now()
      RETURNING id`.execute(ctx.trx);
    return { deferred: done.rows.length > 0 };
  },
});

// The worker looks for due schedules every 5 minutes, so a mail leaves within minutes of its hour.
export const REPORT_SCHEDULE_SWEEP_MS = 5 * 60_000;
const SWEEP_LIMIT = 50;
const SWEEP_ACTOR = { type: 'system' as const, component: 'social.report_schedule' };

// One pass: runs each due schedule in its org. Returns how many ran.
export async function sweepReportSchedules(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; schedule_id: string }>`SELECT org_id, schedule_id FROM crove_social.report_schedules_due(${SWEEP_LIMIT}::int)`.execute(deps.workerDb);
  let ran = 0;
  for (const row of rows) {
    try {
      const done = await deps.runtime.execute<{ ran: boolean }>('social.report_schedule.run', { scheduleId: row.schedule_id }, { actor: SWEEP_ACTOR, orgId: row.org_id });
      if (done.ran) ran += 1;
    } catch (error) {
      console.warn(`[social-report-schedule] ${row.schedule_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'ERROR');
      await deps.runtime.execute('social.report_schedule.defer', { scheduleId: row.schedule_id }, { actor: SWEEP_ACTOR, orgId: row.org_id }).catch(() => undefined);
    }
  }
  return ran;
}

export const reportScheduleCommands = [reportScheduleSave, reportScheduleRemove, reportScheduleRun, reportScheduleDefer, reportScheduleTest, reportScheduleMintLink];
export const reportScheduleQueries = [reportScheduleList];
