import { describe, expect, it } from 'vitest';
import { BlueskyLoginBudget } from '../src/bluesky-login-limit.ts';

describe('BlueskyLoginBudget', () => {
  it('limits tries per member, per org and per handle, and refills over a minute', () => {
    let now = 0;
    const budget = new BlueskyLoginBudget({ perUserPerMinute: 2, perOrgPerMinute: 3, perHandlePerMinute: 2, now: () => now });
    expect(budget.take('o1', 'u1', 'a.bsky.social')).toEqual({ allowed: true });
    expect(budget.take('o1', 'u1', 'b.bsky.social')).toEqual({ allowed: true });
    expect(budget.take('o1', 'u1', 'c.bsky.social')).toMatchObject({ allowed: false, reason: 'user' });
    // Another member of the org: the org's third try, then the org is spent.
    expect(budget.take('o1', 'u2', 'c.bsky.social')).toEqual({ allowed: true });
    expect(budget.take('o1', 'u3', 'd.bsky.social')).toMatchObject({ allowed: false, reason: 'org' });
    // One handle across orgs: someone else's account is not tried more than its budget.
    expect(budget.take('o2', 'u4', 'a.bsky.social')).toEqual({ allowed: true });
    expect(budget.take('o3', 'u5', 'a.bsky.social')).toMatchObject({ allowed: false, reason: 'handle' });
    now += 60_000;
    expect(budget.take('o1', 'u1', 'c.bsky.social')).toEqual({ allowed: true });
  });

  it('spends nothing on a try another budget refuses', () => {
    const budget = new BlueskyLoginBudget({ perUserPerMinute: 5, perOrgPerMinute: 5, perHandlePerMinute: 1, now: () => 0 });
    expect(budget.take('o1', 'u1', 'a.bsky.social')).toEqual({ allowed: true });
    for (let i = 0; i < 5; i++) expect(budget.take('o1', 'u1', 'a.bsky.social')).toMatchObject({ allowed: false, reason: 'handle' });
    // The refused tries did not use up the member's or the org's budget.
    for (let i = 0; i < 4; i++) expect(budget.take('o1', 'u1', `h${i}.bsky.social`)).toEqual({ allowed: true });
  });
});
