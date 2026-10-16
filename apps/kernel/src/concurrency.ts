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

// A bounded number of tasks at once, the rest waiting in FIFO order (issue #281: the invalidation stream's background
// re-checks, so that the re-checks of many streams of one org, triggered by hints, never take more than `limit`
// connections of the API pool from request traffic). Unlike ConcurrencyLimiter it never refuses: an overflow waits
// for a free slot. The caller bounds the queue; each open stream has at most one re-check running or waiting.
export class Semaphore {
  readonly limit: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    this.limit = limit;
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  // Runs fn once a slot is free; the slot is released when fn settles, and handed to the longest waiter.
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
