// The crove-turnstile Trusted Types policy (#1353): it turns Turnstile's one script URL into a script URL and refuses
// anything else, so a script's src can never take another origin through it.
import { describe, expect, it } from 'vitest';
import { TURNSTILE_POLICY, TURNSTILE_SCRIPT, turnstileScriptUrl } from '../src/lib/turnstile.ts';

describe('the crove-turnstile Trusted Types policy', () => {
  it('is named as the kernel CSP allows it and passes Turnstile’s script only', () => {
    expect(TURNSTILE_POLICY).toBe('crove-turnstile');
    expect(turnstileScriptUrl(TURNSTILE_SCRIPT)).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    for (const url of ['https://challenges.cloudflare.com/turnstile/v0/api.js', 'https://evil.example/api.js', '/assets/sw.js', `${TURNSTILE_SCRIPT}&x=1`]) {
      expect(() => turnstileScriptUrl(url), url).toThrow(/only allows the Turnstile script/);
    }
  });
});
