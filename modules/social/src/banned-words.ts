// Banned and sensitive words (#1055), as Hootsuite's compliance word lists and Sprinklr's do: words or phrases an org
// does not want in its posts ("số 1", "tốt nhất", claims of cures), each a warning or a block, for every channel or
// some. Owners and admins add and remove them (social.banned_word.add, social.banned_word.remove, R1, audited); every
// member reads the list (social.banned_word.list), so the composer marks matches as a person types.
//
// The check runs where content moves on: social.post.submit (and import with submit), the approval in
// social.variant.decide and social.variant.schedule refuse a channel whose effective content holds a 'block' word with
// 422 BANNED_WORDS; evergreen and recurring copies with one stay drafts; an approval that completes on its own (a
// lowered approval count, the client's yes, the client step turned off) leaves such a channel in review; RSS feeds only
// make drafts, which are submitted like any post. A 'warn' word never refuses: social.post.get lists it for the writer
// and the reviewer. A channel already scheduled, queued, retried or resumed is not checked again before it goes out.
// Every check has a budget (BANNED_OPS_MAX; a command over many posts shares one BANNED_COMMAND_OPS_MAX across them):
// past it a command refuses (BANNED_WORDS_TOO_COMPLEX), an import row or a copy stays a draft, an automatic approval
// leaves the channel in review, and a view says too_complex.
// Matching is the pure domain/banned-words.ts, the same in the app. Crove ships no list of its own.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole, SocialBannedWordLevel } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { effectiveContent } from './domain/approval.ts';
import {
  BANNED_PHRASE_MAX,
  BANNED_REASON_MAX,
  BANNED_WORD_CHANNELS_MAX,
  BANNED_WORD_LEVELS,
  BANNED_COMMAND_OPS_MAX,
  BANNED_COMMAND_PREPARE_MAX,
  BANNED_WORDS_MAX,
  BannedWordsTooComplex,
  bannedBudget,
  compileBannedWords,
  findBannedWords,
  normalizePhrase,
  prepareBannedText,
  variantTexts,
  wordsForChannel,
  type BannedBudget,
  type BannedFieldMatch,
  type BannedMatch,
  type BannedMatcher,
  type BannedText,
  type BannedWord,
  type BannedWordLevel,
} from './domain/banned-words.ts';
import { overrides, settingsOf, type PostContent, type Trx, type VariantRow } from './variants.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
// The matches a variant view lists, at most, one per word and field.
export const BANNED_VIEW_MAX = 50;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// The phrase as the person typed it, in NFC with its white space collapsed; its normalized form is checked too.
const zPhrase = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\s+/gu, ' ').trim())
  .pipe(z.string().min(1).max(BANNED_PHRASE_MAX))
  .refine((s) => normalizePhrase(s) !== '', 'phrase is empty');

export const zBannedWordAdd = z.strictObject({
  phrase: zPhrase,
  level: z.enum(BANNED_WORD_LEVELS),
  reason: z.string().trim().max(BANNED_REASON_MAX).nullable().optional(),
  // The channels it applies to; every channel when empty or absent.
  connectionIds: z.array(zId).max(BANNED_WORD_CHANNELS_MAX).optional(),
});

// One write at a time per org, so the count and the duplicate check hold until the commit.
const lockOrg = (ctx: CommandContext) => sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.banned_word:${ctx.orgId}`}))`.execute(ctx.trx);

export const bannedWordAdd = defineCommand({
  name: 'social.banned_word.add',
  input: zBannedWordAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const connectionIds = [...new Set(input.connectionIds ?? [])];
    if (connectionIds.length > 0) {
      const found = await ctx.trx.selectFrom('crove_kernel.channel_connection').select('id').where('org_id', '=', ctx.orgId).where('id', 'in', connectionIds).where('status', '<>', 'revoked').execute();
      if (found.length !== connectionIds.length) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không thuộc tổ chức này');
    }
    await lockOrg(ctx);
    const normalized = normalizePhrase(input.phrase);
    const count = await ctx.trx.selectFrom('crove_social.banned_word').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (Number(count.n) >= BANNED_WORDS_MAX) throw new DomainError('BANNED_WORD_LIMIT', 409, `Mỗi tổ chức lưu tối đa ${BANNED_WORDS_MAX} từ cấm`);
    const taken = await ctx.trx.selectFrom('crove_social.banned_word').select('id').where('org_id', '=', ctx.orgId).where('normalized', '=', normalized).executeTakeFirst();
    if (taken) throw new DomainError('BANNED_WORD_EXISTS', 409, 'Từ này đã có trong danh sách', { wordId: taken.id });
    const reason = input.reason ? input.reason : null;
    const row = await ctx.trx
      .insertInto('crove_social.banned_word')
      .values({ org_id: ctx.orgId, phrase: input.phrase, normalized, level: input.level, reason, connection_ids: connectionIds, created_by: userId, created_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ word_id: row.id, phrase: input.phrase, level: input.level, connection_ids: connectionIds });
    return { wordId: row.id };
  },
});

