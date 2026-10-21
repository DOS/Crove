// Discord channels (#832), written from Discord's docs (discord.com/developers/docs/resources/webhook). A server admin
// makes a webhook in the channel's Integrations settings and pastes its URL; no app review, no OAuth.
//
// Connect: the webhook's URL holds its id and token. Get Webhook with Token checks it is an incoming webhook of a
// server's channel. The token is sealed like any credential, with the server and channel ids for post links; the
// webhook's id is the account id.
// Publish: one Execute Webhook call (wait=true, so Discord answers with the message), JSON for text, multipart with up
// to 10 images and videos uploaded with the call (10 MB each, 25 MB in all), so a deployment storing files on local
// disk posts them too. Mentions are never parsed: a post's text cannot ping @everyone, a role or a member. A webhook
// has no idempotency key and cannot read the channel's history, so an unclear answer is left to a person
// (publishSafety 'never').
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, RemoveInput, RemoveResult, RetrySafety } from './index.ts';
import { removeResult } from './comment.ts';
import { holdsLink } from './text.ts';
import { allowlistedFetch, ConnectorError, type Fetch } from './oauth.ts';

export const DISCORD_HOSTS = ['discord.com'] as const;
const API = 'https://discord.com/api/v10';
// A message's content, in UTF-16 code units (Discord counts characters; this never undercounts).
export const DISCORD_TEXT_MAX = 2000;
export const DISCORD_FILE_MAX_BYTES = 10 * 1024 * 1024;
// The whole request, every file together.
export const DISCORD_MESSAGE_MAX_BYTES = 25 * 1024 * 1024;
const FILES_MAX = 10;
const DESCRIPTION_MAX = 1024;
// The hosts a webhook URL is copied from; every call goes to discord.com whatever the URL said.
const URL_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
const WEBHOOK_PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{60,100})\/?$/;
const SNOWFLAKE = /^\d{17,20}$/;
const TOKEN = /^[A-Za-z0-9_-]{60,100}$/;

export interface DiscordSecret {
  token: string;
  // The server and channel the webhook posts to, for message links.
  guildId: string;
  channelId: string;
}

export function discordSecretOf(secret: string): DiscordSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<DiscordSecret>;
    if (typeof s.token !== 'string' || !TOKEN.test(s.token)) return null;
    if (typeof s.guildId !== 'string' || !SNOWFLAKE.test(s.guildId) || typeof s.channelId !== 'string' || !SNOWFLAKE.test(s.channelId)) return null;
    return { token: s.token, guildId: s.guildId, channelId: s.channelId };
  } catch {
    return null;
  }
}

export class DiscordError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly retryAfter: number | null;
  constructor(status: number, body: { code?: unknown; message?: unknown; retry_after?: unknown } | null, retryAfterHeader: string | null = null) {
    super(typeof body?.message === 'string' ? body.message.slice(0, 500) : `Discord answered ${status}`);
    this.status = status;
    this.code = typeof body?.code === 'number' && body.code !== 0 ? body.code : null;
    const header = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
    this.retryAfter = typeof body?.retry_after === 'number' ? body.retry_after : Number.isFinite(header) ? header : null;
  }
}

class DiscordClient {
  private readonly fetch: Fetch;
  constructor(fetchImpl?: Fetch, timeoutMs = 30_000) {
    this.fetch = allowlistedFetch(DISCORD_HOSTS, fetchImpl, timeoutMs);
  }

  // One call on a webhook, or on one of its messages (DELETE). The token is in the path, as the API takes it, and never
  // logged.
  async call<T>(webhookId: string, token: string, init: { method: 'GET' } | { method: 'POST'; body: string | FormData } | { method: 'DELETE'; messageId: string }): Promise<T | null> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.method === 'POST' && typeof init.body === 'string') headers['content-type'] = 'application/json';
    const url = `${API}/webhooks/${webhookId}/${token}${init.method === 'POST' ? '?wait=true' : init.method === 'DELETE' ? `/messages/${init.messageId}` : ''}`;
    const response = await this.fetch(url, { method: init.method, headers, ...(init.method === 'POST' ? { body: init.body } : {}) });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new DiscordError(response.status, json, response.headers.get('retry-after'));
    return json as T | null;
  }
}

