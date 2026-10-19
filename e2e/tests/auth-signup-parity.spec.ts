// The /auth/v1 proxy's reading of a sign-up request, checked against the pinned Supabase Auth itself (#564, from the
// review of #559). Under a restricted sign-up policy (#350) the proxy decides from the JSON body which email a request
// would create an account for, whether an email code may create one (create_user) and which grant a /token request
// runs, all by modelling Supabase Auth's Go decoding: keys match field names case-insensitively under Unicode simple
// folding ("create_uſer", U+017F, is create_user), the last match wins, the email is lower-cased, and a form body
// decides grant_type over the query string. apps/kernel/test/signup-policy-proxy.db.test.ts tests the proxy against a
// fake upstream that follows that model; this spec sends the same request shapes to the real image and checks that it
// still behaves as modelled, so a Supabase Auth or Go toolchain bump that changes the matching fails CI.
//
// The first test sends each request through the proxy on the default e2e stack, whose policy is open, so it reaches
// Supabase Auth unchanged, and computes the proxy's verdict for it with signupGate() under allowlist. It runs in CI
// and is skipped on a restricted stack. The second needs a stack started with AUTH_SIGNUP_POLICY=allowlist and
// AUTH_SIGNUP_ALLOWED_DOMAINS=example.com (as invite-preclaim.spec.ts) and is skipped otherwise. The invite token
// header (x-crove-invite) never reaching Supabase Auth cannot be seen from outside, since Supabase Auth ignores
// unknown headers: the proxy's db tests check it at the fake upstream (signup-policy-proxy.db.test.ts and
// test/invariant/invite-preclaim.db.test.ts).
import { expect, test } from '@playwright/test';
import { signupGate, type SignupGate, type SignupRules } from '../../apps/kernel/src/auth-signup-policy.ts';
import { sql } from '../lib/db.ts';
import { PASSWORD } from '../lib/session.ts';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const RULES: SignupRules = { policy: 'allowlist', domains: new Set(['example.com']) };

// A unique address per case; `tag` finds every account Supabase Auth created for the case, whatever its spelling.
function address(tag: string, n: number): string {
  return `e2e-parity-${tag}-${n}@example.com`;
}

