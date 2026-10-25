// A TikTok account's creator options (#1497) as the composer reads them from the channel option cache: the adapter's
// list (tiktokCreatorOptions) read back by the contract's tiktokCreatorOf.
import { describe, expect, it } from 'vitest';
import { tiktokCreatorOptions } from '@crove/channel';
import { tiktokCreatorOf } from '../src/contract.ts';

describe('tiktokCreatorOf', () => {
  it('reads back what the adapter lists', () => {
    const items = tiktokCreatorOptions({ creator_nickname: 'Tiệm Bánh B', privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 });
    expect(tiktokCreatorOf(items)).toEqual({ nickname: 'Tiệm Bánh B', privacyLevels: ['SELF_ONLY'], off: { comment: false, duet: true, stitch: false }, maxVideoSeconds: 600, cannotPost: null });
  });

  it('keeps the levels in TikTok order and drops what it does not know', () => {
    const creator = tiktokCreatorOf([
      { id: 'privacy_SELF_ONLY', name: 'SELF_ONLY' },
      { id: 'privacy_PUBLIC_TO_EVERYONE', name: 'PUBLIC_TO_EVERYONE' },
      { id: 'privacy_EVERYONE', name: 'EVERYONE' },
      { id: 'max_video_seconds', name: 'ten' },
      { id: 'cannot_post', name: 'something_else' },
    ]);
    expect(creator).toMatchObject({ nickname: null, privacyLevels: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], maxVideoSeconds: null, cannotPost: null });
  });

  it('says when TikTok will not let the account post now', () => {
    expect(tiktokCreatorOf([{ id: 'cannot_post', name: 'spam_risk_user_banned_from_posting' }])).toMatchObject({ privacyLevels: [], cannotPost: 'spam_risk_user_banned_from_posting' });
  });
});
