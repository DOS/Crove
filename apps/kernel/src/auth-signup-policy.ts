// Who may create an account through the bundled Supabase Auth (issue #350), enforced by the kernel's /auth/v1 proxy
// before a request reaches Supabase Auth.
//
// AUTH_SIGNUP_POLICY:
//   open         the proxy checks nothing; Supabase Auth's own switch decides (AUTH_DISABLE_SIGNUP, i.e.
//                GOTRUE_DISABLE_SIGNUP, still closes sign-up for everyone). The default, as before this setting.
//   invite_only  a sign-up goes through only when it carries the token of a valid member invite for exactly its
//                email (INVITE_TOKEN_HEADER): pending, unexpired, in an active org, from an inviter who may still
//                grant the role (crove_kernel.signup_invite_token_valid).
//   allowlist    a sign-up goes through for an email whose domain is in AUTH_SIGNUP_ALLOWED_DOMAINS (exact domain,
//                no subdomains) and that holds no valid invite, or with the token of a valid invite for it (an
//                outside accountant can still be invited).
//
// Why the token and not just the invited address (issue #563): Supabase Auth keeps the password of the first
// unconfirmed sign-up for an address and only mails the confirmation again on a later one (v2.197 signup.go, "do not
// update the user"). Admitting any sign-up for an invited address let whoever knew it sign up first with their own
// password; the invitee then confirmed that account from the email and joined the org on it, and the attacker signed
// in. The token is in the accept link mailed to the invited address (and shown once to the inviter), so a sign-up
// for an invited address now needs someone who opened that link. The web app sends the token it holds from the link;
// the proxy never forwards the header to Supabase Auth.
//
// Under invite_only and allowlist the proxy lets an account be created only where it can read the email:
//   - POST /signup with an email and no phone. A phone or anonymous sign-up has no email to check: refused.
//   - POST /otp, unless every create_user key is false (a code or magic link for an existing account only). A
//     client that signs existing users in by email code sends create_user: false (supabase-js shouldCreateUser).
//   - /authorize and /callback (OAuth providers) and /token grants other than password, refresh_token and pkce
//     (id_token, web3) can create an account from an identity the proxy never sees: refused while the policy is set.
// Every refused sign-up is the same 403 (`signupRefused`), whatever the reason (no invite, no token or a token for another
// address, a revoked or expired invite, a domain not allowed, a malformed or ambiguous body), and none calls Supabase Auth, so all refusals are one timing
// class. A refused sign-in method (the OAuth paths and grants above) gets its own code (`methodRefused`): it depends on
// the path alone, never on the email, so it tells nothing about invites.
//
// Supabase Auth decodes the body with Go's encoding/json: keys match field names case-insensitively under Unicode
// simple folding (so "create_uſer", with U+017F, sets create_user), the last match wins, and it lower-cases the email.
// The proxy matches keys the same way and fails closed on anything it cannot read with certainty: a body that repeats a
// key (after that folding) is refused, since JavaScript keeps the last copy while Go may keep an earlier one, and the
// address must be plain ASCII (no Unicode look-alikes, which Go and JavaScript lower-case differently).
//
// Refusals that tell who holds an invite (#564 item 1). Under allowlist, a sign-up at an allowed domain without the
// invite's token is refused exactly when the address holds a valid invite, so each such refusal answers "is this
// address invited?". A refused sign-up keeps its email slot (per IPv4 address or IPv6 /64, and only for a request that
// sends an email), but one IPv6 /48 holds 65,536 /64s, and with AUTH_AUTOCONFIRM a sign-up takes no email slot at all.
// So each of these checks first takes a slot of its own (`limitInviteChecks`): at most
// AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR per IPv4 address or IPv6 /48, and, when set, at most
// AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR for the whole deployment, where an address refused again within the hour
// counts once. The deployment cap is off by default: a member who may invite can create invited addresses at the
// allowed domain and, from a few clients, fill it every hour, which would stop plain sign-ups for the whole domain.
// An admitted sign-up gives its slots back, so only refusals count. At a limit the proxy answers 429 before it asks
// whether the address is invited, so that answer depends on the client alone; at the deployment's limit Retry-After is
// always an hour, so it does not tell when the oldest refusal in the deployment happened. Refusals that do not depend on an invite (another domain, invite_only,
// a body it cannot read) tell nothing and take no slot, so the pilot-check probe (an `.invalid` address) keeps its 403.
// GoTrue's obfuscated 200 was not used instead: GoTrue answers a closed sign-up with 422 signup_disabled, not a fake
// success; a fake user cannot stand in for an autoconfirmed sign-up, whose real answer carries a session; and a person
// refused that way would wait for a confirmation email that never comes.
//
// Email changes (#564 item 4). The allowlist would gate only creation if a signed-in user could then move the account
// to any address. Under allowlist, a request to /user other than GET or HEAD that names an email is refused unless
// its email is one plain address at an allowed domain, read the way the sign-up gate reads it (`emailChangeGate`). A
// change asked for before the policy was set can still be confirmed from its link (/verify). invite_only and open leave email changes to Supabase Auth, which mails the new address a
// confirmation link before it changes anything.
import type pg from 'pg';
import { hashKey } from './auth-email-limit.ts';

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

