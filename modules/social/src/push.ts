// Browser push (#1238): the notifications someone must act on (the mailed kinds) also reach the devices a member turned
// push on, as Planable pushes approvals. A member subscribes one browser at a time from the notification settings
// (social.push.subscribe, with the endpoint and keys the browser's push service gave it) and turns it off again
// (social.push.unsubscribe); each member reads and changes only their own rows (a restrictive policy), and a member's
// rows go with the membership.
//
// Sending is the worker's: after social.notification.dispatch commits, it queues one job per new notification of a
// pushed kind, reads what to send with social.push.targets (system), encrypts and posts it to each endpoint itself, and
// records the answers with social.push.record (system): a 404 or 410 deletes the subscription, other failures count up
// and a subscription that failed PUSH_FAILURE_LIMIT times in a row is deleted too. The push carries no post text: a
// short line naming the kind and the app path that opens it. A deployment without VAPID keys offers no push and the
// worker queues nothing (the API and the worker check the keys; these commands do not).
import { createPublicKey } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole, SocialNotificationKind } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { PUSHED_KINDS, notificationPath } from './notifications.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The devices one member keeps per org; subscribing one more drops the one used longest ago.
export const PUSH_DEVICE_LIMIT = 10;
// Failed sends in a row (not 404 or 410) after which a subscription is deleted.
export const PUSH_FAILURE_LIMIT = 10;
export const PUSH_ENDPOINT_MAX = 2048;

const B64URL = /^[A-Za-z0-9_-]+$/;
// An endpoint as stored and compared: the URL parser's form, so the browser's spelling and the row's always match.
const normalEndpoint = (raw: string) => (URL.canParse(raw) ? new URL(raw).toString() : raw);
// The browser's keys as base64url without padding; some browsers pad or use the standard alphabet.
const toBase64Url = (value: string) => value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const keyOf = (bytes: number, check?: (raw: Buffer) => boolean) =>
  z
    .string()
    .min(1)
    .max(128)
    .transform(toBase64Url)
    .refine((v) => B64URL.test(v) && Buffer.from(v, 'base64url').length === bytes && (check?.(Buffer.from(v, 'base64url')) ?? true), 'invalid key');
// Whether 65 bytes are an uncompressed point on P-256: the key import checks the point is on the curve.
function onP256(raw: Buffer): boolean {
  if (raw[0] !== 0x04) return false;
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}
// An uncompressed P-256 point (0x04 || x || y) and the 16-byte auth secret (RFC 8291 section 3).
export const zPushP256dh = keyOf(65, onP256);
export const zPushAuth = keyOf(16);
// A push service URL: https, no credentials or fragment. Where it may go (public addresses only) is the egress guard's.
export const zPushEndpoint = z
  .string()
  .min(12)
  .max(PUSH_ENDPOINT_MAX)
  .refine((raw) => {
    if (!URL.canParse(raw)) return false;
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
  }, 'invalid push endpoint')
  .transform(normalEndpoint)
  .refine((v) => v.length <= PUSH_ENDPOINT_MAX, 'invalid push endpoint');
// The device label the settings page shows, built by the browser from its user agent ("Chrome trên Windows").
const zDeviceLabel = z
  .string()
  .transform((v) => [...v.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 100).join(''))
  .optional();

function requireUser(ctx: Pick<QueryContext, 'actor'>): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

export interface PushDevice {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  // The browser asking: its endpoint is this row's.
  current: boolean;
}

