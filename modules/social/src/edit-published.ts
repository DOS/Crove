// Correcting a published post's text on its platform (#1223), as Publer edits a published Facebook or LinkedIn post: a
// typo, a wrong price or a dead link is fixed without a takedown and a repost, which would lose the engagement. Text
// only. An owner or admin asks (social.variant.edit_published, R2, audited) with the new own text of the channel; the
// approval-time checks run on it as on any approval (the channel's rules, the blocked words, the review checklist, with
// the channel's signature appended through effectiveContent), and the person's approval of the next revision and its
// hash is recorded. A channel whose policy needs more than one approval, four-eyes or the client's approval is refused
// with EDIT_NEEDS_REVIEW: v1 has no review of an edit by several people. The worker then runs the edit job:
// social.edit.begin records the call as started (its own external_call step beside the publish call: edit, then
// edit_2... for each later ask), the adapter's edit is called, and social.edit.record stores the answer. Only the
// platform's confirmation changes the variant's text, revision and content hash, with a version of the post; until
// then, and after a failure, the post keeps the text it went out with, and the post page says where the edit stands.
// An unclear answer goes to a person, who checks the platform and asks again: nothing asks again by itself.
import { sql } from 'kysely';
import { z } from 'zod';
import { SOCIAL_REVIEW_CHECKS_MAX, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { effectiveContent } from './domain/approval.ts';
import { editRefusal } from './domain/channels.ts';
import { callRevision, publishCallKey } from './domain/publish.ts';
import { COMMENT_STALE_MS, type CommentCall } from './comments.ts';
import { base, hashOf, issuesOf, lockPost, lockVariants, mediaFor, mediaKind, overrides, refuseArchived, setVariant, settingsOf, variantPost, type PostRow, type Trx, type VariantRow } from './variants.ts';
import { refuseChannels } from './channel-access.ts';
import { bannedCheckerOf, isBlocked, refuseBannedWords } from './banned-words.ts';
import { publishingHeld } from './publish-hold.ts';
import { withoutSignature } from './domain/signature.ts';
import { checklistForApproval, tickedChecklist } from './review-checklist.ts';
import { approvalsRequired, clientApprovalOn, fourEyesOn } from './policy.ts';
import { outgoing, type PublishWork } from './publishing.ts';
import { withVersion } from './versions.ts';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
export const EDIT_STEP = 'edit';
// An ask with no call after this long never had its job run, and a call still started this long never got its answer
// recorded (the worker died mid-call): either way a person may ask again.
export const EDIT_STALE_MS = COMMENT_STALE_MS;
export const EDIT_BODY_MAX = 100_000;

export type EditWork =
  | { action: 'none'; reason: string }
  // scopes: what the platform granted the connection, as stored (#1474), for an adapter whose edit needs a permission
  // connect does not require.
  | ({ action: 'call'; variantId: string; provider: string; connectionId: string; callKey: string; externalId: string; scopes: string[]; shortLink?: { code: string; target: string } } & Pick<PublishWork, 'content' | 'settings'>);

type EditVariant = Pick<VariantRow, 'id' | 'revision' | 'published_revision' | 'attempt'>;
const editPrefix = (v: EditVariant) => publishCallKey(v.id, callRevision(v), v.attempt, EDIT_STEP);

// request_hash: the content hash the call sent, which names the ask it was made for.
export type EditCall = CommentCall & { finished_at: Date | null; request_hash: string | null };

// The edit calls of each variant's publish, oldest first, in one query.
export async function editCallsOf(trx: Trx, orgId: string, variants: readonly EditVariant[]): Promise<Map<string, EditCall[]>> {
  const out = new Map<string, EditCall[]>(variants.map((v) => [v.id, []]));
  if (variants.length === 0) return out;
  const prefixes = variants.map(editPrefix);
  const { rows } = await sql<EditCall>`
    SELECT key, state, external_ref, error_code, started_at, finished_at, request_hash FROM crove_kernel.external_call
    WHERE org_id = ${orgId}::uuid
      AND (key = ANY(${prefixes}::text[]) OR key LIKE ANY(${prefixes.map((p) => `${p}\\_%`)}::text[]))
    ORDER BY started_at, key`.execute(trx);
  for (const row of rows) {
    const i = prefixes.findIndex((p) => row.key === p || row.key.startsWith(`${p}_`));
    if (i >= 0) out.get((variants[i] as EditVariant).id)?.push(row);
  }
  return out;
}

// Where a person's correction of a published variant stands, for the post screen; null when there is none. pending:
// the job has not answered yet; failed: the platform refused (code says why), or the job never ran; unknown: the call
// went out and its answer is unclear or never came.
export type EditState = { state: 'pending' | 'failed' | 'unknown'; code: string | null };
export function editState(calls: readonly CommentCall[], v: { edit_state: string | null; edit_requested_at: Date | null; edit_error_code?: string | null }, now: Date): EditState | null {
  if (!v.edit_state || !v.edit_requested_at) return null;
  const last = calls.at(-1);
  // The ask came after the last call: its job has not made one yet.
  const asked = !last || last.started_at.getTime() < v.edit_requested_at.getTime() ? null : last;
  // The reason kept on the variant (the worker stopped it, or the platform's code) comes first.
  if (v.edit_state === 'failed') return { state: 'failed', code: v.edit_error_code ?? asked?.error_code ?? null };
  if (v.edit_state === 'unknown') return { state: 'unknown', code: v.edit_error_code ?? asked?.error_code ?? 'OUTCOME_UNKNOWN' };
  if (!asked) return now.getTime() - v.edit_requested_at.getTime() > EDIT_STALE_MS ? { state: 'failed', code: 'EDIT_NOT_RUN' } : { state: 'pending', code: null };
  return now.getTime() - asked.started_at.getTime() > EDIT_STALE_MS ? { state: 'unknown', code: 'OUTCOME_UNKNOWN' } : { state: 'pending', code: null };
}

// The pending edit as the variant row keeps it.
interface EditColumns {
  edit_body: string | null;
  edit_content_hash: string | null;
  edit_requested_at: Date | null;
  edit_requested_by: string | null;
  edit_state: string | null;
  edit_error_code: string | null;
}
const NO_EDIT = { edit_body: null, edit_content_hash: null, edit_requested_at: null, edit_requested_by: null, edit_state: null, edit_error_code: null };

async function lockVariant(ctx: CommandContext, variantId: string): Promise<{ post: PostRow; v: VariantRow & EditColumns }> {
  const postId = await variantPost(ctx.trx, ctx.orgId, [variantId]);
  const post = await lockPost(ctx.trx, ctx.orgId, postId);
  const v = (await lockVariants(ctx.trx, ctx.orgId, postId)).find((x) => x.id === variantId);
  if (!v) throw new DomainError('VARIANT_NOT_FOUND', 404, 'Không tìm thấy kênh này của bài đăng');
  const edit = await ctx.trx
    .selectFrom('crove_social.post_variant')
    .select(['edit_body', 'edit_content_hash', 'edit_requested_at', 'edit_requested_by', 'edit_state', 'edit_error_code'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', v.id)
    .executeTakeFirstOrThrow();
  return { post, v: { ...v, ...edit } };
}

// The variant as it would be with the new own text: its other columns (its settings with the signature, its media) as
// they went out.
const withBody = (v: VariantRow, body: string): VariantRow => ({ ...v, body });

const mediaKinds = (post: PostRow, v: VariantRow) => mediaFor(base(post), v).map((m) => mediaKind(m.mime));

const requireSystem = (ctx: CommandContext) => {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
};

// Whether the channel's policy asks for more than one person's approval of its content: several approvals, four-eyes
// (#740) or the client's (#770). Read at the ask and again before the call, as the publish reads its policy again.
async function needsReview(ctx: CommandContext, v: VariantRow): Promise<boolean> {
  const connection = [v.channel_connection_id];
  const required = (await approvalsRequired(ctx.trx, ctx.orgId, connection)).get(v.channel_connection_id) ?? 1;
  return required > 1 || (await fourEyesOn(ctx.trx, ctx.orgId, connection)).size > 0 || (await clientApprovalOn(ctx.trx, ctx.orgId, connection)).size > 0;
}

// The reasons the worker stops a pending edit before calling, kept on the variant for the post page; a person asks again.
export const EDIT_STOPPED = {
  // The org's publishing is held (#946).
  held: 'PUBLISHING_HELD',
  // The ask waited longer than EDIT_STALE_MS for its job (a worker outage): never sent hours late.
  expired: 'EDIT_NOT_RUN',
  // The channel's policy now asks for several people's approval.
  review: 'EDIT_NEEDS_REVIEW',
  // A blocked word added since the ask (#1055).
  banned: 'BANNED_WORDS',
  // The content the ask was approved as is not what would be sent now.
  changed: 'EDIT_CONTENT_CHANGED',
} as const;

// An owner or admin corrects the text of a published channel. body: the channel's new own text, without its
// signature, which is appended as it was at publish. revision: the variant's revision as they saw it. checks: the
// review checklist items they ticked, as for an approval.
export const variantEditPublished = defineCommand({
  name: 'social.variant.edit_published',
  input: z.strictObject({
    variantId: zId,
    revision: z.number().int().positive(),
    body: z.string().max(EDIT_BODY_MAX),
    checks: z.array(zId).max(SOCIAL_REVIEW_CHECKS_MAX).optional(),
  }),
  // The worker corrects the published text from its event: an effect outside Crove (#1653).
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const userId = ctx.actor.userId;
    // Nothing goes out while the org's publishing is held (#946): asked for after the release. Taken before the post's
    // lock, as every command that sends something takes it.
    if (await publishingHeld(ctx)) throw new DomainError('PUBLISHING_HELD', 409, 'Đang tạm dừng mọi bài đăng; hãy sửa bài sau khi tiếp tục đăng', { variantId: input.variantId });
    const { post, v } = await lockVariant(ctx, input.variantId);
    // Only on a channel the caller may use (#1081).
    await refuseChannels(ctx, [v.channel_connection_id]);
    // Not on an archived post (#1299): restored first, as for any other edit.
    refuseArchived(post);
    if (v.status !== 'published') throw new DomainError('EDIT_NOT_PUBLISHED', 409, 'Chỉ sửa được nội dung của kênh đã đăng', { variantId: v.id, status: v.status });
    // Confirmed by hand as published (social.variant.resolve) without the platform's id, or a draft kept in the
    // platform's app (#903): nothing to name in the call.
    if (!v.external_post_id) throw new DomainError('EDIT_NO_PLATFORM_ID', 409, 'Không có mã bài trên nền tảng nên không sửa được; hãy sửa trực tiếp trên nền tảng', { variantId: v.id });
    const refusal = editRefusal(v.provider, settingsOf(v), mediaKinds(post, v));
    if (refusal) throw new DomainError('EDIT_NOT_SUPPORTED', 422, 'Chưa sửa được bài đã đăng trên kênh này; hãy sửa trực tiếp trên nền tảng', { variantId: v.id, reason: refusal });
    if (v.revision !== input.revision) throw new DomainError('STALE_REVISION', 409, 'Kênh này đã được sửa ở nơi khác, hãy tải lại', { revision: v.revision });
    const calls = (await editCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    if (editState(calls, v, ctx.now)?.state === 'pending') throw new DomainError('EDIT_PENDING', 409, 'Bản sửa trước đang được gửi lên kênh; hãy chờ kết quả rồi sửa tiếp', { variantId: v.id });
    // No review of an edit by several people in v1: a channel whose policy asks for more than one person's approval of
    // its content is edited on the platform itself, or by a takedown and a new post reviewed as usual.
    if (await needsReview(ctx, v)) throw new DomainError('EDIT_NEEDS_REVIEW', 422, 'Kênh này cần nhiều người duyệt nên không sửa thẳng bài đã đăng được; hãy sửa trên nền tảng, hoặc gỡ bài rồi đăng bài mới', { variantId: v.id });
    const next = withBody(v, input.body);
    const hash = hashOf(base(post), next);
    if (hash === v.content_hash) throw new DomainError('EDIT_UNCHANGED', 422, 'Nội dung mới giống hệt nội dung đang đăng', { variantId: v.id });
    // The checks of an approval, on the content as it would go out.
    const issues = issuesOf(base(post), next);
    if (issues.length > 0) throw new DomainError('VARIANT_INVALID', 422, 'Nội dung mới chưa đúng yêu cầu của nền tảng', { variants: [{ variantId: v.id, issues }] });
    await refuseBannedWords(ctx, base(post), [next]);
    const checklist = tickedChecklist(await checklistForApproval(ctx), v, input.checks);
    const revision = v.revision + 1;
    const content = effectiveContent(base(post), overrides(next), next.content_frozen, settingsOf(next));
    // The person's approval of the new content, under the revision it takes once the platform confirms it.
    await ctx.trx
      .insertInto('crove_social.post_approval')
      .values({
        org_id: ctx.orgId,
        post_id: post.id,
        variant_id: v.id,
        revision,
        content_hash: hash,
        decision: 'approved',
        comment: null,
        decided_by: userId,
        actor_origin: 'ui',
        snapshot: JSON.stringify({
          provider: v.provider,
          channel_connection_id: v.channel_connection_id,
          body: content.body,
          title: content.title,
          link_url: content.linkUrl,
          media: mediaFor(base(post), v).map((m) => ({ file_id: m.fileId, generation: m.generation, alt_text: m.altText })),
          settings: settingsOf(v),
        }),
        checklist: checklist === null ? null : JSON.stringify(checklist),
      })
      .execute();
    await setVariant(ctx, v.id, { edit_body: input.body, edit_content_hash: hash, edit_requested_at: ctx.now, edit_requested_by: userId, edit_state: 'pending', edit_error_code: null });
    ctx.audit({ post_id: post.id, variant_id: v.id, provider: v.provider, revision, content_hash: hash });
    // The job's begin goes only while the last call is still the one this ask saw, so a second job of it stops.
    await ctx.emit('social.variant.edit_requested', { post_id: post.id, variant_id: v.id, provider: v.provider, after: calls.at(-1)?.key ?? null });
    return { postId: post.id, variantId: v.id, revision: v.revision, queued: true };
  },
});

// The variant's short link (#706) for the revision it went out under: an edit sends the link through it again, and a
// new code is never made for one.
async function shortLinkOf(ctx: CommandContext, v: VariantRow, target: string | null): Promise<{ code: string; target: string } | undefined> {
  if (!target) return undefined;
  const row = await ctx.trx
    .selectFrom('crove_social.short_link')
    .select(['code', 'target_url'])
    .where('org_id', '=', ctx.orgId)
    .where('variant_id', '=', v.id)
    .where('revision', '=', callRevision(v))
    .executeTakeFirst();
  return row && row.target_url === target ? { code: row.code, target: row.target_url } : undefined;
}

// Decides whether the worker makes the edit call now, and records the call as started first.
export const editBegin = defineCommand({
  name: 'social.edit.begin',
  // after: the last edit call the ask saw (null: none was made).
  input: z.strictObject({ variantId: zId, provider: z.string().min(1).max(32), after: z.string().min(1).max(300).nullable() }),
  // Commits the provider call as started; the worker then makes it, an effect outside Crove (#1578).
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input): Promise<EditWork> => {
    requireSystem(ctx);
    // The hold's lock shared first, before any post lock, as every command that sends something takes it (#946).
    const held = await publishingHeld(ctx);
    const { post, v } = await lockVariant(ctx, input.variantId);
    if (v.provider !== input.provider) return { action: 'none', reason: 'provider_mismatch' };
    if (v.status !== 'published' || !v.external_post_id) return { action: 'none', reason: 'not_published' };
    if (editRefusal(v.provider, settingsOf(v), mediaKinds(post, v))) return { action: 'none', reason: 'not_supported' };
    if (v.edit_state !== 'pending' || v.edit_body === null || v.edit_content_hash === null || v.edit_requested_at === null) return { action: 'none', reason: 'not_asked' };
    const calls = (await editCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    if ((calls.at(-1)?.key ?? null) !== input.after) return { action: 'none', reason: 'stale' };
    // Checked again now, as the publish checks its approvals again: the ask fails with its reason, nothing is sent, and a
    // person asks again (unlike a scheduled post, an edit has no time to go out at after a release).
    const next = withBody(v, v.edit_body);
    const stopped =
      held ? EDIT_STOPPED.held
      : ctx.now.getTime() - v.edit_requested_at.getTime() > EDIT_STALE_MS ? EDIT_STOPPED.expired
      : (await needsReview(ctx, v)) ? EDIT_STOPPED.review
      : hashOf(base(post), next) !== v.edit_content_hash ? EDIT_STOPPED.changed
      : isBlocked(await bannedCheckerOf(ctx.trx, ctx.orgId), base(post), next) ? EDIT_STOPPED.banned
      : null;
    if (stopped) {
      await setVariant(ctx, v.id, { edit_state: 'failed', edit_error_code: stopped });
      await ctx.emit('social.variant.edit_failed', { post_id: post.id, variant_id: v.id, provider: v.provider, code: stopped, unclear: false, by: v.edit_requested_by });
      return { action: 'none', reason: stopped };
    }
    const stepName = calls.length === 0 ? EDIT_STEP : `${EDIT_STEP}_${calls.length + 1}`;
    const callKey = publishCallKey(v.id, callRevision(v), v.attempt, stepName);
    // Idempotent: the same text set twice shows once.
    await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: callKey, module: 'social', target: v.provider, step: stepName, retry_safety: 'idempotent', request_hash: v.edit_content_hash, started_at: ctx.now })
      .execute();
    const sent = outgoing(post, next);
    const shortLink = await shortLinkOf(ctx, v, sent.content.linkUrl);
    const connection = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('scopes').where('org_id', '=', ctx.orgId).where('id', '=', v.channel_connection_id).executeTakeFirst();
    const scopes = connection ? [...connection.scopes] : [];
    return { action: 'call', variantId: v.id, provider: v.provider, connectionId: v.channel_connection_id, callKey, externalId: v.external_post_id, scopes, ...sent, ...(shortLink ? { shortLink } : {}) };
  },
});

// The code a pending ask is stopped with when an older ask's call is confirmed after it (the platform shows that text).
export const EDIT_SUPERSEDED = 'EDIT_SUPERSEDED';

// The variant takes a confirmed text: the next revision, the hash of the content with it, the revision it went out under
// kept for its call keys, and a version of the post in the person's name. keep: the pending ask's columns to leave set
// (none: the ask is done).
async function confirm(ctx: CommandContext, post: PostRow, v: VariantRow & EditColumns, body: string, by: string | null, keep: Partial<EditColumns> = {}): Promise<void> {
  await withVersion(
    ctx,
    post.id,
    async () => {
      await setVariant(ctx, v.id, { body, content_hash: hashOf(base(post), withBody(v, body)), revision: v.revision + 1, published_revision: callRevision(v), ...NO_EDIT, ...keep });
    },
    by,
  );
  await ctx.emit('social.variant.edited', { post_id: post.id, variant_id: v.id, provider: v.provider, by, revision: v.revision + 1 });
}

// The own text and the person of an earlier ask of this variant, from its approval row (its snapshot keeps the text as
// sent, signature included): null when no approval of that hash gives back exactly that content.
async function olderAsk(ctx: CommandContext, post: PostRow, v: VariantRow, hash: string): Promise<{ body: string; by: string; hash: string } | null> {
  const rows = await ctx.trx
    .selectFrom('crove_social.post_approval')
    .select(['snapshot', 'decided_by'])
    .where('org_id', '=', ctx.orgId)
    .where('variant_id', '=', v.id)
    .where('content_hash', '=', hash)
    .where('decision', '=', 'approved')
    .orderBy('id', 'desc')
    .execute();
  for (const row of rows) {
    const sent = (row.snapshot as { body?: unknown } | null)?.body;
    if (typeof sent !== 'string') continue;
    // The signature is appended after a blank line, which the text before it keeps: the text as typed is the one
    // without it, when that gives the same content back.
    const kept = withoutSignature(sent, settingsOf(v));
    for (const body of new Set([kept.trimEnd(), kept])) {
      if (hashOf(base(post), withBody(v, body)) === hash) return { body, by: row.decided_by, hash };
    }
  }
  return null;
}

const zText = (max: number) => z.string().max(max);
const zEditResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('edited') }),
  z.strictObject({ kind: z.literal('rejected'), error: z.enum(['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient']), code: zText(200).optional(), message: zText(2000).optional() }),
  z.strictObject({ kind: z.literal('unknown'), code: zText(200).optional() }),
  // Nothing was called: the channel's credential could not be used.
  z.strictObject({ kind: z.literal('blocked'), code: zText(200) }),
]);
export type EditRecord = z.infer<typeof zEditResult>;

