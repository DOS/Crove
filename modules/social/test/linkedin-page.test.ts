// LinkedIn Company Pages (#1077): the channel rules the composer and the adapter share.
import { describe, expect, it } from 'vitest';
import { CHANNEL_PROVIDERS } from '@crove/channel';
import { CAPABILITIES, COMMENT_RULES, LINK_PLACEMENT, PROVIDERS, UTM_SOURCE, VIDEO_READY, linkedinVisibilities, sentText, validateVariant } from '../src/contract.ts';

const check = (settings: Record<string, unknown>) => validateVariant({ provider: 'linkedin_page', body: 'Khai trương chi nhánh mới', title: null, media: [], settings });

describe('linkedin_page', () => {
  it('is a provider on both sides, with the member channel left as it was', () => {
    expect(PROVIDERS).toContain('linkedin_page');
    expect(CHANNEL_PROVIDERS).toContain('linkedin_page');
    expect(CAPABILITIES.linkedin_page).toEqual({ ...CAPABILITIES.linkedin, provider: 'linkedin_page' });
    expect(COMMENT_RULES.linkedin_page).toEqual(COMMENT_RULES.linkedin);
    expect(LINK_PLACEMENT.linkedin_page).toBe('text');
    expect(UTM_SOURCE.linkedin_page).toBe('linkedin');
    expect(VIDEO_READY.has('linkedin_page')).toBe(true);
    expect(sentText('linkedin_page', 'Bài', 'https://example.com/a', 0)).toBe('Bài\n\nhttps://example.com/a');
  });

  it('lets a page post go to anyone or to signed-in members, never to connections a page does not have', () => {
    expect(linkedinVisibilities('linkedin_page')).toEqual(['public', 'loggedIn']);
    expect(linkedinVisibilities('linkedin')).toEqual(['public', 'connections', 'loggedIn']);
    expect(linkedinVisibilities('threads')).toBeNull();
    expect(check({})).toEqual([]);
    for (const visibility of ['public', 'loggedIn']) expect(check({ visibility })).toEqual([]);
    for (const visibility of ['connections', 'LOGGED_IN', 7]) expect(check({ visibility })).toEqual([{ code: 'VISIBILITY_INVALID', field: 'settings.visibility', limit: null, actual: null }]);
    expect(validateVariant({ provider: 'linkedin', body: 'Bài', title: null, media: [], settings: { visibility: 'connections' } })).toEqual([]);
  });

  it('counts a first comment against the page limit', () => {
    expect(check({ firstComment: 'Đặt bánh tại tiembanhb.vn' })).toEqual([]);
    expect(check({ firstComment: 'a'.repeat(1251) }).map((i) => i.code)).toContain('COMMENT_TOO_LONG');
  });
});
