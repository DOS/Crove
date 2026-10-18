// A budget for AI drafting (#386): each draft is a paid model call, and the general /api limit (600 requests a minute
// per user by default) would let one member start hundreds. A member gets a few drafts a minute and one at a time; an
// org gets a few more a minute across its members. In this process's memory, as the /api limit is (see
// rate-limit.ts): N API instances allow up to N times the budget.
import { RateLimiter, type RateLimitDecision } from './rate-limit.ts';

export interface DraftBudgetOptions {
  perUserPerMinute?: number;
  perOrgPerMinute?: number;
  now?: () => number;
}

export type DraftTicket = { allowed: true; release: () => void } | { allowed: false; retryAfterSeconds: number; reason: 'busy' | 'user' | 'org' };

export class DraftBudget {
  private readonly users: RateLimiter;
  private readonly orgs: RateLimiter;
  private readonly running = new Set<string>();

  constructor(options: DraftBudgetOptions = {}) {
    const now = options.now ?? Date.now;
    this.users = new RateLimiter({ perMinute: options.perUserPerMinute ?? 6, now });
    this.orgs = new RateLimiter({ perMinute: options.perOrgPerMinute ?? 30, now });
  }

  // One draft for this member of this org, or why not. A granted ticket is released when the draft is done.
  take(orgId: string, userId: string): DraftTicket {
    const key = `${orgId}:${userId}`;
    if (this.running.has(key)) return { allowed: false, retryAfterSeconds: 5, reason: 'busy' };
    const user: RateLimitDecision = this.users.take(key);
    if (!user.allowed) return { allowed: false, retryAfterSeconds: user.retryAfterSeconds, reason: 'user' };
    const org = this.orgs.take(orgId);
    if (!org.allowed) return { allowed: false, retryAfterSeconds: org.retryAfterSeconds, reason: 'org' };
    this.running.add(key);
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.running.delete(key);
      },
    };
  }
}
