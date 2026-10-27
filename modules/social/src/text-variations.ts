// Text variations (#1260): up to 5 other texts of an evergreen (#393) or recurring (#979) post, kept on the post with
// the position of the next one (crove_social.post.text_variations, text_variation_next). Each copy the worker makes
// takes the next one in turn as its text (repostCopy with rotate), and the cursor moves on in the copy's transaction,
// under the post's lock; a text that would repeat a recent post on X or LinkedIn (#1156) is passed over while another
// is left. The variation is the copy's text, so banned words, the review checklist, the channel rules, the signature and
// the duplicate check all see the text sent, and the copy goes to review as before. A variation AI wrote (#583, the
// rewrite's "variation" action) only fills the form; it is marked ai once a person saves it, and a copy made from it is
// tainted.
import { z } from 'zod';
import { zId, zSocialTextVariations } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext } from '@crove/kernel-runtime';
import { effectiveContent } from './domain/approval.ts';
import { refusesDuplicates } from './domain/duplicate.ts';
import { cursorAfterEdit, cursorOf, keepAiMarks, parseTextVariations, variationOrder, type TextVariation } from './domain/text-variations.ts';
import { duplicatesOf } from './duplicates.ts';
import { lockPost, refuseArchived, settingsOf, type VariantRow } from './variants.ts';
import { refusePostWholly } from './channel-access.ts';

const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export interface ChosenVariation extends TextVariation {
  index: number;
  // The cursor once the copy is made.
  next: number;
}

async function variationsOf(ctx: CommandContext, postId: string): Promise<{ list: TextVariation[]; cursor: number }> {
  const row = await ctx.trx.selectFrom('crove_social.post').select(['text_variations', 'text_variation_next']).where('org_id', '=', ctx.orgId).where('id', '=', postId).executeTakeFirstOrThrow();
  return { list: parseTextVariations(row.text_variations), cursor: row.text_variation_next };
}

/**
 * The variation the next copy of `postId` takes for the channels `targets`, or null when the post has none. Call under
 * the post's lock. The one at the cursor, unless its text, signature included, matches a post of the last 30 days (or
 * one scheduled or queued) on one of the targets on X or LinkedIn, which refuse it: then the next one in turn that does
 * not, and when every one does, the one at the cursor all the same (the post page and review warn as for any text).
 */
export async function nextTextVariation(ctx: CommandContext, postId: string, targets: readonly VariantRow[]): Promise<ChosenVariation | null> {
  const { list, cursor } = await variationsOf(ctx, postId);
  if (list.length === 0) return null;
  const refusing = targets.filter((v) => refusesDuplicates(v.provider));
  const repeats = async (variation: TextVariation): Promise<boolean> => {
    if (refusing.length === 0) return false;
    const found = await duplicatesOf(
      ctx.trx,
      ctx.orgId,
      // The copy does not exist yet: nothing is left out of the comparison (postId null), so the post's own text that
      // went out counts too.
      refusing.map((v) => ({
        id: v.id,
        postId: null,
        connectionId: v.channel_connection_id,
        status: 'draft' as const,
        body: effectiveContent({ body: variation.text, title: null, linkUrl: null }, { body: null, title: null, linkUrl: null }, false, settingsOf(v)).body,
      })),
      ctx.now,
    );
    return found.size > 0;
  };
  let index = cursorOf(list.length, cursor);
  for (const at of variationOrder(list.length, cursor)) {
    if (!(await repeats(list[at] as TextVariation))) {
      index = at;
      break;
    }
  }
  const chosen = list[index] as TextVariation;
  return { ...chosen, index, next: (index + 1) % list.length };
}

// Moves the cursor past the variation a copy just took. Under the post's lock, in the copy's transaction.
export async function advanceTextVariation(ctx: CommandContext, postId: string, chosen: ChosenVariation): Promise<void> {
  await ctx.trx.updateTable('crove_social.post').set({ text_variation_next: chosen.next }).where('org_id', '=', ctx.orgId).where('id', '=', postId).execute();
}

export type TextVariationsResult = { postId: string; variations: TextVariation[]; next: number };

// Replaces the list. Only on an evergreen or series post (clearing is always allowed), never on a copy of a series,
// whose copies repeat with their series post; a member limited to some channels (#1081) only on a post wholly on those,
// as its copies go to every channel of it. The cursor stays on the text it named when that text is kept.
export const postSetTextVariations = defineCommand({
  name: 'social.post.set_text_variations',
  input: z.strictObject({ postId: zId, variations: zSocialTextVariations }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  target: (input) => ({ type: 'social.post', id: input.postId }),
  handler: async (ctx, input): Promise<TextVariationsResult> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const post = await lockPost(ctx.trx, ctx.orgId, input.postId);
    await refusePostWholly(ctx, input.postId);
    // Not on an archived post (#1299): restore it first, as for any other edit.
    refuseArchived(post);
    const row = await ctx.trx
      .selectFrom('crove_social.post')
      .select(['evergreen_days', 'recurrence', 'recurrence_source_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .executeTakeFirstOrThrow();
    if (row.recurrence_source_id !== null && input.variations.length > 0) {
      throw new DomainError('VARIATIONS_ON_COPY', 409, 'Bài này là một lần lặp của bài định kỳ khác; hãy thêm biến thể ở bài gốc của chuỗi');
    }
    if (row.evergreen_days === null && row.recurrence === null && input.variations.length > 0) {
      throw new DomainError('VARIATIONS_NOT_REPEATING', 409, 'Chỉ bài tự đăng lại hoặc lặp lại theo lịch mới có biến thể nội dung; hãy bật một trong hai trước');
    }
    const before = await variationsOf(ctx, input.postId);
    const variations = keepAiMarks(before.list, input.variations);
    const next = cursorAfterEdit(before.list, before.cursor, variations);
    await ctx.trx
      .updateTable('crove_social.post')
      .set({ text_variations: JSON.stringify(variations), text_variation_next: next, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.postId)
      .execute();
    // The count and the AI marks; the texts themselves stay out of the audit row.
    ctx.audit({ post_id: input.postId, variations: variations.length, ai: variations.filter((v) => v.ai).length, next });
    return { postId: input.postId, variations, next };
  },
});

export const textVariationCommands = [postSetTextVariations];
