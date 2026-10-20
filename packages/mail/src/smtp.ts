// SMTP (issue #129), the default provider: any relay, Mailpit under docker compose. Plain SMTP has no idempotency
// key, so a send whose reply was lost may have been delivered: its retry safety is 'never'. A connection that never
// reached the server, and a 4xx reply, are the server asking to try again later.
import nodemailer from 'nodemailer';
import type { MailErrorKind, MailProvider, SendResult } from './types.ts';

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string | undefined;
  pass?: string | undefined;
  from: string;
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

// A 5xx reply, refused credentials, a server without the TLS we require or a malformed message fail the same way on
// every attempt; anything else (a 4xx reply, a connection that failed or timed out) may pass later.
export function classifySmtpError(error: unknown): SendResult {
  const e = (error ?? {}) as SmtpError;
  const code = describeMailError(error);
  const reject = (kind: MailErrorKind): SendResult => ({ status: 'rejected', error: kind, code });
  if (typeof e.responseCode === 'number') {
    if (e.responseCode < 500) return reject('transient');
    if (e.code === 'EAUTH') return reject('auth');
    return reject(e.code === 'EENVELOPE' && e.responseCode >= 550 && e.responseCode <= 553 ? 'invalid_recipient' : 'bad_request');
  }
  if (e.code === 'EAUTH' || e.code === 'ENOAUTH') return reject('auth');
  if (['ETLS', 'EENVELOPE', 'EMESSAGE', 'ECONFIG'].includes(String(e.code))) return reject('bad_request');
  return reject('transient');
}

export function createSmtpProvider(options: SmtpOptions): MailProvider {
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
    name: 'smtp',
    enabled: true,
    sendRetrySafety: 'never',
    async send(mail) {
      try {
        await transport.sendMail({
          from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          ...(mail.messageId ? { messageId: mail.messageId } : {}),
        });
        return { status: 'accepted' };
      } catch (error) {
        return classifySmtpError(error);
      }
    },
  };
}
