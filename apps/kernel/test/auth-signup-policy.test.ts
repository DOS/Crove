// The sign-up policy's decisions (#350) without a database: which requests can create an account, how the email is
// read from a body the way Supabase Auth's Go decoder reads it, and the configuration that stops the boot.
import { describe, expect, it } from 'vitest';
import {
  emailChangeGate,
  emailChangeRefused,
  goFoldKey,
  limitInviteChecks,
  methodRefused,
  parseAllowedDomains,
  signupAllowed,
  signupEmail,
  signupGate,
  signupInviteToken,
  SignupRefusalsLimited,
  signupRefusalsLimited,
  signupRefused,
  topLevelKeys,
  type InviteChecks,
  type RefusalLimiter,
  type SignupRules,
} from '../src/auth-signup-policy.ts';
import { loadConfig } from '../src/config.ts';

const rules = (policy: SignupRules['policy'], domains: string[] = []): SignupRules => ({ policy, domains: new Set(domains) });
const json = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const gate = (r: SignupRules, path: string, body?: unknown, query = '', contentType: string | null = 'application/json') =>
  signupGate(r, { path, search: new URLSearchParams(query), contentType, body: body === undefined ? null : json(body) });

const BASE = { DATABASE_URL: 'postgres://x@localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };
const BUNDLED = { ...BASE, AUTH_UPSTREAM_URL: 'http://auth:9999' };

describe('signupEmail', () => {
  it('lower-cases a plain ASCII address and trims it', () => {
    expect(signupEmail(' An.Nguyen+Tax@Corp.Example.VN ')).toBe('an.nguyen+tax@corp.example.vn');
  });

  it('refuses non-ASCII, control characters, several @ and non-strings', () => {
    for (const value of ['Kim@corp.test', 'an@cоrp.test', 'an@corp.test\u0000', 'a​@corp.test', 'a@b@corp.test', '"a"@corp.test', 'a@corp', 'a@-corp.test', '', 42, null, undefined, ['a@corp.test']]) {
      expect(signupEmail(value)).toBeNull();
    }
  });
});

describe('goFoldKey', () => {
  it('folds the way Go matches JSON keys to ASCII field names', () => {
    expect(goFoldKey('CREATE_USER')).toBe('create_user');
    expect(goFoldKey('create_uſer')).toBe('create_user');
    expect(goFoldKey('Key')).toBe('key');
    // Dotless i and dotted capital I are not in the simple fold set of i.
    expect(goFoldKey('emaıl')).not.toBe('email');
    expect(goFoldKey('EMAİL')).not.toBe('email');
  });
});

describe('signupGate', () => {
  it('passes everything under open', () => {
    expect(gate(rules('open'), '/signup', { phone: '+84901234567' })).toEqual({ kind: 'pass' });
    expect(gate(rules('open'), '/authorize')).toEqual({ kind: 'pass' });
  });

  it('checks the one email of a sign-up and refuses what it cannot read', () => {
    const r = rules('invite_only');
    expect(gate(r, '/signup', { email: 'An@Corp.test', password: 'x' })).toEqual({ kind: 'check', email: 'an@corp.test' });
    // A key repeated after Go's folding is refused, even with one address: JavaScript and Go may keep different copies.
    expect(gate(r, '/signup', { email: 'an@corp.test', EMAIL: 'AN@corp.test' })).toEqual({ kind: 'refuse' });
    for (const body of [
      { email: 'an@corp.test', Email: 'x@corp.test' },
      { email: 'an@corp.test', EMAIL: null },
      { phone: '+84901234567' },
      { email: 'an@corp.test', phone: '1' },
      {},
      [],
      'x',
      // JSON.parse keeps the last copy of a repeated key (null: no phone); Go keeps the phone, as a null leaves it.
      '{"email":"an@corp.test","phone":"+84901234567","phone":null}',
      '{"email":"an@corp.test","email":"an@corp.test"}',
      '{"email":"an@corp.test","PHONE":"+84901234567","Phone":null}',
    ]) {
      expect(gate(r, '/signup', body)).toEqual({ kind: 'refuse' });
    }
    expect(gate(r, '/signup')).toEqual({ kind: 'refuse' });
    expect(gate(r, '/signup', { email: 'an@corp.test', phone: '' })).toEqual({ kind: 'check', email: 'an@corp.test' });
  });

  it('passes an email code that cannot create an account', () => {
    const r = rules('allowlist', ['corp.test']);
    expect(gate(r, '/otp', { email: 'x@else.test', create_user: false })).toEqual({ kind: 'pass' });
    expect(gate(r, '/otp', { phone: '+84901234567', CREATE_USER: false })).toEqual({ kind: 'pass' });
    expect(gate(r, '/otp', { email: 'x@else.test', create_user: false, 'create_uſer': true })).toEqual({ kind: 'refuse' });
    expect(gate(r, '/otp', '{"email":"x@else.test","create_user":false,"create_user":false}')).toEqual({ kind: 'refuse' });
    expect(gate(r, '/otp', { email: 'x@else.test', create_user: 'false' })).toEqual({ kind: 'check', email: 'x@else.test' });
    expect(gate(r, '/otp', { email: 'x@else.test', create_user: null })).toEqual({ kind: 'check', email: 'x@else.test' });
  });

  it('passes only sign-in grants on /token, with the query as the one source', () => {
    const r = rules('invite_only');
    for (const grant of ['password', 'refresh_token', 'pkce']) expect(gate(r, '/token', {}, `grant_type=${grant}`)).toEqual({ kind: 'pass' });
    expect(gate(r, '/token', {}, 'grant_type=password', null)).toEqual({ kind: 'pass' });
    expect(gate(r, '/token', {}, 'grant_type=password', 'Application/JSON; charset=utf-8')).toEqual({ kind: 'pass' });
    for (const [query, type] of [
      ['grant_type=id_token', 'application/json'],
      ['grant_type=web3', 'application/json'],
      ['', 'application/json'],
      ['grant_type=password&grant_type=password', 'application/json'],
      ['grant_type=password', 'application/x-www-form-urlencoded'],
      ['grant_type=password', 'multipart/form-data; boundary=x'],
      ['grant_type=password', 'text/plain'],
    ] as const) {
      expect(gate(r, '/token', {}, query, type)).toEqual({ kind: 'method' });
    }
  });

  it('refuses OAuth and leaves every other path to Supabase Auth', () => {
    const r = rules('invite_only');
    expect(gate(r, '/authorize')).toEqual({ kind: 'method' });
    expect(gate(r, '/callback')).toEqual({ kind: 'method' });
    for (const path of ['/recover', '/verify', '/user', '/logout', '/resend', '/settings', '/factors']) expect(gate(r, path, { email: 'x@y.test' })).toEqual({ kind: 'pass' });
  });
});

describe('signupAllowed', () => {
  const TOKEN = 'T'.repeat(43);
  // held: the address holds some valid invite; matches: TOKEN is the token of a valid invite for it.
  const checks = (held: boolean, matches: boolean): InviteChecks & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      held: async (email) => (asked.push(`held ${email}`), held),
      matches: async (email, token) => (asked.push(`matches ${email}`), matches && token === TOKEN),
    };
  };
  it('admits allowed domains exactly while the address holds no invite, and otherwise asks for the invite token', async () => {
    const r = rules('allowlist', ['corp.test']);
    expect(await signupAllowed(r, 'a+b@corp.test', null, checks(false, false))).toBe(true);
    expect(await signupAllowed(r, 'a@sub.corp.test', null, checks(false, false))).toBe(false);
    expect(await signupAllowed(r, 'a@evilcorp.test', null, checks(false, false))).toBe(false);
    expect(await signupAllowed(r, 'a@else.test', TOKEN, checks(true, true))).toBe(true);
    // An invited address at an allowed domain needs its link too (#563): someone else could otherwise sign up first.
    expect(await signupAllowed(r, 'a@corp.test', null, checks(true, false))).toBe(false);
    expect(await signupAllowed(r, 'a@corp.test', TOKEN, checks(true, true))).toBe(true);
    expect(await signupAllowed(r, 'a@else.test', null, checks(true, true))).toBe(false);
  });
  it('under invite_only admits only a sign-up carrying the token of a valid invite for its email (#563)', async () => {
    const r = rules('invite_only');
    // Holding an invite is not enough: whoever knows an invited address could sign up first with their own password.
    const held = checks(true, false);
    expect(await signupAllowed(r, 'a@corp.test', null, held)).toBe(false);
    expect(held.asked).toEqual([]);
    expect(await signupAllowed(r, 'a@corp.test', TOKEN, checks(true, false))).toBe(false);
    expect(await signupAllowed(r, 'a@corp.test', 'U'.repeat(43), checks(true, true))).toBe(false);
    const ok = checks(true, true);
    expect(await signupAllowed(r, 'a@corp.test', TOKEN, ok)).toBe(true);
    expect(ok.asked).toEqual(['matches a@corp.test']);
  });
  it('asks nothing under open', async () => {
    const asked = checks(true, true);
    expect(await signupAllowed(rules('open'), 'a@corp.test', null, asked)).toBe(true);
    expect(asked.asked).toEqual([]);
  });
  it('reads the token header only when it is one well-formed token', () => {
    expect(signupInviteToken(TOKEN)).toBe(TOKEN);
    expect(signupInviteToken('A-_b'.repeat(10) + 'xyz')).toBe('A-_b'.repeat(10) + 'xyz');
    for (const bad of [undefined, null, '', 'T'.repeat(42), 'T'.repeat(44), `${'T'.repeat(42)}=`, ` ${'T'.repeat(43)}`, `${'T'.repeat(43)}, ${'T'.repeat(43)}`]) {
      expect(signupInviteToken(bad)).toBeNull();
    }
  });
});