function newTag(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

function accountsLike(tag: string): string[] {
  return sql<{ email: string }>(`SELECT email FROM auth.users WHERE email LIKE '%' || :'tag' || '%' ORDER BY email`, { tag }).map((r) => r.email);
}

interface Answer {
  status: number;
  errorCode: string | null;
  msg: string | null;
}

async function send(path: string, body: string, contentType: string | null): Promise<Answer> {
  const response = await fetch(`${BASE_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: contentType === null ? {} : { 'content-type': contentType },
    // Bytes, so fetch adds no Content-Type of its own.
    body: new TextEncoder().encode(body),
  });
  const answer = (await response.json().catch(() => null)) as { error_code?: unknown; msg?: unknown } | null;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return { status: response.status, errorCode: text(answer?.error_code), msg: text(answer?.msg) };
}

function gateFor(path: string, body: string, contentType: string | null): SignupGate {
  const url = new URL(`${BASE_URL}${path}`);
  return signupGate(RULES, { path: url.pathname, search: url.searchParams, contentType, body: new TextEncoder().encode(body) });
}

interface BodyCase {
  name: string;
  path: '/signup' | '/otp';
  // The raw JSON, so keys can repeat and keep their order. `a` and `b` are the case's two addresses.
  body: (a: string, b: string) => string;
  // What the proxy concludes: 'a' (check that address), 'pass' (cannot create an account) or 'refuse'.
  gate: 'a' | 'pass' | 'refuse';
  // The accounts Supabase Auth creates: none, `a` or `b`.
  creates: 'none' | 'a' | 'b';
}

const q = JSON.stringify;
const CASES: BodyCase[] = [
  { name: 'upper-case email key', path: '/signup', body: (a) => `{"EMAIL":${q(a)},"password":${q(PASSWORD)}}`, gate: 'a', creates: 'a' },
  { name: 'mixed-case key and address, lower-cased', path: '/signup', body: (a) => `{"eMail":${q(a.toUpperCase())},"PassWord":${q(PASSWORD)}}`, gate: 'a', creates: 'a' },
  { name: 'two email keys, last one wins', path: '/signup', body: (a, b) => `{"email":${q(a)},"Email":${q(b)},"password":${q(PASSWORD)}}`, gate: 'refuse', creates: 'b' },
  { name: 'two email keys, one address', path: '/signup', body: (a) => `{"email":${q(a)},"EMAIL":${q(a.toUpperCase())},"password":${q(PASSWORD)}}`, gate: 'a', creates: 'a' },
  { name: 'email and phone', path: '/signup', body: (a) => `{"email":${q(a)},"Phone":"+15005550006","password":${q(PASSWORD)}}`, gate: 'refuse', creates: 'none' },
  { name: 'email code, create_user unset', path: '/otp', body: (a) => `{"email":${q(a)}}`, gate: 'a', creates: 'a' },
  { name: 'email code, create_user false', path: '/otp', body: (a) => `{"email":${q(a)},"create_user":false}`, gate: 'pass', creates: 'none' },
  { name: 'email code, create_uſer (U+017F) false', path: '/otp', body: (a) => `{"email":${q(a)},"create_uſer":false}`, gate: 'pass', creates: 'none' },
  { name: 'email code, CREATE_USER false', path: '/otp', body: (a) => `{"email":${q(a)},"CREATE_USER":false}`, gate: 'pass', creates: 'none' },
  { name: 'email code, false then create_uſer true', path: '/otp', body: (a) => `{"email":${q(a)},"create_user":false,"create_uſer":true}`, gate: 'a', creates: 'a' },
  { name: 'email code, true then Create_User false', path: '/otp', body: (a) => `{"email":${q(a)},"create_user":true,"Create_User":false}`, gate: 'a', creates: 'none' },
  { name: 'email code, create_user as a string', path: '/otp', body: (a) => `{"email":${q(a)},"create_user":"false"}`, gate: 'a', creates: 'none' },
];

test('Supabase Auth decodes sign-up bodies and /token grants as the proxy models them', async ({ request }) => {
  const config = (await (await request.get('/api/config')).json()) as { signupPolicy?: string };
  test.skip(config.signupPolicy !== 'open', 'needs the default open sign-up policy, so every request reaches Supabase Auth unchanged');
  const tag = newTag();
  for (const [n, c] of CASES.entries()) {
    const a = address(`${tag}-${n}`, 1);
    const b = address(`${tag}-${n}`, 2);
    const body = c.body(a, b);
    const gate = gateFor(c.path, body, 'application/json');
    expect(gate, c.name).toEqual(c.gate === 'a' ? { kind: 'check', email: a } : { kind: c.gate });

    const answer = await send(c.path, body, 'application/json');
    expect(answer.status, `${c.name}: ${answer.errorCode}`).toBeLessThan(500);
    expect(answer.status, `${c.name}: rate limited`).not.toBe(429);
    const created = accountsLike(`${tag}-${n}-`);
    expect(created, c.name).toEqual(c.creates === 'none' ? [] : [c.creates === 'a' ? a : b]);
    // The property the proxy relies on: a request it lets through unchecked creates nothing, and a checked one
    // creates at most the account for the address it checked.
    if (gate.kind === 'pass') expect(created, c.name).toEqual([]);
    if (gate.kind === 'check') expect(created.every((email) => email === gate.email), c.name).toBe(true);
  }

  // /token: Supabase Auth reads grant_type with Go's FormValue, so a form body overrides the query string; a JSON or
  // untyped body leaves the query as the one source. Two controls give its answers for the password grant and for
  // a grant it does not know (v2.197 gives both the error code invalid_credentials, with different messages).
  const login = q({ email: address(`${tag}-token`, 1), password: 'e2e-wrong-password' });
  const passwordGrant = await send('/token?grant_type=password', login, 'application/json');
  const unknownGrant = await send('/token?grant_type=crove_parity', login, 'application/json');
  expect(passwordGrant.status).toBe(400);
  expect(unknownGrant.status).toBe(400);
  expect(unknownGrant.msg).not.toBe(passwordGrant.msg);
  expect(gateFor('/token?grant_type=password', login, 'application/json')).toEqual({ kind: 'pass' });
  expect(gateFor('/token?grant_type=crove_parity', login, 'application/json')).toEqual({ kind: 'method' });

  const form = `grant_type=crove_parity&email=${encodeURIComponent(address(`${tag}-token`, 1))}&password=e2e-wrong-password`;
  for (const contentType of ['application/x-www-form-urlencoded', 'Application/X-WWW-Form-URLencoded; charset=UTF-8']) {
    expect(await send('/token?grant_type=password', form, contentType), contentType).toEqual(unknownGrant);
    expect(gateFor('/token?grant_type=password', form, contentType), contentType).toEqual({ kind: 'method' });
  }
  // With no Content-Type Go does not parse the body as a form: the query's password grant runs (and refuses a body
  // that is not JSON), so the proxy may pass it.
  const untyped = await send('/token?grant_type=password', form, null);
  expect(untyped.status).toBe(400);
  expect(untyped.msg).not.toBe(unknownGrant.msg);
  expect(gateFor('/token?grant_type=password', form, null)).toEqual({ kind: 'pass' });

  // pilot-check's sign-up probe (#564) relies on Supabase Auth refusing a sign-up without a password, in its error
  // shape and before it creates or mails anything, when no gate refuses it first.
  const probe = `pilot-check-${tag}@pilot-check.invalid`;
  const probed = await send('/signup', q({ email: probe }), 'application/json');
  expect([400, 422]).toContain(probed.status);
  expect(probed.errorCode).toEqual(expect.any(String));
  expect(probed.errorCode).not.toBe('signup_disabled');
  expect(accountsLike(probe)).toEqual([]);
});

test('the proxy refuses on the real stack what its gate refuses (needs AUTH_SIGNUP_POLICY=allowlist)', async ({ request }) => {
  const config = (await (await request.get('/api/config')).json()) as { signupPolicy?: string };
  test.skip(config.signupPolicy !== 'allowlist', 'needs AUTH_SIGNUP_POLICY=allowlist with AUTH_SIGNUP_ALLOWED_DOMAINS=example.com');

  const tag = newTag();
  for (const [n, c] of CASES.entries()) {
    if (c.gate !== 'refuse') continue;
    const body = c.body(address(`${tag}-${n}`, 1), address(`${tag}-${n}`, 2));
    expect(await send(c.path, body, 'application/json'), c.name).toMatchObject({ status: 403, errorCode: 'signup_not_allowed' });
    expect(accountsLike(`${tag}-${n}-`), c.name).toEqual([]);
  }
  const form = 'grant_type=id_token&provider=google&id_token=x';
  expect(await send('/token?grant_type=password', form, 'application/x-www-form-urlencoded')).toMatchObject({ status: 403, errorCode: 'signup_method_not_allowed' });
  // The sign-up probe of pilot-check: refused by the proxy, nothing created.
  const probe = `pilot-check-${tag}@pilot-check.invalid`;
  expect(await send('/signup', q({ email: probe }), 'application/json')).toMatchObject({ status: 403, errorCode: 'signup_not_allowed' });
  expect(accountsLike(probe)).toEqual([]);
});
