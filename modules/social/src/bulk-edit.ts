// Labels and the assignee on many posts at once (#1057), as Planable and Hootsuite Planner edit a month's posts in one
// go. Each command is one transaction: it locks every post it names in id order (as the queue reorders do), so two
// bulk edits, or a bulk edit and a single one, never wait on each other in a cycle; then each post goes through the
// single-post command (social.post.set_labels, social.post.assign) as a nested command, with that command's own
// checks, its own audit row (the post's timeline shows it) and, for an assignment, its own event, so the assignee is
// told of each post as for a single assignment. A post the caller may not change is left out with the reason, and
// the others go on; the answer names every post left out and why.
//
// Left out without trying: a post that is not there (or is another org's), one already published (every live channel
// out), and one the change would not change. A label edit that would put more than ten labels on a post leaves that
// post out too. A label to add that the org does not have, or an assignee who is not a member, refuses the whole
// command: nothing would be done the way the person asked.
//
// Find and replace (#1144), as Publer and Hootsuite edit a month of scheduled posts when a link, a price or a promo
// code changes: social.post.bulk_replace_preview lists, per post, where the text matches (the base text, title and
// link, each channel's own text, title and link, and its first comment) and why a post would be left out;
// social.post.bulk_replace makes exactly those changes. Both read the posts the same way and decide with the same plan
// (planReplace), so on the same content the preview shows what the command does. The command locks the posts in id
// order, then runs social.post.update for the base content and social.variant.update for each channel's own, as
// nested commands: each with its revision check, its audit row, its post version, its channel access check (#1081) and
// its state step, so an approved or scheduled channel the change reaches goes back to draft for review, as after a
// single edit. Left out, with the reason:
// - not_found; not_allowed for a post on none of the caller's channels (#1081), before anything else is said of it,
//   so a limited member learns nothing of a post they cannot see (#1099), and for a change that would reach a channel
//   they may not use (a channel's own content outside their channels is not even looked at);
// - published: no channel left to edit; no_match; unchanged: the replacement is what was there;
// - in_flight: the change would reach a channel going out;
// - over_limit: a field over what an edit takes, or a channel that fitted its rules and would no longer;
// - invalid_link: a link that would no longer be one;
// - banned_words: a channel the change would give a 'block' word it did not have (#1055).
// A refusal of a post's first nested command leaves only that post out; one of a later nested command of the same post
// fails the whole command, so a post is never left half replaced (the checks above make it rare).
import { sql } from 'kysely';
import { z } from 'zod';
import { zSocialBulkAssign, zSocialBulkLabels, zSocialBulkReplace, type SocialBulkSkipReason, type SocialReplaceField } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { BannedWordsTooComplex } from './domain/banned-words.ts';
import { replaceLiteral, type ReplaceExcerpt, type ReplaceOptions } from './domain/replace.ts';
import { FROZEN, IN_FLIGHT } from './domain/state.ts';
import { bannedChecker, bannedCommandBudget, bannedTooComplex, bannedWordsOf, type BannedCheck } from './banned-words.ts';
import { channelScope, mayUse, type ChannelScope } from './channel-access.ts';
import { MAX_LABELS_PER_POST } from './labels.ts';
import { coverProblem } from './cover-check.ts';
import { POST_COLUMNS, VARIANT_COLUMNS, base, hashOf, issuesOf, loadPostMedia, lockVariants, settingsOf, type PostRow, type Trx, type VariantRow } from './variants.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export interface BulkEditResult {
  done: string[];
  skipped: { postId: string; reason: SocialBulkSkipReason }[];
}

