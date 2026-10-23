// Account growth of connected channels (#645): once a day per channel, the worker asks each adapter that can
// (accountMetrics) for the account's followers, and its reach over the last day where the platform gives it, and keeps
// the answer as that day's snapshot. A try that got no answer is kept too, with no counts, so the channel waits for the
// next day. The Metrics tab draws each channel's followers over 7, 30 or 90 days from these snapshots.
// Who follows the account (#1146) is asked for at most once a week per channel, within the same daily pass: the day's
// snapshot keeps it, and a week passes before the channel is asked again, also when the platform gave nothing.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zSocialAudience } from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import type { Publisher } from '@crove/channel';
import { DomainError, defineCommand, defineQuery, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { channelScope, connectionInScope } from './channel-access.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ACTOR: SystemActor = { type: 'system', component: 'social.accounts' };
// How often the worker looks for channels without today's snapshot, and how many it reads per pass.
export const ACCOUNT_SWEEP_MS = 60 * 60_000;
export const ACCOUNT_LIMIT = 200;

// A day as the snapshots keep it: the UTC date.
export const utcDay = (at: Date) => at.toISOString().slice(0, 10);
// How many days a channel's audience is kept before it is asked for again (#1146).
export const AUDIENCE_EVERY_DAYS = 7;

export type SocialAudience = z.infer<typeof zSocialAudience>;

const zCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

export const accountRecord = defineCommand({
  name: 'social.account.record',
  input: z.strictObject({
    connectionId: zId,
    capturedOn: z.iso.date(),
    followers: zCount.optional(),
    reach: zCount.optional(),
    // Who follows the account (#1146), when it was asked for: null when the platform gave nothing (kept as {} so the
    // channel waits a week all the same); absent when it was not asked.
    audience: zSocialAudience.nullable().optional(),
    error: z.enum(['no_answer', 'token_expired', 'permission']).optional(),
  }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    const connection = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).executeTakeFirst();
    if (!connection) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    const row = await ctx.trx
      .insertInto('crove_social.account_snapshot')
      .values({
        org_id: ctx.orgId,
        channel_connection_id: connection.id,
        captured_on: input.capturedOn,
        followers: input.followers === undefined || input.followers === null ? null : String(input.followers),
        reach: input.reach === undefined || input.reach === null ? null : String(input.reach),
        audience: input.audience === undefined ? null : JSON.stringify(input.audience ?? {}),
        error: input.error ?? null,
        captured_at: ctx.now,
      })
      .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id', 'captured_on']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return { recorded: Boolean(row) };
  },
});

export interface AccountPoint {
  day: string;
  followers: number | null;
  reach: number | null;
}
export interface AccountTrend {
  connectionId: string;
  provider: string;
  points: AccountPoint[];
  // The latest audience taken in the window (#1146), with its day; null when none was.
  audience: (SocialAudience & { day: string }) | null;
}

