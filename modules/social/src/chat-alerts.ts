// Team alerts in a Telegram or Discord chat (#863): Vietnamese small teams live in chat apps more than in email, so an
// org may name one chat where Social posts a short line, with a link to the post, when something happens to a post:
// a channel waits for review, failed or needs attention, was published, or a client answered through a review link.
// The owners and admins pick which of those kinds the chat gets.
//
// The chat is a Telegram chat (a bot's token and the chat's id) or a Discord webhook (its id and token), sealed by the
// deployment's credential broker for the binding (org, CHAT_ALERT_PROVIDER, the alert's id), and kept the way a
// channel credential is (ADR-0025): crove_social.chat_alert holds no secret, and the sealed target sits in the
// definer-only crove_social.chat_alert_target. The API checks a target with the platform and seals it, and the save
// command seals it in (chat_alert_target_put); nothing in the API reads it back. Only the worker does, through
// chat_alert_target_get (granted to crove_worker alone, refused once the member who saved it is no longer an owner or
// admin): social.chat_alert.prepare for an alert, social.chat_alert.target for an owner's test line, which the test
// command only asks for (an outbox event the worker turns into a job) and the worker records (social.chat_alert.tested).
// No answer carries the target, and no audit row holds more than its kind and kinds.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { SOCIAL_CHAT_ALERT_KINDS, SOCIAL_CHAT_ALERT_TARGETS, type MemberRole, type SocialChatAlertKind, type SocialChatAlertTarget } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

// The kinds of alert a chat may get, in the order the settings show them.
export const CHAT_ALERT_KINDS = SOCIAL_CHAT_ALERT_KINDS;
export type ChatAlertKind = SocialChatAlertKind;
export const CHAT_ALERT_TARGETS = SOCIAL_CHAT_ALERT_TARGETS;
export type ChatAlertTarget = SocialChatAlertTarget;
// The provider of the sealed target's binding; the account is the alert's id.
export const CHAT_ALERT_PROVIDER = 'social.chat_alert';
// The event the test command writes; the worker sends the test line for it.
export const CHAT_ALERT_TEST_EVENT = 'social.chat_alert.test_requested';
// Why the last test line did not go out, as the worker records it.
export const CHAT_ALERT_TEST_CODES = ['CHAT_ALERT_REFUSED', 'CHAT_ALERT_RATE_LIMITED', 'CHAT_ALERT_UNREACHABLE', 'CHAT_ALERT_UNREADABLE', 'CHAT_ALERT_OWNER_LEFT'] as const;
export type ChatAlertTestCode = (typeof CHAT_ALERT_TEST_CODES)[number];

// The outbox events that may alert, and the kind of alert each is. The same events the in-app notifications react to
// (NOTIFYING_EVENTS), and a published channel, which they do not.
export const CHAT_ALERT_EVENTS: Readonly<Record<string, ChatAlertKind>> = {
  'social.post.submitted': 'needs_approval',
  'social.variant.failed': 'failed',
  'social.variant.needs_attention': 'failed',
  'social.variant.published': 'published',
  'social.review.answered': 'client_answered',
};
export const CHAT_ALERTING_EVENTS: readonly string[] = Object.keys(CHAT_ALERT_EVENTS);

export function chatAlertKindOf(eventType: string): ChatAlertKind | null {
  return Object.hasOwn(CHAT_ALERT_EVENTS, eventType) ? (CHAT_ALERT_EVENTS[eventType] as ChatAlertKind) : null;
}

// Each kind once, in CHAT_ALERT_KINDS' order.
export const zChatAlertKinds = z
  .array(z.enum(CHAT_ALERT_KINDS))
  .min(1)
  .max(CHAT_ALERT_KINDS.length)
  .transform((kinds) => CHAT_ALERT_KINDS.filter((k) => kinds.includes(k)));

const zKeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
// The sealed envelope as base64; the column allows 4 KiB.
const zEnvelope = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .max(5_500);

export const zChatAlertSave = z.strictObject({
  // The id the envelope was sealed for: the alert is saved under it.
  id: zId,
  kind: z.enum(CHAT_ALERT_TARGETS),
  keyId: zKeyId,
  envelope: zEnvelope,
  // The chat's title or the webhook's name.
  label: z.string().trim().min(1).max(200),
  events: zChatAlertKinds,
});

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// Errors the chat_alert_target_* definers raise, as domain errors. Anything else goes through the runtime's mapping.
function targetError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'CHAT_ALERT_NOT_SET':
      throw new DomainError('CHAT_ALERT_NOT_SET', 404, 'Chưa có nhóm chat nào nhận tin báo');
    case 'CHAT_ALERT_OWNER_LEFT':
      throw new DomainError('CHAT_ALERT_OWNER_LEFT', 409, 'Người đã lưu nhóm chat không còn là chủ sở hữu hoặc quản trị viên; hãy lưu lại nhóm chat');
    case 'CREDENTIAL_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới đổi được nơi nhận tin báo');
    default:
      throw error;
  }
}

