// Team alerts in a Telegram or Discord chat (#863): the worker's half. The API checks and seals a target
// (chat-alert-save.ts) and never opens one; here the worker reads the sealed target through the definer only it may
// call (crove_social.chat_alert_target_get), posts one short line per alerting outbox event, and sends an owner's
// test line and records how it went.
//
// - Sealing: the target ({botToken, chatId} or {webhookId, token}) is sealed with the credential broker for the binding
//   (org, 'social.chat_alert', the alert's id), so an envelope copied to another alert or org does not open. It is
//   opened for one call and dropped; it never reaches a log, an audit row or an answer. The definer refuses it once the
//   member who saved the chat is no longer an owner or admin (CHAT_ALERT_OWNER_LEFT): the alert is skipped and logged.
// - At most one message per event: the job is queued once per event (singleton key and slot, see worker.ts) and never
//   retried, and this process remembers the events it sent for, so a second job for the same event sends nothing. A
//   crash between the send and the end of the job loses the alert rather than repeating it.
// - At most CHAT_ALERT_PER_MINUTE messages per org in any minute, in this process's memory; the rest are dropped with
//   a log line. Telegram itself allows a bot about 20 messages a minute in one group and answers 429 beyond.
// - A failure is logged without the target or the platform's text, and never touches the mail notifications, which
//   run in their own job, or the outbox relay.
import { discordChatTargetOf, DiscordError, sendDiscordText, sendTelegramText, telegramChatTargetOf, TelegramError, type DiscordChatTarget, type Fetch, type TelegramChatTarget } from '@crove/channel';
import { CHAT_ALERT_PROVIDER, type ChatAlertFacts, type ChatAlertTarget, type ChatAlertTestCode, type SealedChatAlert } from '@crove/mod-social';
import { CredentialError, DomainError, type Actor, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

export const CHAT_ALERT_PER_MINUTE = 30;
// The post's title or first line, in characters.
export const CHAT_ALERT_TITLE_MAX = 80;
const CHANNEL_MAX = 60;
const REVIEWER_MAX = 40;
// Events remembered as sent for; the oldest is forgotten first.
const SEEN_MAX = 10_000;
const SYSTEM: Actor = { type: 'system', component: 'social.chat_alert' };

export const CHAT_ALERT_TEST_TEXT = 'Crove: tin thử. Từ giờ nhóm sẽ nhận tin báo về bài đăng mạng xã hội tại đây.';

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

// Control characters and line separators would garble the line: each is a space, and any run of whitespace one space.
// Format characters (bidirectional overrides and isolates, zero-width ones, soft hyphens) could reorder or hide text,
// so they go.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const FORMAT = /\p{Cf}/gu;
export function clip(text: string, max: number): string {
  const s = text.replace(FORMAT, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : s;
}

// Discord reads markdown, masked links and mentions in a message (mentions never ping: allowed_mentions parses none);
// a backslash keeps each of those characters as it is.
export function discordEscape(text: string): string {
  return text.replace(/[\\*_~`|>#[\]()<@]/g, '\\$&');
}

// Telegram gets plain text, with no parse mode, but still notifies a member named @username in it: an at sign in what a
// person wrote becomes the fullwidth one (U+FF20), which reads the same and mentions nobody.
export function telegramEscape(text: string): string {
  return text.replace(/@/g, '\uFF20');
}

// The one line an alert posts, in Vietnamese: what happened, to which post and on which channels, and the post's link.
export function chatAlertText(facts: ChatAlertFacts, options: { publicUrl: string; target: ChatAlertTarget }): string {
  const esc = options.target === 'discord' ? discordEscape : telegramEscape;
  const title = facts.postText ? clip(facts.postText, CHAT_ALERT_TITLE_MAX) : '';
  const post = (capital: boolean) => (title ? `${capital ? 'Bài' : 'bài'} «${esc(title)}»` : capital ? 'Một bài' : 'một bài');
  const named = facts.channels.map((c) => esc(clip(c, CHANNEL_MAX))).filter(Boolean);
  const more = facts.channelCount - named.length;
  const channels = named.length === 0 ? '' : more > 0 ? `${named.join(', ')} và ${more} kênh khác` : named.join(', ');
  const on = (word: string) => (channels ? ` ${word} ${channels}` : '');
  let line: string;
  switch (facts.kind) {
    case 'needs_approval':
      line = `${post(true)}${on('trên')} đang chờ duyệt`;
      break;
    case 'failed':
      line = facts.event === 'social.variant.needs_attention' ? `${post(true)}${on('trên')} cần bạn kiểm tra` : `${post(true)} không đăng được${on('lên')}`;
      break;
    case 'published':
      line = `${post(true)} đã đăng${on('lên')}`;
      break;
    case 'client_answered': {
      const name = facts.reviewer ? clip(facts.reviewer, REVIEWER_MAX) : '';
      const who = name ? `Khách hàng ${esc(name)}` : 'Khách hàng';
      line = facts.verdict === 'approved' ? `${who} đã duyệt ${post(false)}` : `${who} yêu cầu sửa ${post(false)}`;
      break;
    }
  }
  const base = options.publicUrl.trim().replace(/\/+$/, '');
  return base ? `${line}: ${base}/o/${facts.slug}/social/${facts.postId}` : `${line}.`;
}

// ---------------------------------------------------------------------------
// Targets and calls
// ---------------------------------------------------------------------------

type Target = { kind: 'telegram'; target: TelegramChatTarget } | { kind: 'discord'; target: DiscordChatTarget };

const binding = (orgId: string, alertId: string) => ({ orgId, provider: CHAT_ALERT_PROVIDER, externalAccountId: alertId });

// The sealed target opened, or null when it does not open or is not a target of its kind.
function openTarget(broker: CredentialBroker, orgId: string, sealed: SealedChatAlert): Target | null {
  let secret: string;
  try {
    secret = broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, binding(orgId, sealed.id));
  } catch (error) {
    if (error instanceof CredentialError) return null;
    throw error;
  }
  if (sealed.kind === 'telegram') {
    const target = telegramChatTargetOf(secret);
    return target ? { kind: 'telegram', target } : null;
  }
  const target = discordChatTargetOf(secret);
  return target ? { kind: 'discord', target } : null;
}

async function sendLine(to: Target, text: string, fetchImpl: Fetch | undefined): Promise<void> {
  if (to.kind === 'telegram') await sendTelegramText(to.target, text, fetchImpl);
  else await sendDiscordText(to.target, text, fetchImpl);
}

export type ChatAlertFailure = 'refused' | 'rate_limited' | 'unreachable';
const FAILURE_CODES: Readonly<Record<ChatAlertFailure, ChatAlertTestCode>> = { refused: 'CHAT_ALERT_REFUSED', rate_limited: 'CHAT_ALERT_RATE_LIMITED', unreachable: 'CHAT_ALERT_UNREACHABLE' };

// What a failed call means for the person: the chat refused it (the bot was removed, the token or webhook changed),
// the platform is limiting the bot, or it did not answer.
export function chatAlertFailure(error: unknown): ChatAlertFailure {
  const status = error instanceof TelegramError || error instanceof DiscordError ? error.status : null;
  if (status === 429) return 'rate_limited';
  if (status !== null && status >= 400 && status < 500) return 'refused';
  return 'unreachable';
}

// A refusal's code for a log line, never its message.
function codeOf(error: unknown): string {
  return error instanceof DomainError ? error.code : error instanceof Error ? error.name : typeof error;
}

// For a log line: the platform's status and code, never its text (which may quote the request) or the target.
function failureNote(error: unknown): string {
  if (error instanceof TelegramError) return `Telegram answered ${error.status}${error.code !== null ? ` (${error.code})` : ''}`;
  if (error instanceof DiscordError) return `Discord answered ${error.status}${error.code !== null ? ` (${error.code})` : ''}`;
  return `no answer (${error instanceof Error ? error.name : typeof error})`;
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

// At most perMinute in any 60 seconds per org, counting each attempt.
export class ChatAlertLimiter {
  private readonly sent = new Map<string, number[]>();
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(perMinute = CHAT_ALERT_PER_MINUTE, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
  }

  take(orgId: string): boolean {
    const now = this.now();
    const recent = (this.sent.get(orgId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= this.perMinute) {
      this.sent.set(orgId, recent);
      return false;
    }
    recent.push(now);
    this.sent.set(orgId, recent);
    // Orgs with nothing in the last minute are forgotten, so the map holds only orgs sending now.
    if (this.sent.size > 1000) for (const [key, times] of this.sent) if (times.every((at) => now - at >= 60_000)) this.sent.delete(key);
    return true;
  }
}

export type ChatAlertOutcome = 'none' | 'sent' | 'duplicate' | 'rate_limited' | 'failed';

export interface ChatAlertSenderDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // PUBLIC_URL, where the post's link points; without it the line has no link.
  publicUrl: string;
  // The platforms' fetch (tests); every call still goes through the adapters' host allowlist.
  fetch?: Fetch;
  perMinute?: number;
  now?: () => number;
}

export class ChatAlertSender {
  private readonly deps: ChatAlertSenderDeps;
  private readonly limiter: ChatAlertLimiter;
  private readonly seen = new Set<string>();

  constructor(deps: ChatAlertSenderDeps) {
    this.deps = deps;
    this.limiter = new ChatAlertLimiter(deps.perMinute ?? CHAT_ALERT_PER_MINUTE, deps.now ?? Date.now);
  }

  // One outbox event of the org: the line it posts to the org's chat, if the org has one for its kind. Never throws.
  async handle(orgId: string, eventId: string): Promise<ChatAlertOutcome> {
    const label = `org ${orgId.slice(0, 8)} event ${eventId.slice(0, 8)}`;
    if (this.seen.has(eventId)) return 'duplicate';
    let prepared: { alert: SealedChatAlert; facts: ChatAlertFacts } | null;
    try {
      prepared = await this.deps.runtime.query('social.chat_alert.prepare', { eventId }, { actor: SYSTEM, orgId });
    } catch (error) {
      // CHAT_ALERT_OWNER_LEFT: the member who saved the chat is no longer an owner or admin; skipped until it is saved again.
      console.error(`[social-chat-alert] ${label}: not sent (${codeOf(error)})`);
      return 'failed';
    }
    if (!prepared) return 'none';
    // Remembered before the call: a second job for this event sends nothing, whatever becomes of this one.
    this.remember(eventId);
    const { alert, facts } = prepared;
    if (!this.limiter.take(orgId)) {
      console.warn(`[social-chat-alert] ${label}: dropped, more than ${this.deps.perMinute ?? CHAT_ALERT_PER_MINUTE} alerts a minute for the org`);
      return 'rate_limited';
    }
    try {
      const to = openTarget(this.deps.broker, orgId, alert);
      if (!to) {
        console.error(`[social-chat-alert] ${label}: the saved ${alert.kind} target does not open; it needs saving again`);
        return 'failed';
      }
      await sendLine(to, chatAlertText(facts, { publicUrl: this.deps.publicUrl, target: alert.kind }), this.deps.fetch);
      console.log(`[social-chat-alert] ${label}: ${facts.kind} sent to ${alert.kind}`);
      return 'sent';
    } catch (error) {
      console.warn(`[social-chat-alert] ${label}: ${facts.kind} not sent to ${alert.kind}: ${failureNote(error)}`);
      return 'failed';
    }
  }

  // An owner's test line (social.chat_alert.test): sent now, and its outcome recorded on the alert. Never throws.
  async test(orgId: string, eventId: string): Promise<ChatAlertOutcome> {
    const label = `org ${orgId.slice(0, 8)} test ${eventId.slice(0, 8)}`;
    if (this.seen.has(eventId)) return 'duplicate';
    this.remember(eventId);
    let code: ChatAlertTestCode | null = null;
    let sealed: SealedChatAlert | null = null;
    try {
      sealed = await this.deps.runtime.query<SealedChatAlert>('social.chat_alert.target', {}, { actor: SYSTEM, orgId });
    } catch (error) {
      const refused = codeOf(error);
      // Removed since: nothing to test, nothing to record.
      if (refused === 'CHAT_ALERT_NOT_SET') return 'none';
      code = refused === 'CHAT_ALERT_OWNER_LEFT' ? 'CHAT_ALERT_OWNER_LEFT' : 'CHAT_ALERT_UNREADABLE';
    }
    if (sealed) {
      const to = (() => {
        try {
          return openTarget(this.deps.broker, orgId, sealed);
        } catch {
          return null;
        }
      })();
      if (!to) code = 'CHAT_ALERT_UNREADABLE';
      else {
        try {
          await sendLine(to, CHAT_ALERT_TEST_TEXT, this.deps.fetch);
        } catch (error) {
          code = FAILURE_CODES[chatAlertFailure(error)];
          console.warn(`[social-chat-alert] ${label}: not sent to ${sealed.kind}: ${failureNote(error)}`);
        }
      }
    }
    try {
      await this.deps.runtime.execute('social.chat_alert.tested', { code }, { actor: SYSTEM, orgId });
    } catch (error) {
      console.error(`[social-chat-alert] ${label}: outcome not recorded (${codeOf(error)})`);
      return 'failed';
    }
    console.log(`[social-chat-alert] ${label}: ${code ?? 'sent'}`);
    return code ? 'failed' : 'sent';
  }

  private remember(eventId: string) {
    this.seen.add(eventId);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
