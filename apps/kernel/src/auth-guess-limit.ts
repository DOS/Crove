// Limits on guessing secrets through the /auth/v1 proxy (issue #221, plan §4.4 step 0 and §4.11).
//
// Supabase Auth limits requests per client address only (the X-Real-IP the proxy sets): /token a burst of 30 then
// 150 per 5 minutes, /verify 30 per 5 minutes, MFA challenge and verify 15 a minute. So one address may try about
// 1,800 passwords an hour, and many addresses may try one account without limit. The proxy therefore counts the
// requests that check a secret someone could guess, before it forwards them:
//   - password sign-in: POST /token with any grant but a refresh token, a PKCE code or an ID token, keyed by the
//     email or phone in the body;
//   - one-time codes: POST /verify naming an email or phone (a 6-digit emailed or texted code), keyed by it;
//   - MFA codes: POST /factors/<id>/verify (a 6-digit TOTP code), keyed by the factor.
// Each takes one slot from three token buckets: its client address (IPv6 per /64) in any 15 minutes, the account
// from that address in any 15 minutes, and the account from every address in an hour. A request Supabase Auth
// accepts (2xx) or does not check (429, its own limit) gives its slots back, so in effect failed attempts count;
// any other answer, or none, keeps them. Over a budget: 429 RATE_LIMITED with Retry-After, nothing forwarded.
//
// The account budget is at least four times what one address may spend on an account in an hour (config.ts refuses
// less), so one address alone can never lock someone out; it takes several. A locked-out user still signs in with an
// emailed link (recovery, magic link): links and PKCE code exchanges are not counted.
//
// In this process's memory, as #213 does for the per-user /api limit: no database write for traffic nobody has
// authenticated (§4.4 step 0), and it holds per API instance only, so N instances allow up to N times each budget.
// Account keys are SHA-256 hashes. Memory is bounded per bucket set: buckets that are full again are dropped first
// (that loses nothing), and if none is, the one touched longest ago.
import { bodyAccount, fieldValues, hashKey, jsonFields } from './auth-email-limit.ts';

export type GuessKind = 'password' | 'code' | 'mfa';

export interface Guess {
  kind: GuessKind;
  // `email:<address>`, `phone:<digits>` or `factor:<id>`. null: the body names none clearly, which counts in one
  // shared bucket per kind (Supabase Auth refuses such a request anyway).
  account: string | null;
}

// Grants of POST /token that check no secret someone could guess: a refresh token, a PKCE code with its verifier
// (both long and random), an ID token (signed by a provider). Every other grant, and an unknown one, counts.
const SAFE_GRANTS = new Set(['refresh_token', 'pkce', 'id_token']);
const FACTOR_VERIFY = /^\/factors\/([\w-]+)\/verify$/;

// `path` is the path after /auth/v1. Fails closed: whatever this cannot read with certainty counts.
export function guessRequest(method: string, path: string, query: URLSearchParams, contentType: string | null, body: Uint8Array | null): Guess | null {
  if (method.toUpperCase() !== 'POST') return null;
  if (path === '/token') {
    if (safeGrant(query, contentType, body)) return null;
    const fields = jsonFields(body);
    return { kind: 'password', account: fields ? bodyAccount(fields) : null };
  }
  if (path === '/verify') {
    const fields = jsonFields(body);
    // A body naming neither an email nor a phone verifies an emailed link's token hash, too long to guess.
    if (fields && fieldValues(fields, 'email').length === 0 && fieldValues(fields, 'phone').length === 0) return null;
    return { kind: 'code', account: fields ? bodyAccount(fields) : null };
  }
  const factor = FACTOR_VERIFY.exec(path);
  // Supabase Auth reads the id as a UUID, with or without hyphens and in any case.
  if (factor?.[1]) return { kind: 'mfa', account: `factor:${factor[1].replace(/-/g, '').toLowerCase()}` };
  return null;
}

