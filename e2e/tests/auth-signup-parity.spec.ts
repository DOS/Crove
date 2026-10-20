// The /auth/v1 proxy's reading of a sign-up request, checked against the pinned Supabase Auth itself (#564, from the
// review of #559). Under a restricted sign-up policy (#350) the proxy decides from the JSON body which email a request
// would create an account for, whether an email code may create one (create_user) and which grant a /token request
// runs, all by modelling Supabase Auth's Go decoding: keys match field names case-insensitively under Unicode simple
// folding ("create_uſer", U+017F, is create_user), the last match wins, the email is lower-cased, and a form body
// decides grant_type over the query string. apps/kernel/test/signup-policy-proxy.db.test.ts tests the proxy against a
// fake upstream that follows that model; this spec sends the same request shapes to the real image and checks that it
// still behaves as modelled, so a Supabase Auth or Go toolchain bump that changes the matching fails CI. The same
// goes for PUT /user, whose email the proxy checks against the allowlist (emailChangeGate, #564 item 4).
//
// The first test sends each request through the proxy on the default e2e stack, whose policy is open, so it reaches
// Supabase Auth unchanged, and computes the proxy's verdict for it with signupGate() under allowlist. It runs in CI
// and is skipped on a restricted stack. The second needs a stack started with AUTH_SIGNUP_POLICY=allowlist and
// AUTH_SIGNUP_ALLOWED_DOMAINS=example.com (as invite-preclaim.spec.ts) and is skipped otherwise. The invite token
// header (x-crove-invite) never reaching Supabase Auth cannot be seen from outside, since Supabase Auth ignores
// unknown headers: the proxy's db tests check it at the fake upstream (signup-policy-proxy.db.test.ts and
// test/invariant/invite-preclaim.db.test.ts).
import { expect, test } from '@playwright/test';
import { emailChangeGate, signupGate, type SignupGate, type SignupRules } from '../../apps/kernel/src/auth-signup-policy.ts';
import { exec, sql } from '../lib/db.ts';
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

// An account that can call PUT /user: signed up through the proxy, confirmed in the database, signed in.
async function signedIn(email: string): Promise<{ id: string; token: string }> {
  const signedUp = await send('/signup', JSON.stringify({ email, password: PASSWORD }), 'application/json');
  expect(signedUp.status, `sign-up of ${email}: ${signedUp.errorCode}`).toBe(200);
  exec(`UPDATE auth.users SET email_confirmed_at = now() WHERE email = :'email'`, { email });
  const response = await fetch(`${BASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status, `sign-in of ${email}`).toBe(200);
  const session = (await response.json()) as { access_token: string; user: { id: string } };
  return { id: session.user.id, token: session.access_token };
}

// PUT /user as `token`, with the raw body.
async function updateUser(token: string, body: string, contentType = 'application/json'): Promise<Answer> {
  const response = await fetch(`${BASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body: new TextEncoder().encode(body),
  });
  const answer = (await response.json().catch(() => null)) as { error_code?: unknown; msg?: unknown } | null;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return { status: response.status, errorCode: text(answer?.error_code), msg: text(answer?.msg) };
}

