// Per-client budget for the emails Supabase Auth sends (issue #190), enforced by the /auth/v1 proxy.
//
// Supabase Auth counts sent emails in one deployment-wide bucket (GOTRUE_RATE_LIMIT_EMAIL_SENT, per hour, applied
// only while confirmations are on). Its own per-address limits (GOTRUE_RATE_LIMIT_OTP: a burst of 30) are larger
// than that bucket, so one client could use it all and leave everyone else without confirmation and recovery
// emails for an hour. The proxy therefore reserves a slot in the database before it forwards a request that makes
// Supabase Auth send an email:
//   - per client address: at most AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR in any rolling hour (IPv6 counts per /64,
//     since one host usually holds a whole /64), and
//   - per recipient: at most one every AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS.
// The count lives in PostgreSQL (crove_kernel.auth_email_reserve), so it holds across API instances and restarts.
// Keys are SHA-256 hashes; neither the address nor the email is stored. A request Supabase Auth answers with 4xx or
// 5xx sent no email, so its slot is released; one it did not answer in time keeps it (it may still have sent).
import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type pg from 'pg';

export type EmailRule = 'auth_email_per_client' | 'auth_email_per_address' | 'auth_email_busy';

export type EmailVerdict = { allowed: true; reservation: string } | { allowed: false; rule: EmailRule; retryAfterSeconds: number };

export interface EmailLimiter {
  reserve(request: { client: string; target: string | null }): Promise<EmailVerdict>;
  release(reservation: string, client: string): Promise<void>;
}

export interface EmailLimits {
  perClientPerHour: number;
  addressIntervalSeconds: number;
}

// The paths (after /auth/v1) whose success makes Supabase Auth send an email or a code. `null`: not one of them.
// Sign-up sends one only while confirmations are on. The recipient is the email (or phone) in the JSON body, or
// for PUT /user the new email; GET /reauthenticate mails the signed-in user, whom the proxy does not resolve.
//
// Supabase Auth decodes the body with Go's encoding/json whatever the Content-Type, and Go matches keys without
// regard to case ({"EMAIL": ...} sets the email) with the last match winning. So keys are matched the same way here,
// and whatever this parser cannot read with certainty fails closed: an unparseable body still counts per client
// (Supabase Auth refuses it, which gives the slot back), and conflicting recipients count with no recipient.
export function emailSendRequest(method: string, path: string, body: Uint8Array | null, autoconfirm: boolean): { target: string | null } | null {
  const verb = method.toUpperCase();
  const sends =
    (verb === 'POST' && (path === '/recover' || path === '/otp' || path === '/resend')) ||
    (verb === 'POST' && path === '/signup' && !autoconfirm) ||
    (verb === 'PUT' && path === '/user') ||
    path === '/reauthenticate';
  if (!sends) return null;
  if (path === '/reauthenticate') return { target: null };
  const fields = jsonFields(body);
  if (!fields) return { target: null };
  const emails = fieldValues(fields, 'email');
  const phones = fieldValues(fields, 'phone');
  // A user update without an email key (password, metadata) and a sign-up with neither email nor phone (anonymous
  // sign-in) send nothing.
  if (path === '/user' && emails.length === 0) return null;
  if (path === '/signup' && emails.length === 0 && phones.length === 0) return null;
  return { target: bodyAccount(fields) };
}

// The account a JSON body names, read as Supabase Auth reads it: `email:<address>` when it has an email, otherwise
// `phone:<digits>`. null when it names neither, or not as one clear string.
export function bodyAccount(fields: Record<string, unknown>): string | null {
  const email = recipient(fieldValues(fields, 'email'), (v) => v.trim().toLowerCase());
  if (email !== undefined) return email ? `email:${email}` : null;
  const phone = recipient(fieldValues(fields, 'phone'), (v) => v.replace(/[^\d]/g, ''));
  if (phone !== undefined) return phone ? `phone:${phone}` : null;
  return null;
}

// Values of every key equal to `name` ignoring case, as Go's decoder matches struct fields.
export function fieldValues(fields: Record<string, unknown>, name: string): unknown[] {
  return Object.entries(fields)
    .filter(([key]) => key.toLowerCase() === name)
    .map(([, value]) => value);
}

// undefined: no such key, or only empty values. '': the key is there but not one clear string, so no recipient.
function recipient(values: unknown[], normalize: (value: string) => string): string | undefined {
  const present = values.filter((v) => v !== null && v !== '');
  if (present.length === 0) return undefined;
  const normalized = new Set(present.map((v) => (typeof v === 'string' ? normalize(v) : '')));
  const [only] = normalized;
  return normalized.size === 1 && only ? only : '';
}

export function jsonFields(body: Uint8Array | null): Record<string, unknown> | null {
  if (!body || body.byteLength === 0) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The bucket a client address falls in: an IPv4 address as is, an IPv6 address by its /64 (IPv4-mapped IPv6 as the
// IPv4 address). Anything else (no socket address) shares one bucket, so it fails closed rather than open.
export function clientBucket(ip: string | null): string {
  if (!ip) return 'unknown';
  const address = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (isIPv4(address)) return `v4:${address}`;
  if (!isIPv6(address)) return 'unknown';
  const groups = expandIPv6(address);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `v4:${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `v6:${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

// Eight 16-bit groups of a valid IPv6 address (validated by isIPv6), including a dotted IPv4 tail.
function expandIPv6(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

export const hashKey = (value: string): string => createHash('sha256').update(value).digest('hex');

// Not configured to throw: the proxy answers 503 when the limiter cannot decide, so a broken database never opens
// the email budget.
export function createDbEmailLimiter(pool: pg.Pool, limits: EmailLimits): EmailLimiter {
  return {
    async reserve({ client, target }) {
      const { rows } = await pool.query<{ reserved_id: string | null; rule: EmailRule | null; retry_after_seconds: number | null }>(
        'SELECT reserved_id::text, rule, retry_after_seconds FROM crove_kernel.auth_email_reserve($1, $2, $3, $4)',
        [hashKey(client), target === null ? null : hashKey(target), limits.perClientPerHour, limits.addressIntervalSeconds],
      );
      const row = rows[0];
      if (row?.reserved_id) return { allowed: true, reservation: row.reserved_id };
      return { allowed: false, rule: row?.rule ?? 'auth_email_busy', retryAfterSeconds: Math.max(1, row?.retry_after_seconds ?? 1) };
    },
    async release(reservation, client) {
      await pool.query('SELECT crove_kernel.auth_email_release($1, $2)', [reservation, hashKey(client)]);
    },
  };
}