// Whether a channel's audience is due on a day (#1146): no snapshot of the AUDIENCE_EVERY_DAYS days up to it asked for
// one, whatever the platform answered.
export const accountAudienceDue = defineQuery({
  name: 'social.account.audience_due',
  input: z.strictObject({ connectionId: zId, day: z.iso.date() }),
  access: 'system',
  handler: async (ctx, input): Promise<{ due: boolean }> => {
    const { rows } = await sql<{ asked: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM crove_social.account_snapshot s
        WHERE s.org_id = ${ctx.orgId} AND s.channel_connection_id = ${input.connectionId} AND s.audience IS NOT NULL
          AND s.captured_on > ${input.day}::date - ${AUDIENCE_EVERY_DAYS}::int AND s.captured_on <= ${input.day}::date
      ) AS asked`.execute(ctx.trx);
    return { due: !rows[0]?.asked };
  },
});

// Each channel's snapshots from `days` days ago (UTC) to today, oldest first, so the first is the window's baseline and
// the change over 7 days is today against 7 days ago; days with no answer are left out.
export const accountTrends = defineQuery({
  name: 'social.account.trends',
  input: z.object({ days: z.number().int().min(1).max(366) }),
  access: ALL,
  handler: async (ctx, input): Promise<AccountTrend[]> => {
    // A member limited to some channels (#1081) sees those only.
    const scope = await channelScope(ctx);
    const { rows } = await sql<{ connection_id: string; provider: string; captured_on: string; followers: string | null; reach: string | null }>`
      SELECT s.channel_connection_id AS connection_id, c.provider, to_char(s.captured_on, 'YYYY-MM-DD') AS captured_on, s.followers, s.reach
      FROM crove_social.account_snapshot s
      JOIN crove_kernel.channel_connection c ON c.org_id = s.org_id AND c.id = s.channel_connection_id
      WHERE s.org_id = ${ctx.orgId}
        AND s.captured_on >= (pg_catalog.now() AT TIME ZONE 'UTC')::date - ${input.days}::int
        AND (s.followers IS NOT NULL OR s.reach IS NOT NULL)
        AND ${connectionInScope(scope, 's.channel_connection_id')}
      ORDER BY s.channel_connection_id, s.captured_on
      LIMIT 60000`.execute(ctx.trx);
    // The latest audience the platform gave in the window, per channel ({} is an ask that got nothing).
    const audiences = await sql<{ connection_id: string; captured_on: string; audience: unknown }>`
      SELECT DISTINCT ON (s.channel_connection_id) s.channel_connection_id AS connection_id, to_char(s.captured_on, 'YYYY-MM-DD') AS captured_on, s.audience
      FROM crove_social.account_snapshot s
      WHERE s.org_id = ${ctx.orgId}
        AND s.captured_on >= (pg_catalog.now() AT TIME ZONE 'UTC')::date - ${input.days}::int
        AND s.audience IS NOT NULL AND s.audience <> '{}'::jsonb
        AND ${connectionInScope(scope, 's.channel_connection_id')}
      ORDER BY s.channel_connection_id, s.captured_on DESC
      LIMIT 1000`.execute(ctx.trx);
    const audienceByChannel = new Map<string, AccountTrend['audience']>();
    for (const r of audiences.rows) {
      const parsed = zSocialAudience.safeParse(r.audience);
      if (parsed.success) audienceByChannel.set(r.connection_id, { ...parsed.data, day: r.captured_on });
    }
    const byChannel = new Map<string, AccountTrend>();
    for (const r of rows) {
      const trend = byChannel.get(r.connection_id) ?? { connectionId: r.connection_id, provider: r.provider, points: [], audience: audienceByChannel.get(r.connection_id) ?? null };
      trend.points.push({ day: r.captured_on, followers: r.followers === null ? null : Number(r.followers), reach: r.reach === null ? null : Number(r.reach) });
      byChannel.set(r.connection_id, trend);
    }
    return [...byChannel.values()];
  },
});

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

export interface AccountDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  workerDb: Db;
  publishers: Readonly<Record<string, Publisher>>;
  now?: () => Date;
}

// One pass over the channels with no snapshot for today.
export async function sweepAccounts(deps: AccountDeps): Promise<{ recorded: number; skipped: number }> {
  const providers = Object.entries(deps.publishers)
    .filter(([, p]) => typeof p.accountMetrics === 'function')
    .map(([id]) => id);
  const out = { recorded: 0, skipped: 0 };
  if (providers.length === 0) return out;
  const { rows } = await sql<{ org_id: string; connection_id: string; provider: string }>`
    SELECT org_id, connection_id, provider FROM crove_social.account_snapshots_due(${ACCOUNT_LIMIT}::int, ${providers}::text[])`.execute(deps.workerDb);
  const day = utcDay(deps.now?.() ?? new Date());
  for (const row of rows) {
    const publisher = deps.publishers[row.provider];
    try {
      const options = { actor: ACTOR, orgId: row.org_id };
      const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: row.connection_id }, options);
      const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: row.org_id, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
      const { due } = await deps.runtime.query<{ due: boolean }>('social.account.audience_due', { connectionId: row.connection_id, day }, options);
      const result = await publisher?.accountMetrics?.({ externalAccountId: sealed.externalAccountId, secret, ...(due ? { audience: true } : {}) });
      const counts = !result
        ? { error: 'no_answer' as const }
        : 'refused' in result
          ? { error: result.refused }
          : { followers: result.followers, reach: result.reach ?? null, ...(due && result.audience !== undefined ? { audience: audienceFrom(result.audience) } : {}) };
      const done = await deps.runtime.execute<{ recorded: boolean }>('social.account.record', { connectionId: row.connection_id, capturedOn: day, ...counts }, options);
      if (done.recorded && !('error' in counts)) out.recorded += 1;
      else out.skipped += 1;
    } catch (error) {
      // A connection whose owner left, or a credential that will not open: nothing to read; the publish path reports it.
      if (!(error instanceof DomainError)) console.warn(`[social-accounts] channel ${row.connection_id.slice(0, 8)}`, error instanceof Error ? error.message : error);
      out.skipped += 1;
      // Kept as today's try all the same, so a channel that keeps failing waits a day instead of coming back first on
      // every pass ahead of the others.
      await deps.runtime.execute('social.account.record', { connectionId: row.connection_id, capturedOn: day, error: 'no_answer' }, { actor: ACTOR, orgId: row.org_id }).catch(() => undefined);
    }
  }
  return out;
}

// An adapter's audience as the record command takes it; one out of bounds counts as nothing given, so the followers
// are kept all the same.
function audienceFrom(audience: unknown): SocialAudience | null {
  const parsed = zSocialAudience.safeParse(audience);
  return parsed.success ? parsed.data : null;
}

export const accountCommands = [accountRecord];
export const accountQueries = [accountTrends, accountAudienceDue];
