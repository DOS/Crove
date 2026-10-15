// Outbound mail (issue #129). One generic adapter: SMTP, configured by SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and
// SMTP_FROM (the settings the bundled Supabase Auth uses for its own mails; Mailpit locally). Without SMTP_HOST, mail
// is off: send() logs one line naming the subject and sends nothing. Crove Cloud may plug its own Mailer.
//
// Mail bodies may carry secrets (an invite's accept link), so nothing here logs a body, a recipient or an error
// message: failures are reported by error code and SMTP reply code only.
import nodemailer from 'nodemailer';
import type { Config } from './config.ts';

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** false: no mail server is configured and send() only logs that the mail was not sent. */
  readonly enabled: boolean;
  /** Sends one mail or throws. */
  send(mail: OutboundMail): Promise<void>;
}

export type Delivery = 'sent' | 'failed' | 'off';

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string | undefined;
  pass?: string | undefined;
  from: string;
}

export function createSmtpMailer(options: SmtpOptions): Mailer {
  const auth = options.user && options.pass ? { user: options.user, pass: options.pass } : undefined;
  // 465 is implicit TLS; other ports upgrade with STARTTLS when the server offers it, and must when credentials
  // would otherwise cross the network in the clear.
  const secure = options.port === 465;
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure,
    requireTLS: !secure && auth !== undefined,
    ...(auth ? { auth } : {}),
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
    logger: false,
    debug: false,
  });
  // A bare address gets the display name Supabase Auth's mails use; "Name <address>" is kept as given.
  const from = options.from.includes('<') ? options.from : { name: 'Crove', address: options.from };
  return {
    enabled: true,
    async send(mail) {
      await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    },
  };
}

export function createLogMailer(log: (line: string) => void = (line) => console.log(line)): Mailer {
  return {
    enabled: false,
    async send(mail) {
      log(`[mail] not sent, SMTP_HOST is not set: "${mail.subject}"`);
    },
  };
}

export function createMailer(config: Pick<Config, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS' | 'SMTP_FROM'>): Mailer {
  if (!config.SMTP_HOST || !config.SMTP_FROM) return createLogMailer();
  return createSmtpMailer({ host: config.SMTP_HOST, port: config.SMTP_PORT, user: config.SMTP_USER, pass: config.SMTP_PASS, from: config.SMTP_FROM });
}

export function describeMailer(config: Pick<Config, 'SMTP_HOST' | 'SMTP_PORT'>): string {
  return config.SMTP_HOST ? `SMTP at ${config.SMTP_HOST}:${config.SMTP_PORT}` : 'off (SMTP_HOST is not set; mails are logged, not sent)';
}

interface SmtpError {
  code?: unknown;
  responseCode?: unknown;
}

// An error code and SMTP reply code, never the message (it may quote the recipient or the server's reply).
export function describeMailError(error: unknown): string {
  const e = (error ?? {}) as SmtpError;
  const code = typeof e.code === 'string' ? e.code : error instanceof Error ? error.name : 'unknown';
  return typeof e.responseCode === 'number' ? `${code} ${e.responseCode}` : code;
}

// A 5xx reply, refused credentials or a malformed message fail the same way on every attempt; a 4xx reply is the
// server asking to try again later.
function permanent(error: unknown): boolean {
  const e = (error ?? {}) as SmtpError;
  if (typeof e.responseCode === 'number') return e.responseCode >= 500;
  return e.code === 'EAUTH' || e.code === 'EENVELOPE' || e.code === 'EMESSAGE' || e.code === 'ECONFIG';
}

export interface DeliverOptions {
  // Waits before the second, third, ... attempt. Default: two retries, after 0.5 s and 2 s.
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  // Names the mail in log lines, e.g. "invite mail". Never the recipient.
  label?: string;
}

/** Sends one mail with retries on transient errors. Never throws: the result says what happened. */
export async function deliver(mailer: Mailer, mail: OutboundMail, options: DeliverOptions = {}): Promise<Delivery> {
  const log = options.log ?? ((line: string) => console.error(line));
  const label = options.label ?? 'mail';
  if (!mailer.enabled) {
    await mailer.send(mail).catch(() => undefined);
    return 'off';
  }
  const delays = options.retryDelaysMs ?? [500, 2_000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await mailer.send(mail);
      return 'sent';
    } catch (error) {
      const delay = delays[attempt];
      if (permanent(error) || delay === undefined) {
        log(`[mail] ${label} not sent after ${attempt + 1} attempt(s): ${describeMailError(error)}`);
        return 'failed';
      }
      await sleep(delay);
    }
  }
}
