// The process-wide cap on staged upload completions (issue #223): refuses at once when full, per user and in total.
import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from '../src/concurrency.ts';

describe('ConcurrencyLimiter', () => {
  it('hands out at most `total` slots, and a released slot is free again', () => {
    const limiter = new ConcurrencyLimiter({ total: 2, perKey: 2 });
    const a = limiter.tryAcquire('u1');
    const b = limiter.tryAcquire('u2');
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    expect(limiter.tryAcquire('u3')).toBeNull();
    a?.();
    expect(limiter.inUse).toBe(1);
    expect(limiter.tryAcquire('u3')).toBeTypeOf('function');
  });

  it('keeps one key to its share, half the total by default', () => {
    const limiter = new ConcurrencyLimiter({ total: 4 });
    expect(limiter.perKey).toBe(2);
    const first = limiter.tryAcquire('u1');
    expect(limiter.tryAcquire('u1')).toBeTypeOf('function');
    expect(limiter.tryAcquire('u1')).toBeNull();
    // Others still get the rest.
    expect(limiter.tryAcquire('u2')).toBeTypeOf('function');
    first?.();
    expect(limiter.tryAcquire('u1')).toBeTypeOf('function');
    expect(new ConcurrencyLimiter({ total: 1 }).perKey).toBe(1);
    expect(new ConcurrencyLimiter({ total: 2, perKey: 5 }).perKey).toBe(2);
  });

  it('ignores a second release of the same slot', () => {
    const limiter = new ConcurrencyLimiter({ total: 2, perKey: 1 });
    const release = limiter.tryAcquire('u1');
    const other = limiter.tryAcquire('u2');
    release?.();
    release?.();
    expect(limiter.inUse).toBe(1);
    expect(limiter.tryAcquire('u2')).toBeNull();
    other?.();
    expect(limiter.inUse).toBe(0);
  });

  it('refuses a bad configuration', () => {
    expect(() => new ConcurrencyLimiter({ total: 0 })).toThrow(/total/);
    expect(() => new ConcurrencyLimiter({ total: 1.5 })).toThrow(/total/);
    expect(() => new ConcurrencyLimiter({ total: 2, perKey: 0 })).toThrow(/perKey/);
  });
});
