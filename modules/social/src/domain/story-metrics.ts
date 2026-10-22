// When the metrics sweep asks about a Story (#1082). Meta keeps a Story's insights for 24 hours only, while the sweep
// asks a variant again 6 hours after its last capture, so the last regular capture of a Story could land a few hours
// before its end and the counts of its last hours would be lost. A Story is therefore captured as usual while the next
// regular capture would still come in time, waits (nothing asked, nothing kept) once it would not, takes one final
// capture from STORY_FINAL_FROM_MS on, and is marked expired, never asked again, after STORY_LIFETIME_MS.
export const STORY_LIFETIME_MS = 24 * 3_600_000;
// The final capture opens 2 hours before the end, so a pass that runs late or a worker restarted meanwhile still
// takes it in time; the sweep runs every 15 minutes.
export const STORY_FINAL_FROM_MS = 22 * 3_600_000;
// A regular capture is taken only when the one after it (an interval later, plus a pass) would come by this age, that
// is inside the final window.
export const STORY_REGULAR_BY_MS = 23 * 3_600_000;
// The capture keys of the final capture and of the mark that ends the asking: each is written once per variant.
export const STORY_FINAL_KEY = 'story-final';
export const STORY_EXPIRED_KEY = 'story-expired';

export type StoryCapture = 'regular' | 'wait' | 'final' | 'expired';

// What a due Story gets now: publishedAt is when it went out, intervalMs the sweep's interval between captures.
export function storyCapture(publishedAt: Date, now: Date, intervalMs: number): StoryCapture {
  const age = now.getTime() - publishedAt.getTime();
  if (age >= STORY_LIFETIME_MS) return 'expired';
  if (age >= STORY_FINAL_FROM_MS) return 'final';
  return age + intervalMs <= STORY_REGULAR_BY_MS ? 'regular' : 'wait';
}
