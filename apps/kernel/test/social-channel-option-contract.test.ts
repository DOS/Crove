// The HTTP contract of a channel's options (#1120) names every kind of list the database keeps: the router hands the
// command's answer through untyped, so a kind missing here is refused only at run time, as an output the contract does
// not allow (#1497, where the TikTok block got no list).
import { describe, expect, it } from 'vitest';
import { SOCIAL_CHANNEL_OPTION_ERRORS, SOCIAL_CHANNEL_OPTION_KINDS, SOCIAL_CHANNEL_OPTION_STATUSES } from '@crove/db';
import { zSocialChannelOptions } from '@crove/kernel-contract';

describe('zSocialChannelOptions', () => {
  it("allows every kind, status and error of crove_social.channel_option", () => {
    expect([...zSocialChannelOptions.shape.kind.options].sort()).toEqual([...SOCIAL_CHANNEL_OPTION_KINDS].sort());
    expect([...zSocialChannelOptions.shape.status.options].sort()).toEqual([...SOCIAL_CHANNEL_OPTION_STATUSES].sort());
    expect([...zSocialChannelOptions.shape.error.unwrap().options].sort()).toEqual([...SOCIAL_CHANNEL_OPTION_ERRORS].sort());
  });
});
