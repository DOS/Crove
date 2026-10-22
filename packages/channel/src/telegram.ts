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
// Silent and pinned posts (#982): settings.telegram.silent sends every call of the post with disable_notification
// (members get it without a sound); settings.telegram.pin pins the post afterwards with pinChatMessage, a second step of
// its own (pin), so a refused pin never touches the post. In a channel a bot may pin when it may edit others' messages
// (can_edit_messages; can_pin_messages is the right of groups), which connect reads into the connection's scopes.
// Link buttons (#1017): settings.telegram.buttons go under a text, photo or video post as reply_markup.inline_keyboard
// (URL buttons). A media group takes no keyboard, so an album with buttons is refused with nothing sent, never posted
// without them; validation says so first.
import type { CommentResult, ConnectedAccount, PinInput, Publisher, PublishInput, PublishResult, RemoveInput, RemoveResult, RetrySafety } from './index.ts';
import { commentResult, removeResult } from './comment.ts';
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
// A post's id as publish returns it: the channel and the message.
const POST_ID = /^(-100\d{5,20}):(\d{1,20})$/;
// The scope a connection carries when its bot may pin messages in the channel (#982). modules/social names the same
// string TELEGRAM_PIN_SCOPE, for the editor.
export const TELEGRAM_PIN_SCOPE = 'can_pin_messages';

// The link buttons under a post (#1017): at most 3 rows of 3, each a label of 1 to 64 characters and an https link.
// modules/social names the same limits for validation and the editor.
export const TELEGRAM_BUTTON_ROWS_MAX = 3;
export const TELEGRAM_BUTTONS_PER_ROW_MAX = 3;
export const TELEGRAM_BUTTON_TEXT_MAX = 64;
type InlineKeyboard = { text: string; url: string }[][];

// settings.telegram.buttons (#1017) as Telegram's inline keyboard: null without any, 'invalid' when they are not rows
// of { text, url } within the limits with https links (sent as they are would be refused, or worse, opened).
function keyboardOf(settings: Readonly<Record<string, unknown>> | undefined): InlineKeyboard | 'invalid' | null {
  const raw = settings?.telegram;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const buttons = (raw as { buttons?: unknown }).buttons;
  if (buttons === undefined) return null;
  if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > TELEGRAM_BUTTON_ROWS_MAX) return 'invalid';
  const rows: InlineKeyboard = [];
  for (const row of buttons as unknown[]) {
    if (!Array.isArray(row) || row.length === 0 || row.length > TELEGRAM_BUTTONS_PER_ROW_MAX) return 'invalid';
    const out: { text: string; url: string }[] = [];
    for (const b of row as unknown[]) {
      const { text, url } = (b && typeof b === 'object' ? b : {}) as { text?: unknown; url?: unknown };
      if (typeof text !== 'string' || typeof url !== 'string') return 'invalid';
      const label = text.trim();
      // Counted as validation counts it: characters, a Vietnamese letter with its marks as one however it was typed.
      if (label.length === 0 || [...label.normalize('NFC')].length > TELEGRAM_BUTTON_TEXT_MAX || !httpsUrl(url)) return 'invalid';
      out.push({ text: label, url });
    }
    rows.push(out);
  }
  return rows;
}
// An https link with a host: no user name or password, no control characters or invisible marks (C0, DEL,
// zero-width and direction marks, line and paragraph separators, the byte order mark).
function httpsUrl(url: string): boolean {
  if (url.length > 2048 || !/^https:\/\/[^\s]+$/i.test(url)) return false;
  const hidden = [...url].some((ch) => {
    const c = ch.codePointAt(0) as number;
    return c < 0x20 || c === 0x7f || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0xfeff;
  });
  if (hidden) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

// settings.telegram.silent (#982): true sends the post without a sound; anything else is a post as usual.
function silentOf(settings: Readonly<Record<string, unknown>> | undefined): boolean {
  const raw = settings?.telegram;
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { silent?: unknown }).silent === true);
}

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
    // An unknown or malformed token answers 404 on getMe, a revoked one 401.
    if (error instanceof TelegramError && (error.status === 401 || error.status === 404)) throw new ConnectorError('denied', 'Telegram refused the bot token', 'TELEGRAM_TOKEN_REFUSED');
    if (error instanceof TelegramError && (error.status === 400 || error.status === 403)) throw new ConnectorError('denied', 'Telegram does not know this channel for the bot', 'TELEGRAM_CHANNEL_NOT_FOUND');
    throw new ConnectorError('provider', 'Telegram did not answer');
  };
  const me = await client.call<{ id?: unknown; is_bot?: unknown }>(login.botToken, 'getMe', {}).catch(failed);
  if (typeof me.id !== 'number' || me.is_bot !== true) throw new ConnectorError('denied', 'not a bot token', 'TELEGRAM_TOKEN_REFUSED');
  const chat = await client.call<{ id?: unknown; type?: unknown; title?: unknown; username?: unknown }>(login.botToken, 'getChat', { chat_id: login.channel }).catch(failed);
  if (typeof chat.id !== 'number' || chat.type !== 'channel') throw new ConnectorError('denied', 'not a Telegram channel', 'TELEGRAM_NOT_A_CHANNEL');
  const member = await client.call<{ status?: unknown; can_post_messages?: unknown; can_edit_messages?: unknown }>(login.botToken, 'getChatMember', { chat_id: chat.id, user_id: me.id }).catch(failed);
  const canPost = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages === true);
  if (!canPost) throw new ConnectorError('denied', 'the bot may not post in this channel', 'TELEGRAM_BOT_CANNOT_POST');
  // The right to pin (#982): in a channel it comes with editing others' messages; the owner has every right.
  const canPin = member.status === 'creator' || (member.status === 'administrator' && member.can_edit_messages === true);
  const username = typeof chat.username === 'string' && USERNAME.test(chat.username) ? chat.username : null;
  const title = typeof chat.title === 'string' && chat.title.trim() ? chat.title.trim() : username ? `@${username}` : 'Telegram';
  const secret: TelegramSecret = { botToken: login.botToken, username };
  return { provider: 'telegram', externalAccountId: String(chat.id), displayName: title.slice(0, 200), scopes: canPin ? [TELEGRAM_PIN_SCOPE] : [], expiresAt: null, secret: JSON.stringify(secret) };
}

