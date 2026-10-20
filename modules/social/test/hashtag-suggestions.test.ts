// Hashtags suggested while writing (#818): what did better than the channel's median, best first, not already used.
import { describe, expect, it } from 'vitest';
import { hashtagSuggestions } from '../src/domain/insights.ts';

const group = (key: string, ratio: number | null, posts = 3) => ({ key, posts, median: 10, ratio });
const channels = [
  { connectionId: 'fb', byHashtag: [group('khaitruong', 2.5), group('banhmi', 1.4, 6), group('sale', 0.6), group('moi', null)] },
  { connectionId: 'ig', byHashtag: [group('banhmi', 1.8, 4), group('quan3', 1.4, 9), group('cafe', 1)] },
];

describe('hashtag suggestions (#818)', () => {
  it('ranks hashtags above their channel median by the best ratio, then the most posts', () => {
    expect(hashtagSuggestions(channels, '')).toEqual(['khaitruong', 'banhmi', 'quan3']);
  });

  it('leaves out the hashtags the text holds, matched the way posts are read', () => {
    expect(hashtagSuggestions(channels, 'Mở cửa rồi #KhaiTruong')).toEqual(['banhmi', 'quan3']);
  });

  it('keeps to one channel when asked, and to the maximum', () => {
    expect(hashtagSuggestions(channels, '', { connectionId: 'ig' })).toEqual(['banhmi', 'quan3']);
    expect(hashtagSuggestions(channels, '', { max: 1 })).toEqual(['khaitruong']);
    expect(hashtagSuggestions([], 'x')).toEqual([]);
  });
});
