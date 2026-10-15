// The per-user request limit at the HTTP edge (issue #162): the token bucket, its configuration and the 429 answer.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { Db } from '@crove/db';
import { DEFAULT_REFUSAL_AUDIT_LIMITS, DomainError, Runtime, type BlobStore } from '@crove/kernel-runtime';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('RateLimiter', () => {
  it('allows perMinute requests at once, then refuses with the seconds until the next one', () => {
    const time = clock();
    const limiter = new RateLimiter({ perMinute: 3, now: time.now });
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    // One request back every 20 seconds.
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 20 });
    time.advance(15_000);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 5 });
    time.advance(5_000);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('keeps each key on its own bucket', () => {
    const limiter = new RateLimiter({ perMinute: 1, now: clock().now });
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
  });

  it('refills to the limit and no further, and a clock that goes back refills nothing', () => {
    const time = clock();
    const limiter = new RateLimiter({ perMinute: 2, now: time.now });
    limiter.take('a');
    limiter.take('a');
    time.advance(-60_000);
    expect(limiter.take('a').allowed).toBe(false);
    time.advance(10 * 60_000);
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, false]);
  });

  it('keeps at most maxKeys keys, dropping only buckets that are full again', () => {
    const time = clock();
    const limiter = new RateLimiter({ perMinute: 2, maxKeys: 3, now: time.now });
    for (const key of ['a', 'b', 'c']) limiter.take(key);
    // Every tracked bucket is still spending: a new key is refused, nobody's bucket is reset.
    expect(limiter.take('new')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(limiter.size).toBe(3);
    // Refused again without another sweep until a bucket can be full again.
    time.advance(10_000);
    expect(limiter.take('other')).toEqual({ allowed: false, retryAfterSeconds: 20 });
    // Known keys keep their own budget meanwhile.
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    // Once b and c are full again they make room; a, still spending, is kept.
    time.advance(20_000);
    expect(limiter.take('new').allowed).toBe(true);
    expect(limiter.size).toBe(2);
    // a kept its own bucket (one token earned back since), not a fresh one with two.
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('refuses a limit that is not a positive integer', () => {
    for (const perMinute of [0, -1, 1.5, Number.NaN]) expect(() => new RateLimiter({ perMinute })).toThrow(/perMinute/);
  });
});

describe('rate limit and refusal audit configuration', () => {
  it('defaults to 600 requests per minute and the refusal audit bound of the runtime', () => {
    expect(loadConfig(base)).toMatchObject({
      API_RATE_LIMIT_PER_MINUTE: 600,
      REFUSAL_AUDIT_LIMIT_PER_ACTOR: DEFAULT_REFUSAL_AUDIT_LIMITS.perActor,
      REFUSAL_AUDIT_LIMIT_PER_ORG: DEFAULT_REFUSAL_AUDIT_LIMITS.perOrg,
      REFUSAL_AUDIT_WINDOW_SECONDS: DEFAULT_REFUSAL_AUDIT_LIMITS.windowSeconds,
    });
    expect(DEFAULT_REFUSAL_AUDIT_LIMITS).toEqual({ perActor: 50, perOrg: 500, windowSeconds: 3600, reserve: 10 });
    expect(loadConfig(base)).toMatchObject({ REFUSAL_AUDIT_RESERVE_PER_ACTOR: 10, REFUSAL_TALLY_RETENTION_DAYS: 7 });
    expect(loadConfig({ ...base, API_RATE_LIMIT_PER_MINUTE: '0' }).API_RATE_LIMIT_PER_MINUTE).toBe(0);
  });

  it('refuses malformed values instead of ignoring them', () => {
    for (const value of ['-1', '1.5', 'many', '1000000']) {
      expect(() => loadConfig({ ...base, API_RATE_LIMIT_PER_MINUTE: value })).toThrow(/API_RATE_LIMIT_PER_MINUTE/);
    }
    for (const field of ['REFUSAL_AUDIT_LIMIT_PER_ACTOR', 'REFUSAL_AUDIT_LIMIT_PER_ORG']) {
      for (const value of ['0', '-1', '1.5', 'many', '1000000']) expect(() => loadConfig({ ...base, [field]: value })).toThrow(new RegExp(field));
    }
    for (const value of ['-1', '1.5', 'many']) expect(() => loadConfig({ ...base, REFUSAL_AUDIT_RESERVE_PER_ACTOR: value })).toThrow(/REFUSAL_AUDIT_RESERVE_PER_ACTOR/);
    expect(() => loadConfig({ ...base, REFUSAL_AUDIT_LIMIT_PER_ACTOR: '5', REFUSAL_AUDIT_RESERVE_PER_ACTOR: '6' })).toThrow(/RESERVE/);
    expect(loadConfig({ ...base, REFUSAL_AUDIT_RESERVE_PER_ACTOR: '0' }).REFUSAL_AUDIT_RESERVE_PER_ACTOR).toBe(0);
    for (const value of ['0', '3651', 'week']) expect(() => loadConfig({ ...base, REFUSAL_TALLY_RETENTION_DAYS: value })).toThrow(/REFUSAL_TALLY_RETENTION_DAYS/);
    for (const value of ['59', '86401', '0', 'hour']) {
      expect(() => loadConfig({ ...base, REFUSAL_AUDIT_WINDOW_SECONDS: value })).toThrow(/REFUSAL_AUDIT_WINDOW_SECONDS/);
    }
  });

  it('refuses refusal audit limits out of range in the runtime too', () => {
    const db = {} as Db;
    expect(() => new Runtime(db, { refusalAudit: { perActor: 0, perOrg: 1, windowSeconds: 60 } })).toThrow(/perActor/);
    expect(() => new Runtime(db, { refusalAudit: { perActor: 1, perOrg: 1_000_000, windowSeconds: 60 } })).toThrow(/perOrg/);
    expect(() => new Runtime(db, { refusalAudit: { perActor: 1, perOrg: 1, windowSeconds: 30 } })).toThrow(/windowSeconds/);
    expect(() => new Runtime(db, { refusalAudit: { perActor: 5, perOrg: 9, windowSeconds: 60, reserve: 6 } })).toThrow(/reserve/);
    expect(() => new Runtime(db, { refusalAudit: { perActor: 5, perOrg: 9, windowSeconds: 60, reserve: -1 } })).toThrow(/reserve/);
    expect(() => new Runtime(db, { refusalAudit: 'unbounded' })).not.toThrow();
  });
});

describe('per-user request limit on /api', () => {
  const users: Record<string, AuthUser> = {
    alice: { userId: 'alice', email: 'a@example.com', name: null, aal: 'aal1', sessionId: 's-a', mfaAt: null },
    bob: { userId: 'bob', email: 'b@example.com', name: null, aal: 'aal1', sessionId: 's-b', mfaAt: null },
  };
  const app = (options: { perMinute?: string; limiter?: RateLimiter | null }) => {
    let calls = 0;
    const built = createHttpApp({
      config: loadConfig({ ...base, ...(options.perMinute ? { API_RATE_LIMIT_PER_MINUTE: options.perMinute } : {}) }),
      runtime: { installed: () => true, modules: () => ['kernel', 'finance'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async (header) => {
        calls++;
        const user = users[header?.replace('Bearer ', '') ?? ''];
        if (!user) throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ');
        return user;
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
      ...(options.limiter !== undefined ? { rateLimiter: options.limiter } : {}),
    });
    return { built, calls: () => calls };
  };
  // An unknown /api path answers 404 after the middleware, so it shows what the limit lets through.
  const get = (target: ReturnType<typeof app>, who: string) => target.built.request('/api/nothing-here', { headers: { authorization: `Bearer ${who}` } });

  it('answers 429 RATE_LIMITED with Retry-After past the limit, per user', async () => {
    const target = app({ perMinute: '2' });
    expect((await get(target, 'alice')).status).toBe(404);
    expect((await get(target, 'alice')).status).toBe(404);
    const refused = await get(target, 'alice');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: expect.any(Number) });
    // Another user still gets through.
    expect((await get(target, 'bob')).status).toBe(404);
  });

  it('limits only after the token is verified, so a bad token cannot spend a user budget', async () => {
    const target = app({ perMinute: '1' });
    for (let i = 0; i < 5; i++) expect((await target.built.request('/api/nothing-here', { headers: { authorization: 'Bearer mallory' } })).status).toBe(401);
    expect((await get(target, 'alice')).status).toBe(404);
  });

  it('is off with API_RATE_LIMIT_PER_MINUTE=0 or a null limiter', async () => {
    for (const target of [app({ perMinute: '0' }), app({ perMinute: '1', limiter: null })]) {
      for (let i = 0; i < 5; i++) expect((await get(target, 'alice')).status).toBe(404);
    }
  });

  it('leaves the public endpoints alone', async () => {
    const target = app({ perMinute: '1' });
    for (let i = 0; i < 3; i++) expect((await target.built.request('/api/config')).status).toBe(200);
    expect(target.calls()).toBe(0);
  });
});
