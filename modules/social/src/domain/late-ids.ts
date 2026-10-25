// TikTok posts whose public id comes later (#1475). TikTok gives a public post's id only once its moderation passes,
// which may come after its status check ended at PUBLISH_COMPLETE (the variant then keeps the publish_id as its
// external_post_id, with no address and no counts); and a draft sent to the creator's TikTok inbox (#903, the
// SENT_TO_APP note) becomes a post only when the creator posts it in TikTok. The worker asks TikTok's status again for
// both, reading only: hourly on the post's first day, then every 6 hours, for 7 days. The rules here are shared by the
// worker's commands and the screens.
import { NOT_PUBLIC_NOTES, SENT_TO_APP, tiktokModeOf } from './channels.ts';

// How long after its publish a post is asked about, and how often.
export const LATE_ID_DAYS = 7;
export const LATE_ID_FIRST_DAY_EVERY_MS = 3_600_000;
export const LATE_ID_LATER_EVERY_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;
const WINDOW_MS = LATE_ID_DAYS * DAY_MS;

// The note of a published public TikTok post that never got its public id (checked for 7 days, or TikTok failed it):
// "TikTok chưa trả mã bài", so nobody waits for its link or counts.
export const TIKTOK_NO_POST_ID = 'TIKTOK_NO_POST_ID';
// What the timeline shows for a draft sent to the TikTok app that the creator then posted there ("Đã đăng trong
// TikTok"); never stored, read from the variant's inbox mode.
export const POSTED_IN_APP = 'POSTED_IN_APP';

// TikTok's public post ids: a 64-bit integer as digits. A publish_id never is one.
export const TIKTOK_POST_ID = /^\d{1,32}$/;

export interface LateIdVariant {
  provider: string;
  status: string;
  settings: Readonly<Record<string, unknown>>;
  external_post_id: string | null;
  error_code: string | null;
  published_at: Date | null;
}

// What a variant waits for: the creator to post its draft (sent_to_app), its public id (no_id), or nothing (null). A
// direct post that is not PUBLIC_TO_EVERYONE never gets a public id (TikTok returns it only for public viewership), so
// it is never asked about; an inbox draft is, whatever its creator picks in TikTok.
export function lateIdWait(v: LateIdVariant): 'sent_to_app' | 'no_id' | null {
  if (v.provider !== 'tiktok' || v.status !== 'published' || !v.published_at) return null;
  const mode = tiktokModeOf(v.settings);
  if (mode !== 'inbox' && (mode !== 'direct' || v.settings.privacyLevel !== 'PUBLIC_TO_EVERYONE')) return null;
  if (v.external_post_id === null) return v.error_code === SENT_TO_APP && mode === 'inbox' ? 'sent_to_app' : null;
  return v.error_code === null && !TIKTOK_POST_ID.test(v.external_post_id) ? 'no_id' : null;
}

// Whether the 7 days of asking are over.
export function lateIdOver(publishedAt: Date, now: Date): boolean {
  return now.getTime() - publishedAt.getTime() >= WINDOW_MS;
}

// When to ask next: an hour later on the post's first day, 6 hours later after it, and never past the 7 days (that last
// turn records the end without asking TikTok).
export function lateIdNextCheck(publishedAt: Date, now: Date): Date {
  const age = now.getTime() - publishedAt.getTime();
  const next = now.getTime() + (age < DAY_MS ? LATE_ID_FIRST_DAY_EVERY_MS : LATE_ID_LATER_EVERY_MS);
  return new Date(Math.min(next, publishedAt.getTime() + WINDOW_MS));
}

// Past every turn: what next_check_at says once the asking has stopped (the scan only looks within the 7 days and a
// day of grace, so it never picks the variant again).
export function lateIdStopped(publishedAt: Date): Date {
  return new Date(publishedAt.getTime() + WINDOW_MS + 2 * DAY_MS);
}

// The note the timeline gives a published variant: one that is not public yet (NOT_PUBLIC_NOTES), a TikTok post that
// never got its public id, or POSTED_IN_APP for a TikTok draft the creator posted in the app; null otherwise.
export function publishedNote(v: { provider: string; settings: Readonly<Record<string, unknown>>; error_code: string | null }): string | null {
  if (v.error_code !== null) return NOT_PUBLIC_NOTES.includes(v.error_code) || v.error_code === TIKTOK_NO_POST_ID ? v.error_code : null;
  return v.provider === 'tiktok' && tiktokModeOf(v.settings) === 'inbox' ? POSTED_IN_APP : null;
}