// The request header the web app puts the invite token in when it signs up from an accept link. Read by the proxy
// and never forwarded.
export const INVITE_TOKEN_HEADER = 'x-crove-invite';

// The token of a sign-up request, or null when the header is missing or is not one well-formed token.
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function signupInviteToken(value: string | null | undefined): string | null {
  return typeof value === 'string' && INVITE_TOKEN.test(value) ? value : null;
}

// What the proxy asks the database (createDbInviteChecks): whether an email holds a valid invite at all, and whether
// a token names a valid invite for exactly that email.
export interface InviteChecks {
  held: (email: string) => Promise<boolean>;
  matches: (email: string, token: string) => Promise<boolean>;
}

// open: everything. Otherwise the token of a valid invite for the email admits it under either policy; without one,
// allowlist admits an allowed domain only while the address holds no valid invite (an invited address needs its
// link, wherever its domain is), and invite_only admits nothing.
export async function signupAllowed(rules: SignupRules, email: string, token: string | null, checks: InviteChecks): Promise<boolean> {
  if (rules.policy === 'open') return true;
  if (token !== null && (await checks.matches(email, token))) return true;
  if (rules.policy === 'allowlist' && rules.domains.has(email.slice(email.lastIndexOf('@') + 1))) return !(await checks.held(email));
  return false;
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

// A change of the account's email through /user under allowlist (#564 item 4). pass: the policy is not allowlist, or
// the request does not change the email (another path, GET or HEAD, an empty body, no email key or only empty ones,
// which Supabase Auth reads as "no change"). refuse: answer emailChangeRefused(). Supabase Auth decodes the body as
// JSON whatever its Content-Type and matches the email key as in signupGate. A body the proxy cannot read as one JSON
// object, or one that repeats a key (jsonObject), might still name an email, so it is refused (Supabase Auth refuses
// the former too). The one email value must be "" or one plain address at an allowed domain; null is refused.
export function emailChangeGate(rules: SignupRules, request: { method: string; path: string; body: Uint8Array | null }): 'pass' | 'refuse' {
  if (rules.policy !== 'allowlist' || request.path !== '/user') return 'pass';
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || !request.body || request.body.byteLength === 0) return 'pass';
  const fields = jsonObject(request.body);
  if (!fields) return 'refuse';
  for (const value of goFieldValues(fields, 'email')) {
    // "" is "no change" to Supabase Auth. A null is too, alone, but it is refused like any value that is not one
    // address: the proxy does not rely on Go's handling of it.
    if (value === '') continue;
    const email = signupEmail(value);
    if (email === null || !rules.domains.has(email.slice(email.lastIndexOf('@') + 1))) return 'refuse';
  }
  return 'pass';
}

