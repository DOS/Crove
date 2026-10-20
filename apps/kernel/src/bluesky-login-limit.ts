// A budget for Bluesky logins (#399): connecting a Bluesky account opens a session with its app password, and Bluesky
// limits logins per account, so a member trying a handle that is not theirs could use up its owner's logins. A member
// gets a few tries a minute, an org a few more across its members, and a handle a few across the whole deployment. In
// this process's memory, as the /api limit is (see rate-limit.ts).
import { RateLimiter } from './rate-limit.ts';

export interface BlueskyLoginBudgetOptions {
  perUserPerMinute?: number;
  perOrgPerMinute?: number;
  perHandlePerMinute?: number;
  now?: () => number;
}

export type BlueskyLoginTicket = { allowed: true } | { allowed: false; retryAfterSeconds: number; reason: 'user' | 'org' | 'handle' };

export class BlueskyLoginBudget {
  private readonly limits: { reason: 'user' | 'org' | 'handle'; limiter: RateLimiter }[];

  constructor(options: BlueskyLoginBudgetOptions = {}) {
    const now = options.now ?? Date.now;
    this.limits = [
      { reason: 'user', limiter: new RateLimiter({ perMinute: options.perUserPerMinute ?? 3, now }) },
      { reason: 'org', limiter: new RateLimiter({ perMinute: options.perOrgPerMinute ?? 10, now }) },
      { reason: 'handle', limiter: new RateLimiter({ perMinute: options.perHandlePerMinute ?? 3, now }) },
    ];
  }

  // One login for this member of this org on this handle (lowercase, without the @), or why not.
  take(orgId: string, userId: string, handle: string): BlueskyLoginTicket {
    const keys = [`${orgId}:${userId}`, orgId, handle];
    // Every budget is looked at before any is spent: a try one budget refuses costs the others nothing.
    for (const [i, { reason, limiter }] of this.limits.entries()) {
      const seen = limiter.peek(keys[i] as string);
      if (!seen.allowed) return { allowed: false, retryAfterSeconds: seen.retryAfterSeconds, reason };
    }
    for (const [i, { reason, limiter }] of this.limits.entries()) {
      const taken = limiter.take(keys[i] as string);
      if (!taken.allowed) return { allowed: false, retryAfterSeconds: taken.retryAfterSeconds, reason };
    }
    return { allowed: true };
  }
}
