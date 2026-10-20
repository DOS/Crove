// Telegram channels (#747), written from the Bot API docs (core.telegram.org/bots/api). A shop's channel is posted to by
// a bot the owner made with @BotFather and added to the channel as an administrator that may post; no app review.
//
// Connect: the bot token and the channel's @username (or its numeric id). getMe checks the token, getChat finds the
// channel, getChatMember checks the bot may post there. The token is sealed like any credential; the channel's id is
// the account id.
// Publish: sendMessage for text (Telegram shows the link's preview), sendPhoto or sendVideo for one file, sendMediaGroup
// for an album of 2 to 10 photos and videos, the caption on the first. Files are uploaded with the call (photos up to
// 10 MB, videos up to 50 MB), so a deployment storing files on local disk posts them too. The Bot API has no
// idempotency key and cannot read a channel's history, so an unclear answer is left to a person (publishSafety 'never').
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, RetrySafety } from './index.ts';
import { holdsLink } from './text.ts';
import { allowlistedFetch, ConnectorError, type Fetch } from './oauth.ts';

export const TELEGRAM_HOSTS = ['api.telegram.org'] as const;
const API = 'https://api.telegram.org';
// A message's text, and a caption.
export const TELEGRAM_TEXT_MAX = 4096;
export const TELEGRAM_CAPTION_MAX = 1024;
const ALBUM_MAX = 10;
const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const USERNAME = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/;
const CHAT_ID = /^-100\d{5,20}$/;

export interface TelegramSecret {
  botToken: string;
  // The channel's public username, for post links; none for a private channel.
  username: string | null;
}

export function telegramSecretOf(secret: string): TelegramSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<TelegramSecret>;
    if (typeof s.botToken !== 'string' || !TOKEN.test(s.botToken)) return null;
    return { botToken: s.botToken, username: typeof s.username === 'string' && USERNAME.test(s.username) ? s.username.replace(/^@/, '') : null };
  } catch {
    return null;
  }
}

export class TelegramError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly retryAfter: number | null;
  constructor(status: number, body: { error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } } | null) {
    super(typeof body?.description === 'string' ? body.description.slice(0, 500) : `Telegram answered ${status}`);
    this.status = status;
    this.code = typeof body?.error_code === 'number' ? body.error_code : null;
    this.retryAfter = typeof body?.parameters?.retry_after === 'number' ? body.parameters.retry_after : null;
  }
}

class TelegramClient {
  private readonly fetch: Fetch;
  constructor(fetchImpl?: Fetch, timeoutMs = 30_000) {
    this.fetch = allowlistedFetch(TELEGRAM_HOSTS, fetchImpl, timeoutMs);
  }

  // One Bot API method, its arguments as JSON, or as a multipart form when it uploads files (each named by its key and
  // referred to as attach://<key>). The token is in the path, as the API takes it, and never logged.
  async call<T>(token: string, method: string, args: Record<string, unknown>, files?: ReadonlyMap<string, { bytes: Uint8Array; mime: string }>): Promise<T> {
    let body: string | FormData;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (files && files.size > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(args)) form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      for (const [key, file] of files) form.append(key, new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime }), key);
      body = form;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(args);
    }
    const response = await this.fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers, body });
    const json = (await response.json().catch(() => null)) as { ok?: unknown; result?: unknown; error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } } | null;
    if (!response.ok || !json || json.ok !== true) throw new TelegramError(response.ok ? 502 : response.status, json);
    return json.result as T;
  }
}

// The connect form's fields, checked before any call: a bot token from @BotFather, and the channel's @username or id.
export function telegramLogin(input: { botToken: string; channel: string }): { botToken: string; channel: string } {
  const botToken = input.botToken.trim();
  const channel = input.channel.trim().replace(/^https?:\/\/t\.me\//i, '@');
  if (!TOKEN.test(botToken)) throw new ConnectorError('denied', 'not a Telegram bot token', 'TELEGRAM_TOKEN_INVALID');
  if (!USERNAME.test(channel) && !CHAT_ID.test(channel)) throw new ConnectorError('denied', 'not a Telegram channel name', 'TELEGRAM_CHANNEL_INVALID');
  return { botToken, channel: CHAT_ID.test(channel) ? channel : `@${(USERNAME.exec(channel) as RegExpExecArray)[1]}` };
}

export async function connectTelegram(login: { botToken: string; channel: string }, fetchImpl?: Fetch): Promise<ConnectedAccount> {
  const client = new TelegramClient(fetchImpl, 15_000);
  const failed = (error: unknown): never => {
    if (error instanceof TelegramError && (error.status === 401 || error.code === 401)) throw new ConnectorError('denied', 'Telegram refused the bot token', 'TELEGRAM_TOKEN_REFUSED');
    if (error instanceof TelegramError && (error.status === 400 || error.status === 403)) throw new ConnectorError('denied', 'Telegram does not know this channel for the bot', 'TELEGRAM_CHANNEL_NOT_FOUND');
    throw new ConnectorError('provider', 'Telegram did not answer');
  };
  const me = await client.call<{ id?: unknown; is_bot?: unknown }>(login.botToken, 'getMe', {}).catch(failed);
  if (typeof me.id !== 'number' || me.is_bot !== true) throw new ConnectorError('denied', 'not a bot token', 'TELEGRAM_TOKEN_REFUSED');
  const chat = await client.call<{ id?: unknown; type?: unknown; title?: unknown; username?: unknown }>(login.botToken, 'getChat', { chat_id: login.channel }).catch(failed);
  if (typeof chat.id !== 'number' || chat.type !== 'channel') throw new ConnectorError('denied', 'not a Telegram channel', 'TELEGRAM_NOT_A_CHANNEL');
  const member = await client.call<{ status?: unknown; can_post_messages?: unknown }>(login.botToken, 'getChatMember', { chat_id: chat.id, user_id: me.id }).catch(failed);
  const canPost = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages === true);
  if (!canPost) throw new ConnectorError('denied', 'the bot may not post in this channel', 'TELEGRAM_BOT_CANNOT_POST');
  const username = typeof chat.username === 'string' && USERNAME.test(chat.username) ? chat.username : null;
  const title = typeof chat.title === 'string' && chat.title.trim() ? chat.title.trim() : username ? `@${username}` : 'Telegram';
  const secret: TelegramSecret = { botToken: login.botToken, username };
  return { provider: 'telegram', externalAccountId: String(chat.id), displayName: title.slice(0, 200), scopes: [], expiresAt: null, secret: JSON.stringify(secret) };
}

const textOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  return content.linkUrl && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};
const isVideo = (m: { mime: string }) => m.mime.startsWith('video/');
const utf16 = (s: string) => s.length;

function telegramResult(error: unknown): PublishResult {
  if (!(error instanceof TelegramError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = `TELEGRAM_${error.code ?? error.status}`;
  const base = { code, message: error.message, httpStatus: error.status };
  if (error.status === 429) return { kind: 'rejected', error: 'rate_limited', ...base, ...(error.retryAfter ? { retryAt: new Date(Date.now() + error.retryAfter * 1000) } : {}) };
  if (error.status === 401) return { kind: 'rejected', error: 'token_expired', ...base };
  if (error.status === 403) return { kind: 'rejected', error: 'permission', ...base };
  if (error.status === 400) return { kind: 'rejected', error: 'bad_request', ...base };
  // A server error may or may not have posted: Telegram cannot be asked.
  return { kind: 'unknown', code, message: error.message };
}

export class TelegramPublisher implements Publisher {
  readonly provider = 'telegram' as const;
  readonly publishSafety: RetrySafety = 'never';
  private readonly client: TelegramClient;

  constructor(fetchImpl?: Fetch) {
    this.client = new TelegramClient(fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = telegramSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_BOT_TOKEN' };
    if (!CHAT_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_CHAT_ID' };
    const chat = input.externalAccountId;
    const text = textOf(input.content);
    const media = input.content.media;
    if (!text && media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    if (media.length > ALBUM_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_MEDIA' };
    if (media.length === 0 ? utf16(text) > TELEGRAM_TEXT_MAX : utf16(text) > TELEGRAM_CAPTION_MAX) return { kind: 'rejected', error: 'bad_request', code: media.length === 0 ? 'TEXT_TOO_LONG' : 'CAPTION_TOO_LONG' };
    // Every file is read before the first call, so a read failure posts nothing.
    const files = new Map<string, { bytes: Uint8Array; mime: string }>();
    for (const [i, m] of media.entries()) {
      const bytes = await input.readMedia(m.fileId).catch(() => null);
      if (!bytes) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      files.set(`file${i}`, { bytes, mime: m.mime });
    }
    let messageId: unknown;
    try {
      if (media.length === 0) {
        messageId = (await this.client.call<{ message_id?: unknown }>(s.botToken, 'sendMessage', { chat_id: chat, text })).message_id;
      } else if (media.length === 1) {
        const one = media[0] as { mime: string };
        const method = isVideo(one) ? 'sendVideo' : 'sendPhoto';
        messageId = (await this.client.call<{ message_id?: unknown }>(s.botToken, method, { chat_id: String(chat), [isVideo(one) ? 'video' : 'photo']: 'attach://file0', ...(text ? { caption: text } : {}) }, files)).message_id;
      } else {
        const group = media.map((m, i) => ({ type: isVideo(m) ? 'video' : 'photo', media: `attach://file${i}`, ...(i === 0 && text ? { caption: text } : {}) }));
        const sent = await this.client.call<{ message_id?: unknown }[]>(s.botToken, 'sendMediaGroup', { chat_id: String(chat), media: group }, files);
        messageId = sent[0]?.message_id;
      }
    } catch (error) {
      return telegramResult(error);
    }
    if (typeof messageId !== 'number') return { kind: 'unknown', code: 'NO_MESSAGE_ID' };
    return { kind: 'accepted', externalId: `${chat}:${messageId}`, url: s.username ? `https://t.me/${s.username}/${messageId}` : null };
  }
}
