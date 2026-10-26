// Per-org abuse limits (#675, plan §4.12): how much one org may use in any 24 hours of inbound email, attachment
// bytes, extraction pages and AI cost, so one org cannot spend the whole deployment's AI budget or flood the shared
// extraction queue (#432 made it fair, not bounded). The worker asks kernel.usage.over before it files a message or
// reads a document, and records what it used with kernel.usage.record. An item over a limit is never dropped: the
// worker keeps it, records a deferral (kernel.usage.defer) and tries it again once enough of the window has passed;
// the org's owners get one mail per metric in any 24 hours. Counted in crove_kernel.org_usage, a sliding window like
// the auth email budget.
import { sql } from 'kysely';
import { z } from 'zod';
import { USAGE_DEFERRAL_SUBJECTS, USAGE_METRICS, type UsageMetric } from '@crove/db';
import { defineCommand, defineQuery } from '@crove/kernel-runtime';
import { createMailMessage } from './mail.ts';

export const USAGE_DEFERRED_TEMPLATE = 'kernel.usage.deferred';
// The window every limit counts over, in hours.
export const USAGE_WINDOW_HOURS = 24;

// The limit of each metric over the window: attachment bytes in bytes, AI cost in the deployment's price unit
// (AI_PRICE_*), as a decimal string.
export type UsageLimits = Record<UsageMetric, string>;

// Defaults for one small or medium business: far above a normal day of invoices, low enough that one org cannot use
// the deployment's whole AI budget. ai_cost counts only once AI prices are configured.
export const DEFAULT_USAGE_LIMITS: UsageLimits = {
  inbound_emails: '300',
  attachment_bytes: String(1000 * 1024 * 1024),
  extraction_pages: '1500',
  ai_cost: '20',
};

const zAmount = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/);
const zMetric = z.enum(USAGE_METRICS);

export interface UsageOver {
  metric: UsageMetric;
  used: string;
  limit: string;
  // When enough of the window has passed for the org to be under the limit again.
  retryAt: string;
}

// The first of the metrics the org is at or over its limit on, with when it falls back under; null when it is under
// all of them. A check before use: one item may take an org past a limit, the next one waits.
export const usageOver = defineQuery({
  name: 'kernel.usage.over',
  input: z.strictObject({ metrics: z.array(zMetric).min(1).max(USAGE_METRICS.length), limits: z.partialRecord(zMetric, zAmount) }),
  access: 'system',
  handler: async (ctx, input): Promise<UsageOver | null> => {
    for (const metric of input.metrics) {
      const limit = input.limits[metric];
      if (limit === undefined) continue;
      // The rows of the window, oldest first, with the running total: the org is back under the limit once the rows up
      // to the first one whose removal leaves less than the limit have left the window.
      const { rows } = await sql<{ used: string; over: boolean; retry_at: Date | null }>`
        WITH w AS (
          SELECT created_at, amount,
                 sum(amount) OVER (ORDER BY created_at, id) AS prefix,
                 sum(amount) OVER () AS total
          FROM crove_kernel.org_usage
          WHERE org_id = ${ctx.orgId} AND metric = ${metric}
            AND created_at > pg_catalog.now() - pg_catalog.make_interval(hours => ${USAGE_WINDOW_HOURS}::int)
        )
        SELECT (SELECT coalesce(max(total), 0)::text FROM w) AS used,
               (SELECT coalesce(max(total), 0) >= ${limit}::numeric FROM w) AS over,
               (SELECT created_at + pg_catalog.make_interval(hours => ${USAGE_WINDOW_HOURS}::int) FROM w
                WHERE total - prefix < ${limit}::numeric ORDER BY created_at LIMIT 1) AS retry_at`.execute(ctx.trx);
      const row = rows[0];
      if (!row?.over || !row.retry_at) continue;
      return { metric, used: row.used, limit, retryAt: row.retry_at.toISOString() };
    }
    return null;
  },
});

