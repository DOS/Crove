// A channel's options for the composer (#1120): a Pinterest board's sections, for the pin's section picker, and since
// #1131 a YouTube channel's playlists and a WordPress site's categories and tags (each with its taxonomy). Only
// the worker may open a channel's token (ADR-0025), so the composer cannot ask the platform itself: as for link
// previews (#641), a member asks for the list (social.channel_option.request); a fresh answer (under a day old) or a
// request in progress is returned as it is, else the request is queued for the worker, within a per-org budget a
// minute. The worker reads the connection and kind from the pending row in the org's system context, opens the token
// through kernel.channel.credential (credential_get), lists the options through the channel's adapter and records
// them (social.channel_option.record). The token never reaches a command, an event, an error or an answer.
//
// The list is shown in Crove only, as names (third-party text, rendered as text). Publishing never trusts it: the
// Pinterest adapter lists the board's sections again before it pins, and refuses a section the board no longer has;
// YouTube refuses a playlist that is gone when the video is added to it, and WordPress matches the names as before.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { SOCIAL_CHANNEL_OPTION_ERRORS, type MemberRole, type SocialChannelOptionError, type SocialChannelOptionKind, type SocialChannelOptionStatus } from '@crove/db';
import { CHANNEL_OPTIONS_MAX, CHANNEL_OPTION_NAME_MAX, OPTION_NAME_INVISIBLE, WORDPRESS_TAXONOMIES, type ChannelOption, type ChannelOptionsResult, type Publisher } from '@crove/channel';
import { DomainError, defineCommand, defineQuery, type CommandContext, type CredentialBroker, type QueryContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { CHANNEL_OPTION_KIND_OF, isProvider } from './domain/channels.ts';
import { refuseChannels } from './channel-access.ts';

// Who composes posts, and so may ask for a channel's options.
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ACTOR: SystemActor = { type: 'system', component: 'social.channel_option' };
// An answer is fresh this long; a request in progress is not repeated for this long; a failed read is the answer this
// long, so asking again at once neither queues another job nor escapes the budget below (which counts lists, not
// asks).
export const CHANNEL_OPTION_FRESH_MS = 24 * 60 * 60_000;
export const CHANNEL_OPTION_RETRY_MS = 2 * 60_000;
export const CHANNEL_OPTION_FAILED_RETRY_MS = 5 * 60_000;
// Requests an org may send to the worker per minute.
export const CHANNEL_OPTION_PER_MINUTE = 20;

// What the composer reads: the options only once they are read, else none.
export interface ChannelOptionList {
  connectionId: string;
  kind: SocialChannelOptionKind;
  status: SocialChannelOptionStatus;
  options: ChannelOption[];
  error: SocialChannelOptionError | null;
  fetchedAt: string | null;
  // A failed read: how long before asking again queues a new one; null otherwise.
  retryAfterSeconds: number | null;
}

type Row = { id: string; status: SocialChannelOptionStatus; items: unknown; error: SocialChannelOptionError | null; requested_at: Date; fetched_at: Date | null };
const COLUMNS = ['id', 'status', 'items', 'error', 'requested_at', 'fetched_at'] as const;

const zOptionName = z
  .string()
  .min(1)
  .max(CHANNEL_OPTION_NAME_MAX)
  .refine((v) => !OPTION_NAME_INVISIBLE.test(v) && v.trim() === v, 'one trimmed line, no control, zero-width or direction marks');
// A WordPress term carries its taxonomy (#1131); an item of any other list has none.
const zOption = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), name: zOptionName, taxonomy: z.enum(WORDPRESS_TAXONOMIES).optional() });
const zOptions = z
  .array(zOption)
  .max(CHANNEL_OPTIONS_MAX)
  .refine((list) => new Set(list.map((o) => `${o.taxonomy ?? ''}:${o.id}`)).size === list.length, 'distinct ids')
  .refine((list) => list.every((o) => o.taxonomy !== undefined) || list.every((o) => o.taxonomy === undefined), 'a taxonomy on every item or on none');

// Whether a list's items have the shape of its kind: a taxonomy on every WordPress term, on no other item.
const fitsKind = (kind: SocialChannelOptionKind, options: readonly ChannelOption[]) => options.every((o) => (o.taxonomy !== undefined) === (kind === 'wordpress_term'));

// How long a failed read stays the answer, from now; null for a list that did not fail.
function retryAfter(r: Row, now: Date): number | null {
  if (r.status !== 'failed' || r.fetched_at === null) return null;
  return Math.max(0, Math.ceil((r.fetched_at.getTime() + CHANNEL_OPTION_FAILED_RETRY_MS - now.getTime()) / 1000));
}