async function lockChatAlert(ctx: CommandContext) {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.chat_alert:${ctx.orgId}`}))`.execute(ctx.trx);
  return ctx.trx.selectFrom('crove_social.chat_alert').select(['id', 'created_at']).where('org_id', '=', ctx.orgId).orderBy('created_at').orderBy('id').execute();
}

async function deleteAlerts(ctx: CommandContext, ids: readonly string[]) {
  if (ids.length === 0) return;
  // The cascade drops the targets too; dropping them first says so in the definer's own terms.
  for (const id of ids) await sql`SELECT crove_social.chat_alert_target_drop(${id}::uuid)`.execute(ctx.trx).catch(targetError);
  await ctx.trx.deleteFrom('crove_social.chat_alert').where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
}

// Saves the org's chat in place of the one before. The envelope is bound to the alert's id, so the alert takes the id
// the API sealed it for, and its target is sealed in through the definer in the same transaction.
export const chatAlertSave = defineCommand({
  name: 'social.chat_alert.save',
  input: zChatAlertSave,
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const existing = await lockChatAlert(ctx);
    await deleteAlerts(
      ctx,
      existing.map((r) => r.id),
    );
    await ctx.trx
      .insertInto('crove_social.chat_alert')
      .values({
        org_id: ctx.orgId,
        id: input.id,
        kind: input.kind,
        label: input.label,
        events: input.events,
        updated_by: userId,
        created_at: existing[0]?.created_at ?? ctx.now,
        updated_at: ctx.now,
      })
      .execute();
    await sql`SELECT crove_social.chat_alert_target_put(${input.id}::uuid, ${input.keyId}, decode(${input.envelope}, 'base64'))`.execute(ctx.trx).catch(targetError);
    ctx.audit({ kind: input.kind, events: input.events });
    return { saved: true };
  },
});

export const chatAlertRemove = defineCommand({
  name: 'social.chat_alert.remove',
  input: z.strictObject({}),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx) => {
    requireUser(ctx);
    const rows = await lockChatAlert(ctx);
    await deleteAlerts(
      ctx,
      rows.map((r) => r.id),
    );
    ctx.audit({});
    return { removed: rows.length > 0 };
  },
});

async function alertOf(ctx: CommandContext | QueryContext) {
  return ctx.trx.selectFrom('crove_social.chat_alert').select(['id', 'kind', 'events']).where('org_id', '=', ctx.orgId).orderBy('created_at').orderBy('id').executeTakeFirst();
}

// An owner or admin asks for a test line: audited here and written as an event; the worker sends it and records the
// outcome on the alert (lastTestAt, lastTestCode). The API never sees the target.
export const chatAlertTest = defineCommand({
  name: 'social.chat_alert.test',
  input: z.strictObject({}),
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx) => {
    requireUser(ctx);
    const row = await alertOf(ctx);
    if (!row) throw new DomainError('CHAT_ALERT_NOT_SET', 404, 'Chưa có nhóm chat nào nhận tin báo');
    await ctx.emit(CHAT_ALERT_TEST_EVENT, { alert_id: row.id });
    ctx.audit({ kind: row.kind });
    return { queued: true };
  },
});

// The worker records how the test line went: null when it went out, else why not.
export const chatAlertTested = defineCommand({
  name: 'social.chat_alert.tested',
  input: z.strictObject({ code: z.enum(CHAT_ALERT_TEST_CODES).nullable() }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    const done = await ctx.trx.updateTable('crove_social.chat_alert').set({ last_test_at: ctx.now, last_test_code: input.code }).where('org_id', '=', ctx.orgId).executeTakeFirst();
    ctx.audit({ code: input.code });
    return { recorded: Number(done.numUpdatedRows) > 0 };
  },
});

// The sealed target, for the worker, which opens it for one call and drops it.
export interface SealedChatAlert {
  id: string;
  kind: ChatAlertTarget;
  keyId: string;
  // base64
  envelope: string;
}