describe('emailChangeGate (#564 item 4)', () => {
  const r = rules('allowlist', ['corp.test', 'partner.vn']);
  const change = (body: unknown, method = 'PUT', path = '/user', policy = r) =>
    emailChangeGate(policy, { method, path, body: body === undefined ? null : json(body) });

  it('lets an email change through only to an allowed domain, read as the sign-up gate reads it', () => {
    expect(change({ email: 'a@corp.test' })).toBe('pass');
    expect(change({ email: ' A+Tax@CORP.TEST ' })).toBe('pass');
    // Only the top-level key is the account's email; metadata may say anything.
    expect(change({ email: 'b@partner.vn', data: { email: 'x@evil.test' } })).toBe('pass');
    for (const email of [
      'a@evil.test',
      'a@sub.corp.test',
      'a@corp.test.evil.test',
      'a@c\u043erp.test',
      'a@corp.test\u0000',
      'a@corp.test@evil.test',
      '"a@corp.test"@evil.test',
      'a@\uff43orp.test',
      'a\u200b@corp.test',
      'not-an-email',
    ]) {
      expect(change({ email }), email).toBe('refuse');
    }
  });

  it('matches the email key the way Go decodes it and checks every value it might keep', () => {
    expect(change({ EMAIL: 'a@evil.test' })).toBe('refuse');
    expect(change({ eMaIl: 'a@corp.test' })).toBe('pass');
    expect(change({ email: 'a@corp.test', Email: 'a@evil.test' })).toBe('refuse');
    expect(change({ Email: 'a@evil.test', email: 'a@corp.test' })).toBe('refuse');
    // An empty value last makes Go keep "", no change; the proxy still refuses the other value, failing closed.
    expect(change({ email: 'a@evil.test', EMAIL: '' })).toBe('refuse');
    // Dotless i does not fold to i in Go, so this key is not the email and Supabase Auth ignores it.
    expect(change({ 'ema\u0131l': 'a@evil.test' })).toBe('pass');
    // A number, an object or an array is no address; Supabase Auth would refuse it, and so does the proxy.
    expect(change({ email: 42 })).toBe('refuse');
    expect(change({ email: { address: 'a@corp.test' } })).toBe('refuse');
    expect(change({ email: ['a@corp.test'] })).toBe('refuse');
  });

  it('passes updates that change no email: no key, an empty value, password and metadata', () => {
    expect(change({ password: 'new-password-1' })).toBe('pass');
    expect(change({ data: { name: 'An' } })).toBe('pass');
    expect(change({ email: '' })).toBe('pass');
    // A null is refused: the proxy does not rely on how Go treats it.
    expect(change({ email: null, password: 'new-password-1' })).toBe('refuse');
    expect(change(undefined)).toBe('pass');
    expect(change('')).toBe('pass');
  });

  // JSON.parse keeps the last copy of a repeated key, here null, while Go assigns each copy in turn and a null leaves
  // the string as it was: Supabase Auth would start the change to the first address.
  it('refuses a body that repeats the email key, exactly or after Go folding', () => {
    for (const body of [
      '{"email":"test_user@gmail.com","email":null}',
      '{"EMAIL":"x@evil.test","EMAIL":null}',
      '{"email":"x@evil.test","Email":null}',
      '{"email":"x@evil.test","email":""}',
      '{"email":"a@corp.test","email":"a@corp.test"}',
      '{"email":"x@evil.test","em\\u0061il":null}',
      '{"password":"a","PASSWORD":"b"}',
    ]) {
      expect(change(body), body).toBe('refuse');
    }
  });

  it('refuses a body it cannot read as one JSON object, whatever the method on /user', () => {
    for (const body of ['not json', '{"email": "a@evil.test"', '[{"email": "a@evil.test"}]', 'null', '"a@evil.test"', 'email=a@evil.test']) {
      expect(change(body), body).toBe('refuse');
    }
    expect(change({ email: 'a@evil.test' }, 'POST')).toBe('refuse');
    expect(change({ email: 'a@evil.test' }, 'patch')).toBe('refuse');
    expect(change({ email: 'a@evil.test' }, 'GET')).toBe('pass');
    expect(change({ email: 'a@evil.test' }, 'HEAD')).toBe('pass');
  });

  it('applies to /user under allowlist only', () => {
    for (const path of ['/signup', '/otp', '/recover', '/resend', '/verify', '/token']) expect(change({ email: 'a@evil.test' }, 'POST', path)).toBe('pass');
    expect(change({ email: 'a@evil.test' }, 'PUT', '/user', rules('open'))).toBe('pass');
    expect(change({ email: 'a@evil.test' }, 'PUT', '/user', rules('invite_only'))).toBe('pass');
    expect(change('not json', 'PUT', '/user', rules('invite_only'))).toBe('pass');
  });

  it('answers one 403 in Supabase Auth error shape', async () => {
    const response = emailChangeRefused();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 403, error_code: 'email_change_not_allowed', msg: expect.any(String) });
  });
});

