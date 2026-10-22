// Crove's own short links (#706): on a channel that turns them on, a post's link goes out as <PUBLIC_URL>/l/<code>,
// which redirects to the link with its UTM tags and counts the click (short_link_hit, the redirect's definer). The
// code is made when the variant first goes out and kept for its revision, so a retry, a status check or a reconcile
// sends the same link; the target is fixed then and never taken from a request.
import type { CommandContext } from '@crove/kernel-runtime';
import { mapTelegramButtonUrls } from './domain/channels.ts';
import type { PublishWork } from './publishing.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const SHORT_CODE_LENGTH = 12;

// A random code of SHORT_CODE_LENGTH letters and digits (71 bits), drawn without modulo bias.
export function shortCode(random: (size: number) => Uint8Array = (size) => crypto.getRandomValues(new Uint8Array(size))): string {
  let out = '';
  while (out.length < SHORT_CODE_LENGTH) {
    for (const byte of random(SHORT_CODE_LENGTH * 2)) {
      // 248 is the largest multiple of 62 under 256.
      if (byte < 248 && out.length < SHORT_CODE_LENGTH) out += ALPHABET[byte % 62];
    }
  }
  return out;
}

// The deployment's URL without its trailing slashes (a loop: a regex on PUBLIC_URL would be quadratic on many of them).
export function shortUrl(publicUrl: string, code: string): string {
  let base = publicUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/l/${code}`;
}

// Where the text holds the link as a whole: after the start, a space or an opening bracket or quote, and before the end,
// a space, a closing bracket or quote, or sentence punctuation. A longer link it begins (the same site's other pages)
// is left alone.
const BEFORE = new Set([' ', '\n', '\t', '(', '[', '"', "'", '<']);
const AFTER = new Set([' ', '\n', '\t', ')', ']', '"', "'", '>', ',', '.', '!', '?', ';', ':']);
function replaceWhole(text: string, target: string, replacement: string): string {
  let out = '';
  let from = 0;
  for (let at = text.indexOf(target); at >= 0; at = text.indexOf(target, at + target.length)) {
    const before = at === 0 ? undefined : text[at - 1];
    const after = text[at + target.length];
    // Punctuation counts as an end only when the text ends or a space follows it.
    const next = text[at + target.length + 1];
    const ends = after === undefined || (AFTER.has(after) && (!'.,!?;:'.includes(after) || next === undefined || next === ' ' || next === '\n'));
    if ((before === undefined || BEFORE.has(before)) && ends) {
      out += text.slice(from, at) + replacement;
      from = at + target.length;
    }
  }
  return out + text.slice(from);
}

// The content as it goes out with its short link: the link replaced, and so is the same link where the text holds it.
export function shortened<T extends { body: string; linkUrl: string | null }>(content: T, link: { target: string; url: string }): T {
  if (!content.linkUrl) return content;
  return { ...content, linkUrl: link.url, body: replaceWhole(content.body, link.target, link.url) };
}

// The settings as they go out with the post's short link: a Telegram button (#1017) to the post's link goes through it
// too. A button to another page keeps its own link (with its UTM tags), as a link written in the text does: a variant
// has one short link per revision.
export function shortenedSettings(settings: Record<string, unknown>, link: { target: string; url: string }): Record<string, unknown> {
  return mapTelegramButtonUrls(settings, (url) => (url === link.target ? link.url : url));
}

// The short link of a publish step: the variant's for its revision when it has one; on a first call, a new one when its
// channel sends links through Crove and the post has a link.
export async function withShortLink(ctx: CommandContext, w: PublishWork, revision: number): Promise<PublishWork> {
  const target = w.content.linkUrl;
  if (!target || !/^https?:\/\//.test(target) || target.length > 2048) return w;
  const existing = await ctx.trx
    .selectFrom('crove_social.short_link')
    .select(['code', 'target_url'])
    .where('org_id', '=', ctx.orgId)
    .where('variant_id', '=', w.variantId)
    .where('revision', '=', revision)
    .executeTakeFirst();
  if (existing) return { ...w, shortLink: { code: existing.code, target: existing.target_url } };
  if (w.action !== 'call') return w;
  const policy = await ctx.trx
    .selectFrom('crove_social.channel_policy')
    .select('short_links')
    .where('org_id', '=', ctx.orgId)
    .where('channel_connection_id', '=', w.connectionId)
    .executeTakeFirst();
  if (!policy?.short_links) return w;
  // A clash of two random codes is all but impossible; one more try covers it.
  for (let i = 0; i < 2; i++) {
    const code = shortCode();
    const row = await ctx.trx
      .insertInto('crove_social.short_link')
      .values({ org_id: ctx.orgId, code, variant_id: w.variantId, revision, post_id: w.postId, target_url: target, created_at: ctx.now })
      .onConflict((oc) => oc.doNothing())
      .returning(['code', 'target_url'])
      .executeTakeFirst();
    if (row) return { ...w, shortLink: { code: row.code, target: row.target_url } };
  }
  // Both tries clashed (a code, or another step that made the variant's link meanwhile): the variant's own, if any.
  const made = await ctx.trx.selectFrom('crove_social.short_link').select(['code', 'target_url']).where('org_id', '=', ctx.orgId).where('variant_id', '=', w.variantId).where('revision', '=', revision).executeTakeFirst();
  return made ? { ...w, shortLink: { code: made.code, target: made.target_url } } : w;
}