// A stored list as the composer shows it: only a read list has options, and only well-formed ones.
function view(connectionId: string, kind: SocialChannelOptionKind, r: Row, now: Date): ChannelOptionList {
  const parsed = r.status === 'ready' ? zOptions.safeParse(r.items) : null;
  return { connectionId, kind, status: r.status, options: parsed?.success && fitsKind(kind, parsed.data) ? parsed.data : [], error: r.error, fetchedAt: r.fetched_at?.toISOString() ?? null, retryAfterSeconds: retryAfter(r, now) };
}

type Ctx = Pick<QueryContext, 'trx' | 'orgId' | 'actor' | 'role'>;

// The caller's live connection and the kind of list it offers: refused for a channel outside the caller's scope
// (#1081), one that is not active, and one whose channel lists nothing.
async function listedChannel(ctx: Ctx, connectionId: string): Promise<SocialChannelOptionKind> {
  await refuseChannels(ctx, [connectionId]);
  const connection = await ctx.trx.selectFrom('crove_kernel.channel_connection').select(['provider', 'status']).where('org_id', '=', ctx.orgId).where('id', '=', connectionId).executeTakeFirst();
  if (!connection) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh này');
  if (connection.status !== 'active') throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này cần được kết nối lại trước');
  const kind = isProvider(connection.provider) ? CHANNEL_OPTION_KIND_OF[connection.provider] : undefined;
  if (!kind) throw new DomainError('CHANNEL_OPTIONS_NOT_OFFERED', 422, 'Kênh này không có danh sách để chọn');
  return kind;
}

const zRequest = z.strictObject({ connectionId: zId });

