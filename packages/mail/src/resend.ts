// Resend (https://resend.com), the first HTTP provider (issue #539). Picked over Amazon SES and Postmark because:
// - a send takes an Idempotency-Key that Resend honours for 24 hours, so a transactional retry after a timeout is not
//   delivered twice (SES has no such key; Postmark neither);
// - its webhooks are signed (Svix: HMAC-SHA256 over id, timestamp and body), checked here without network calls
//   (SES signs through SNS, whose certificate must be fetched; Postmark offers only basic auth).
// Requests go to api.resend.com only (the FQDN allowlist, until the egress policy of ADR-0016 exists).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type MailEvent, type MailEventKind, type MailProvider, type SendResult, WebhookRejected, type WebhookRequest } from './types.ts';

const API = 'https://api.resend.com/emails';
const HOSTS = new Set(['api.resend.com']);
// Svix refuses deliveries older or newer than five minutes, which bounds replays of a captured request.
const TOLERANCE_MS = 5 * 60_000;
const MAX_ID = 255;

export interface ResendOptions {
  apiKey: string;
  from: string;
  // whsec_<base64>, from the webhook's page in Resend; unset, webhooks are refused.
  webhookSecret?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// The idempotency key of a mail: its Message-ID, unique per mail_message row and kept across attempts.
function idempotencyKey(messageId: string): string {
  return `crove:${messageId.replace(/^<|>$/g, '')}`.slice(0, 256);
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : undefined;
}

async function classifyResponse(response: Response): Promise<SendResult> {
  const code = `RESEND_${response.status}`;
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
    const id = typeof body?.id === 'string' && body.id.length > 0 && body.id.length <= MAX_ID ? body.id : undefined;
    return id ? { status: 'accepted', providerMessageId: id } : { status: 'accepted' };
  }
  if (response.status === 429) {
    const wait = retryAfterMs(response);
    return { status: 'rejected', error: 'rate_limited', code, ...(wait ? { retryAfterMs: wait } : {}) };
  }
  if (response.status === 401 || response.status === 403) return { status: 'rejected', error: 'auth', code };
  // 409: a request with the same idempotency key is still being processed; the retry gets its answer.
  if (response.status === 409) return { status: 'rejected', error: 'transient', code };
  if (response.status >= 500) return { status: 'unknown', code };
  return { status: 'rejected', error: 'bad_request', code };
}

const EVENT_KINDS: Record<string, MailEventKind | 'bounce'> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'deferred',
  'email.complained': 'complaint',
  'email.bounced': 'bounce',
};

function header(request: WebhookRequest, name: string): string {
  const value = request.headers[name];
  if (!value) throw new WebhookRejected('signature');
  return value;
}

/** Checks a Svix signature (the scheme Resend's webhooks use) or throws WebhookRejected. */
export function verifySvix(secret: string, request: WebhookRequest, now: number = Date.now()): string {
  const id = header(request, 'svix-id');
  const timestamp = header(request, 'svix-timestamp');
  const signatures = header(request, 'svix-signature');
  const seconds = Number(timestamp);
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now - seconds * 1000) > TOLERANCE_MS) throw new WebhookRejected('stale');
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${request.body}`).digest();
  // "v1,<base64> v1,<base64>": any one matching signature is enough (Svix sends several while a secret rotates).
  const match = signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!match) throw new WebhookRejected('signature');
  return id;
}

function bounded(value: unknown, max = 64): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

// One webhook delivery is one event. Event types E2 does not record (sent, opened, clicked) return no event.
export function parseResendWebhook(secret: string, request: WebhookRequest, now: number = Date.now()): MailEvent[] {
  const eventId = verifySvix(secret, request, now);
  let payload: { type?: unknown; created_at?: unknown; data?: { email_id?: unknown; created_at?: unknown; bounce?: { type?: unknown; subType?: unknown } } };
  try {
    payload = JSON.parse(request.body) as typeof payload;
  } catch {
    throw new WebhookRejected('malformed');
  }
  const mapped = typeof payload.type === 'string' ? EVENT_KINDS[payload.type] : undefined;
  if (!mapped) return [];
  const messageId = payload.data?.email_id;
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > MAX_ID || eventId.length > MAX_ID) throw new WebhookRejected('malformed');
  const at = new Date(typeof payload.data?.created_at === 'string' ? payload.data.created_at : typeof payload.created_at === 'string' ? payload.created_at : now);
  const occurredAt = Number.isNaN(at.getTime()) ? new Date(now).toISOString() : at.toISOString();
  const detail: Record<string, string> = {};
  let kind: MailEventKind;
  if (mapped === 'bounce') {
    const type = bounded(payload.data?.bounce?.type);
    const subType = bounded(payload.data?.bounce?.subType);
    if (type) detail.bounceType = type;
    if (subType) detail.bounceSubType = subType;
    // Only a bounce Resend calls permanent stops all mail to the address; an undetermined one is treated as soft.
    kind = type === 'Permanent' ? 'bounce_hard' : 'bounce_soft';
  } else {
    kind = mapped;
  }
  return [{ providerEventId: eventId, providerMessageId: messageId, kind, occurredAt, detail }];
}

export function createResendProvider(options: ResendOptions): MailProvider {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const url = new URL(API);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) throw new Error('Resend requests go to api.resend.com only');
  return {
    name: 'resend',
    enabled: true,
    sendRetrySafety: 'idempotent',
    async send(mail) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            ...(mail.messageId ? { 'idempotency-key': idempotencyKey(mail.messageId) } : {}),
          },
          body: JSON.stringify({
            from: options.from,
            to: [mail.to],
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            ...(mail.messageId ? { headers: { 'Message-ID': mail.messageId } } : {}),
          }),
        });
      } catch (error) {
        // The request may have reached Resend: the outcome is unknown.
        return { status: 'unknown', code: error instanceof Error && error.name === 'TimeoutError' ? 'RESEND_TIMEOUT' : 'RESEND_NETWORK' };
      }
      return classifyResponse(response);
    },
    ...(options.webhookSecret
      ? { parseWebhook: (request: WebhookRequest, now?: number) => parseResendWebhook(options.webhookSecret as string, request, now) }
      : {}),
  };
}
