// Alert delivery for the prober (plan §4.13, issues #39 and #151), behind the AlertSink port (ADR-0030). One webhook
// adapter with four request shapes, picked by ALERT_WEBHOOK_FORMAT (default: from the webhook host):
//   slack     Slack incoming webhook: {text, mrkdwn: false}, with &, < and > escaped as Slack asks.
//   discord   Discord execute webhook: {content, allowed_mentions: {parse: []}}, content at most 2000 characters,
//             Markdown characters escaped and no @everyone, role or user pings.
//   telegram  Telegram Bot API sendMessage: {chat_id, text, link_preview_options: {is_disabled: true}} and no
//             parse_mode, so the text is sent as plain text and needs no escaping.
//   generic   anything else (Mattermost, Google Chat, a custom receiver): {text, content, crove}, where crove is the
//             structured alert.
// Without a webhook the alert is printed to stdout. The webhook URL usually embeds a secret (Slack and Discord in
// the path, Telegram's bot token), so it is never logged: only its host is.
//
// The same webhook also carries messages that are not health alerts (postMessage): the weekly usage summary of
// `usage-report --post` (issue #344), which reads its own login's data and shares only the webhook settings.
import { hostname } from 'node:os';
import { z } from 'zod';

export type AlertKind = 'alert' | 'resolved' | 'test';
// Why an alert goes out: a new problem, another set of failing checks, or the same problem repeated.
export type AlertState = 'new' | 'changed' | 'repeat';

export interface Finding {
  // backup: a failed backup run, reported by tools/backup/backup.sh through `prober --backup-failed` (issue #307). auth:
  // Supabase Auth did not answer its health check (issue #1994). archive_verify, archive_lag: the WORM archive's nightly
  // verification stopped, or the archive fell behind (issue #1997). extraction: document readings kept failing at the
  // reading service (issue #1998).
  check:
    | 'outbox'
    | 'inbound'
    | 'jobs_schema'
    | 'job_age'
    | 'dead_letters'
    | 'heartbeat'
    | 'notify_queue'
    | 'probe'
    | 'backup'
    | 'auth'
    | 'archive_verify'
    | 'archive_lag'
    | 'extraction';
  message: string;
  value: number | null;
  threshold: number | null;
}

export interface Alert {
  kind: AlertKind;
  instance: string;
  at: string;
  findings: Finding[];
  // The health() row the findings came from, when the probe could read it.
  health?: Record<string, unknown>;
  // kind 'alert': why it is sent (absent means new).
  state?: AlertState;
  // When the problem started (repeat, changed, resolved), ISO 8601.
  since?: string;
  // The checks that failed before (changed, resolved).
  previous?: string[];
}

export interface AlertPayload {
  text: string;
  content: string;
  crove: {
    kind: AlertKind;
    severity: 'critical' | 'info';
    instance: string;
    at: string;
    findings: Finding[];
    state?: AlertState;
    since?: string;
    previous?: string[];
    health?: Record<string, unknown>;
  };
}

export const WEBHOOK_FORMATS = ['generic', 'slack', 'discord', 'telegram'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

// The plain text stays under Discord's 2000-character content limit (Telegram allows 4096, Slack far more).
const MAX_TEXT = 1900;
export const DISCORD_MAX_CONTENT = 2000;

/** "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

function lasted(alert: Alert): string | null {
  if (!alert.since) return null;
  const ms = Date.parse(alert.at) - Date.parse(alert.since);
  return Number.isFinite(ms) ? formatDuration(ms / 1000) : null;
}

function headline(alert: Alert): string {
  const n = alert.findings.length;
  const duration = lasted(alert);
  if (alert.kind === 'test') return `[Crove] Test alert from ${alert.instance}: alert delivery works.`;
  if (alert.kind === 'alert' && n > 0 && alert.findings.every((f) => f.check === 'backup')) {
    return `[Crove] ALERT on ${alert.instance}: the backup failed.`;
  }
  if (alert.kind === 'resolved') {
    const after = duration ? ` after ${duration}` : '';
    if (alert.previous?.length === 1 && alert.previous[0] === 'probe') {
      return `[Crove] RESOLVED on ${alert.instance}: the prober reads crove_kernel.health() again${after}.`;
    }
    const was = alert.previous?.length ? ` (${alert.previous.join(', ')})` : '';
    return `[Crove] RESOLVED on ${alert.instance}: the failing health checks pass again${after}${was}.`;
  }
  if (alert.state === 'repeat') {
    return `[Crove] STILL FAILING on ${alert.instance}${duration ? ` for ${duration}` : ''}: ${n} health check(s) failed.`;
  }
  if (alert.state === 'changed') {
    const was = alert.previous?.length ? ` (was: ${alert.previous.join(', ')})` : '';
    return `[Crove] ALERT on ${alert.instance}: ${n} health check(s) failed${was}.`;
  }
  return `[Crove] ALERT on ${alert.instance}: ${n} health check(s) failed.`;
}

export function alertText(alert: Alert): string {
  const lines = alert.findings.map((f) => `- ${f.message}`);
  const text = [headline(alert), ...lines].join('\n');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}

export function alertPayload(alert: Alert): AlertPayload {
  const text = alertText(alert);
  return {
    text,
    content: text,
    crove: {
      kind: alert.kind,
      severity: alert.kind === 'alert' ? 'critical' : 'info',
      instance: alert.instance,
      at: alert.at,
      findings: alert.findings,
      ...(alert.kind === 'alert' ? { state: alert.state ?? 'new' } : {}),
      ...(alert.since ? { since: alert.since } : {}),
      ...(alert.previous ? { previous: alert.previous } : {}),
      ...(alert.health ? { health: alert.health } : {}),
    },
  };
}

// Slack treats &, < and > as control characters (links, mentions): they are sent as HTML entities, nothing else is.
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Discord renders Markdown in content: a backslash makes each emphasis, code and spoiler character literal (the
// lines start with "[Crove]" or "- ", so no heading or quote can form, and the findings render as a list). The
// result is cut to the 2000-character limit without leaving a dangling escape.
export function discordContent(text: string): string {
  const escaped = text.replace(/[\\*_~`|]/g, (c) => `\\${c}`);
  if (escaped.length <= DISCORD_MAX_CONTENT) return escaped;
  let cut = escaped.slice(0, DISCORD_MAX_CONTENT - 3);
  // An odd run of trailing backslashes would escape the ellipsis: drop the last one.
  const trailing = /\\+$/.exec(cut)?.[0].length ?? 0;
  if (trailing % 2 === 1) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/** The format for a webhook URL: Slack, Discord and Telegram by their API hosts, generic otherwise. */
export function detectWebhookFormat(url: string): WebhookFormat {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'generic';
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'hooks.slack.com') return 'slack';
  if (host === 'api.telegram.org') return 'telegram';
  if (/^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/.test(host) && parsed.pathname.startsWith('/api/webhooks/')) return 'discord';
  return 'generic';
}

