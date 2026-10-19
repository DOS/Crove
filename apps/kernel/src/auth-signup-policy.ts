// Who may create an account through the bundled Supabase Auth (issue #350), enforced by the kernel's /auth/v1 proxy
// before a request reaches Supabase Auth.
//
// AUTH_SIGNUP_POLICY:
//   open         the proxy checks nothing; Supabase Auth's own switch decides (AUTH_DISABLE_SIGNUP, i.e.
//                GOTRUE_DISABLE_SIGNUP, still closes sign-up for everyone). The default, as before this setting.
//   invite_only  a sign-up goes through only for an email that holds a valid member invite: pending, unexpired, in
//                an active org, from an inviter who may still grant the role (crove_kernel.signup_invite_valid).
//   allowlist    a sign-up goes through for an email whose domain is in AUTH_SIGNUP_ALLOWED_DOMAINS (exact domain,
//                no subdomains), or that holds a valid invite (an outside accountant can still be invited).
//
// Under invite_only and allowlist the proxy lets an account be created only where it can read the email:
//   - POST /signup with an email and no phone. A phone or anonymous sign-up has no email to check: refused.
//   - POST /otp, unless every create_user key is false (a code or magic link for an existing account only). A
//     client that signs existing users in by email code sends create_user: false (supabase-js shouldCreateUser).
//   - /authorize and /callback (OAuth providers) and /token grants other than password, refresh_token and pkce
//     (id_token, web3) can create an account from an identity the proxy never sees: refused while the policy is set.
// Every refused sign-up is the same 403 (`signupRefused`), whatever the reason (no invite, a revoked or expired one, a
// domain not allowed, a malformed or ambiguous body), and none calls Supabase Auth, so all refusals are one timing
// class. A refused sign-in method (the OAuth paths and grants above) gets its own code (`methodRefused`): it depends on
// the path alone, never on the email, so it tells nothing about invites.
//
// Supabase Auth decodes the body with Go's encoding/json: keys match field names case-insensitively under Unicode
// simple folding (so "create_uſer", with U+017F, sets create_user), the last match wins, and it lower-cases the email.
// The proxy matches keys the same way and fails closed on anything it cannot read with certainty: several email keys
// must all carry the same address, and the address must be plain ASCII (no Unicode look-alikes, which Go and
// JavaScript lower-case differently).
import type pg from 'pg';

export const SIGNUP_POLICIES = ['open', 'invite_only', 'allowlist'] as const;
export type SignupPolicy = (typeof SIGNUP_POLICIES)[number];

export interface SignupRules {
  policy: SignupPolicy;
  // Lower-case ASCII domains; used by allowlist only.
  domains: ReadonlySet<string>;
}

// pass: not a request that can create an account, or the policy is open. check: forward only if this email may sign
// up (signupAllowed). refuse: answer signupRefused() (a sign-up body it cannot read). method: answer methodRefused()
// (a sign-in method that is off while the policy is restricted, whatever the email).
export type SignupGate = { kind: 'pass' } | { kind: 'check'; email: string } | { kind: 'refuse' } | { kind: 'method' };

export interface SignupRequest {
  path: string;
  search: URLSearchParams;
  contentType: string | null;
  body: Uint8Array | null;
}

// Sign-in grants that never create an account.
const SAFE_GRANTS = new Set(['password', 'refresh_token', 'pkce']);

export function signupGate(rules: SignupRules, request: SignupRequest): SignupGate {
  if (rules.policy === 'open') return { kind: 'pass' };
  const { path } = request;
  if (path === '/authorize' || path === '/callback') return { kind: 'method' };
  if (path === '/token') {
    // Supabase Auth reads grant_type with Go's FormValue: a form-encoded body wins over the query string. Only a JSON
    // (or empty) body leaves the query as the one source.
    const grants = request.search.getAll('grant_type');
    const safe = grants.length === 1 && SAFE_GRANTS.has(grants[0]!) && jsonOrNone(request.contentType);
    return safe ? { kind: 'pass' } : { kind: 'method' };
  }
  if (path !== '/signup' && path !== '/otp') return { kind: 'pass' };
  const fields = jsonObject(request.body);
  if (!fields) return { kind: 'refuse' };
  if (path === '/otp') {
    const createUser = goFieldValues(fields, 'create_user');
    if (createUser.length > 0 && createUser.every((v) => v === false)) return { kind: 'pass' };
  }
  // A phone number (any non-empty value) means a phone sign-up, or a body Supabase Auth refuses: no email to check.
  if (goFieldValues(fields, 'phone').some((v) => v !== null && v !== '')) return { kind: 'refuse' };
  const emails = goFieldValues(fields, 'email');
  if (emails.length === 0) return { kind: 'refuse' };
  const normalized = new Set(emails.map(signupEmail));
  const [only] = normalized;
  return normalized.size === 1 && typeof only === 'string' ? { kind: 'check', email: only } : { kind: 'refuse' };
}