interface LockedPost {
  id: string;
  status: string;
  assignee_user_id: string | null;
  due_at: Date | null;
}

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// Every post named, locked in id order; the ones not found are simply missing from the map.
async function lockPosts(ctx: CommandContext, postIds: readonly string[]): Promise<Map<string, LockedPost>> {
  const rows = await ctx.trx
    .selectFrom('crove_social.post')
    .select(['id', 'status', 'assignee_user_id', 'due_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', [...postIds])
    .orderBy('id')
    .forUpdate()
    .execute();
  return new Map(rows.map((r) => [r.id, r]));
}

// The posts in the order they were locked (by id), so the nested commands run in that order too.
const byId = (postIds: readonly string[]) => [...postIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// The refusals of a nested command that leave only that post out: the caller may not change it. Anything else (a
// broken session, an agent's limits, a server error) fails the whole command.
// A post on channels a limited member may not use (#1081) is one of those.
const notAllowed = (refusal: DomainError) => refusal.code === 'FORBIDDEN' || refusal.code === 'CHANNEL_NOT_ALLOWED';

function audit(ctx: CommandContext, result: BulkEditResult, facts: Record<string, unknown>) {
  ctx.audit({
    ...facts,
    done: result.done.length,
    post_ids: result.done,
    skipped: result.skipped.map((s) => ({ post_id: s.postId, reason: s.reason })),
  });
}

export const postBulkLabels = defineCommand({
  name: 'social.post.bulk_labels',
  input: zSocialBulkLabels,
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input): Promise<BulkEditResult> => {
    requireUser(ctx);
    const posts = await lockPosts(ctx, input.postIds);
    if (input.add.length > 0) {
      // Held until the commit, as social.post.set_labels does, so a label deleted meanwhile waits for this command.
      const found = await ctx.trx.selectFrom('crove_social.label').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', input.add).forKeyShare().execute();
      if (found.length !== input.add.length) throw new DomainError('LABEL_NOT_FOUND', 404, 'Có nhãn không tồn tại hoặc đã bị xóa');
    }
    const ids = [...posts.keys()];
    const current = ids.length === 0 ? [] : await ctx.trx.selectFrom('crove_social.post_label').select(['post_id', 'label_id']).where('org_id', '=', ctx.orgId).where('post_id', 'in', ids).orderBy('created_at').orderBy('label_id').execute();
    const labelsOf = new Map<string, string[]>();
    for (const r of current) labelsOf.set(r.post_id, [...(labelsOf.get(r.post_id) ?? []), r.label_id]);
    const remove = new Set(input.remove);
    const result: BulkEditResult = { done: [], skipped: [] };
    for (const postId of byId(input.postIds)) {
      const post = posts.get(postId);
      if (!post) {
        result.skipped.push({ postId, reason: 'not_found' });
        continue;
      }
      if (post.status === 'published') {
        result.skipped.push({ postId, reason: 'published' });
        continue;
      }
      const have = labelsOf.get(postId) ?? [];
      const kept = have.filter((id) => !remove.has(id));
      const next = [...kept, ...input.add.filter((id) => !have.includes(id))];
      if (next.length === have.length && kept.length === have.length) {
        result.skipped.push({ postId, reason: 'unchanged' });
        continue;
      }
      if (next.length > MAX_LABELS_PER_POST) {
        result.skipped.push({ postId, reason: 'too_many_labels' });
        continue;
      }
      const attempt = await ctx.tryRun('social.post.set_labels', { postId, labelIds: next }, { recover: notAllowed });
      if (attempt.status === 'ok') result.done.push(postId);
      else result.skipped.push({ postId, reason: 'not_allowed' });
    }
    audit(ctx, result, { add: input.add, remove: input.remove });
    return result;
  },
});

export const postBulkAssign = defineCommand({
  name: 'social.post.bulk_assign',
  input: zSocialBulkAssign,
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input): Promise<BulkEditResult> => {
    requireUser(ctx);
    const posts = await lockPosts(ctx, input.postIds);
    // Checked once for all the posts: a person who is not a member is never assigned anything (crove_kernel.member_profiles
    // answers for members of the org only).
    if (input.assigneeUserId) {
      const { rows } = await sql<{ user_id: string }>`SELECT user_id FROM crove_kernel.member_profiles(${[input.assigneeUserId]}::uuid[])`.execute(ctx.trx);
      if (rows.length === 0) throw new DomainError('ASSIGNEE_NOT_MEMBER', 422, 'Người được giao không phải thành viên của tổ chức');
    }
    const dueMs = input.dueAt ? Date.parse(input.dueAt) : null;
    const result: BulkEditResult = { done: [], skipped: [] };
    for (const postId of byId(input.postIds)) {
      const post = posts.get(postId);
      if (!post) {
        result.skipped.push({ postId, reason: 'not_found' });
        continue;
      }
      if (post.status === 'published') {
        result.skipped.push({ postId, reason: 'published' });
        continue;
      }
      // Left out, the due date stays each post's own.
      const due = input.dueAt === undefined ? (post.due_at?.toISOString() ?? null) : input.dueAt;
      const sameDue = input.dueAt === undefined || (post.due_at?.getTime() ?? null) === dueMs;
      if (post.assignee_user_id === input.assigneeUserId && sameDue) {
        result.skipped.push({ postId, reason: 'unchanged' });
        continue;
      }
      const attempt = await ctx.tryRun('social.post.assign', { postId, assigneeUserId: input.assigneeUserId, dueAt: due }, { recover: notAllowed });
      if (attempt.status === 'ok') result.done.push(postId);
      else result.skipped.push({ postId, reason: 'not_allowed' });
    }
    audit(ctx, result, { assignee_user_id: input.assigneeUserId, due_at: input.dueAt === undefined ? 'kept' : input.dueAt });
    return result;
  },
});