export const bannedWordRemove = defineCommand({
  name: 'social.banned_word.remove',
  input: z.strictObject({ wordId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const row = await ctx.trx
      .deleteFrom('crove_social.banned_word')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.wordId)
      .returning(['id', 'phrase', 'level'])
      .executeTakeFirst();
    if (!row) throw new DomainError('BANNED_WORD_NOT_FOUND', 404, 'Không tìm thấy từ này trong danh sách');
    ctx.audit({ word_id: row.id, phrase: row.phrase, level: row.level });
    return { wordId: row.id };
  },
});

export interface BannedWordView extends BannedWord {
  createdBy: string;
  createdAt: string;
}

/** The org's words, by phrase. */
export async function bannedWordsOf(trx: Trx, orgId: string): Promise<BannedWordView[]> {
  const rows = await trx
    .selectFrom('crove_social.banned_word')
    .select(['id', 'phrase', 'level', 'reason', 'connection_ids', 'created_by', 'created_at'])
    .where('org_id', '=', orgId)
    .orderBy('normalized')
    .limit(BANNED_WORDS_MAX)
    .execute();
  return rows.map((r) => ({ id: r.id, phrase: r.phrase, level: r.level, reason: r.reason, connectionIds: r.connection_ids, createdBy: r.created_by, createdAt: r.created_at.toISOString() }));
}

export const bannedWordList = defineQuery({
  name: 'social.banned_word.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<BannedWordView[]> => bannedWordsOf(ctx.trx, ctx.orgId),
});

export type BannedCheck = (post: PostContent, v: Pick<VariantRow, 'channel_connection_id' | 'body' | 'title' | 'link_url' | 'settings' | 'content_frozen'>) => BannedFieldMatch[];

/**
 * The org's words and the matches in a variant's effective content of the words for its channel. One budget covers
 * every check made with it: make one checker per command or view, and share it across the command's rows or posts;
 * past the budget a check throws BannedWordsTooComplex. Channels with the same words share one compiled matcher, and
 * a text (the post's shared body, say) is cut into units once and scanned once per word set, however many variants
 * show it.
 */
export function bannedChecker(words: readonly BannedWord[], budget: BannedBudget = bannedBudget()): BannedCheck {
  const keyOf = new Map<string, string>();
  const matchers = new Map<string, BannedMatcher>();
  // Prepared texts are kept for a second word set up to PREPARED_KEPT units in all; matches by word set, then text.
  const prepared = new Map<string, BannedText>();
  let kept = 0;
  const found = new Map<string, Map<string, BannedMatch[]>>();
  return (post, v) => {
    if (words.length === 0) return [];
    let key = keyOf.get(v.channel_connection_id);
    if (key === undefined) {
      const mine = wordsForChannel(words, v.channel_connection_id);
      key = mine.map((w) => w.id).join(',');
      keyOf.set(v.channel_connection_id, key);
      if (!matchers.has(key)) matchers.set(key, compileBannedWords(mine));
    }
    const matcher = matchers.get(key) as BannedMatcher;
    let byText = found.get(key);
    if (!byText) {
      byText = new Map();
      found.set(key, byText);
    }
    const memo = byText;
    const content = effectiveContent(post, overrides(v), v.content_frozen, settingsOf(v));
    return variantTexts(content, settingsOf(v)).flatMap(({ field, text }) => {
      let list = memo.get(text);
      if (!list) {
        let t = prepared.get(text);
        if (!t) {
          // Cutting a text into units is linear in it; it counts against the budget like the scan.
          t = prepareBannedText(text, budget);
          if (kept + t.units.length <= PREPARED_KEPT) {
            prepared.set(text, t);
            kept += t.units.length;
          }
        }
        list = findBannedWords(t, matcher, budget);
        memo.set(text, list);
      }
      // At most one match per word and text, so this copy is bounded by the list.
      return list.map((m) => ({ ...m, field }));
    });
  };
}

