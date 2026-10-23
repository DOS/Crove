// The alt-text limits of the channels (#801), as an AI suggestion keeps within them (#1121).
import { describe, expect, it } from 'vitest';
import {
  BLUESKY_VIDEO_ALT_TEXT_MAX,
  DISCORD_ALT_TEXT_MAX,
  FACEBOOK_ALT_TEXT_MAX,
  INSTAGRAM_ALT_TEXT_MAX,
  LINKEDIN_ALT_TEXT_MAX,
  MASTODON_ALT_TEXT_MAX,
  PINTEREST_ALT_TEXT_MAX,
  THREADS_ALT_TEXT_MAX,
  WORDPRESS_ALT_TEXT_MAX,
  X_ALT_TEXT_MAX,
} from '@crove/channel';
import { ALT_TEXT_LIMITS, PROVIDERS, strictestAltTextLimit } from '../src/contract.ts';

describe('alt-text limits', () => {
  it('takes the smallest limit of the chosen channels', () => {
    expect(strictestAltTextLimit(['x', 'pinterest', 'mastodon'])).toBe(500);
    expect(strictestAltTextLimit(['mastodon', 'linkedin'])).toBe(1500);
    expect(strictestAltTextLimit(['discord', 'facebook_page'])).toBe(1000);
  });

  it('has no limit for channels that send no alt text, or for unknown providers', () => {
    expect(strictestAltTextLimit([])).toBeNull();
    expect(strictestAltTextLimit(['tiktok', 'youtube', 'telegram'])).toBeNull();
    expect(strictestAltTextLimit(['not-a-provider'])).toBeNull();
    expect(strictestAltTextLimit(['tiktok', 'pinterest'])).toBe(500);
  });

  // The limits are copied from the adapters by hand (the contract runs in the browser, which does not load them); this
  // is where the two must agree (#1126). An adapter that starts or stops cutting alt text fails here until both follow.
  it('matches the alt text each Crove adapter sends', () => {
    expect(ALT_TEXT_LIMITS).toEqual({
      x: X_ALT_TEXT_MAX,
      facebook_page: FACEBOOK_ALT_TEXT_MAX,
      instagram: INSTAGRAM_ALT_TEXT_MAX,
      threads: THREADS_ALT_TEXT_MAX,
      bluesky: BLUESKY_VIDEO_ALT_TEXT_MAX,
      mastodon: MASTODON_ALT_TEXT_MAX,
      linkedin: LINKEDIN_ALT_TEXT_MAX,
      linkedin_page: LINKEDIN_ALT_TEXT_MAX,
      pinterest: PINTEREST_ALT_TEXT_MAX,
      discord: DISCORD_ALT_TEXT_MAX,
      wordpress: WORDPRESS_ALT_TEXT_MAX,
    });
  });

  it('names only known providers, each with a positive whole limit', () => {
    for (const [provider, limit] of Object.entries(ALT_TEXT_LIMITS)) {
      expect(PROVIDERS as readonly string[]).toContain(provider);
      expect(Number.isInteger(limit) && (limit as number) > 0).toBe(true);
    }
  });
});