// What social.post.update and social.variant.update take: the text, the title, the link, and the settings that hold
// the first comment.
const BODY_MAX = 100_000;
const TITLE_MAX = 500;
const LINK_MAX = 2000;
const SETTINGS_MAX_BYTES = 16_384;
const zLink = z.url({ protocol: /^https?$/ }).max(LINK_MAX);

export interface ReplaceMatch extends ReplaceExcerpt {
  // null: the post's own content, which every channel without its own inherits.
  variantId: string | null;
  connectionId: string | null;
  field: SocialReplaceField;
  count: number;
}
interface ContentEdit {
  body?: string;
  title?: string;
  linkUrl?: string;
}
type VariantEdit = ContentEdit & { settings?: Record<string, unknown> };
interface ReplacePlan {
  postId: string;
  skip: SocialBulkSkipReason | null;
  matches: ReplaceMatch[];
  // The nested edits, when it changes: the base content, then each channel's own.
  post: ContentEdit | null;
  variants: Array<{ variantId: string; edit: VariantEdit }>;
}
export interface BulkReplacePreview {
  posts: Array<{ postId: string; skip: SocialBulkSkipReason | null; matches: ReplaceMatch[] }>;
}

interface LoadedPost {
  post: PostRow;
  variants: VariantRow[];
}

// The posts named and their channels; the command locks them (posts in id order, then each post's variants, as the
// nested edits lock them), the preview reads them.
async function loadPosts(trx: Trx, orgId: string, postIds: readonly string[], lock: boolean): Promise<Map<string, LoadedPost>> {
  let q = trx.selectFrom('crove_social.post').select(POST_COLUMNS).where('org_id', '=', orgId).where('id', 'in', [...postIds]).orderBy('id');
  if (lock) q = q.forUpdate();
  const out = new Map<string, LoadedPost>();
  for (const row of await q.execute()) {
    const media = await loadPostMedia(trx, orgId, row.id);
    const variants = lock
      ? await lockVariants(trx, orgId, row.id)
      : await trx.selectFrom('crove_social.post_variant').select(VARIANT_COLUMNS).where('org_id', '=', orgId).where('post_id', '=', row.id).orderBy('position').orderBy('id').execute();
    out.set(row.id, { post: { ...row, media }, variants });
  }
  return out;
}

const issueKey = (i: { code: string; field: string }) => `${i.code}:${i.field}`;
const blockedWords = (check: BannedCheck, content: Parameters<BannedCheck>[0], v: VariantRow) =>
  check(content, v)
    .filter((m) => m.level === 'block')
    .map((m) => m.wordId);

