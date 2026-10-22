import { describe, expect, it } from 'vitest';
import { barWidth, STORY_METRICS, storyCounts } from '../src/lib/social-insights.ts';

describe('what works bars (#705)', () => {
  it('puts the channel median in the middle and caps at twice it', () => {
    expect(barWidth(1)).toBe(50);
    expect(barWidth(0.5)).toBe(25);
    expect(barWidth(1.5)).toBe(75);
    expect(barWidth(3)).toBe(100);
    expect(barWidth(0)).toBe(0);
    expect(barWidth(null)).toBe(0);
  });
});

describe('Story counts (#1082)', () => {
  it('lists the Story counts a capture holds, in order, and nothing for a feed post', () => {
    expect(storyCounts({ reach: 210, nextStory: 1, replies: 4, tapsForward: 19, exits: 0, profileVisits: 7 })).toEqual([
      { name: 'replies', value: 4 },
      { name: 'tapsForward', value: 19 },
      { name: 'exits', value: 0 },
      { name: 'nextStory', value: 1 },
      { name: 'profileVisits', value: 7 },
    ]);
    expect(storyCounts({ reach: 30, reactions: 3, comments: 1 })).toEqual([]);
    expect(STORY_METRICS).toEqual(['replies', 'tapsForward', 'tapsBack', 'exits', 'nextStory', 'follows', 'profileVisits']);
  });
});