// Team alerts (#863): the org's own chat for Social alerts, not a channel posts go to. A group or supergroup the bot
// was added to, a channel where it may post, or a private chat with the bot, by @username, t.me link or numeric id.
const ALERT_CHAT_ID = /^-?\d{5,20}$/;

export interface TelegramChatTarget {
  botToken: string;
  // The chat's numeric id, as getChat answered it.
  chatId: string;
}

// The alert form's fields, checked before any call.
export function telegramChatLogin(input: { botToken: string; chatId: string }): { botToken: string; chat: string } {
  const botToken = input.botToken.trim();
  const chat = input.chatId.trim().replace(/^https?:\/\/t\.me\//i, '@');
  if (!TOKEN.test(botToken)) throw new ConnectorError('denied', 'not a Telegram bot token', 'TELEGRAM_TOKEN_INVALID');
  if (!USERNAME.test(chat) && !ALERT_CHAT_ID.test(chat)) throw new ConnectorError('denied', 'not a Telegram chat id or name', 'TELEGRAM_CHAT_INVALID');
  return { botToken, chat: ALERT_CHAT_ID.test(chat) ? chat : `@${(USERNAME.exec(chat) as RegExpExecArray)[1]}` };
}

// getMe checks the token, getChat finds the chat, getChatMember checks the bot may write there. Returns the target
// (to be sealed) and the chat's title for the settings card.
export async function checkTelegramChat(login: { botToken: string; chat: string }, fetchImpl?: Fetch): Promise<{ target: TelegramChatTarget; label: string }> {
  const client = new TelegramClient(fetchImpl, 15_000);
  const failed = (error: unknown): never => {
    if (error instanceof TelegramError && (error.status === 401 || error.status === 404)) throw new ConnectorError('denied', 'Telegram refused the bot token', 'TELEGRAM_TOKEN_REFUSED');
    if (error instanceof TelegramError && (error.status === 400 || error.status === 403)) throw new ConnectorError('denied', 'Telegram does not know this chat for the bot', 'TELEGRAM_CHAT_NOT_FOUND');
    throw new ConnectorError('provider', 'Telegram did not answer');
  };
  const me = await client.call<{ id?: unknown; is_bot?: unknown }>(login.botToken, 'getMe', {}).catch(failed);
  if (typeof me.id !== 'number' || me.is_bot !== true) throw new ConnectorError('denied', 'not a bot token', 'TELEGRAM_TOKEN_REFUSED');
  const chat = await client
    .call<{ id?: unknown; type?: unknown; title?: unknown; username?: unknown; first_name?: unknown }>(login.botToken, 'getChat', { chat_id: login.chat })
    .catch(failed);
  if (typeof chat.id !== 'number' || !['private', 'group', 'supergroup', 'channel'].includes(String(chat.type))) throw new ConnectorError('denied', 'not a Telegram chat', 'TELEGRAM_CHAT_NOT_FOUND');
  // A private chat is the bot's own with a person who started it; anywhere else the bot must be able to write.
  if (chat.type !== 'private') {
    const member = await client.call<{ status?: unknown; can_post_messages?: unknown; can_send_messages?: unknown }>(login.botToken, 'getChatMember', { chat_id: chat.id, user_id: me.id }).catch(failed);
    const canSend =
      chat.type === 'channel'
        ? member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages === true)
        : member.status === 'creator' || member.status === 'administrator' || member.status === 'member' || (member.status === 'restricted' && member.can_send_messages === true);
    if (!canSend) throw new ConnectorError('denied', 'the bot may not write in this chat', 'TELEGRAM_BOT_CANNOT_SEND');
  }
  const username = typeof chat.username === 'string' && USERNAME.test(chat.username) ? chat.username : null;
  const named = [chat.title, chat.first_name].find((n): n is string => typeof n === 'string' && n.trim().length > 0);
  const label = named?.trim() ?? (username ? `@${username}` : 'Telegram');
  return { target: { botToken: login.botToken, chatId: String(chat.id) }, label: label.slice(0, 200) };
}

