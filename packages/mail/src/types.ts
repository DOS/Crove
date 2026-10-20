// The provider interface (Email plan §3.9, ADR-0034 decision 5). A provider sends one mail and says what happened; it
// never throws for a refusal, so callers decide retries from the result alone. Mail bodies may carry secrets (an
// invite's accept link): nothing here logs a body, a recipient or a provider's error message, only codes.

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  // The Message-ID header, "<id@domain>"; unset, the transport makes one. HTTP providers also derive their
  // idempotency key from it, so a retry of the same mail is not sent twice.
  messageId?: string;
  // The envelope sender that bounce reports go to (#539: bounce+<token>@INBOUND_DOMAIN). SMTP uses it; HTTP providers
  // report bounces through their webhooks instead.
  returnPath?: string;
}

// How safe it is to repeat a send whose outcome is unknown (ADR-0025): 'idempotent' when the provider drops a repeat
// of the same mail, 'never' when a repeat may deliver it twice.
export type RetrySafety = 'safe' | 'idempotent' | 'reconcile_only' | 'never';

export type MailErrorKind = 'invalid_recipient' | 'suppressed_by_provider' | 'rate_limited' | 'auth' | 'bad_request' | 'transient';

// 'rejected': the provider did not take the mail, for the reason `error` names (`transient` and `rate_limited` may
// succeed later). 'unknown': the provider may have taken it (a timeout, a 5xx after the request was sent).
// `code` is safe to log and to store: an error code and status, never a message.
export type SendResult =
  | { status: 'accepted'; providerMessageId?: string }
  | { status: 'rejected'; error: MailErrorKind; code: string; retryAfterMs?: number }
  | { status: 'unknown'; code: string };

// Delivery events (Email plan §3.2): the kinds E2 records. Unsubscribes and clicks come with E6 and E8.
export type MailEventKind = 'delivered' | 'deferred' | 'bounce_hard' | 'bounce_soft' | 'complaint';

export interface MailEvent {
  // Unique per provider event, so a replayed webhook is recognized.
  providerEventId: string;
  // The id the provider gave the mail when it accepted it (mail_message.provider_message_id).
  providerMessageId: string;
  kind: MailEventKind;
  occurredAt: string;
  // Bounded, and never an address or a provider message: for example the bounce type.
  detail: Record<string, string>;
}

export interface WebhookRequest {
  // Header names in lower case.
  headers: Record<string, string | undefined>;
  // The raw body, as received: signatures cover these exact bytes.
  body: string;
}

export class WebhookRejected extends Error {
  readonly reason: 'signature' | 'stale' | 'malformed';
  constructor(reason: 'signature' | 'stale' | 'malformed') {
    super(`webhook rejected: ${reason}`);
    this.name = 'WebhookRejected';
    this.reason = reason;
  }
}

export interface MailProvider {
  // Stored in mail_message.provider: lower case, digits and underscores, at most 32 characters.
  readonly name: string;
  // false: no provider is configured and send() only logs that the mail was not sent.
  readonly enabled: boolean;
  readonly sendRetrySafety: RetrySafety;
  send(mail: OutboundMail): Promise<SendResult>;
  // Checks the signature and returns the events of one webhook delivery, or throws WebhookRejected. Absent when the
  // provider has no webhooks (SMTP: bounces arrive as DSN mails through the inbound route).
  parseWebhook?(request: WebhookRequest, now?: number): MailEvent[];
}