describe('topLevelKeys', () => {
  it('lists the top-level keys with repeats, decoding escapes, and skips nested objects and strings', () => {
    expect(topLevelKeys('{"a":1,"b":{"a":2,"c":[{"a":3}]},"a":"x,\\"a\\":{"}')).toEqual(['a', 'b', 'a']);
    expect(topLevelKeys(' { "em\\u0061il" : null , "x\\\\" : [1, {"y": 2}] } ')).toEqual(['email', 'x\\']);
    expect(topLevelKeys('{}')).toEqual([]);
  });
});

describe('limitInviteChecks (#564 item 1)', () => {
  // A limiter with room for `room` slots that records what it was asked and what was given back.
  const limiter = (room: number) => {
    const log: string[] = [];
    let used = 0;
    const l: RefusalLimiter & { log: string[] } = {
      log,
      reserve: async ({ client, email }) => {
        log.push(`reserve ${client} ${email}`);
        if (used >= room) return { allowed: false, retryAfterSeconds: 120 };
        used++;
        return {
          allowed: true,
          release: async () => {
            used--;
            log.push(`release ${client} ${email}`);
          },
        };
      },
    };
    return l;
  };
  const inner = (held: boolean | 'throw'): InviteChecks => ({
    held: async () => {
      if (held === 'throw') throw new Error('database down');
      return held;
    },
    matches: async () => true,
  });

  it('keeps the slot of a refusal and gives it back when the address holds no invite', async () => {
    const l = limiter(1);
    const client = 'v6:2001:db8:1::/48';
    expect(await limitInviteChecks(inner(false), l, client).held('a@corp.test')).toBe(false);
    expect(await limitInviteChecks(inner(false), l, client).held('b@corp.test')).toBe(false);
    expect(await limitInviteChecks(inner(true), l, client).held('c@corp.test')).toBe(true);
    await expect(limitInviteChecks(inner(false), l, client).held('d@corp.test')).rejects.toBeInstanceOf(SignupRefusalsLimited);
    expect(l.log).toEqual([
      `reserve ${client} a@corp.test`,
      `release ${client} a@corp.test`,
      `reserve ${client} b@corp.test`,
      `release ${client} b@corp.test`,
      `reserve ${client} c@corp.test`,
      `reserve ${client} d@corp.test`,
    ]);
  });

  it('at the limit throws before it asks whether the address is invited', async () => {
    let asked = 0;
    const checks = limitInviteChecks({ held: async () => (asked++, false), matches: async () => true }, limiter(0), 'v4:203.0.113.9');
    await expect(checks.held('a@corp.test')).rejects.toBeInstanceOf(SignupRefusalsLimited);
    await expect(checks.held('a@corp.test')).rejects.toMatchObject({ retryAfterSeconds: 120 });
    expect(asked).toBe(0);
  });

  it('gives the slot back when the invite check fails, and never counts the token check', async () => {
    const l = limiter(1);
    await expect(limitInviteChecks(inner('throw'), l, 'unknown').held('a@corp.test')).rejects.toThrow('database down');
    expect(l.log).toEqual(['reserve unknown a@corp.test', 'release unknown a@corp.test']);
    expect(await limitInviteChecks(inner(true), l, 'unknown').matches('a@corp.test', 'T'.repeat(43))).toBe(true);
    expect(l.log).toHaveLength(2);
  });

  it('under signupAllowed counts only the lookups whose answer depends on an invite', async () => {
    const l = limiter(10);
    const checks = limitInviteChecks(inner(true), l, 'v4:203.0.113.9');
    // Another domain, invite_only and a matching token never ask held().
    expect(await signupAllowed(rules('allowlist', ['corp.test']), 'a@evil.test', null, checks)).toBe(false);
    expect(await signupAllowed(rules('invite_only'), 'a@corp.test', null, checks)).toBe(false);
    expect(await signupAllowed(rules('allowlist', ['corp.test']), 'a@corp.test', 'T'.repeat(43), checks)).toBe(true);
    expect(l.log).toEqual([]);
    expect(await signupAllowed(rules('allowlist', ['corp.test']), 'b@corp.test', null, checks)).toBe(false);
    expect(l.log).toEqual(['reserve v4:203.0.113.9 b@corp.test']);
  });

  it("answers 429 with Supabase Auth's request rate limit code and Retry-After", async () => {
    const response = signupRefusalsLimited(42.2);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('43');
    expect(await response.json()).toEqual({ code: 429, error_code: 'over_request_rate_limit', msg: expect.any(String) });
  });
});

