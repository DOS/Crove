// The sign-up policy's decisions (#350) without a database: which requests can create an account, how the email is
// read from a body the way Supabase Auth's Go decoder reads it, and the configuration that stops the boot.
import { describe, expect, it } from 'vitest';
import { goFoldKey, methodRefused, parseAllowedDomains, signupAllowed, signupEmail, signupGate, signupRefused, type SignupRules } from '../src/auth-signup-policy.ts';
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
    expect(gate(r, '/signup', { email: 'an@corp.test', EMAIL: 'AN@corp.test' })).toEqual({ kind: 'check', email: 'an@corp.test' });
    for (const body of [{ email: 'an@corp.test', Email: 'x@corp.test' }, { email: 'an@corp.test', EMAIL: null }, { phone: '+84901234567' }, { email: 'an@corp.test', phone: '1' }, {}, [], 'x']) {
      expect(gate(r, '/signup', body)).toEqual({ kind: 'refuse' });
    }
    expect(gate(r, '/signup')).toEqual({ kind: 'refuse' });
    expect(gate(r, '/signup', { email: 'an@corp.test', phone: '' })).toEqual({ kind: 'check', email: 'an@corp.test' });
  });

  it('passes an email code that cannot create an account', () => {
    const r = rules('allowlist', ['corp.test']);
    expect(gate(r, '/otp', { email: 'x@else.test', create_user: false })).toEqual({ kind: 'pass' });
    expect(gate(r, '/otp', { phone: '+84901234567', CREATE_USER: false })).toEqual({ kind: 'pass' });
    expect(gate(r, '/otp', { email: 'x@else.test', create_user: false, 'create_uſer': true })).toEqual({ kind: 'check', email: 'x@else.test' });
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
  const never = async () => false;
  const always = async () => true;
  it('admits allowed domains exactly, and otherwise asks for an invite', async () => {
    const r = rules('allowlist', ['corp.test']);
    expect(await signupAllowed(r, 'a+b@corp.test', never)).toBe(true);
    expect(await signupAllowed(r, 'a@sub.corp.test', never)).toBe(false);
    expect(await signupAllowed(r, 'a@evilcorp.test', never)).toBe(false);
    expect(await signupAllowed(r, 'a@else.test', always)).toBe(true);
    expect(await signupAllowed(rules('invite_only'), 'a@corp.test', never)).toBe(false);
    expect(await signupAllowed(rules('invite_only'), 'a@corp.test', always)).toBe(true);
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