// One response for every refused email change, in Supabase Auth's error shape.
export function emailChangeRefused(): Response {
  const error = { code: 403, error_code: 'email_change_not_allowed', msg: 'Không thể đổi sang email ở tên miền này' };
  return new Response(JSON.stringify(error), { status: 403, headers: { 'content-type': 'application/json' } });
}

// Slots for the invite lookups of restricted sign-ups (#564 item 1, see the header). `release` never throws: a slot
// left unreleased only brings the client closer to its limit.
export type RefusalSlot = { allowed: true; release: () => Promise<void> } | { allowed: false; retryAfterSeconds: number };
export interface RefusalLimiter {
  reserve(request: { client: string; email: string }): Promise<RefusalSlot>;
}
export interface RefusalLimits {
  // Per IPv4 address or IPv6 /48 (clientBucket(ip, 48)), in any rolling hour.
  perClientPerHour: number;
  // For the whole deployment, in any rolling hour; 0 (the default) turns it off.
  globalPerHour: number;
}

// Thrown by the checks limitInviteChecks returns when the client or the deployment is at its limit.
export class SignupRefusalsLimited extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('sign-up refusal limit reached');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// The invite checks for one request from `client`. held(), whose answer says whether an address is invited, first
// takes a refusal slot and gives it back when the address holds no invite (the sign-up is then admitted). matches()
// needs the invite's token and tells nothing to whoever lacks it, so it is not counted.
export function limitInviteChecks(checks: InviteChecks, limiter: RefusalLimiter, client: string): InviteChecks {
  return {
    matches: checks.matches,
    held: async (email) => {
      const slot = await limiter.reserve({ client, email });
      if (!slot.allowed) throw new SignupRefusalsLimited(slot.retryAfterSeconds);
      let held: boolean;
      try {
        held = await checks.held(email);
      } catch (error) {
        await slot.release();
        throw error;
      }
      if (!held) await slot.release();
      return held;
    },
  };
}