function planPost(postId: string, loaded: LoadedPost | undefined, scope: ChannelScope, check: BannedCheck, options: ReplaceOptions): ReplacePlan {
  const matches: ReplaceMatch[] = [];
  const leave = (skip: SocialBulkSkipReason, shown: ReplaceMatch[] = matches): ReplacePlan => ({ postId, skip, matches: shown, post: null, variants: [] });
  if (!loaded) return leave('not_found', []);
  const { post, variants } = loaded;
  if (scope !== null && !variants.some((v) => scope.has(v.channel_connection_id))) return leave('not_allowed', []);
  const live = variants.filter((v) => !FROZEN.has(v.status));
  // A channel's own content is replaced while it can still be edited, and only on the caller's channels.
  const editable = live.filter((v) => !v.content_frozen);
  if (editable.length === 0) return leave('published', []);
  let over = false;
  const replaced = (v: VariantRow | null, field: SocialReplaceField, text: string | null, max: number): string | undefined => {
    if (text === null) return undefined;
    const r = replaceLiteral(text, options, max);
    if (r.count === 0 || !r.first) return undefined;
    matches.push({ variantId: v?.id ?? null, connectionId: v?.channel_connection_id ?? null, field, count: r.count, ...r.first });
    if (r.overflow) {
      over = true;
      return undefined;
    }
    return r.text === text ? undefined : r.text;
  };
  const contentEdit = (v: VariantRow | null, content: { body: string | null; title: string | null; link_url: string | null }): ContentEdit => {
    const edit: ContentEdit = {};
    const body = replaced(v, 'body', content.body, BODY_MAX);
    const title = replaced(v, 'title', content.title, TITLE_MAX);
    const link = replaced(v, 'link', content.link_url, LINK_MAX);
    if (body !== undefined) edit.body = body;
    if (title !== undefined) edit.title = title;
    if (link !== undefined) edit.linkUrl = link;
    return edit;
  };
  const postEdit = contentEdit(null, post);
  const own = new Map<string, VariantEdit>();
  for (const v of editable) {
    if (!mayUse(scope, v.channel_connection_id)) continue;
    const edit: VariantEdit = contentEdit(v, v);
    const settings = settingsOf(v);
    const comment = typeof settings.firstComment === 'string' ? replaced(v, 'first_comment', settings.firstComment, SETTINGS_MAX_BYTES) : undefined;
    if (comment !== undefined) edit.settings = { ...settings, firstComment: comment };
    if (Object.keys(edit).length > 0) own.set(v.id, edit);
  }
  if (matches.length === 0) return leave('no_match');
  if (Object.keys(postEdit).length === 0 && own.size === 0 && !over) return leave('unchanged');

  const before = base(post);
  const after = base({ ...post, body: postEdit.body ?? post.body, title: postEdit.title ?? post.title, link_url: postEdit.linkUrl ?? post.link_url });
  const next = (v: VariantRow): VariantRow => {
    const e = own.get(v.id);
    return e ? { ...v, body: e.body ?? v.body, title: e.title ?? v.title, link_url: e.linkUrl ?? v.link_url, settings: e.settings ?? v.settings } : v;
  };
  // The channels whose content would change, as social.post.update and social.variant.update find them.
  const reached = live.filter((v) => hashOf(after, next(v)) !== v.content_hash);
  if (reached.some((v) => !mayUse(scope, v.channel_connection_id))) return leave('not_allowed');
  if (reached.some((v) => IN_FLIGHT.has(v.status))) return leave('in_flight');
  const edits = [...own.values()];
  if (over || edits.some((e) => e.settings !== undefined && Buffer.byteLength(JSON.stringify(e.settings), 'utf8') > SETTINGS_MAX_BYTES)) return leave('over_limit');
  const links = [postEdit.linkUrl, ...edits.map((e) => e.linkUrl)].filter((l) => l !== undefined);
  if (links.some((l) => !zLink.safeParse(l).success)) return leave('invalid_link');
  // A channel that fitted its rules keeps fitting them; one already over a limit may stay so (the edit does not make it
  // worse in kind), as a single edit leaves the check to the review.
  for (const v of reached) {
    const had = new Set(issuesOf(before, v).map(issueKey));
    if (issuesOf(after, next(v)).some((i) => !had.has(issueKey(i)))) return leave('over_limit');
  }
  for (const v of reached) {
    const had = new Set(blockedWords(check, before, v));
    if (blockedWords(check, after, next(v)).some((id) => !had.has(id))) return leave('banned_words');
  }
  return {
    postId,
    skip: null,
    matches,
    post: Object.keys(postEdit).length > 0 ? postEdit : null,
    variants: editable.filter((v) => own.has(v.id)).map((v) => ({ variantId: v.id, edit: own.get(v.id) as VariantEdit })),
  };
}

type ReplaceInput = z.infer<typeof zSocialBulkReplace>;
const optionsOf = (input: ReplaceInput): ReplaceOptions => ({ find: input.find, replace: input.replace, caseSensitive: input.caseSensitive ?? false, wholeWord: input.wholeWord ?? false });

