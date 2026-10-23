// The same text going out again on a channel (#1156): for each open channel of a post, the newest other post on the
// same channel connection with the same text, published in the last 30 days or scheduled or queued there. Only the
// same connection is compared, so a member limited to some channels (#1081), who reads only the channels they may
// use, learns nothing of the others. The read is bounded: at most DUPLICATE_SCAN_MAX rows per channel, newest first,
// through post_variant_connection_idx (org_id, channel_connection_id, status).
import { sql } from 'kysely';
import type { SocialVariantStatus } from '@crove/db';
import { DUPLICATE_SCAN_MAX, DUPLICATE_WINDOW_DAYS, duplicateText, newestDuplicate, type DuplicateCandidate, type DuplicateOf } from './domain/duplicate.ts';
import { withSignature } from './domain/signature.ts';
import { settingsOf, type Trx } from './variants.ts';

// The channels a person may still change before they go out; a published, removed or cancelled one is not checked.
const OPEN: readonly SocialVariantStatus[] = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'failed', 'paused'];

export interface DuplicateSubject {
  id: string;
  postId: string;
  connectionId: string;
  status: SocialVariantStatus;
  // The text the channel sends (its own, else the post's, with its signature: effectiveContent).
  body: string;
}

export async function duplicatesOf(trx: Trx, orgId: string, subjects: readonly DuplicateSubject[], now: Date): Promise<Map<string, DuplicateOf>> {
  const out = new Map<string, DuplicateOf>();
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000);
  for (const s of subjects) {
    if (!OPEN.includes(s.status) || duplicateText(s.body) === '') continue;
    const rows = await trx
      .selectFrom('crove_social.post_variant as v')
      .innerJoin('crove_social.post as p', (j) => j.onRef('p.org_id', '=', 'v.org_id').onRef('p.id', '=', 'v.post_id'))
      .select(['v.status', 'v.body', 'v.settings', 'v.content_frozen', 'v.published_at', 'v.scheduled_at', 'v.queue_slot_at', 'v.error_retry_at', 'p.body as post_body', 'p.scheduled_at as post_scheduled_at'])
      .where('v.org_id', '=', orgId)
      .where('v.channel_connection_id', '=', s.connectionId)
      .where('v.status', 'in', ['published', 'scheduled'])
      .where((eb) => eb.or([eb('v.status', '=', 'scheduled'), eb('v.published_at', '>=', since)]))
      // Another post: the post's own channel is the one being checked.
      .where('v.post_id', '<>', s.postId)
      // Newest first, as the post page shows each time (effectiveAt): a scheduled one is ahead, a published one behind.
      .orderBy(sql`coalesce(v.published_at, v.error_retry_at, v.queue_slot_at, v.scheduled_at, p.scheduled_at)`, (ob) => ob.desc().nullsLast())
      .limit(DUPLICATE_SCAN_MAX)
      .execute();
    const candidates: DuplicateCandidate[] = rows.map((r) => ({
      // A published channel keeps the text it went out with (#335); a scheduled one sends its own or the post's. Either
      // with its signature (#1190), as effectiveContent appends it.
      text: withSignature(r.content_frozen ? (r.body ?? '') : (r.body ?? r.post_body), settingsOf(r)),
      at: r.status === 'published' ? r.published_at : (r.error_retry_at ?? r.queue_slot_at ?? r.scheduled_at ?? r.post_scheduled_at),
      status: r.status === 'published' ? 'published' : r.queue_slot_at !== null && r.scheduled_at === null && r.error_retry_at === null ? 'queued' : 'scheduled',
    }));
    const match = newestDuplicate(s.body, candidates);
    if (match) out.set(s.id, match);
  }
  return out;
}
