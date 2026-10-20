// The worker's side of blog feeds (#708): every quarter hour, the feeds due for a read (about hourly) are fetched
// through the egress guard, read in crove-extract (the kernel parses no XML) and recorded: the new items become drafts,
// or the failure counts towards a pause. A failure of the extract service itself is left for the next pass, unrecorded.
import { sql } from 'kysely';
import { EXTRACT_LIMITS, type ExtractClient } from '@crove/extract-contract';
import type { Db } from '@crove/db';
import { EgressError, guardedFetch, type Runtime } from '@crove/kernel-runtime';
import type { FeedResult } from '@crove/mod-social';

export const FEED_TIMEOUT_MS = 10_000;
const FEED_LIMIT = 50;
// Batches of FEED_LIMIT read in one pass (400 feeds a quarter hour); the rest wait for the next pass, oldest first.
const FEED_BATCHES = 8;
const ACTOR = { type: 'system' as const, component: 'social.feeds' };

export interface FeedDeps {
  runtime: Runtime;
  workerDb: Db;
  extract: ExtractClient;
  // Tests only.
  fetch?: typeof guardedFetch;
}

// One feed: null when the service could not answer (try again later), else what to record.
export async function readFeedOnce(deps: FeedDeps, url: string): Promise<FeedResult | null> {
  let page;
  try {
    page = await (deps.fetch ?? guardedFetch)(url, {
      timeoutMs: FEED_TIMEOUT_MS,
      maxBytes: EXTRACT_LIMITS.maxFeedBytes,
      // The newest items come first: a long feed is cut, not refused.
      overLimit: 'truncate',
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1',
    });
  } catch (error) {
    if (error instanceof EgressError) return { ok: false, error: error.code };
    throw error;
  }
  if (page.status < 200 || page.status >= 300) return { ok: false, error: 'http' };
  const type = (page.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  // Many blogs serve their feed as text/html or text/plain: anything but an image or a video is given to the reader.
  if (/^(image|video|audio)\//.test(type)) return { ok: false, error: 'not_feed' };
  const body = page.truncated ? wholeItems(page.body) : page.body;
  if (!body) return { ok: false, error: 'too_large' };
  const read = await deps.extract.extract('feed', body);
  if (!read.ok) {
    if (read.code === 'invalid' || read.code === 'too_large' || read.code === 'timeout' || read.code === 'memory') return { ok: false, error: 'not_feed' };
    return null;
  }
  return { ok: true, title: read.feed.title, items: read.feed.items };
}

// A feed cut at the size limit, kept up to its last whole item (RSS, RSS 1.0) or entry (Atom) and closed again, so a
// cut inside an item or a CDATA section does not make the whole feed unreadable. null: no whole item in the part read.
export function wholeItems(body: Buffer): Buffer | null {
  const text = body.toString('latin1');
  const root = /<(rss|feed|rdf:RDF)[\s>]/.exec(text)?.[1];
  const tag = root === 'feed' ? '</entry>' : '</item>';
  const end = text.lastIndexOf(tag);
  if (!root || end < 0) return null;
  const close = root === 'rss' ? '</channel></rss>' : `</${root}>`;
  return Buffer.concat([body.subarray(0, end + tag.length), Buffer.from(close)]);
}

// One pass over the feeds due, a batch at a time; returns how many drafts it made. A feed is read once a pass, even if
// it is still due after (the extract service could not answer).
export async function sweepFeeds(deps: FeedDeps): Promise<number> {
  const seen = new Set<string>();
  let drafted = 0;
  for (let batch = 0; batch < FEED_BATCHES; batch++) {
    const { rows } = await sql<{ org_id: string; feed_id: string }>`SELECT org_id, feed_id FROM crove_social.feeds_due(${FEED_LIMIT}::int)`.execute(deps.workerDb);
    const fresh = rows.filter((r) => !seen.has(r.feed_id));
    for (const row of fresh) {
      seen.add(row.feed_id);
      drafted += await readOne(deps, row);
    }
    if (rows.length < FEED_LIMIT || fresh.length === 0) break;
  }
  return drafted;
}

async function readOne(deps: FeedDeps, row: { org_id: string; feed_id: string }): Promise<number> {
  try {
    const feed = await deps.runtime.query<{ url: string } | null>('social.feed.load', { feedId: row.feed_id }, { actor: ACTOR, orgId: row.org_id });
    if (!feed) return 0;
    const result = await readFeedOnce(deps, feed.url);
    if (!result) return 0;
    const done = await deps.runtime.execute<{ drafted: number }>('social.feed.record', { feedId: row.feed_id, result }, { actor: ACTOR, orgId: row.org_id });
    return done.drafted;
  } catch (error) {
    console.warn(`[social-feeds] feed ${row.feed_id.slice(0, 8)}`, error instanceof Error ? error.message : error);
    return 0;
  }
}