async function sealedOf(ctx: QueryContext, row: { id: string; kind: ChatAlertTarget }): Promise<SealedChatAlert> {
  const { rows } = await sql<{ key_id: string; envelope: Buffer }>`
    SELECT key_id, envelope FROM crove_social.chat_alert_target_get(${row.id}::uuid)`
    .execute(ctx.trx)
    .catch(targetError);
  const target = rows[0];
  if (!target) throw new DomainError('CHAT_ALERT_NOT_SET', 404, 'Chưa có nhóm chat nào nhận tin báo');
  return { id: row.id, kind: row.kind, keyId: target.key_id, envelope: target.envelope.toString('base64') };
}

// For the worker: the org's sealed chat (a test line), or the one with this id (a reseal). Refuses CHAT_ALERT_NOT_SET
// and CHAT_ALERT_OWNER_LEFT.
export const chatAlertTarget = defineQuery({
  name: 'social.chat_alert.target',
  input: z.strictObject({ alertId: zId.optional() }),
  access: 'system',
  handler: async (ctx, input): Promise<SealedChatAlert> => {
    const row = input.alertId
      ? await ctx.trx.selectFrom('crove_social.chat_alert').select(['id', 'kind', 'events']).where('org_id', '=', ctx.orgId).where('id', '=', input.alertId).executeTakeFirst()
      : await alertOf(ctx);
    if (!row) throw new DomainError('CHAT_ALERT_NOT_SET', 404, 'Chưa có nhóm chat nào nhận tin báo');
    return sealedOf(ctx, row);
  },
});

// After a credential key rotation (#776): the worker stores the target sealed again with the current key, only if the
// stored envelope is still the one it read (its key id and SHA-256), which the definer checks under a row lock.
export const chatAlertReseal = defineCommand({
  name: 'social.chat_alert.reseal',
  input: z.strictObject({ alertId: zId, fromKeyId: zKeyId, fromEnvelopeSha256: z.string().regex(/^[0-9a-f]{64}$/), keyId: zKeyId, envelope: zEnvelope }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'social.chat_alert', id: input.alertId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const { rows } = await sql<{ resealed: boolean }>`
      SELECT crove_social.chat_alert_target_reseal(${input.alertId}::uuid, ${input.fromKeyId}, ${input.fromEnvelopeSha256}, ${input.keyId}, decode(${input.envelope}, 'base64')) AS resealed`
      .execute(ctx.trx)
      .catch(targetError);
    const resealed = rows[0]?.resealed === true;
    // Key ids only: they name a key without revealing it.
    if (resealed) ctx.audit({ alert_id: input.alertId, from_key_id: input.fromKeyId, key_id: input.keyId });
    return { resealed };
  },
});

export interface ChatAlertView {
  kind: ChatAlertTarget;
  events: ChatAlertKind[];
  // The chat's title or the webhook's name.
  label: string | null;
  updatedAt: string;
  // The last test line: when the worker tried it, and why it did not go out (null: it did).
  lastTestAt: string | null;
  lastTestCode: string | null;
}

// Whether the org has a chat for alerts, which and what it gets; never its target.
export const chatAlertGet = defineQuery({
  name: 'social.chat_alert.get',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<ChatAlertView | null> => {
    const row = await ctx.trx
      .selectFrom('crove_social.chat_alert')
      .select(['kind', 'events', 'label', 'updated_at', 'last_test_at', 'last_test_code'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();
    if (!row) return null;
    return {
      kind: row.kind,
      events: CHAT_ALERT_KINDS.filter((k) => row.events.includes(k)),
      label: row.label,
      updatedAt: row.updated_at.toISOString(),
      lastTestAt: row.last_test_at?.toISOString() ?? null,
      lastTestCode: row.last_test_code,
    };
  },
});

// What an alert says, for the worker to word it.
export interface ChatAlertFacts {
  kind: ChatAlertKind;
  // The event it comes from, where one kind words two (a failed channel, one that needs attention).
  event: string;
  slug: string;
  postId: string;
  // The post's title or the start of its text.
  postText: string | null;
  // The channels it is about (at most three), and how many there are in all.
  channels: string[];
  channelCount: number;
  // A client's answer: approved or asked for changes, and the name they gave.
  verdict: 'approved' | 'changes_requested' | null;
  reviewer: string | null;
}

const zPostEvent = z.object({ post_id: zId });
const zVariantEvent = z.object({ post_id: zId, variant_id: zId });
const CHANNELS_NAMED = 3;

async function channelNames(ctx: QueryContext, postId: string, filter: { variantId: string } | { status: 'in_review' }): Promise<string[]> {
  let q = ctx.trx
    .selectFrom('crove_social.post_variant as v')
    .leftJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'v.org_id').onRef('c.id', '=', 'v.channel_connection_id'))
    .select(['v.provider', 'c.display_name'])
    .where('v.org_id', '=', ctx.orgId)
    .where('v.post_id', '=', postId);
  q = 'variantId' in filter ? q.where('v.id', '=', filter.variantId) : q.where('v.status', '=', filter.status);
  const rows = await q.orderBy('v.created_at').orderBy('v.id').execute();
  return rows.map((r) => r.display_name ?? r.provider);
}