// Supabase Auth takes the grant from Go's FormValue: a form-encoded body's grant_type first, then the query string's.
// Safe only when every grant_type in the query and in the body read as a form (whatever the Content-Type) is one of
// SAFE_GRANTS. A multipart body is not read here, so it is never safe.
function safeGrant(query: URLSearchParams, contentType: string | null, body: Uint8Array | null): boolean {
  if (/multipart\//i.test(contentType ?? '')) return false;
  const grants = query.getAll('grant_type');
  if (body && body.byteLength > 0) grants.push(...new URLSearchParams(new TextDecoder().decode(body)).getAll('grant_type'));
  return grants.length > 0 && grants.every((grant) => SAFE_GRANTS.has(grant));
}

export interface GuessLimits {
  // Attempts per client address, all accounts together, in any 15 minutes.
  perClient: number;
  // Attempts per account from one client address in any 15 minutes.
  perAccountClient: number;
  // Attempts per account from every address together in an hour.
  perAccount: number;
}

export type GuessVerdict = { allowed: true; release: () => void } | { allowed: false; retryAfterSeconds: number };

export interface GuessLimiter {
  // Takes a slot from each budget, or none. `release` gives them back once Supabase Auth accepted the attempt.
  reserve(client: string, guess: Guess): GuessVerdict;
}

export interface GuessLimiterOptions {
  // Buckets kept at most per budget (default 50,000).
  maxKeys?: number;
  now?: () => number;
}

const QUARTER_HOUR_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
// A full map is swept for buckets that are full again at most this often; in between it drops its oldest bucket.
const SWEEP_INTERVAL_MS = 1000;

export function createGuessLimiter(limits: GuessLimits, options: GuessLimiterOptions = {}): GuessLimiter {
  const make = (capacity: number, windowMs: number) => new TokenBuckets({ capacity, windowMs, ...options });
  const byClient = make(limits.perClient, QUARTER_HOUR_MS);
  const byAccountClient = make(limits.perAccountClient, QUARTER_HOUR_MS);
  const byAccount = make(limits.perAccount, HOUR_MS);
  return {
    reserve(client, guess) {
      const account = hashKey(`${guess.kind}:${guess.account ?? ''}`);
      const slots: Array<[TokenBuckets, string]> = [
        [byClient, client],
        [byAccountClient, `${account}|${client}`],
        [byAccount, account],
      ];
      const taken: Array<[TokenBuckets, string]> = [];
      for (const slot of slots) {
        const decision = slot[0].take(slot[1]);
        if (!decision.allowed) {
          for (const [buckets, key] of taken) buckets.refund(key);
          return { allowed: false, retryAfterSeconds: decision.retryAfterSeconds };
        }
        taken.push(slot);
      }
      let released = false;
      return {
        allowed: true,
        release: () => {
          if (released) return;
          released = true;
          for (const [buckets, key] of taken) buckets.refund(key);
        },
      };
    },
  };
}

interface Bucket {
  tokens: number;
  at: number;
}

// Token buckets that hold `capacity` and earn it back evenly over `windowMs`. A key with no bucket is a full bucket,
// so a bucket that is full again is dropped. Unlike rate-limit.ts (per signed-in user), tokens can be given back, and
// a full map evicts instead of refusing new keys: these keys come from people nobody has authenticated, and refusing
// every new key while the map is full would let a flood of addresses lock everyone out.
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly rate: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  // The next time a full map may be swept. Until then it drops its oldest bucket, so a flood of new keys costs at most
  // one sweep a second (or until the first bucket is full again), not one per request.
  private sweepAfter = 0;

  constructor(options: { capacity: number; windowMs: number; maxKeys?: number; now?: () => number }) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) throw new Error('capacity must be a positive integer');
    this.capacity = options.capacity;
    this.rate = options.capacity / options.windowMs;
    this.maxKeys = options.maxKeys ?? 50_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  take(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const tokens = this.level(key, now);
    if (tokens >= 1) {
      this.store(key, tokens - 1, now);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.store(key, tokens, now);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.rate / 1000)) };
  }

  // Gives back one token taken earlier. A bucket dropped since then was full or evicted: nothing to give back.
  refund(key: string): void {
    if (!this.buckets.has(key)) return;
    const now = this.now();
    this.store(key, this.level(key, now) + 1, now);
  }

  private level(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    // A clock that went backwards refills nothing.
    return bucket ? Math.min(this.capacity, bucket.tokens + Math.max(0, now - bucket.at) * this.rate) : this.capacity;
  }

  private store(key: string, tokens: number, now: number): void {
    // Deleting and setting again moves the key to the end, so the map's first key is the one touched longest ago.
    const known = this.buckets.delete(key);
    if (tokens >= this.capacity) return;
    if (!known && this.buckets.size >= this.maxKeys) this.makeRoom(now);
    this.buckets.set(key, { tokens, at: now });
  }

  // Drops every bucket that is full again; if none is, the one touched longest ago, whose owner gets a fresh budget.
  private makeRoom(now: number): void {
    if (now >= this.sweepAfter) {
      let soonest = Number.POSITIVE_INFINITY;
      for (const [key, bucket] of this.buckets) {
        const missing = this.capacity - (bucket.tokens + Math.max(0, now - bucket.at) * this.rate);
        if (missing <= 0) this.buckets.delete(key);
        else soonest = Math.min(soonest, now + missing / this.rate);
      }
      const freed = this.buckets.size < this.maxKeys;
      this.sweepAfter = Math.max(freed ? 0 : soonest, now + SWEEP_INTERVAL_MS);
      if (freed) return;
    }
    const oldest = this.buckets.keys().next();
    if (!oldest.done) this.buckets.delete(oldest.value);
  }
}
