// Per-actor request rate limit at the HTTP edge (issue #162, plan §4.4 step 0): a token bucket per key, in this
// process's memory. Each key may spend `perMinute` requests at once and earns them back evenly over a minute.
//
// In-process on purpose: it costs one Map lookup per request and no database round trip, so it stays off the hot
// path. It therefore holds per API instance only: N instances behind a load balancer allow up to N times the limit.
// Multi-instance deployments put a shared limit in front (the edge proxy, CDN or WAF, or a shared store); the
// database-backed limits (org creation, inbound rotation, the refusal audit bound) hold across instances anyway.
export interface RateLimitDecision {
  allowed: boolean;
  // Whole seconds until one more request is allowed (at least 1), when refused.
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  perMinute: number;
  // Keys kept at most; past it, keys whose bucket is full again are dropped first, then the least recently used.
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
    // A clock that went backwards refills nothing rather than going negative.
    const tokens = known ? Math.min(this.perMinute, known.tokens + Math.max(0, now - known.at) * rate) : this.perMinute;
    // Re-inserted on every use, so the Map's order is least recently used first.
    if (known) this.buckets.delete(key);
    else if (this.buckets.size >= this.maxKeys) this.evict(now, rate);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: now });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.buckets.set(key, { tokens, at: now });
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / rate / 1000)) };
  }

  private evict(now: number, rate: number): void {
    for (const [key, bucket] of this.buckets) {
      // A full bucket is the same as no bucket.
      if (bucket.tokens + (now - bucket.at) * rate >= this.perMinute) this.buckets.delete(key);
    }
    // Still full: drop the least recently used tenth, so eviction stays rare under a flood of new keys.
    if (this.buckets.size >= this.maxKeys) {
      let drop = Math.max(1, Math.floor(this.maxKeys / 10));
      for (const key of this.buckets.keys()) {
        if (drop-- <= 0) break;
        this.buckets.delete(key);
      }
    }
  }
}