// The facts of an event the chat gets; null when the event is not an alert, the org has no chat for its kind, or
// there is nothing left to say (a post already decided, gone since, a client's plain comment).
async function factsOf(ctx: QueryContext, type: string, payload: unknown): Promise<Omit<ChatAlertFacts, 'slug' | 'postText'> | null> {
  const kind = chatAlertKindOf(type);
  if (!kind) return null;
  const none = { verdict: null, reviewer: null };
  switch (type) {
    case 'social.post.submitted': {
      const e = zPostEvent.safeParse(payload);
      if (!e.success) return null;
      // Already decided (a one-step approval, a policy): nothing waits on a reviewer any more.
      const channels = await channelNames(ctx, e.data.post_id, { status: 'in_review' });
      if (channels.length === 0) return null;
      return { kind, event: type, postId: e.data.post_id, channels: channels.slice(0, CHANNELS_NAMED), channelCount: channels.length, ...none };
    }
    case 'social.variant.failed':
    case 'social.variant.needs_attention':
    case 'social.variant.published': {
      const e = zVariantEvent.safeParse(payload);
      if (!e.success) return null;
      const channels = await channelNames(ctx, e.data.post_id, { variantId: e.data.variant_id });
      return { kind, event: type, postId: e.data.post_id, channels, channelCount: channels.length, ...none };
    }
    case 'social.review.answered': {
      const e = z.object({ post_id: zId, feedback_id: zId }).safeParse(payload);
      if (!e.success) return null;
      const f = await ctx.trx
        .selectFrom('crove_social.review_feedback')
        .select(['reviewer_name', 'verdict'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', e.data.feedback_id)
        .where('post_id', '=', e.data.post_id)
        .executeTakeFirst();
      // A plain comment is for the team's thread, not the chat.
      if (!f || (f.verdict !== 'approved' && f.verdict !== 'changes_requested')) return null;
      return { kind, event: type, postId: e.data.post_id, channels: [], channelCount: 0, verdict: f.verdict, reviewer: f.reviewer_name };
    }
    default:
      return null;
  }
}

// For the worker: the org's sealed chat and what to tell it about an outbox event, or null when nothing is sent.
// Refuses CHAT_ALERT_OWNER_LEFT when the member who saved the chat may no longer have it opened.
export const chatAlertPrepare = defineQuery({
  name: 'social.chat_alert.prepare',
  input: z.strictObject({ eventId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<{ alert: SealedChatAlert; facts: ChatAlertFacts } | null> => {
    const event = await ctx.trx.selectFrom('crove_kernel.outbox_event').select(['type', 'payload']).where('org_id', '=', ctx.orgId).where('id', '=', input.eventId).executeTakeFirst();
    if (!event) return null;
    const kind = chatAlertKindOf(event.type);
    if (!kind) return null;
    const row = await alertOf(ctx);
    if (!row || !row.events.includes(kind)) return null;
    const facts = await factsOf(ctx, event.type, event.payload);
    if (!facts) return null;
    const post = await ctx.trx.selectFrom('crove_social.post').select(['title', 'body']).where('org_id', '=', ctx.orgId).where('id', '=', facts.postId).executeTakeFirst();
    // Gone since (deleted): nothing to open.
    if (!post) return null;
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('slug').where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (!org) return null;
    const postText = [...(post.title?.trim() || post.body || '')].slice(0, 400).join('') || null;
    return { alert: await sealedOf(ctx, row), facts: { ...facts, slug: org.slug, postText } };
  },
});

export const chatAlertCommands = [chatAlertSave, chatAlertRemove, chatAlertTest, chatAlertTested, chatAlertReseal];
export const chatAlertQueries = [chatAlertGet, chatAlertPrepare, chatAlertTarget];
