// A process-wide cap on concurrent work that holds a large buffer, such as completing a staged upload (each holds up
// to 25 MB while it is hashed and written; ADR-0013, issue #223). tryAcquire never waits: a full limiter refuses at
// once, so the caller answers 503 with Retry-After and nothing queues up in memory behind it. A per-key cap keeps
// one user from holding every slot.
//
// In-process, like the request rate limit: N API instances allow N times the total, which is what a memory bound per
// process needs.
export interface ConcurrencyLimiterOptions {
  // Slots in this process.
  total: number;
  // Slots one key (a user) may hold at once (default: half the total, at least 1).
  perKey?: number;
}

export class ConcurrencyLimiter {
  readonly total: number;
  readonly perKey: number;
  private used = 0;
  private readonly byKey = new Map<string, number>();

  constructor(options: ConcurrencyLimiterOptions) {
    if (!Number.isInteger(options.total) || options.total < 1) throw new Error('total must be a positive integer');
    const perKey = options.perKey ?? Math.max(1, Math.floor(options.total / 2));
    if (!Number.isInteger(perKey) || perKey < 1) throw new Error('perKey must be a positive integer');
    this.total = options.total;
    this.perKey = Math.min(perKey, options.total);
  }

  get inUse(): number {
    return this.used;
  }

  // A release function when a slot was free (call it exactly once; later calls do nothing), or null when the limiter
  // or the key's share of it is full.
  tryAcquire(key: string): (() => void) | null {
    const held = this.byKey.get(key) ?? 0;
    if (this.used >= this.total || held >= this.perKey) return null;
    this.used++;
    this.byKey.set(key, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      const left = (this.byKey.get(key) ?? 1) - 1;
      if (left > 0) this.byKey.set(key, left);
      else this.byKey.delete(key);
    };
  }
}