// The viewer's push devices in this org, and whether the asking browser (its endpoint, when it has a subscription) is
// one of them. Never an endpoint or a key.
export const pushDevices = defineQuery({
  name: 'social.push.devices',
  input: z.strictObject({ endpoint: z.string().max(PUSH_ENDPOINT_MAX).nullable() }),
  access: ALL,
  handler: async (ctx, input): Promise<{ devices: PushDevice[]; subscribed: boolean }> => {
    const me = requireUser(ctx);
    const mine = input.endpoint === null ? null : normalEndpoint(input.endpoint);
    const rows = await ctx.trx
      .selectFrom('crove_social.push_subscription')
      .select(['id', 'user_agent', 'created_at', 'last_used_at', 'endpoint'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', me)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const devices = rows.map((r) => ({ id: r.id, label: r.user_agent, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null, current: mine !== null && r.endpoint === mine }));
    return { devices, subscribed: devices.some((d) => d.current) };
  },
});

// Turns push on for the asking browser: its subscription becomes the viewer's row (the same endpoint again refreshes
// its keys and label and clears its failures). Beyond PUSH_DEVICE_LIMIT the device used longest ago goes.
export const pushSubscribe = defineCommand({
  name: 'social.push.subscribe',
  input: z.strictObject({ endpoint: zPushEndpoint, p256dh: zPushP256dh, auth: zPushAuth, label: zDeviceLabel }),
  risk: 'R1',
  access: ALL,
  handler: async (ctx, input): Promise<{ id: string }> => {
    const me = requireUser(ctx);
    const label = input.label || null;
    const row = await ctx.trx
      .insertInto('crove_social.push_subscription')
      .values({ org_id: ctx.orgId, user_id: me, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, user_agent: label, created_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'user_id', 'endpoint']).doUpdateSet({ p256dh: input.p256dh, auth: input.auth, user_agent: label, failure_count: 0 }))
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`
      DELETE FROM crove_social.push_subscription
      WHERE org_id = ${ctx.orgId} AND user_id = ${me} AND id IN (
        SELECT id FROM crove_social.push_subscription
        WHERE org_id = ${ctx.orgId} AND user_id = ${me} AND id <> ${row.id}
        ORDER BY coalesce(last_used_at, created_at) DESC, id DESC
        OFFSET ${PUSH_DEVICE_LIMIT - 1})`.execute(ctx.trx);
    ctx.audit({ subscription_id: row.id });
    return { id: row.id };
  },
});

// Turns push off: the asking browser's subscription (by its endpoint), or one of the viewer's devices by id.
export const pushUnsubscribe = defineCommand({
  name: 'social.push.unsubscribe',
  input: z.union([z.strictObject({ endpoint: z.string().min(1).max(PUSH_ENDPOINT_MAX) }), z.strictObject({ id: zId })]),
  risk: 'R1',
  access: ALL,
  handler: async (ctx, input): Promise<{ removed: number }> => {
    const me = requireUser(ctx);
    let q = ctx.trx.deleteFrom('crove_social.push_subscription').where('org_id', '=', ctx.orgId).where('user_id', '=', me);
    q = 'id' in input ? q.where('id', '=', input.id) : q.where('endpoint', '=', normalEndpoint(input.endpoint));
    const done = await q.executeTakeFirst();
    return { removed: Number(done.numDeletedRows) };
  },
});

// The one line a push shows for its kind; never the post's text or a channel's name.
export function pushLine(kind: SocialNotificationKind, detail: Readonly<Record<string, unknown>>): string {
  switch (kind) {
    case 'review_requested':
      return 'Có bài đang chờ bạn duyệt';
    case 'decided':
      return detail.decision === 'approved' ? 'Bài của bạn đã được duyệt' : detail.decision === 'rejected' ? 'Bài của bạn bị từ chối' : 'Người duyệt đề nghị sửa bài của bạn';
    case 'failed':
      return detail.removal === 'scheduled' ? 'Chưa tự gỡ được một bài đã hẹn giờ gỡ' : 'Một bài đăng không thành công';
    case 'needs_attention':
      return 'Một bài đăng cần bạn xử lý';
    case 'channel_expired':
      return 'Một kênh cần kết nối lại';
    case 'mention':
      return 'Bạn được nhắc đến trong một bình luận';
    case 'queue_low':
      return 'Hàng đợi của một kênh sắp hết bài';
    case 'post_outperforming':
      return 'Một bài đang được tương tác nhiều hơn hẳn thường lệ';
    default:
      return 'Bạn có thông báo mới';
  }
}

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface PushTargets {
  subscriptions: PushTarget[];
  // What the push shows: the kind's line, the app path it opens, and a tag that folds repeats of one thing together.
  line: string;
  path: string;
  tag: string;
}

// For the worker's push job: the notification's line and path and its member's subscriptions, or null when nothing
// is to be sent (a kind that is not pushed, a notification gone or read, an org no longer active, a member who left or
// whose account is disabled: member_emails leaves those out).
export const pushTargets = defineQuery({
  name: 'social.push.targets',
  input: z.strictObject({ notificationId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<PushTargets | null> => {
    const n = await ctx.trx
      .selectFrom('crove_social.notification')
      .select(['user_id', 'kind', 'post_id', 'connection_id', 'detail', 'read_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.notificationId)
      .executeTakeFirst();
    if (!n || n.read_at !== null || !PUSHED_KINDS.has(n.kind)) return null;
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'status']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (org?.status !== 'active') return null;
    // A member now, with an account that is not disabled.
    const { rows: active } = await sql<{ user_id: string }>`SELECT user_id FROM crove_kernel.member_emails(${[n.user_id]}::uuid[])`.execute(ctx.trx);
    if (active.length === 0) return null;
    const subscriptions = await ctx.trx
      .selectFrom('crove_social.push_subscription')
      .select(['id', 'endpoint', 'p256dh', 'auth'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', n.user_id)
      .orderBy('id')
      .limit(PUSH_DEVICE_LIMIT)
      .execute();
    if (subscriptions.length === 0) return null;
    const detail = n.detail && typeof n.detail === 'object' ? (n.detail as Record<string, unknown>) : {};
    return {
      subscriptions,
      line: pushLine(n.kind, detail),
      path: notificationPath(org.slug, n.kind, n.post_id, n.connection_id),
      tag: `${n.kind}:${n.post_id ?? n.connection_id ?? input.notificationId}`,
    };
  },
});

// The push service's answer for each subscription a job sent to: 'sent' resets its failures, 'gone' (404, 410, or an
// endpoint the egress guard refuses) deletes it, 'failed' counts one more failure and deletes it at the limit.
export const pushRecord = defineCommand({
  name: 'social.push.record',
  input: z.strictObject({ results: z.array(z.strictObject({ id: zId, outcome: z.enum(['sent', 'gone', 'failed']) })).min(1).max(PUSH_DEVICE_LIMIT) }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx: CommandContext, input): Promise<{ sent: number; removed: number; failed: number }> => {
    const ids = (outcome: string) => input.results.filter((r) => r.outcome === outcome).map((r) => r.id);
    const sent = ids('sent');
    const gone = ids('gone');
    const failed = ids('failed');
    if (sent.length > 0) await ctx.trx.updateTable('crove_social.push_subscription').set({ failure_count: 0, last_used_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', 'in', sent).execute();
    let removed = 0;
    if (failed.length > 0) {
      await ctx.trx
        .updateTable('crove_social.push_subscription')
        .set((eb) => ({ failure_count: eb('failure_count', '+', 1) }))
        .where('org_id', '=', ctx.orgId)
        .where('id', 'in', failed)
        .execute();
      const worn = await ctx.trx.deleteFrom('crove_social.push_subscription').where('org_id', '=', ctx.orgId).where('id', 'in', failed).where('failure_count', '>=', PUSH_FAILURE_LIMIT).executeTakeFirst();
      removed += Number(worn.numDeletedRows);
    }
    if (gone.length > 0) {
      const done = await ctx.trx.deleteFrom('crove_social.push_subscription').where('org_id', '=', ctx.orgId).where('id', 'in', gone).executeTakeFirst();
      removed += Number(done.numDeletedRows);
    }
    return { sent: sent.length, removed, failed: failed.length };
  },
});

export const pushCommands = [pushSubscribe, pushUnsubscribe, pushRecord];
export const pushQueries = [pushDevices, pushTargets];