export function telegramChatTargetOf(secret: string): TelegramChatTarget | null {
  try {
    const s = JSON.parse(secret) as Partial<TelegramChatTarget>;
    if (typeof s.botToken !== 'string' || !TOKEN.test(s.botToken) || typeof s.chatId !== 'string' || !ALERT_CHAT_ID.test(s.chatId)) return null;
    return { botToken: s.botToken, chatId: s.chatId };
  } catch {
    return null;
  }
}

// One line of plain text (no parse mode, so nothing in it is markup) without a link preview. Throws TelegramError.
export async function sendTelegramText(target: TelegramChatTarget, text: string, fetchImpl?: Fetch): Promise<void> {
  if (text.length === 0 || utf16(text) > TELEGRAM_TEXT_MAX) throw new TelegramError(400, { description: 'message text is empty or too long' });
  await new TelegramClient(fetchImpl, 15_000).call(target.botToken, 'sendMessage', { chat_id: target.chatId, text, link_preview_options: { is_disabled: true } });
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
  private readonly fetchImpl: Fetch | undefined;

  constructor(fetchImpl?: Fetch) {
    this.fetchImpl = fetchImpl;
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
    // Link buttons (#1017): refused rather than dropped, so a post never goes out without the buttons it was approved with.
    const keyboard = keyboardOf(input.settings);
    if (keyboard === 'invalid') return { kind: 'rejected', error: 'bad_request', code: 'BUTTONS_INVALID' };
    if (keyboard && media.length > 1) return { kind: 'rejected', error: 'bad_request', code: 'BUTTONS_ON_ALBUM' };
    const markup = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
    // Every file is read before the first call, so a read failure posts nothing.
    const files = new Map<string, { bytes: Uint8Array; mime: string }>();
    for (const [i, m] of media.entries()) {
      const bytes = await input.readMedia(m.fileId).catch(() => null);
      if (!bytes) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      files.set(`file${i}`, { bytes, mime: m.mime });
    }
    // An upload of up to 10 files (videos up to 50 MB each) takes longer than a text: 30 s, plus 10 s a megabyte, so a
    // slow upload is not cut off after Telegram took the post (which would leave it unclear).
    const megabytes = media.reduce((sum, m) => sum + m.sizeBytes, 0) / 1_000_000;
    const client = new TelegramClient(this.fetchImpl, Math.min(30_000 + Math.ceil(megabytes) * 10_000, 600_000));
    // A silent post (#982): every call of it goes out without a sound; a post as usual sends nothing more.
    const quiet = silentOf(input.settings) ? { disable_notification: true } : {};
    let messageId: unknown;
    try {
      if (media.length === 0) {
        messageId = (await client.call<{ message_id?: unknown }>(s.botToken, 'sendMessage', { chat_id: chat, text, ...quiet, ...markup })).message_id;
      } else if (media.length === 1) {
        const one = media[0] as { mime: string };
        const method = isVideo(one) ? 'sendVideo' : 'sendPhoto';
        messageId = (await client.call<{ message_id?: unknown }>(s.botToken, method, { chat_id: String(chat), [isVideo(one) ? 'video' : 'photo']: 'attach://file0', ...(text ? { caption: text } : {}), ...quiet, ...markup }, files)).message_id;
      } else {
        const group = media.map((m, i) => ({ type: isVideo(m) ? 'video' : 'photo', media: `attach://file${i}`, ...(i === 0 && text ? { caption: text } : {}) }));
        const sent = await client.call<{ message_id?: unknown }[]>(s.botToken, 'sendMediaGroup', { chat_id: String(chat), media: group, ...quiet }, files);
        messageId = sent[0]?.message_id;
      }
    } catch (error) {
      return telegramResult(error);
    }
    if (typeof messageId !== 'number') return { kind: 'unknown', code: 'NO_MESSAGE_ID' };
    return { kind: 'accepted', externalId: `${chat}:${messageId}`, url: s.username ? `https://t.me/${s.username}/${messageId}` : null };
  }

  // Pins the channel's message (#982) with pinChatMessage; an album is named by its first message, which is pinned.
  // disable_notification follows the post's silence (Telegram never announces a pin in a channel, so it only matters
  // elsewhere). A bot without the right to pin is told "not enough rights": TELEGRAM_CANNOT_PIN, for a person to fix in
  // Telegram. Nothing here touches the post.
  async pin(input: PinInput): Promise<CommentResult> {
    const s = telegramSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_BOT_TOKEN' };
    const parts = POST_ID.exec(input.externalId);
    if (!parts || parts[1] !== input.externalAccountId) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    const client = new TelegramClient(this.fetchImpl);
    try {
      await client.call<boolean>(s.botToken, 'pinChatMessage', { chat_id: parts[1], message_id: Number(parts[2]), ...(input.silent ? { disable_notification: true } : {}) });
      return { kind: 'accepted', externalId: input.externalId };
    } catch (error) {
      if (error instanceof TelegramError && (error.status === 400 || error.status === 403) && /not enough rights|CHAT_ADMIN_REQUIRED/i.test(error.message)) {
        return { kind: 'rejected', error: 'permission', code: 'TELEGRAM_CANNOT_PIN', message: error.message };
      }
      return commentResult(telegramResult(error));
    }
  }

  // Deletes the channel's message (#860) with deleteMessage. An album is named by its first message, the one with the
  // caption, so only that one goes. A bot may delete a channel post only within 48 hours of it: Telegram then answers
  // "message can't be deleted", which is TELEGRAM_CANNOT_DELETE (a person removes it in Telegram). A message already
  // gone counts as removed.
  async remove(input: RemoveInput): Promise<RemoveResult> {
    const s = telegramSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_BOT_TOKEN' };
    const parts = POST_ID.exec(input.externalId);
    if (!parts || parts[1] !== input.externalAccountId) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    const client = new TelegramClient(this.fetchImpl);
    try {
      await client.call<boolean>(s.botToken, 'deleteMessage', { chat_id: parts[1], message_id: Number(parts[2]) });
      return { kind: 'removed' };
    } catch (error) {
      if (error instanceof TelegramError && error.status === 400 && /message to delete not found/i.test(error.message)) return { kind: 'removed' };
      if (error instanceof TelegramError && error.status === 400 && /can't be deleted/i.test(error.message)) {
        return { kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_CANNOT_DELETE', message: error.message };
      }
      return removeResult(telegramResult(error));
    }
  }
}