// Stores what the platform answered for the edit call; an answer for a call that is not started changes nothing. On
// the platform's confirmation the variant takes the new text, with the next revision and the hash the person approved,
// and the post a version of it, the person's; the call keys stay named by the revision it went out under.
export const editRecord = defineCommand({
  name: 'social.edit.record',
  input: z.strictObject({ variantId: zId, callKey: z.string().min(1).max(300), result: zEditResult }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'social.post_variant', id: input.variantId }),
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const { post, v } = await lockVariant(ctx, input.variantId);
    const calls = (await editCallsOf(ctx.trx, ctx.orgId, [v])).get(v.id) ?? [];
    const call = calls.find((c) => c.key === input.callKey);
    if (!call || call.state !== 'started') return { recorded: false as const };
    const r = input.result;
    const state = r.kind === 'edited' ? 'succeeded' : r.kind === 'unknown' ? 'ambiguous' : 'failed';
    const errorCode = r.kind === 'edited' ? null : r.kind === 'unknown' ? (r.code ?? 'OUTCOME_UNKNOWN') : (r.code ?? null);
    const errorKind = r.kind === 'edited' ? null : r.kind === 'unknown' ? 'unknown' : r.kind === 'blocked' ? (r.code === 'CHANNEL_NOT_ACTIVE' ? 'token_expired' : 'permission') : r.error;
    await ctx.trx
      .updateTable('crove_kernel.external_call')
      .set({ state, error_kind: errorKind, error_code: errorCode, ...(state === 'ambiguous' ? {} : { finished_at: ctx.now }), updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', input.callKey)
      .where('state', '=', 'started')
      .execute();
    const latest = calls.at(-1)?.key === input.callKey;
    // The answer is the pending ask's only when its call was made for it: the last call, sent after the ask, with the
    // content the ask was approved as. A call that went quiet may answer after a person asked again (#1223 review).
    const forAsk =
      latest && v.edit_state === 'pending' && v.edit_body !== null && v.edit_requested_at !== null && call.request_hash === v.edit_content_hash && call.started_at.getTime() >= v.edit_requested_at.getTime();
    if (forAsk) {
      const by = v.edit_requested_by;
      if (r.kind === 'edited') {
        if (v.status !== 'published') {
          await setVariant(ctx, v.id, NO_EDIT);
          return { recorded: true as const, state, status: v.status };
        }
        await confirm(ctx, post, v, v.edit_body as string, by);
        return { recorded: true as const, state, status: v.status, revision: v.revision + 1 };
      }
      await setVariant(ctx, v.id, { edit_state: r.kind === 'unknown' ? 'unknown' : 'failed', edit_error_code: errorCode });
      await ctx.emit('social.variant.edit_failed', { post_id: post.id, variant_id: v.id, provider: v.provider, code: errorCode, unclear: r.kind === 'unknown', by });
      return { recorded: true as const, state, status: v.status };
    }
    // An older ask's answer. A refusal or an unclear one changes nothing more than its call: the platform shows what it
    // showed. A confirmation means the platform now shows that older text, unless a later call went out after it, whose
    // own answer decides; the variant then takes it, as the person who asked it approved it (their approval row, found
    // by the hash the call sent), and a pending ask made before it was seen is stopped, for its person to send again
    // on the text as it now is. When that text cannot be found, the pending ask is left unclear for a person.
    if (r.kind !== 'edited' || !latest || v.status !== 'published' || call.request_hash === null) return { recorded: true as const, state, status: v.status };
    const older = await olderAsk(ctx, post, v, call.request_hash);
    const pending = v.edit_state === 'pending';
    if (!older) {
      if (pending) await setVariant(ctx, v.id, { edit_state: 'unknown', edit_error_code: EDIT_SUPERSEDED });
      return { recorded: true as const, state, status: v.status };
    }
    const same = pending && older.hash === v.edit_content_hash;
    await confirm(ctx, post, v, older.body, older.by, same || !pending ? {} : { edit_state: 'failed', edit_error_code: EDIT_SUPERSEDED, edit_body: v.edit_body, edit_content_hash: v.edit_content_hash, edit_requested_at: v.edit_requested_at, edit_requested_by: v.edit_requested_by });
    return { recorded: true as const, state, status: v.status, revision: v.revision + 1 };
  },
});

export const editPublishedCommands = [variantEditPublished, editBegin, editRecord];