/**
 * One message for the alert webhook: the plain text every format sends, and the structured object only a generic
 * receiver gets (as `crove`).
 */
export interface WebhookMessage {
  text: string;
  crove: Record<string, unknown>;
}

/** The JSON body for one message in a given format. telegramChatId is required for 'telegram'. */
export function messageBody(message: WebhookMessage, format: WebhookFormat, telegramChatId?: string): Record<string, unknown> {
  switch (format) {
    case 'slack':
      return { text: slackEscape(message.text), mrkdwn: false };
    case 'discord':
      return { content: discordContent(message.text), allowed_mentions: { parse: [] } };
    case 'telegram':
      if (!telegramChatId) throw new Error('a Telegram webhook needs ALERT_TELEGRAM_CHAT_ID');
      return { chat_id: telegramChatId, text: message.text, link_preview_options: { is_disabled: true } };
    case 'generic':
      return { text: message.text, content: message.text, crove: message.crove };
  }
}

/** The JSON body for one alert in a given format. telegramChatId is required for 'telegram'. */
export function webhookBody(alert: Alert, format: WebhookFormat, telegramChatId?: string): Record<string, unknown> {
  const payload = alertPayload(alert);
  return messageBody({ text: payload.text, crove: payload.crove }, format, telegramChatId);
}

export interface AlertSinkOptions {
  webhookUrl?: string | undefined;
  // Default: detected from the webhook host.
  format?: WebhookFormat | undefined;
  telegramChatId?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number;
  log?: ((line: string) => void) | undefined;
}

export interface Delivery {
  channel: 'webhook' | 'stdout';
  ok: boolean;
  error?: string;
}

export function describeWebhook(url: string | undefined, format?: WebhookFormat): string {
  if (!url) return 'stdout (ALERT_WEBHOOK_URL is not set)';
  try {
    const host = new URL(url).host;
    const kind = format ?? detectWebhookFormat(url);
    return kind === 'generic' ? `webhook at ${host}` : `${kind} webhook at ${host}`;
  } catch {
    return 'webhook (invalid URL)';
  }
}

// The vendors answer an error with a short reason (Slack "invalid_payload", Telegram {"description": ...}, Discord
// {"message": ...}) that never contains the webhook secret: it is kept, cut to 200 printable characters. A generic
// receiver's answer is not logged at all (it may echo the request).
async function errorDetail(response: Response, format: WebhookFormat): Promise<string> {
  if (format === 'generic') {
    await response.arrayBuffer().catch(() => undefined);
    return '';
  }
  const body = await response.text().catch(() => '');
  let reason = body;
  try {
    const json = JSON.parse(body) as { description?: unknown; message?: unknown };
    if (typeof json.description === 'string') reason = json.description;
    else if (typeof json.message === 'string') reason = json.message;
  } catch {
    // Slack answers plain text.
  }
  const clean = reason.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 200);
  return clean ? `: ${clean}` : '';
}

/**
 * Posts one message to the webhook. Never throws and prints nothing: a failed post, or no webhook at all, is reported
 * in the result, which names the webhook by its host only.
 */
