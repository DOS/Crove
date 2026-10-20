// Telegram against recorded Bot API answers (shapes from core.telegram.org/bots/api); no live call.
import { describe, expect, it } from 'vitest';
import { connectTelegram, telegramLogin, TelegramPublisher, telegramSecretOf, type Fetch, type PublishInput } from '../src/index.ts';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';
const CHAT = '-1001234567890';
const SECRET = JSON.stringify({ botToken: TOKEN, username: 'quanpho' });

type Call = { method: string; json: Record<string, unknown> | null; form: FormData | null; token: string };

function bot(answers: Record<string, { status?: number; body: unknown }[]>) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const [, tokenPart, method] = url.pathname.split('/') as [string, string, string];
    const form = init?.body instanceof FormData ? init.body : null;
    calls.push({ method, token: tokenPart.replace(/^bot/, ''), json: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null, form });
    const answer = answers[method]?.shift() ?? { status: 500, body: { ok: false, error_code: 500, description: `no answer for ${method}` } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const ok = (result: unknown) => ({ body: { ok: true, result } });
const fail = (status: number, description: string, extra: Record<string, unknown> = {}) => ({ status, body: { ok: false, error_code: status, description, ...extra } });

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: CHAT,
  secret: SECRET,
  content: { body: 'Khai trương! Xem https://example.com/a', title: null, linkUrl: null, media: [] },
  readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
  mediaUrl: async () => null,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});
const photo = (fileId: string) => ({ fileId, mime: 'image/jpeg', sizeBytes: 3, altText: null });
const video = (fileId: string) => ({ fileId, mime: 'video/mp4', sizeBytes: 3, altText: null });

describe('Telegram connect', () => {
  it('checks the bot, the channel and its right to post, then connects the channel by its id', async () => {
    const { fetchImpl, calls } = bot({
      getMe: [ok({ id: 987654321, is_bot: true, username: 'quanpho_bot' })],
      getChat: [ok({ id: -1001234567890, type: 'channel', title: 'Quán Phở', username: 'quanpho' })],
      getChatMember: [ok({ status: 'administrator', can_post_messages: true })],
    });
    const account = await connectTelegram(telegramLogin({ botToken: TOKEN, channel: 'https://t.me/quanpho' }), fetchImpl);
    expect(account).toEqual({ provider: 'telegram', externalAccountId: CHAT, displayName: 'Quán Phở', scopes: [], expiresAt: null, secret: SECRET });
    expect(calls.map((c) => c.method)).toEqual(['getMe', 'getChat', 'getChatMember']);
    expect(calls[1]?.json).toEqual({ chat_id: '@quanpho' });
    expect(calls[2]?.json).toEqual({ chat_id: -1001234567890, user_id: 987654321 });
  });

  it('refuses a malformed token or channel before any call', () => {
    expect(() => telegramLogin({ botToken: 'not-a-token', channel: '@quanpho' })).toThrow(expect.objectContaining({ code: 'TELEGRAM_TOKEN_INVALID' }));
    expect(() => telegramLogin({ botToken: TOKEN, channel: 'quán phở' })).toThrow(expect.objectContaining({ code: 'TELEGRAM_CHANNEL_INVALID' }));
    expect(telegramLogin({ botToken: ` ${TOKEN} `, channel: CHAT })).toEqual({ botToken: TOKEN, channel: CHAT });
  });

  it('says why a channel cannot connect: a refused token, an unknown chat, a group, a bot that may not post', async () => {
    const connect = (answers: Parameters<typeof bot>[0]) => connectTelegram({ botToken: TOKEN, channel: '@quanpho' }, bot(answers).fetchImpl);
    const me = () => [ok({ id: 1, is_bot: true })];
    await expect(connect({ getMe: [fail(401, 'Unauthorized')] })).rejects.toMatchObject({ code: 'TELEGRAM_TOKEN_REFUSED' });
    await expect(connect({ getMe: [fail(404, 'Not Found')] })).rejects.toMatchObject({ code: 'TELEGRAM_TOKEN_REFUSED' });
    await expect(connect({ getMe: me(), getChat: [fail(400, 'Bad Request: chat not found')] })).rejects.toMatchObject({ code: 'TELEGRAM_CHANNEL_NOT_FOUND' });
    await expect(connect({ getMe: me(), getChat: [ok({ id: -1001, type: 'supergroup', title: 'Nhóm' })] })).rejects.toMatchObject({ code: 'TELEGRAM_NOT_A_CHANNEL' });
    await expect(
      connect({ getMe: me(), getChat: [ok({ id: -1001, type: 'channel', title: 'Kênh' })], getChatMember: [ok({ status: 'administrator', can_post_messages: false })] }),
    ).rejects.toMatchObject({ code: 'TELEGRAM_BOT_CANNOT_POST' });
    await expect(connect({ getMe: me(), getChat: [ok({ id: -1001, type: 'channel', title: 'Kênh' })], getChatMember: [ok({ status: 'member' })] })).rejects.toMatchObject({ code: 'TELEGRAM_BOT_CANNOT_POST' });
    await expect(connect({ getMe: [fail(502, 'Bad Gateway')] })).rejects.toMatchObject({ kind: 'provider' });
  });

  it('reads back only a well-formed sealed secret', () => {
    expect(telegramSecretOf(SECRET)).toEqual({ botToken: TOKEN, username: 'quanpho' });
    expect(telegramSecretOf(JSON.stringify({ botToken: TOKEN, username: null }))).toEqual({ botToken: TOKEN, username: null });
    expect(telegramSecretOf(JSON.stringify({ botToken: 'x' }))).toBeNull();
    expect(telegramSecretOf('not json')).toBeNull();
  });
});

