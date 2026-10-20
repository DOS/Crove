// Outbound mail (issue #129). The providers live in @crove/mail (Email plan §3.9): SMTP, configured by SMTP_HOST,
// SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM (the settings the bundled Supabase Auth uses for its own mails;
// Mailpit locally), or Resend with MAIL_PROVIDER=resend (#539). Without a provider, mail is off: send() logs one line
// naming the subject and sends nothing. Crove Cloud may plug its own provider.
//
// Mail bodies may carry secrets (an invite's accept link), so nothing here logs a body, a recipient or an error
// message: failures are reported by error code only.
import { createLogProvider, createResendProvider, createSmtpProvider, describeMailError, type MailProvider, type OutboundMail, type SendResult } from '@crove/mail';
import type { Config } from './config.ts';

export { createLogProvider, describeMailError, type MailProvider, type OutboundMail } from '@crove/mail';

export type Delivery = 'sent' | 'failed' | 'off';

// What deliver() reports: the outcome, the provider that took the mail and the id it gave it (stored on the mail's
// row, so its delivery events find it).
export interface DeliveryResult {
  status: Delivery;
  provider: string;
  providerMessageId?: string;
}

type MailConfig = Pick<Config, 'MAIL_PROVIDER' | 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS' | 'SMTP_FROM' | 'RESEND_API_KEY' | 'RESEND_WEBHOOK_SECRET'>;

export function createMailer(config: MailConfig): MailProvider {
  if (config.MAIL_PROVIDER === 'resend' && config.RESEND_API_KEY && config.SMTP_FROM) {
    return createResendProvider({ apiKey: config.RESEND_API_KEY, from: config.SMTP_FROM, webhookSecret: config.RESEND_WEBHOOK_SECRET });
  }
  if (!config.SMTP_HOST || !config.SMTP_FROM) return createLogProvider();
  return createSmtpProvider({ host: config.SMTP_HOST, port: config.SMTP_PORT, user: config.SMTP_USER, pass: config.SMTP_PASS, from: config.SMTP_FROM });
}

// The right-hand side of the Message-ID of the mail Crove sends (#538): the domain of SMTP_FROM, else the host of
// PUBLIC_URL. Mail systems weigh a Message-ID whose domain matches the sender's.
export function messageIdDomain(config: Pick<Config, 'SMTP_FROM' | 'PUBLIC_URL'>): string {
  const from = config.SMTP_FROM?.match(/@([^@\s>]+)>?\s*$/)?.[1];
  if (from) return from.toLowerCase();
  return new URL(config.PUBLIC_URL).hostname;
}

export function describeMailer(config: Pick<Config, 'MAIL_PROVIDER' | 'SMTP_HOST' | 'SMTP_PORT'>): string {
  if (config.MAIL_PROVIDER === 'resend') return 'Resend (api.resend.com)';
  return config.SMTP_HOST ? `SMTP at ${config.SMTP_HOST}:${config.SMTP_PORT}` : 'off (SMTP_HOST is not set; mails are logged, not sent)';
}

const DEADLINE = Symbol('deadline');

export interface DeliverOptions {
  // Waits before the second, third, ... attempt. Default: two retries, after 0.5 s and 2 s.
  retryDelaysMs?: readonly number[];
  // Bound on the whole delivery, attempts and waits included (default 10 s): the caller (an HTTP request holding a
  // one-time link) must answer before any reverse proxy times out. A send still running then is left to finish in
  // the background and reported as failed.
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  // Names the mail in log lines, e.g. "invite mail". Never the recipient.
  label?: string;
}

/**
 * Sends one mail with retries on a transient refusal, within a deadline. Never throws: the result says what happened.
 * An unknown outcome (the provider may have taken the mail) is retried only when the provider drops a repeat of the
 * same Message-ID; plain SMTP retries only refusals, so a lost reply is reported as failed rather than sent twice.
 */
export async function deliver(mailer: MailProvider, mail: OutboundMail, options: DeliverOptions = {}): Promise<DeliveryResult> {
  const log = options.log ?? ((line: string) => console.error(line));
  const label = options.label ?? 'mail';
  const provider = mailer.name;
  if (!mailer.enabled) {
    await Promise.resolve()
      .then(() => mailer.send(mail))
      .catch(() => undefined);
    return { status: 'off', provider };
  }
  const repeatable = mail.messageId !== undefined && (mailer.sendRetrySafety === 'idempotent' || mailer.sendRetrySafety === 'safe');
  const delays = options.retryDelaysMs ?? [500, 2_000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? 10_000);
  for (let attempt = 0; ; attempt++) {
    let result: SendResult;
    try {
      result = await withDeadline(mailer, mail, deadline - now());
    } catch (error) {
      if (error === DEADLINE) {
        log(`[mail] ${label} not sent within the deadline (attempt ${attempt + 1})`);
      } else {
        // A provider that throws broke its contract: not retried.
        log(`[mail] ${label} not sent after ${attempt + 1} attempt(s): ${describeMailError(error)}`);
      }
      return { status: 'failed', provider };
    }
    if (result.status === 'accepted') {
      return { status: 'sent', provider, ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}) };
    }
    const retryable = result.status === 'unknown' ? repeatable : result.error === 'transient' || result.error === 'rate_limited';
    const base = delays[attempt];
    // A provider that names its wait (a rate limit) is not asked again sooner.
    const delay = base !== undefined && result.status === 'rejected' && result.retryAfterMs !== undefined ? Math.max(base, result.retryAfterMs) : base;
    if (!retryable || delay === undefined || now() + delay >= deadline) {
      log(`[mail] ${label} not sent after ${attempt + 1} attempt(s): ${result.code}`);
      return { status: 'failed', provider };
    }
    await sleep(delay);
  }
}

async function withDeadline(mailer: MailProvider, mail: OutboundMail, remainingMs: number): Promise<SendResult> {
  if (remainingMs <= 0) throw DEADLINE;
  // A send that throws synchronously becomes a rejection here.
  const send = Promise.resolve().then(() => mailer.send(mail));
  // Past the deadline the send runs on; its outcome no longer matters.
  send.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(DEADLINE), remainingMs);
  });
  try {
    return await Promise.race([send, expired]);
  } finally {
    clearTimeout(timer);
  }
}