export async function postMessage(message: WebhookMessage, options: Omit<AlertSinkOptions, 'log'>): Promise<Delivery> {
  const url = options.webhookUrl;
  if (!url) return { channel: 'webhook', ok: false, error: 'ALERT_WEBHOOK_URL is not set' };
  const format = options.format ?? detectWebhookFormat(url);
  const doFetch = options.fetch ?? fetch;
  try {
    const body = messageBody(message, format, options.telegramChatId);
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}${await errorDetail(response, format)}`);
    // Drain the body so the connection is released; its content is not logged.
    await response.arrayBuffer().catch(() => undefined);
    return { channel: 'webhook', ok: true };
  } catch (error) {
    // A transport error that quoted the URL would leak its secret: the URL is cut out of the reason.
    const reason = (error instanceof Error ? error.message : String(error)).split(url).join('<webhook>');
    return { channel: 'webhook', ok: false, error: `${describeWebhook(url, format)} failed: ${reason}` };
  }
}

/** Delivers one alert. Never throws: a failed webhook is reported in the result and the alert is printed instead. */
export async function deliverAlert(alert: Alert, options: AlertSinkOptions): Promise<Delivery> {
  const log = options.log ?? ((line: string) => console.log(line));
  const payload = alertPayload(alert);
  if (!options.webhookUrl) {
    log(payload.text);
    return { channel: 'stdout', ok: true };
  }
  const delivery = await postMessage({ text: payload.text, crove: payload.crove }, options);
  if (!delivery.ok) log(payload.text);
  return delivery;
}

// The alert port (ADR-0030): where the prober sends an alert. deliver never throws; a failed delivery is reported in
// its result. describe names the destination for logs and never includes a secret.
export interface AlertSink {
  describe(): string;
  deliver(alert: Alert): Promise<Delivery>;
}

// The open-source default: the webhook, or stdout without one.
export function webhookAlertSink(options: AlertSinkOptions): AlertSink {
  return { describe: () => describeWebhook(options.webhookUrl, options.format), deliver: (alert) => deliverAlert(alert, options) };
}

const optionalEnv = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

// The webhook settings, shared by the prober and `usage-report --post`.
export const WEBHOOK_ENV = {
  ALERT_WEBHOOK_URL: optionalEnv.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // auto: Slack, Discord and Telegram by their API hosts, generic otherwise.
  ALERT_WEBHOOK_FORMAT: z.enum(['auto', ...WEBHOOK_FORMATS]).default('auto'),
  // Telegram only: the chat the bot posts to, a numeric id (groups and channels are negative) or @channelname.
  ALERT_TELEGRAM_CHAT_ID: optionalEnv.pipe(z.string().regex(/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/).optional()),
  // Names this deployment in messages. Default: the host of PUBLIC_URL, else the machine's host name.
  ALERT_INSTANCE: optionalEnv,
  PUBLIC_URL: optionalEnv,
};

const webhookEnvSchema = z.object(WEBHOOK_ENV);
export type WebhookEnv = z.output<typeof webhookEnvSchema>;

export interface WebhookTarget {
  webhookUrl: string | undefined;
  webhookFormat: WebhookFormat;
  telegramChatId: string | undefined;
  instance: string;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The webhook target from parsed WEBHOOK_ENV values. Throws `invalid <who> configuration: <variable> (...)` for a
 * Telegram webhook without a chat id or not ending in /sendMessage; the message never contains the URL.
 */
export function webhookTarget(raw: WebhookEnv, who: string): WebhookTarget {
  const webhookFormat = raw.ALERT_WEBHOOK_FORMAT === 'auto' ? (raw.ALERT_WEBHOOK_URL ? detectWebhookFormat(raw.ALERT_WEBHOOK_URL) : 'generic') : raw.ALERT_WEBHOOK_FORMAT;
  if (raw.ALERT_WEBHOOK_URL && webhookFormat === 'telegram') {
    if (!raw.ALERT_TELEGRAM_CHAT_ID) throw new Error(`invalid ${who} configuration: ALERT_TELEGRAM_CHAT_ID (a Telegram webhook needs the chat id)`);
    if (!/\/bot[^/]+\/sendMessage$/.test(new URL(raw.ALERT_WEBHOOK_URL).pathname)) {
      throw new Error(`invalid ${who} configuration: ALERT_WEBHOOK_URL (a Telegram webhook is https://api.telegram.org/bot<token>/sendMessage)`);
    }
  }
  return {
    webhookUrl: raw.ALERT_WEBHOOK_URL,
    webhookFormat,
    telegramChatId: raw.ALERT_TELEGRAM_CHAT_ID,
    instance: raw.ALERT_INSTANCE ?? hostOf(raw.PUBLIC_URL) ?? hostname(),
  };
}

/** Reads the webhook settings alone from the environment. Errors name the variables, never their values. */
export function loadWebhookTarget(env: NodeJS.ProcessEnv, who: string): WebhookTarget {
  const parsed = webhookEnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid ${who} configuration: ${fields}`);
  }
  return webhookTarget(parsed.data, who);
}