// The plan of every post, in id order. One banned-word budget is shared across the posts, as in any command over many
// posts; past it the command and the preview both refuse (BANNED_WORDS_TOO_COMPLEX).
async function planReplace(ctx: Pick<QueryContext, 'trx' | 'orgId' | 'actor' | 'role'>, input: ReplaceInput, loaded: Map<string, LoadedPost>): Promise<ReplacePlan[]> {
  const scope = await channelScope(ctx);
  const check = bannedChecker(await bannedWordsOf(ctx.trx, ctx.orgId), bannedCommandBudget());
  const options = optionsOf(input);
  let plans: ReplacePlan[];
  try {
    plans = byId(input.postIds).map((postId) => planPost(postId, loaded.get(postId), scope, check, options));
  } catch (error) {
    if (error instanceof BannedWordsTooComplex) throw bannedTooComplex();
    throw error;
  }
  // A channel's settings edit (its first comment) checks the channel's cover again; one whose cover no longer passes
  // (its file gone, or no longer an image the channel takes) leaves the post out here, rather than refusing the whole
  // command from a later nested edit.
  for (const plan of plans) {
    if (plan.skip !== null) continue;
    const variants = loaded.get(plan.postId)?.variants ?? [];
    for (const { variantId, edit } of plan.variants) {
      const provider = variants.find((v) => v.id === variantId)?.provider;
      if (edit.settings === undefined || provider === undefined) continue;
      if (await coverProblem(ctx, provider, { ...edit.settings })) {
        Object.assign(plan, { skip: 'over_limit', post: null, variants: [] });
        break;
      }
    }
  }
  return plans;
}

// The refusals of a post's first nested edit that leave only that post out.
const LEFT_OUT: Readonly<Partial<Record<string, SocialBulkSkipReason>>> = { FORBIDDEN: 'not_allowed', CHANNEL_NOT_ALLOWED: 'not_allowed', VARIANT_IN_FLIGHT: 'in_flight', VARIANT_STATE: 'in_flight' };

// The post's nested edits, one after another: the reason it was left out, or null when it changed.
async function applyPlan(ctx: CommandContext, plan: ReplacePlan, revision: number): Promise<SocialBulkSkipReason | null> {
  let first = true;
  const run = async (name: string, input: Record<string, unknown>): Promise<SocialBulkSkipReason | null> => {
    const attempt = await ctx.tryRun(name, input, { recover: (refusal) => first && LEFT_OUT[refusal.code] !== undefined });
    first = false;
    return attempt.status === 'ok' ? null : (LEFT_OUT[attempt.refusal.code] ?? 'not_allowed');
  };
  if (plan.post) {
    const left = await run('social.post.update', { postId: plan.postId, revision, ...plan.post });
    if (left) return left;
  }
  for (const { variantId, edit } of plan.variants) {
    // Read again: the base edit before may have given the channel a new revision.
    const v = await ctx.trx.selectFrom('crove_social.post_variant').select('revision').where('org_id', '=', ctx.orgId).where('id', '=', variantId).executeTakeFirstOrThrow();
    const left = await run('social.variant.update', { variantId, revision: v.revision, ...edit });
    if (left) return left;
  }
  return null;
}

export const postBulkReplacePreview = defineQuery({
  name: 'social.post.bulk_replace_preview',
  input: zSocialBulkReplace,
  access: MEMBERS,
  handler: async (ctx, input): Promise<BulkReplacePreview> => {
    const plans = await planReplace(ctx, input, await loadPosts(ctx.trx, ctx.orgId, input.postIds, false));
    return { posts: plans.map((p) => ({ postId: p.postId, skip: p.skip, matches: p.matches })) };
  },
});

export const postBulkReplace = defineCommand({
  name: 'social.post.bulk_replace',
  input: zSocialBulkReplace,
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input): Promise<BulkEditResult> => {
    requireUser(ctx);
    const loaded = await loadPosts(ctx.trx, ctx.orgId, input.postIds, true);
    const result: BulkEditResult = { done: [], skipped: [] };
    for (const plan of await planReplace(ctx, input, loaded)) {
      const left = plan.skip ?? (await applyPlan(ctx, plan, (loaded.get(plan.postId) as LoadedPost).post.revision));
      if (left) result.skipped.push({ postId: plan.postId, reason: left });
      else result.done.push(plan.postId);
    }
    audit(ctx, result, { find: input.find, replace: input.replace, case_sensitive: input.caseSensitive ?? false, whole_word: input.wholeWord ?? false });
    return result;
  },
});

export const bulkEditCommands = [postBulkLabels, postBulkAssign, postBulkReplace];
export const bulkEditQueries = [postBulkReplacePreview];