export const channelOptionRequest = defineCommand({
  name: 'social.channel_option.request',
  input: zRequest,
  risk: 'R1',
  access: MEMBERS,
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx: CommandContext, input): Promise<ChannelOptionList> => {
    const kind = await listedChannel(ctx, input.connectionId);
    const now = ctx.now.getTime();
    const find = () =>
      ctx.trx.selectFrom('crove_social.channel_option').select(COLUMNS).where('org_id', '=', ctx.orgId).where('channel_connection_id', '=', input.connectionId).where('kind', '=', kind);
    const row = await find().forUpdate().executeTakeFirst();
    if (row) {
      const fresh = row.status === 'ready' && row.fetched_at !== null && now - row.fetched_at.getTime() < CHANNEL_OPTION_FRESH_MS;
      const asked = row.status === 'pending' && now - row.requested_at.getTime() < CHANNEL_OPTION_RETRY_MS;
      const resting = (retryAfter(row, ctx.now) ?? 0) > 0;
      if (fresh || asked || resting) return view(input.connectionId, kind, row, ctx.now);
    }
    // One request at a time per org decides the budget, so the count below holds until the commit.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.channel_option:${ctx.orgId}`}))`.execute(ctx.trx);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM crove_social.channel_option
      WHERE org_id = ${ctx.orgId} AND requested_at > ${ctx.now}::timestamptz - interval '1 minute'`.execute(ctx.trx);
    if ((rows[0]?.n ?? 0) >= CHANNEL_OPTION_PER_MINUTE) throw new DomainError('CHANNEL_OPTION_LIMIT', 429, 'Đang tải quá nhiều danh sách, hãy thử lại sau ít phút');
    // Asking again keeps the last answer's options and time as they were; the database lets a member change nothing
    // else (channel_option_before_update).
    const saved = row
      ? await ctx.trx
          .updateTable('crove_social.channel_option')
          // Never earlier than the last ask: another API instance's clock may run a little ahead of this one's.
          .set({ status: 'pending', error: null, requested_at: ctx.now > row.requested_at ? ctx.now : row.requested_at })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', row.id)
          .returning(COLUMNS)
          .executeTakeFirstOrThrow()
      : await ctx.trx
          .insertInto('crove_social.channel_option')
          .values({ org_id: ctx.orgId, channel_connection_id: input.connectionId, kind, status: 'pending', requested_at: ctx.now, created_at: ctx.now })
          .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id', 'kind']).doNothing())
          .returning(COLUMNS)
          .executeTakeFirst();
    // Asked for at the same moment by someone else, who queued it: theirs is the answer.
    if (!saved) return view(input.connectionId, kind, await find().executeTakeFirstOrThrow(), ctx.now);
    await ctx.emit('social.channel_option.requested', { option_id: saved.id, connection_id: input.connectionId, kind });
    return view(input.connectionId, kind, saved, ctx.now);
  },
});

export const channelOptionGet = defineQuery({
  name: 'social.channel_option.get',
  input: zRequest,
  access: MEMBERS,
  handler: async (ctx, input): Promise<ChannelOptionList | null> => {
    const kind = await listedChannel(ctx, input.connectionId);
    const row = await ctx.trx
      .selectFrom('crove_social.channel_option')
      .select(COLUMNS)
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .where('kind', '=', kind)
      .executeTakeFirst();
    return row ? view(input.connectionId, kind, row, new Date()) : null;
  },
});

// For the worker: the connection and kind of a request that still waits, on a connection that is still active.
export const channelOptionLoad = defineQuery({
  name: 'social.channel_option.load',
  input: z.object({ optionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<{ connectionId: string; provider: string; kind: SocialChannelOptionKind } | null> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình nền mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_social.channel_option as o')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'o.org_id').onRef('c.id', '=', 'o.channel_connection_id'))
      .select(['o.channel_connection_id', 'o.kind', 'o.status', 'c.provider', 'c.status as connection_status'])
      .where('o.org_id', '=', ctx.orgId)
      .where('o.id', '=', input.optionId)
      .executeTakeFirst();
    if (!row || row.status !== 'pending' || row.connection_status !== 'active') return null;
    return { connectionId: row.channel_connection_id, provider: row.provider, kind: row.kind };
  },
});

// For the worker: the options it read, or why it could not. A list answered since is left alone; a failure keeps no
// options.
export const channelOptionRecord = defineCommand({
  name: 'social.channel_option.record',
  input: z.strictObject({
    optionId: zId,
    result: z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), options: zOptions }), z.strictObject({ ok: z.literal(false), error: z.enum(SOCIAL_CHANNEL_OPTION_ERRORS) })]),
  }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.channel_option', id: input.optionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình nền mới thực hiện được việc này');
    const r = input.result;
    if (r.ok) {
      const list = await ctx.trx.selectFrom('crove_social.channel_option').select('kind').where('org_id', '=', ctx.orgId).where('id', '=', input.optionId).executeTakeFirst();
      if (list && !fitsKind(list.kind, r.options)) throw new DomainError('VALIDATION', 422, 'Các mục không đúng dạng của danh sách này');
    }
    const done = await ctx.trx
      .updateTable('crove_social.channel_option')
      .set(r.ok ? { status: 'ready', items: JSON.stringify(r.options), error: null, fetched_at: ctx.now } : { status: 'failed', items: '[]', error: r.error, fetched_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.optionId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return { recorded: Number(done.numUpdatedRows) > 0 };
  },
});

export const channelOptionCommands = [channelOptionRequest, channelOptionRecord];
export const channelOptionQueries = [channelOptionGet, channelOptionLoad];

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

export interface ChannelOptionDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  publishers: Readonly<Record<string, Publisher>>;
}

// The worker's job for one request: list the options with the channel's token and record them. A credential that will
// not open (its connecting member left, the connection was dropped) is recorded as refused; a failure to record is
// thrown, so the job is tried again.
export async function runChannelOptionJob(deps: ChannelOptionDeps, orgId: string, optionId: string): Promise<'ready' | 'failed' | 'none'> {
  const options = { actor: ACTOR, orgId };
  const target = await deps.runtime.query<{ connectionId: string; provider: string; kind: SocialChannelOptionKind } | null>('social.channel_option.load', { optionId }, options);
  if (!target) return 'none';
  const record = async (result: { ok: true; options: ChannelOption[] } | { ok: false; error: SocialChannelOptionError }) => {
    await deps.runtime.execute('social.channel_option.record', { optionId, result }, options);
    return result.ok ? ('ready' as const) : ('failed' as const);
  };
  const publisher = deps.publishers[target.provider];
  if (!publisher?.options) return record({ ok: false, error: 'no_answer' });
  let secret: string;
  let externalAccountId: string;
  try {
    const sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: target.connectionId }, options);
    externalAccountId = sealed.externalAccountId;
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId });
  } catch (error) {
    if (error instanceof DomainError && error.status < 500) return record({ ok: false, error: 'permission' });
    throw error;
  }
  let result: ChannelOptionsResult = null;
  try {
    result = await publisher.options({ externalAccountId, secret, kind: target.kind });
  } catch {
    result = null;
  }
  if (!result) return record({ ok: false, error: 'no_answer' });
  if ('refused' in result) return record({ ok: false, error: result.refused });
  const valid = zOptions.safeParse(result.options);
  return valid.success && fitsKind(target.kind, valid.data) ? record({ ok: true, options: valid.data }) : record({ ok: false, error: 'no_answer' });
}
