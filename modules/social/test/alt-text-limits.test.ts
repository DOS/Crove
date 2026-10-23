// The alt-text limits of the channels (#801), as an AI suggestion keeps within them (#1121).
import { describe, expect, it } from 'vitest';
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

  it('names only known providers, each with a positive whole limit', () => {
    for (const [provider, limit] of Object.entries(ALT_TEXT_LIMITS)) {
      expect(PROVIDERS as readonly string[]).toContain(provider);
      expect(Number.isInteger(limit) && (limit as number) > 0).toBe(true);
    }
  });
});