export async function signupAllowed(rules: SignupRules, email: string, inviteValid: (email: string) => Promise<boolean>): Promise<boolean> {
  if (rules.policy === 'open') return true;
  if (rules.policy === 'allowlist' && rules.domains.has(email.slice(email.lastIndexOf('@') + 1))) return true;
  return inviteValid(email);
}

// The address a restricted sign-up is checked under, lower case, or null when it is not one plain ASCII address
// Supabase Auth would store unchanged apart from case. Trimming is safe: an address Supabase Auth does not trim fails
// its own format check.
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;
export function signupEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 254 || /[^\x21-\x7e]/.test(trimmed)) return null;
  const email = asciiLower(trimmed);
  return EMAIL.test(email) ? email : null;
}

// A domain for AUTH_SIGNUP_ALLOWED_DOMAINS: lower-case ASCII labels with at least one dot, or null.
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export function parseAllowedDomains(raw: string): { domains: string[]; invalid: string[] } {
  const entries = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const domain = /[^\x21-\x7e]/.test(entry) ? null : asciiLower(entry);
    if (domain && domain.length <= 253 && DOMAIN.test(domain)) domains.push(domain);
    else invalid.push(entry);
  }
  return { domains: [...new Set(domains)], invalid };
}

// One response for every refused sign-up, in Supabase Auth's error shape so auth-js reads `error.code`.
export function signupRefused(): Response {
  const error = { code: 403, error_code: 'signup_not_allowed', msg: 'Email này chưa được phép đăng ký tài khoản' };
  return new Response(JSON.stringify(error), { status: 403, headers: { 'content-type': 'application/json' } });
}

// A sign-in method that is off while sign-up is restricted, in the same shape.
export function methodRefused(): Response {
  const error = { code: 403, error_code: 'signup_method_not_allowed', msg: 'Cách đăng nhập này đang tắt trên máy chủ' };
  return new Response(JSON.stringify(error), { status: 403, headers: { 'content-type': 'application/json' } });
}

// Throws when the database cannot answer; the proxy then answers 503 and forwards nothing.
export function createDbInviteCheck(pool: pg.Pool): (email: string) => Promise<boolean> {
  return async (email) => {
    const { rows } = await pool.query<{ ok: boolean }>('SELECT crove_kernel.signup_invite_valid($1) AS ok', [email]);
    return rows[0]?.ok === true;
  };
}

// Values of every key Go's encoding/json would decode into the field `name` (lower-case ASCII), in document order.
export function goFieldValues(fields: Record<string, unknown>, name: string): unknown[] {
  return Object.entries(fields)
    .filter(([key]) => goFoldKey(key) === name)
    .map(([, value]) => value);
}

// A key as Go's encoding/json compares it with an ASCII field name: ASCII letters fold by case, and the only other
// characters whose simple case folding reaches an ASCII letter are U+017F (long s, folds with s) and U+212A (Kelvin
// sign, folds with k). Any other non-ASCII character never matches an ASCII name, and is kept as it is.
export function goFoldKey(key: string): string {
  return asciiLower(key.replace(/ſ/g, 's').replace(/K/g, 'k'));
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function jsonOrNone(contentType: string | null): boolean {
  if (contentType === null || contentType.trim() === '') return true;
  return asciiLower(contentType.split(';')[0]!.trim()) === 'application/json';
}

function jsonObject(body: Uint8Array | null): Record<string, unknown> | null {
  if (!body || body.byteLength === 0) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