const PREPARED_KEPT = 200_000;
export async function bannedCheckerOf(trx: Trx, orgId: string): Promise<BannedCheck> {
  return bannedChecker(await bannedWordsOf(trx, orgId));
}

/** The one budget a command that checks many posts shares across all of them (BANNED_COMMAND_OPS_MAX steps, BANNED_COMMAND_PREPARE_MAX characters). */
export const bannedCommandBudget = (): BannedBudget => bannedBudget(BANNED_COMMAND_OPS_MAX, BANNED_COMMAND_PREPARE_MAX);

/** Matches as a variant view lists them: one per word and field (the first place), at most BANNED_VIEW_MAX. */
export function bannedSummary(matches: readonly BannedFieldMatch[]): BannedFieldMatch[] {
  const seen = new Set<string>();
  const out: BannedFieldMatch[] = [];
  for (const m of matches) {
    const key = `${m.wordId}:${m.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
    if (out.length >= BANNED_VIEW_MAX) break;
  }
  return out;
}

const blocking = (matches: readonly BannedFieldMatch[]) => matches.filter((m) => m.level === 'block');

// The refusal of a command whose check ran out of its budget.
export const bannedTooComplex = () =>
  new DomainError('BANNED_WORDS_TOO_COMPLEX', 422, 'Bài quá dài hoặc danh sách từ cấm quá lớn để kiểm tra; hãy rút gọn bài hoặc danh sách từ cấm rồi thử lại');

/**
 * Refuses with 422 BANNED_WORDS when any of the variants holds a 'block' word for its channel; warnings pass. A check
 * that runs out of its budget refuses too (BANNED_WORDS_TOO_COMPLEX): nothing goes on unchecked.
 */
export async function refuseBannedWords(ctx: Pick<CommandContext, 'trx' | 'orgId'>, post: PostContent, variants: readonly VariantRow[]): Promise<void> {
  const check = await bannedCheckerOf(ctx.trx, ctx.orgId);
  let blocked: Array<{ variantId: string; words: Array<{ wordId: string; phrase: string; field: string; reason: string | null }> }>;
  try {
    blocked = variants
      .map((v) => ({ variantId: v.id, words: bannedSummary(blocking(check(post, v))).map((m) => ({ wordId: m.wordId, phrase: m.phrase, field: m.field, reason: m.reason })) }))
      .filter((x) => x.words.length > 0);
  } catch (error) {
    if (error instanceof BannedWordsTooComplex) throw bannedTooComplex();
    throw error;
  }
  if (blocked.length === 0) return;
  const phrases = [...new Set(blocked.flatMap((b) => b.words.map((w) => w.phrase)))];
  throw new DomainError('BANNED_WORDS', 422, `Bài có từ bị cấm: ${phrases.map((p) => `«${p}»`).join(', ')}`, { variants: blocked });
}

/**
 * Whether a variant holds a 'block' word for its channel, for the paths that hold such a variant back (a copy stays a
 * draft, an approval by policy or by the client leaves it in review). A check over its budget counts as blocked.
 */
export function isBlocked(check: BannedCheck, post: PostContent, v: VariantRow): boolean {
  try {
    return check(post, v).some((m) => m.level === 'block');
  } catch (error) {
    if (error instanceof BannedWordsTooComplex) return true;
    throw error;
  }
}

export type BannedWordsStatus = 'checked' | 'not_checked' | 'too_complex';

/** A view's matches of one variant: none and 'too_complex' when the view's budget ran out. */
export function bannedForView(check: BannedCheck, post: PostContent, v: VariantRow): { bannedWords: BannedFieldMatch[]; bannedWordsStatus: BannedWordsStatus } {
  try {
    return { bannedWords: bannedSummary(check(post, v)), bannedWordsStatus: 'checked' };
  } catch (error) {
    if (error instanceof BannedWordsTooComplex) return { bannedWords: [], bannedWordsStatus: 'too_complex' };
    throw error;
  }
}

// The level lists of this module and of the table's refinement in @crove/db must stay the same.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const levelsAgree: Same<BannedWordLevel, SocialBannedWordLevel> = true;
void levelsAgree;

export const bannedWordCommands = [bannedWordAdd, bannedWordRemove];
export const bannedWordQueries = [bannedWordList];