// The connect form's field, checked before any call: a webhook URL as Discord shows it.
export function discordLogin(input: { webhookUrl: string }): { webhookId: string; token: string } {
  const invalid = () => new ConnectorError('denied', 'not a Discord webhook URL', 'DISCORD_WEBHOOK_INVALID');
  let url: URL;
  try {
    url = new URL(input.webhookUrl.trim());
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || !URL_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash) throw invalid();
  const match = WEBHOOK_PATH.exec(url.pathname);
  if (!match) throw invalid();
  return { webhookId: match[1] as string, token: match[2] as string };
}

export async function connectDiscord(login: { webhookId: string; token: string }, fetchImpl?: Fetch): Promise<ConnectedAccount> {
  const client = new DiscordClient(fetchImpl, 15_000);
  const refused = () => new ConnectorError('denied', 'Discord refused the webhook', 'DISCORD_WEBHOOK_REFUSED');
  const hook = await client.call<{ type?: unknown; id?: unknown; name?: unknown; channel_id?: unknown; guild_id?: unknown }>(login.webhookId, login.token, { method: 'GET' }).catch((error: unknown) => {
    // A deleted webhook answers 404 (Unknown Webhook), a changed token 401.
    if (error instanceof DiscordError && (error.status === 401 || error.status === 404)) throw refused();
    throw new ConnectorError('provider', 'Discord did not answer');
  });
  // Type 1 is an incoming webhook; a channel follower's (2) or an application's (3) cannot be posted to this way.
  if (!hook || hook.type !== 1 || hook.id !== login.webhookId) throw refused();
  if (typeof hook.channel_id !== 'string' || !SNOWFLAKE.test(hook.channel_id) || typeof hook.guild_id !== 'string' || !SNOWFLAKE.test(hook.guild_id)) throw refused();
  const name = typeof hook.name === 'string' && hook.name.trim() ? hook.name.trim() : 'Discord';
  const secret: DiscordSecret = { token: login.token, guildId: hook.guild_id, channelId: hook.channel_id };
  return { provider: 'discord', externalAccountId: login.webhookId, displayName: name.slice(0, 200), scopes: [], expiresAt: null, secret: JSON.stringify(secret) };
}

const textOf = (content: { body: string; linkUrl: string | null }) => {
  const body = content.body.trim();
  return content.linkUrl && !holdsLink(body, content.linkUrl) ? [body, content.linkUrl].filter(Boolean).join('\n\n') : body;
};
const kindOf = (mime: string) => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : null);
const EXTENSIONS: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const extensionOf = (mime: string) => EXTENSIONS[mime] ?? (/^[a-z0-9]{1,10}$/.exec(mime.split('/')[1] ?? '')?.[0] ?? 'bin');