// The address an account asked to move to and has not confirmed yet ('' for none), and a reset of that request, so
// the next case starts clean and Supabase Auth's once-a-minute limit on email change mails does not apply.
function pendingEmail(id: string): string {
  return sql<{ email_change: string | null }>(`SELECT email_change FROM auth.users WHERE id = :'id'`, { id })[0]?.email_change ?? '';
}
function clearEmailChange(id: string): void {
  exec(
    `UPDATE auth.users SET email_change = '', email_change_sent_at = NULL, email_change_token_new = '', email_change_token_current = '', email_change_confirm_status = 0 WHERE id = :'id'`,
    { id },
  );
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
  { name: 'two email keys, one address', path: '/signup', body: (a) => `{"email":${q(a)},"EMAIL":${q(a.toUpperCase())},"password":${q(PASSWORD)}}`, gate: 'refuse', creates: 'a' },
  { name: 'phone then null phone, kept by Go', path: '/signup', body: (a) => `{"email":${q(a)},"phone":"+15005550006","phone":null,"password":${q(PASSWORD)}}`, gate: 'refuse', creates: 'none' },
  { name: 'email and phone', path: '/signup', body: (a) => `{"email":${q(a)},"Phone":"+15005550006","password":${q(PASSWORD)}}`, gate: 'refuse', creates: 'none' },
  { name: 'email code, create_user unset', path: '/otp', body: (a) => `{"email":${q(a)}}`, gate: 'a', creates: 'a' },
  { name: 'email code, create_user false', path: '/otp', body: (a) => `{"email":${q(a)},"create_user":false}`, gate: 'pass', creates: 'none' },
  { name: 'email code, create_uſer (U+017F) false', path: '/otp', body: (a) => `{"email":${q(a)},"create_uſer":false}`, gate: 'pass', creates: 'none' },
  { name: 'email code, CREATE_USER false', path: '/otp', body: (a) => `{"email":${q(a)},"CREATE_USER":false}`, gate: 'pass', creates: 'none' },
  { name: 'email code, false then create_uſer true', path: '/otp', body: (a) => `{"email":${q(a)},"create_user":false,"create_uſer":true}`, gate: 'refuse', creates: 'a' },
  { name: 'email code, true then Create_User false', path: '/otp', body: (a) => `{"email":${q(a)},"create_user":true,"Create_User":false}`, gate: 'refuse', creates: 'none' },
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

// #564 item 4: under allowlist the proxy refuses an email change outside the allowed domains, reading PUT /user the
// way it reads a sign-up. Each body goes to Supabase Auth unchanged on the open stack; the address it would move the
// account to (its pending email_change) must be one the gate let through.
interface ChangeCase {
  name: string;
  body: (inside: string, outside: string) => string;
  contentType?: string;
  gate: 'pass' | 'refuse';
  // The pending address Supabase Auth records: none, the allowed one or the outside one.
  moves: 'none' | 'inside' | 'outside';
  // Supabase Auth refuses the body (4xx) instead of answering 200.
  refused?: true;
}
const CHANGES: ChangeCase[] = [
  { name: 'upper-case email key', body: (_, o) => `{"EMAIL":${q(o)}}`, gate: 'refuse', moves: 'outside' },
  { name: 'two email keys, last one wins', body: (i, o) => `{"email":${q(i)},"Email":${q(o)}}`, gate: 'refuse', moves: 'outside' },
  { name: 'two email keys, the allowed one last', body: (i, o) => `{"Email":${q(o)},"email":${q(i)}}`, gate: 'refuse', moves: 'inside' },
  // JSON.parse keeps the last copy (null); Go assigns each in turn, and a null leaves the address it already set.
  { name: 'an address, then the same key null', body: (_, o) => `{"email":${q(o)},"email":null}`, gate: 'refuse', moves: 'outside' },
  { name: 'an address, then a folded key null', body: (_, o) => `{"EMAIL":${q(o)},"Email":null}`, gate: 'refuse', moves: 'outside' },
  { name: 'a text/plain body is still JSON', body: (_, o) => `{"email":${q(o)}}`, contentType: 'text/plain', gate: 'refuse', moves: 'outside' },
  { name: 'mixed-case key and address, lower-cased', body: (i) => `{"eMail":${q(i.toUpperCase())}}`, gate: 'pass', moves: 'inside' },
  // Supabase Auth does not trim an email change (v2.197 refuses it); the gate's trimming lets nothing else through.
  { name: 'spaces around the address', body: (i) => `{"email":${q(` ${i} `)}}`, gate: 'pass', moves: 'none', refused: true },
  { name: 'an empty email changes nothing', body: () => `{"email":"","data":{"e2e":"parity"}}`, gate: 'pass', moves: 'none' },
  { name: 'dotless i is not the email key', body: (_, o) => `{"emaıl":${q(o)}}`, gate: 'pass', moves: 'none' },
  { name: 'an email in the metadata is not the account email', body: (_, o) => `{"data":{"email":${q(o)}}}`, gate: 'pass', moves: 'none' },
];

test('Supabase Auth reads an email change as the proxy models it', async ({ request }) => {
  const config = (await (await request.get('/api/config')).json()) as { signupPolicy?: string };
  test.skip(config.signupPolicy !== 'open', 'needs the default open sign-up policy, so every request reaches Supabase Auth unchanged');
  const tag = newTag();
  const account = await signedIn(address(`${tag}-user`, 1));
  for (const [n, c] of CHANGES.entries()) {
    const inside = address(`${tag}-chg-${n}`, 1);
    const outside = `e2e-parity-${tag}-chg-${n}@outside.example.net`;
    const body = c.body(inside, outside);
    expect(emailChangeGate(RULES, { method: 'PUT', path: '/user', body: new TextEncoder().encode(body) }), c.name).toBe(c.gate);
    const answer = await updateUser(account.token, body, c.contentType);
    if (c.refused) expect(answer.status >= 400 && answer.status < 500, `${c.name}: ${answer.status}`).toBe(true);
    else expect(answer.status, `${c.name}: ${answer.errorCode} ${answer.msg}`).toBe(200);
    const pending = pendingEmail(account.id);
    expect(pending, c.name).toBe(c.moves === 'none' ? '' : c.moves === 'inside' ? inside : outside);
    // The property the proxy relies on: whatever it lets through moves the account nowhere outside the allowlist.
    if (c.gate === 'pass') expect(pending === '' || pending.endsWith('@example.com'), c.name).toBe(true);
    clearEmailChange(account.id);
  }
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

  // An account at an allowed domain may move within the allowlist only (#564 item 4).
  const account = await signedIn(address(`${tag}-user`, 1));
  for (const c of CHANGES.filter((change) => change.gate === 'refuse')) {
    const body = c.body(address(`${tag}-chg`, 1), `e2e-parity-${tag}-chg@outside.example.net`);
    expect(await updateUser(account.token, body, c.contentType), c.name).toMatchObject({ status: 403, errorCode: 'email_change_not_allowed' });
    expect(pendingEmail(account.id), c.name).toBe('');
  }
  const inside = address(`${tag}-moved`, 1);
  expect(await updateUser(account.token, q({ EMAIL: inside }))).toMatchObject({ status: 200 });
  expect(pendingEmail(account.id)).toBe(inside);
});