describe('Telegram publish', () => {
  it('sends text as a message, adding a link the text does not hold', async () => {
    const { fetchImpl, calls } = bot({ sendMessage: [ok({ message_id: 42 })] });
    const result = await new TelegramPublisher(fetchImpl).publish(input({ content: { body: 'Khai trương!', title: null, linkUrl: 'https://example.com/a', media: [] } }));
    expect(result).toEqual({ kind: 'accepted', externalId: `${CHAT}:42`, url: 'https://t.me/quanpho/42' });
    expect(calls[0]?.token).toBe(TOKEN);
    expect(calls[0]?.json).toEqual({ chat_id: CHAT, text: 'Khai trương!\n\nhttps://example.com/a' });
  });

  it('uploads one photo with its caption, and a private channel has no post link', async () => {
    const { fetchImpl, calls } = bot({ sendPhoto: [ok({ message_id: 7 })] });
    const result = await new TelegramPublisher(fetchImpl).publish(input({ secret: JSON.stringify({ botToken: TOKEN, username: null }), content: { body: 'Món mới', title: null, linkUrl: null, media: [photo('f1')] } }));
    expect(result).toEqual({ kind: 'accepted', externalId: `${CHAT}:7`, url: null });
    const form = calls[0]?.form as FormData;
    expect(form.get('chat_id')).toBe(CHAT);
    expect(form.get('photo')).toBe('attach://file0');
    expect(form.get('caption')).toBe('Món mới');
    expect(form.get('file0')).toBeInstanceOf(Blob);
  });

  it('sends a video with sendVideo and an album with sendMediaGroup, the caption on the first item', async () => {
    const one = bot({ sendVideo: [ok({ message_id: 8 })] });
    await new TelegramPublisher(one.fetchImpl).publish(input({ content: { body: '', title: null, linkUrl: null, media: [video('v1')] } }));
    expect(one.calls[0]?.method).toBe('sendVideo');
    expect(one.calls[0]?.form?.get('caption')).toBeNull();

    const album = bot({ sendMediaGroup: [ok([{ message_id: 9 }, { message_id: 10 }])] });
    const result = await new TelegramPublisher(album.fetchImpl).publish(input({ content: { body: 'Album', title: null, linkUrl: null, media: [photo('f1'), video('v1')] } }));
    expect(result).toMatchObject({ kind: 'accepted', externalId: `${CHAT}:9` });
    const form = album.calls[0]?.form as FormData;
    expect(JSON.parse(form.get('media') as string)).toEqual([
      { type: 'photo', media: 'attach://file0', caption: 'Album' },
      { type: 'video', media: 'attach://file1' },
    ]);
    expect(form.get('file1')).toBeInstanceOf(Blob);
  });

  it('refuses what Telegram would refuse without calling it, and posts nothing when a file cannot be read', async () => {
    const { fetchImpl, calls } = bot({});
    const publisher = new TelegramPublisher(fetchImpl);
    expect(await publisher.publish(input({ content: { body: 'x'.repeat(1025), title: null, linkUrl: null, media: [photo('f1')] } }))).toMatchObject({ kind: 'rejected', code: 'CAPTION_TOO_LONG' });
    expect(await publisher.publish(input({ content: { body: 'x'.repeat(4097), title: null, linkUrl: null, media: [] } }))).toMatchObject({ kind: 'rejected', code: 'TEXT_TOO_LONG' });
    expect(await publisher.publish(input({ content: { body: '', title: null, linkUrl: null, media: [] } }))).toMatchObject({ kind: 'rejected', code: 'EMPTY_POST' });
    expect(await publisher.publish(input({ externalAccountId: '@quanpho' }))).toMatchObject({ kind: 'rejected', code: 'BAD_CHAT_ID' });
    expect(await publisher.publish(input({ secret: '{}' }))).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    const unreadable = input({ content: { body: 'x', title: null, linkUrl: null, media: [photo('f1')] }, readMedia: async () => Promise.reject(new Error('gone')) });
    expect(await publisher.publish(unreadable)).toMatchObject({ kind: 'rejected', code: 'MEDIA_UNREADABLE' });
    expect(calls).toHaveLength(0);
  });

  it('maps answers: a flood wait to a retry time, a revoked token, a removed bot, and an unclear server error', async () => {
    const answers = { sendMessage: [fail(429, 'Too Many Requests: retry after 30', { parameters: { retry_after: 30 } }), fail(401, 'Unauthorized'), fail(403, 'Forbidden: bot is not a member of the channel chat'), fail(400, 'Bad Request: message is too long'), fail(500, 'Internal Server Error')] };
    const publisher = new TelegramPublisher(bot(answers).fetchImpl);
    const before = Date.now();
    const limited = await publisher.publish(input());
    expect(limited).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: 'TELEGRAM_429' });
    expect((limited as { retryAt: Date }).retryAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'permission' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'bad_request' });
    // Telegram cannot be asked whether a message went out, so a server error stays unclear.
    expect(await publisher.publish(input())).toMatchObject({ kind: 'unknown', code: 'TELEGRAM_500' });
    expect(publisher.publishSafety).toBe('never');
  });

  it('never calls a host other than the Bot API', async () => {
    const seen: string[] = [];
    const fetchImpl: Fetch = async (url) => {
      seen.push(new URL(url).host);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    };
    await new TelegramPublisher(fetchImpl).publish(input());
    expect(seen).toEqual(['api.telegram.org']);
  });
});