describe('the refusal', () => {
  it('is one 403 in Supabase Auth error shape', async () => {
    const response = signupRefused();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 403, error_code: 'signup_not_allowed', msg: expect.any(String) });
    const method = methodRefused();
    expect(method.status).toBe(403);
    expect(await method.json()).toEqual({ code: 403, error_code: 'signup_method_not_allowed', msg: expect.any(String) });
  });
});

describe('configuration', () => {
  it('defaults to open, as before the setting existed', () => {
    expect(loadConfig(BUNDLED).AUTH_SIGNUP_POLICY).toBe('open');
    expect(loadConfig({ ...BUNDLED, AUTH_SIGNUP_POLICY: ' ' }).AUTH_SIGNUP_POLICY).toBe('open');
  });

  it('parses the allowed domains', () => {
    expect(loadConfig({ ...BUNDLED, AUTH_SIGNUP_POLICY: 'allowlist', AUTH_SIGNUP_ALLOWED_DOMAINS: 'Corp.test, partner.vn corp.test' }).AUTH_SIGNUP_ALLOWED_DOMAINS).toEqual([
      'corp.test',
      'partner.vn',
    ]);
    expect(parseAllowedDomains('*.corp.test, @corp.test, corp, cоrp.test, ok.test')).toEqual({ domains: ['ok.test'], invalid: ['*.corp.test', '@corp.test', 'corp', 'cоrp.test'] });
  });

  it('caps sign-up refusals by default and takes 0 to turn the deployment cap off', () => {
    const config = loadConfig(BUNDLED);
    expect(config.AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR).toBe(5);
    // Off by default: a member who may invite could fill a deployment cap and stop plain sign-ups for the domain.
    expect(config.AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR).toBe(0);
    expect(loadConfig({ ...BUNDLED, AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR: '50' }).AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR).toBe(50);
    // Blank is unset, as for the other optional settings, not 0.
    expect(loadConfig({ ...BUNDLED, AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR: ' ' }).AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR).toBe(5);
    expect(loadConfig({ ...BUNDLED, AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR: '' }).AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR).toBe(0);
    expect(() => loadConfig({ ...BUNDLED, AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR: 'five' })).toThrow(/AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR/);
    expect(loadConfig({ ...BUNDLED, AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR: '0' }).AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR).toBe(0);
    expect(() => loadConfig({ ...BUNDLED, AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR: '0' })).toThrow(/AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR/);
    expect(() => loadConfig({ ...BUNDLED, AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR: '-1' })).toThrow(/AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR/);
  });

  it('stops the boot on a policy it cannot enforce or one set halfway', () => {
    expect(() => loadConfig({ ...BUNDLED, AUTH_SIGNUP_POLICY: 'invite-only' })).toThrow(/AUTH_SIGNUP_POLICY/);
    expect(() => loadConfig({ ...BUNDLED, AUTH_SIGNUP_POLICY: 'allowlist' })).toThrow(/needs AUTH_SIGNUP_ALLOWED_DOMAINS/);
    expect(() => loadConfig({ ...BUNDLED, AUTH_SIGNUP_POLICY: 'allowlist', AUTH_SIGNUP_ALLOWED_DOMAINS: '*.corp.test' })).toThrow(/AUTH_SIGNUP_ALLOWED_DOMAINS \(not a domain: \*\.corp\.test\)/);
    expect(() => loadConfig({ ...BUNDLED, AUTH_SIGNUP_ALLOWED_DOMAINS: 'corp.test' })).toThrow(/applies to AUTH_SIGNUP_POLICY=allowlist only/);
    expect(() => loadConfig({ ...BUNDLED, AUTH_SIGNUP_POLICY: 'invite_only', AUTH_SIGNUP_ALLOWED_DOMAINS: 'corp.test' })).toThrow(/applies to AUTH_SIGNUP_POLICY=allowlist only/);
    expect(() => loadConfig({ ...BASE, AUTH_JWKS_URL: 'https://x.test/jwks', AUTH_SIGNUP_POLICY: 'invite_only' })).toThrow(/enforced by the \/auth\/v1 proxy/);
    expect(loadConfig({ ...BUNDLED, AUTH_SIGNUP_POLICY: 'invite_only' }).AUTH_SIGNUP_POLICY).toBe('invite_only');
  });
});