function discordResult(error: unknown): PublishResult {
  if (!(error instanceof DiscordError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = `DISCORD_${error.code ?? error.status}`;
  const base = { code, message: error.message, httpStatus: error.status };
  if (error.status === 429) return { kind: 'rejected', error: 'rate_limited', ...base, ...(error.retryAfter ? { retryAt: new Date(Date.now() + Math.ceil(error.retryAfter * 1000)) } : {}) };
  // A deleted webhook (10015) or a changed token: the channel needs connecting again.
  if (error.status === 401 || error.status === 404) return { kind: 'rejected', error: 'token_expired', ...base };
  if (error.status === 403) return { kind: 'rejected', error: 'permission', ...base };
  if (error.status === 400 || error.status === 413) return { kind: 'rejected', error: 'bad_request', ...base };
  // A server error may or may not have posted: a webhook cannot be asked.
  return { kind: 'unknown', code, message: error.message };
}

export class DiscordPublisher implements Publisher {
  readonly provider = 'discord' as const;
  readonly publishSafety: RetrySafety = 'never';
  // Uploads of up to 25 MB; the job waits longer than the adapter's own timeout.
  readonly callTimeoutMs = 420_000;
  private readonly fetchImpl: Fetch | undefined;

  constructor(fetchImpl?: Fetch) {
    this.fetchImpl = fetchImpl;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = discordSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_WEBHOOK_TOKEN' };
    if (!SNOWFLAKE.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_WEBHOOK_ID' };
    const text = textOf(input.content);
    const media = input.content.media;
    if (!text && media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' };
    if (text.length > DISCORD_TEXT_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TEXT_TOO_LONG' };
    if (media.length > FILES_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TOO_MANY_MEDIA' };
    if (media.some((m) => !kindOf(m.mime))) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_TYPE_UNSUPPORTED' };
    if (media.some((m) => m.sizeBytes > DISCORD_FILE_MAX_BYTES)) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_TOO_LARGE' };
    if (media.reduce((sum, m) => sum + m.sizeBytes, 0) > DISCORD_MESSAGE_MAX_BYTES) return { kind: 'rejected', error: 'bad_request', code: 'MESSAGE_TOO_LARGE' };
    // Every file is read before the call, so a read failure posts nothing.
    const files: { bytes: Uint8Array; mime: string; filename: string; description: string | null }[] = [];
    for (const [i, m] of media.entries()) {
      const bytes = await input.readMedia(m.fileId).catch(() => null);
      if (!bytes) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
      if (bytes.byteLength > DISCORD_FILE_MAX_BYTES) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_TOO_LARGE' };
      const description = m.altText?.trim() ? m.altText.trim().slice(0, DESCRIPTION_MAX) : null;
      files.push({ bytes, mime: m.mime, filename: `${kindOf(m.mime) as string}-${i + 1}.${extensionOf(m.mime)}`, description });
    }
    // The whole message on what was read, not on the sizes stored.
    if (files.reduce((sum, f) => sum + f.bytes.byteLength, 0) > DISCORD_MESSAGE_MAX_BYTES) return { kind: 'rejected', error: 'bad_request', code: 'MESSAGE_TOO_LARGE' };
    // Mentions are never parsed, whatever the text holds.
    const payload = {
      ...(text ? { content: text } : {}),
      allowed_mentions: { parse: [] },
      ...(files.length > 0 ? { attachments: files.map((f, i) => ({ id: i, filename: f.filename, ...(f.description ? { description: f.description } : {}) })) } : {}),
    };
    let body: string | FormData;
    if (files.length === 0) {
      body = JSON.stringify(payload);
    } else {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      for (const [i, f] of files.entries()) form.append(`files[${i}]`, new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.mime }), f.filename);
      body = form;
    }
    // An upload takes longer than a text: 30 s, plus 10 s a megabyte, so a slow upload is not cut off after Discord
    // took the post (which would leave it unclear).
    const megabytes = files.reduce((sum, f) => sum + f.bytes.byteLength, 0) / 1_000_000;
    const client = new DiscordClient(this.fetchImpl, Math.min(30_000 + Math.ceil(megabytes) * 10_000, 600_000));
    let message: { id?: unknown } | null;
    try {
      message = await client.call<{ id?: unknown }>(input.externalAccountId, s.token, { method: 'POST', body });
    } catch (error) {
      return discordResult(error);
    }
    const messageId = message?.id;
    if (typeof messageId !== 'string' || !/^\d{1,20}$/.test(messageId)) return { kind: 'unknown', code: 'NO_MESSAGE_ID' };
    return { kind: 'accepted', externalId: messageId, url: `https://discord.com/channels/${s.guildId}/${s.channelId}/${messageId}` };
  }

  // Deletes the webhook's message (#860): DELETE /webhooks/{id}/{token}/messages/{message}, answered 204. A message
  // already gone (Unknown Message, 10008) counts as removed; a webhook gone (10015) or a changed token needs connecting
  // again.
  async remove(input: RemoveInput): Promise<RemoveResult> {
    const s = discordSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_WEBHOOK_TOKEN' };
    if (!SNOWFLAKE.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_WEBHOOK_ID' };
    if (!/^\d{1,20}$/.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    const client = new DiscordClient(this.fetchImpl);
    try {
      await client.call(input.externalAccountId, s.token, { method: 'DELETE', messageId: input.externalId });
      return { kind: 'removed' };
    } catch (error) {
      if (error instanceof DiscordError && error.status === 404 && error.code === 10008) return { kind: 'removed' };
      return removeResult(discordResult(error));
    }
  }
}
