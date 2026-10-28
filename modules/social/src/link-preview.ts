// Link preview cards (#641): the title, description and site name a link's page gives, for the composer's preview of
// a platform's link card. A member asks for a link (social.link_preview.request); a fresh answer (under a day old) or
// a request in progress is returned as it is, else the request is queued for the worker. The worker fetches the page
// through the kernel's egress guard, reads its head in crove-extract, and records what it found. The answer is shown
// in Crove only: no adapter reads this table, so nothing fetched is ever sent to a platform.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import { SOCIAL_LINK_PREVIEW_ERRORS, type MemberRole, type SocialLinkPreviewError, type SocialLinkPreviewStatus } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// An answer is fresh this long; a request in progress is not repeated for this long.
export const LINK_PREVIEW_FRESH_MS = 24 * 60 * 60_000;
export const LINK_PREVIEW_RETRY_MS = 2 * 60_000;
// Requests an org may send to the worker per minute.
export const LINK_PREVIEW_PER_MINUTE = 30;

export interface LinkPreview {
  url: string;
  status: SocialLinkPreviewStatus;
  title: string | null;
  description: string | null;
  siteName: string | null;
  // The page's main text (#779), for AI drafts only; null when it had none or was read before.
  text: string | null;
  error: SocialLinkPreviewError | null;
  fetchedAt: string | null;
}

// The link as the cache keys it: an absolute http(s) URL without its fragment; null when it is not one.
export function previewUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  const out = url.toString();
  return out.length <= 2048 ? out : null;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

type Row = { url: string; status: SocialLinkPreviewStatus; title: string | null; description: string | null; site_name: string | null; text: string | null; error: SocialLinkPreviewError | null; fetched_at: Date | null; requested_at: Date };
const COLUMNS = ['url', 'status', 'title', 'description', 'site_name', 'text', 'error', 'fetched_at', 'requested_at'] as const;

function view(r: Row): LinkPreview {
  return { url: r.url, status: r.status, title: r.title, description: r.description, siteName: r.site_name, text: r.text, error: r.error, fetchedAt: r.fetched_at?.toISOString() ?? null };
}

const zUrl = z.string().min(1).max(2048);

function keyOf(raw: string): { url: string; key: string } {
  const url = previewUrl(raw);
  if (!url) throw new DomainError('LINK_INVALID', 422, 'Liên kết phải bắt đầu bằng http:// hoặc https://');
  return { url, key: sha256(url) };
}

export const linkPreviewRequest = defineCommand({
  name: 'social.link_preview.request',
  input: z.strictObject({ url: zUrl }),
  // Its event queues the preview job, which fetches the page the link names (plan §4.7: a job with egress derives
  // R2; #1662).
  risk: 'R2',
  sideEffect: 'external',
  access: ALL,
  handler: async (ctx: CommandContext, input): Promise<LinkPreview> => {
    const { url, key } = keyOf(input.url);
    const now = ctx.now.getTime();
    const row = await ctx.trx.selectFrom('crove_social.link_preview').select(['id', ...COLUMNS]).where('org_id', '=', ctx.orgId).where('url_sha256', '=', key).forUpdate().executeTakeFirst();
    if (row) {
      const fresh = row.status !== 'pending' && row.fetched_at !== null && now - row.fetched_at.getTime() < LINK_PREVIEW_FRESH_MS;
      const asked = row.status === 'pending' && now - row.requested_at.getTime() < LINK_PREVIEW_RETRY_MS;
      if (fresh || asked) return view(row);
    }
    // One fetch at a time per org decides the budget, so the count below holds until the commit.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.link_preview:${ctx.orgId}`}))`.execute(ctx.trx);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM crove_social.link_preview
      WHERE org_id = ${ctx.orgId} AND requested_at > ${ctx.now}::timestamptz - interval '1 minute'`.execute(ctx.trx);
    if ((rows[0]?.n ?? 0) >= LINK_PREVIEW_PER_MINUTE) throw new DomainError('LINK_PREVIEW_LIMIT', 429, 'Đang lấy quá nhiều liên kết, hãy thử lại sau ít phút');
    const saved = row
      ? await ctx.trx
          .updateTable('crove_social.link_preview')
          .set({ status: 'pending', error: null, requested_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', row.id)
          .returning(['id', ...COLUMNS])
          .executeTakeFirstOrThrow()
      : await ctx.trx
          .insertInto('crove_social.link_preview')
          .values({ org_id: ctx.orgId, url, url_sha256: key, status: 'pending', requested_at: ctx.now, created_at: ctx.now })
          .onConflict((oc) => oc.columns(['org_id', 'url_sha256']).doNothing())
          .returning(['id', ...COLUMNS])
          .executeTakeFirst();
    // Asked for at the same moment by someone else, who queued it: theirs is the answer.
    if (!saved) {
      const theirs = await ctx.trx.selectFrom('crove_social.link_preview').select(COLUMNS).where('org_id', '=', ctx.orgId).where('url_sha256', '=', key).executeTakeFirstOrThrow();
      return view(theirs);
    }
    await ctx.emit('social.link_preview.requested', { preview_id: saved.id });
    return view(saved);
  },
});

export const linkPreviewGet = defineQuery({
  name: 'social.link_preview.get',
  input: z.object({ url: zUrl }),
  access: ALL,
  handler: async (ctx, input): Promise<LinkPreview | null> => {
    const { key } = keyOf(input.url);
    const row = await ctx.trx.selectFrom('crove_social.link_preview').select(COLUMNS).where('org_id', '=', ctx.orgId).where('url_sha256', '=', key).executeTakeFirst();
    return row ? view(row) : null;
  },
});

// For the worker: the link of a request that still waits.
export const linkPreviewLoad = defineQuery({
  name: 'social.link_preview.load',
  input: z.object({ previewId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<{ url: string } | null> => {
    const row = await ctx.trx.selectFrom('crove_social.link_preview').select(['url', 'status']).where('org_id', '=', ctx.orgId).where('id', '=', input.previewId).executeTakeFirst();
    return row?.status === 'pending' ? { url: row.url } : null;
  },
});

const zText = (max: number) => z.string().min(1).max(max).nullable();

// For the worker: what the page said, or why it could not be read. A request answered since is left alone.
export const linkPreviewRecord = defineCommand({
  name: 'social.link_preview.record',
  input: z.strictObject({
    previewId: zId,
    result: z.discriminatedUnion('ok', [
      // text: absent from a worker that predates #779.
      z.strictObject({ ok: z.literal(true), title: zText(300), description: zText(1000), siteName: zText(200), text: zText(4000).optional() }),
      z.strictObject({ ok: z.literal(false), error: z.enum(SOCIAL_LINK_PREVIEW_ERRORS) }),
    ]),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    const r = input.result;
    const done = await ctx.trx
      .updateTable('crove_social.link_preview')
      .set(r.ok ? { status: 'ready', title: r.title, description: r.description, site_name: r.siteName, text: r.text ?? null, error: null, fetched_at: ctx.now } : { status: 'failed', error: r.error, fetched_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.previewId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return { recorded: Number(done.numUpdatedRows) > 0 };
  },
});

export const linkPreviewCommands = [linkPreviewRequest, linkPreviewRecord];
export const linkPreviewQueries = [linkPreviewGet, linkPreviewLoad];