// 429 for a restricted sign-up from a client (or a deployment) at its refusal limit, in Supabase Auth's error shape
// and with Supabase Auth's code for a request rate limit.
export function signupRefusalsLimited(retryAfterSeconds: number): Response {
  const error = { code: 429, error_code: 'over_request_rate_limit', msg: 'Quá nhiều lượt đăng ký bị từ chối; vui lòng thử lại sau' };
  return new Response(JSON.stringify(error), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}

// Refusal slots on the email budget's sliding-window counter (crove_kernel.auth_email_reserve, #190): the same table,
// advisory locks and hourly sweep, under keys of their own (the SHA-256 of "signup_refusal:" plus the client bucket,
// or plus "all" for the deployment), so they never mix with email slots. The deployment's slot carries the SHA-256 of
// "signup_refusal:" plus the address as its target, with an interval of an hour: an address refused within the last
// hour takes no second deployment slot (the counter answers rule auth_email_per_address), so repeating one known
// invited address cannot use up everyone's budget. Throws when the database cannot answer.
const REFUSAL_KEY = 'signup_refusal:';
type ReserveRow = { reserved_id: string | null; rule: string | null; retry_after_seconds: number | null };
export function createDbRefusalLimiter(pool: pg.Pool, limits: RefusalLimits): RefusalLimiter {
  const reserve = async (client: string, target: string | null, limit: number, intervalSeconds: number): Promise<ReserveRow> => {
    const { rows } = await pool.query<ReserveRow>(
      'SELECT reserved_id::text, rule, retry_after_seconds FROM crove_kernel.auth_email_reserve($1, $2, $3, $4)',
      [client, target, limit, intervalSeconds],
    );
    return rows[0] ?? { reserved_id: null, rule: null, retry_after_seconds: null };
  };
  const release = async (id: string, client: string): Promise<void> => {
    await pool.query('SELECT crove_kernel.auth_email_release($1, $2)', [id, client]).then(
      () => undefined,
      (error: unknown) => {
        console.error('[auth-proxy] sign-up refusal slot not released:', error instanceof Error ? error.message : error);
      },
    );
  };
  const all = hashKey(`${REFUSAL_KEY}all`);
  return {
    async reserve({ client, email }) {
      const own = hashKey(`${REFUSAL_KEY}${client}`);
      const mine = await reserve(own, null, limits.perClientPerHour, 0);
      const ownId = mine.reserved_id;
      if (!ownId) return { allowed: false, retryAfterSeconds: Math.max(1, mine.retry_after_seconds ?? 1) };
      let allId: string | null = null;
      if (limits.globalPerHour > 0) {
        let global: ReserveRow;
        try {
          global = await reserve(all, hashKey(`${REFUSAL_KEY}${email}`), limits.globalPerHour, 3600);
        } catch (error) {
          await release(ownId, own);
          throw error;
        }
        if (global.reserved_id) allId = global.reserved_id;
        else if (global.rule !== 'auth_email_per_address') {
          await release(ownId, own);
          // A full hour rather than the counter's exact wait, which would date the deployment's oldest refusal. A
          // lock wait (rule auth_email_busy) is retried after a second.
          return { allowed: false, retryAfterSeconds: global.rule === 'auth_email_busy' ? 1 : 3600 };
        }
      }
      return {
        allowed: true,
        release: async () => {
          await release(ownId, own);
          if (allId) await release(allId, all);
        },
      };
    },
  };
}

// Throw when the database cannot answer; the proxy then answers 503 and forwards nothing.
export function createDbInviteChecks(pool: pg.Pool): InviteChecks {
  return {
    held: async (email) => {
      const { rows } = await pool.query<{ ok: boolean }>('SELECT crove_kernel.signup_invite_valid($1) AS ok', [email]);
      return rows[0]?.ok === true;
    },
    matches: async (email, token) => {
      const { rows } = await pool.query<{ ok: boolean }>('SELECT crove_kernel.signup_invite_token_valid($1, $2) AS ok', [email, token]);
      return rows[0]?.ok === true;
    },
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

// The body as one JSON object, or null when it is not one or when two of its top-level keys are the same field to Go
// (equal after goFoldKey, or simply repeated). JavaScript and Go disagree on such a body: JSON.parse keeps the last
// repeated key, while Go assigns each match in turn and a null leaves a string field as it was, so
// {"email":"a@evil.test","email":null} reads as null here and as a@evil.test to Supabase Auth (#564). No client the
// proxy serves sends repeated keys, so a gate refuses the body instead of guessing which value Go keeps.
function jsonObject(body: Uint8Array | null): Record<string, unknown> | null {
  if (!body || body.byteLength === 0) return null;
  const text = new TextDecoder().decode(body);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const key of topLevelKeys(text)) {
    const folded = goFoldKey(key);
    if (seen.has(folded)) return null;
    seen.add(folded);
  }
  return value as Record<string, unknown>;
}

// The keys of a JSON object's top level, repeats included, in document order. Only for text JSON.parse accepted as an
// object: strings are skipped whole (escapes included), so a brace, bracket or comma inside one never counts, and a
// key is the first string after the opening brace or a comma at depth 1.
export function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (depth === 1 && expectKey) {
        keys.push(JSON.parse(text.slice(i, end + 1)) as string);
        expectKey = false;
      }
      i = end;
    } else if (ch === '{' || ch === '[') {
      depth++;
      if (depth === 1) expectKey = ch === '{';
    } else if (ch === '}' || ch === ']') {
      depth--;
    } else if (ch === ',' && depth === 1) {
      expectKey = true;
    }
  }
  return keys;
}