// What the worker used for one item. Amounts of zero are left out.
export const usageRecord = defineCommand({
  name: 'kernel.usage.record',
  input: z.strictObject({ entries: z.array(z.strictObject({ metric: zMetric, amount: zAmount })).min(1).max(USAGE_METRICS.length) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    const values = input.entries.filter((e) => /[1-9]/.test(e.amount)).map((e) => ({ org_id: ctx.orgId, metric: e.metric, amount: e.amount }));
    if (values.length > 0) await ctx.trx.insertInto('crove_kernel.org_usage').values(values).execute();
    return { recorded: values.length };
  },
});

const METRIC_LABELS: Record<UsageMetric, string> = {
  inbound_emails: 'số email nhận',
  attachment_bytes: 'dung lượng tệp đính kèm',
  extraction_pages: 'số trang đọc chứng từ',
  ai_cost: 'chi phí AI',
};

// An item kept for later because its org is over a limit. The owners are mailed at most once per metric in any 24
// hours, under a per-org lock so two jobs deferring at once send one mail.
export const usageDefer = defineCommand({
  name: 'kernel.usage.defer',
  input: z.strictObject({
    metric: zMetric,
    subjectType: z.enum(USAGE_DEFERRAL_SUBJECTS),
    subjectId: z.string().min(1).max(100),
    retryAt: z.iso.datetime({ offset: true }),
  }),
  // It queues the next day's mail (plan §4.7: a send derives R2; #1563). A system command, so the job runs as before.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input) => {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.usage_deferral:${ctx.orgId}:${input.metric}`}, 0))`.execute(ctx.trx);
    const told = await ctx.trx
      .selectFrom('crove_kernel.usage_deferral')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('metric', '=', input.metric)
      .where('notified', '=', true)
      .where(sql<boolean>`created_at > pg_catalog.now() - pg_catalog.make_interval(hours => ${USAGE_WINDOW_HOURS}::int)`)
      .limit(1)
      .executeTakeFirst();
    let queued = 0;
    if (!told) {
      const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
      const owners = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('role', '=', 'owner').orderBy('user_id').execute();
      const ids = owners.map((o) => o.user_id);
      const { rows: people } = ids.length
        ? await sql<{ user_id: string; email: string | null }>`SELECT user_id, email FROM crove_kernel.member_emails(${ids}::uuid[])`.execute(ctx.trx)
        : { rows: [] };
      for (const person of people) {
        if (!person.email) continue;
        const mail = await createMailMessage(ctx, {
          stream: 'transactional',
          source: 'kernel.usage.defer',
          sourceId: null,
          templateKey: USAGE_DEFERRED_TEMPLATE,
          to: person.email,
          subject: `Tổ chức đã dùng hết hạn mức ${METRIC_LABELS[input.metric]} trong ngày`,
          payload: { metric: input.metric, org: org.name, retryAt: input.retryAt, path: `/o/${org.slug}/inbox` },
          status: 'queued',
        });
        if (mail.status === 'queued') queued++;
      }
    }
    // The org's owners count as told even when none had an address: the audit row says how many were mailed.
    await ctx.trx
      .insertInto('crove_kernel.usage_deferral')
      .values({
        org_id: ctx.orgId,
        metric: input.metric,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        retry_at: input.retryAt,
        notified: !told,
      })
      .execute();
    if (input.subjectType === 'file') {
      await ctx.activity('kernel.file', input.subjectId, 'file.deferred', `Chờ hạn mức ngày mai: tổ chức đã dùng hết ${METRIC_LABELS[input.metric]} trong ngày`);
    }
    ctx.audit({ metric: input.metric, subjectType: input.subjectType, retryAt: input.retryAt, mailed: queued });
    return { notified: !told, queued };
  },
});

export const usageCommands = [usageRecord, usageDefer];
export const usageQueries = [usageOver];
