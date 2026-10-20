import { describe, expect, it } from 'vitest';
import { isAutomated } from '../src/short-link.ts';

describe('short link redirect (#706)', () => {
  it('counts people, not link previews or scripts', () => {
    expect(isAutomated('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(false);
    for (const agent of ['facebookexternalhit/1.1', 'Zalo', 'Googlebot/2.1', 'curl/8.4', 'TelegramBot (like TwitterBot)', undefined, '']) expect(isAutomated(agent)).toBe(true);
  });
});
