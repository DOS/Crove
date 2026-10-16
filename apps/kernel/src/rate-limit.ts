// Per-actor request rate limit at the HTTP edge (issue #162, plan §4.4 step 0): a token bucket per key, in this
// process's memory. Each key may spend `perMinute` requests at once and earns them back evenly over a minute.
//
// In-process on purpose: it costs one Map lookup per request and no database round trip, so it stays off the hot
// path. It therefore holds per API instance only: N instances behind a load balancer allow up to N times the limit.
// Multi-instance deployments put a shared limit in front (the edge proxy, CDN or WAF, or a shared store); the
// database-backed limits (org creation, inbound rotation, the refusal audit bound) hold across instances anyway.
//
// Memory is bounded by maxKeys. A key whose bucket is full again is the same as no key, so those are dropped to make
// room; a bucket that is not full is never dropped, because that would hand its owner a fresh budget. When every
// tracked key is still spending and the map is full, a new key is refused (429) until a bucket fills up again.
export interface RateLimitDecision {
  allowed: boolean;
  // Whole seconds until one more request is allowed (at least 1), when refused.
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  perMinute: number;
  // Keys kept at most (default 100,000).
  maxKeys?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  at: number;
}

const MINUTE_MS = 60_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMinute: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  // While the map is full and no bucket can be dropped: the earliest time one is full again. New keys are refused
  // until then without another sweep, so a flood of new keys costs one sweep, not one per request.
  private fullUntil = 0;

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.perMinute) || options.perMinute < 1) throw new Error('perMinute must be a positive integer');
    this.perMinute = options.perMinute;
    this.maxKeys = options.maxKeys ?? 100_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  take(key: string): RateLimitDecision {
    const now = this.now();
    const rate = this.perMinute / MINUTE_MS;
    const known = this.buckets.get(key);
    if (!known && this.buckets.size >= this.maxKeys && !this.makeRoom(now, rate)) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((this.fullUntil - now) / 1000)) };
    }
    // A clock that went backwards refills nothing rather than going negative.
    const tokens = known ? Math.min(this.perMinute, known.tokens + Math.max(0, now - known.at) * rate) : this.perMinute;
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: now });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.buckets.set(key, { tokens, at: now });
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / rate / 1000)) };
  }

  // What take(key) would answer now, without spending or recording anything. For limits that charge only some
  // requests, such as failed stream ticket redeems (issue #281): peek before the work, take after a failure. An
  // unknown key is allowed (its take may still be refused while the map is full).
  peek(key: string): RateLimitDecision {
    const known = this.buckets.get(key);
    if (!known) return { allowed: true, retryAfterSeconds: 0 };
    const rate = this.perMinute / MINUTE_MS;
    const tokens = Math.min(this.perMinute, known.tokens + Math.max(0, this.now() - known.at) * rate);
    if (tokens >= 1) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / rate / 1000)) };
  }

  // Drops every bucket that is full again. Returns false, and records when the first one fills, if none could go.
  private makeRoom(now: number, rate: number): boolean {
    if (now < this.fullUntil) return false;
    let soonest = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      const missing = this.perMinute - (bucket.tokens + Math.max(0, now - bucket.at) * rate);
      if (missing <= 0) this.buckets.delete(key);
      else soonest = Math.min(soonest, now + missing / rate);
    }
    if (this.buckets.size < this.maxKeys) return true;
    this.fullUntil = soonest;
    return false;
  }
}
