// Telegram against recorded Bot API answers (shapes from core.telegram.org/bots/api); no live call.
import { describe, expect, it } from 'vitest';
import { checkTelegramChat, connectTelegram, sendTelegramText, telegramChatLogin, telegramChatTargetOf, telegramLogin, TELEGRAM_PIN_SCOPE, TelegramPublisher, telegramSecretOf, type Fetch, type PublishInput } from '../src/index.ts';

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

  it('reads whether the bot may pin (#982): in a channel that is the right to edit messages, or owning it', async () => {
    const connect = (member: Record<string, unknown>) =>
      connectTelegram(
        { botToken: TOKEN, channel: '@quanpho' },
        bot({ getMe: [ok({ id: 1, is_bot: true })], getChat: [ok({ id: -1001234567890, type: 'channel', title: 'Quán Phở' })], getChatMember: [ok(member)] }).fetchImpl,
      );
    expect((await connect({ status: 'administrator', can_post_messages: true, can_edit_messages: true })).scopes).toEqual([TELEGRAM_PIN_SCOPE]);
    expect((await connect({ status: 'creator' })).scopes).toEqual([TELEGRAM_PIN_SCOPE]);
    expect((await connect({ status: 'administrator', can_post_messages: true, can_edit_messages: false })).scopes).toEqual([]);
    // can_pin_messages is a group's right: a channel's bot with it alone still may not pin.
    expect((await connect({ status: 'administrator', can_post_messages: true, can_pin_messages: true })).scopes).toEqual([]);
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

  it('sends a silent post with disable_notification on every send call, and a post as usual without it (#982)', async () => {
    const silent = { telegram: { silent: true } };
    const text = bot({ sendMessage: [ok({ message_id: 1 })] });
    await new TelegramPublisher(text.fetchImpl).publish(input({ settings: silent }));
    expect(text.calls[0]?.json).toEqual({ chat_id: CHAT, text: 'Khai trương! Xem https://example.com/a', disable_notification: true });

    const one = bot({ sendPhoto: [ok({ message_id: 2 })], sendVideo: [ok({ message_id: 3 })] });
    const publisher = new TelegramPublisher(one.fetchImpl);
    await publisher.publish(input({ settings: silent, content: { body: 'Món mới', title: null, linkUrl: null, media: [photo('f1')] } }));
    await publisher.publish(input({ settings: silent, content: { body: '', title: null, linkUrl: null, media: [video('v1')] } }));
    expect(one.calls.map((c) => [c.method, c.form?.get('disable_notification')])).toEqual([
      ['sendPhoto', 'true'],
      ['sendVideo', 'true'],
    ]);

    const album = bot({ sendMediaGroup: [ok([{ message_id: 4 }, { message_id: 5 }])] });
    await new TelegramPublisher(album.fetchImpl).publish(input({ settings: silent, content: { body: 'Album', title: null, linkUrl: null, media: [photo('f1'), photo('f2')] } }));
    expect(album.calls[0]?.form?.get('disable_notification')).toBe('true');

    // Unset, false or a malformed value: nothing more is sent.
    const usual = bot({ sendMessage: [ok({ message_id: 6 }), ok({ message_id: 7 })], sendPhoto: [ok({ message_id: 8 })], sendMediaGroup: [ok([{ message_id: 9 }])] });
    const plain = new TelegramPublisher(usual.fetchImpl);
    await plain.publish(input({ settings: { telegram: { silent: false, pin: true } } }));
    await plain.publish(input({ settings: { telegram: 'silent' } }));
    await plain.publish(input({ content: { body: 'Món mới', title: null, linkUrl: null, media: [photo('f1')] } }));
    await plain.publish(input({ content: { body: 'Album', title: null, linkUrl: null, media: [photo('f1'), photo('f2')] } }));
    expect(usual.calls.map((c) => (c.json ? 'disable_notification' in c.json : c.form?.has('disable_notification')))).toEqual([false, false, false, false]);
  });

  describe('link buttons (#1017)', () => {
    const rows = [[{ text: 'Mua ngay', url: 'https://shop.example/pho?utm_source=telegram' }, { text: 'Zalo', url: 'https://zalo.me/0901234567' }], [{ text: ' Bản đồ ', url: 'https://maps.example/quan-pho' }]];
    const keyboard = { inline_keyboard: [[{ text: 'Mua ngay', url: 'https://shop.example/pho?utm_source=telegram' }, { text: 'Zalo', url: 'https://zalo.me/0901234567' }], [{ text: 'Bản đồ', url: 'https://maps.example/quan-pho' }]] };
    const settings = { telegram: { silent: true, buttons: rows } };

    it('sends the buttons as the inline keyboard of a text post', async () => {
      const { fetchImpl, calls } = bot({ sendMessage: [ok({ message_id: 11 })] });
      expect(await new TelegramPublisher(fetchImpl).publish(input({ settings }))).toMatchObject({ kind: 'accepted', externalId: `${CHAT}:11` });
      expect(calls[0]).toEqual({ method: 'sendMessage', token: TOKEN, form: null, json: { chat_id: CHAT, text: 'Khai trương! Xem https://example.com/a', disable_notification: true, reply_markup: keyboard } });
    });

    it('sends them as JSON in the form of a photo and of a video', async () => {
      const { fetchImpl, calls } = bot({ sendPhoto: [ok({ message_id: 12 })], sendVideo: [ok({ message_id: 13 })] });
      const publisher = new TelegramPublisher(fetchImpl);
      await publisher.publish(input({ settings, content: { body: 'Món mới', title: null, linkUrl: null, media: [photo('f1')] } }));
      await publisher.publish(input({ settings: { telegram: { buttons: rows } }, content: { body: '', title: null, linkUrl: null, media: [video('v1')] } }));
      expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendVideo']);
      for (const call of calls) expect(JSON.parse(call.form?.get('reply_markup') as string)).toEqual(keyboard);
      expect(calls[0]?.form?.get('caption')).toBe('Món mới');
      expect(calls[1]?.form?.has('disable_notification')).toBe(false);
    });

    it('sends no keyboard without buttons', async () => {
      const { fetchImpl, calls } = bot({ sendMessage: [ok({ message_id: 14 })], sendPhoto: [ok({ message_id: 15 })] });
      const publisher = new TelegramPublisher(fetchImpl);
      await publisher.publish(input({ settings: { telegram: { pin: true } } }));
      await publisher.publish(input({ content: { body: 'Món mới', title: null, linkUrl: null, media: [photo('f1')] } }));
      expect(calls[0]?.json).not.toHaveProperty('reply_markup');
      expect(calls[1]?.form?.has('reply_markup')).toBe(false);
    });

    it('refuses buttons on an album, and buttons Telegram would refuse or should never open, with nothing sent', async () => {
      const { fetchImpl, calls } = bot({});
      const publisher = new TelegramPublisher(fetchImpl);
      const album = { body: 'Album', title: null, linkUrl: null, media: [photo('f1'), photo('f2')] };
      expect(await publisher.publish(input({ settings: { telegram: { buttons: rows } }, content: album }))).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BUTTONS_ON_ALBUM' });
      const refused = (buttons: unknown) => publisher.publish(input({ settings: { telegram: { buttons } } }));
      const button = (over: Record<string, unknown> = {}) => ({ text: 'Mua ngay', url: 'https://shop.example/', ...over });
      for (const buttons of [
        [[button({ url: 'javascript:alert(1)' })]],
        [[button({ url: 'http://shop.example/' })]],
        [[button({ url: 'tg://resolve?domain=quanpho' })]],
        [[button({ url: 'https://shop.example/a b' })]],
        [[button({ url: 'https://user:pass@shop.example/' })]],
        [[button({ url: `https://shop.example/a${String.fromCodePoint(0x200b)}b` })]],
        [[button({ text: 'x'.repeat(65) })]],
        [[button({ text: '   ' })]],
        [[button(), button(), button(), button()]],
        [[button()], [button()], [button()], [button()]],
        [],
        [[]],
        'Mua ngay',
      ]) {
        expect(await refused(buttons)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BUTTONS_INVALID' });
      }
      expect(calls).toHaveLength(0);
      // 64 characters, counted as Vietnamese letters rather than UTF-16 units, and a full 3 by 3 grid go out.
      const full = bot({ sendMessage: [ok({ message_id: 16 }), ok({ message_id: 17 })] });
      const label = 'ắ'.repeat(64).normalize('NFD');
      await new TelegramPublisher(full.fetchImpl).publish(input({ settings: { telegram: { buttons: [[button({ text: label })]] } } }));
      await new TelegramPublisher(full.fetchImpl).publish(input({ settings: { telegram: { buttons: [0, 1, 2].map(() => [button(), button(), button()]) } } }));
      expect(full.calls.map((c) => (c.json?.reply_markup as { inline_keyboard: unknown[][] } | undefined)?.inline_keyboard.flat().length)).toEqual([1, 9]);
    });
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

describe('Telegram team alerts (#863)', () => {
  it('reads a chat as @name, t.me link or numeric id, groups and private chats included, before any call', () => {
    expect(telegramChatLogin({ botToken: ` ${TOKEN} `, chatId: 'https://t.me/nhomshop' })).toEqual({ botToken: TOKEN, chat: '@nhomshop' });
    expect(telegramChatLogin({ botToken: TOKEN, chatId: '-4012345678' })).toEqual({ botToken: TOKEN, chat: '-4012345678' });
    expect(telegramChatLogin({ botToken: TOKEN, chatId: ' 123456789 ' })).toEqual({ botToken: TOKEN, chat: '123456789' });
    expect(() => telegramChatLogin({ botToken: 'x', chatId: '@nhomshop' })).toThrow(expect.objectContaining({ code: 'TELEGRAM_TOKEN_INVALID' }));
    expect(() => telegramChatLogin({ botToken: TOKEN, chatId: 'nhóm shop' })).toThrow(expect.objectContaining({ code: 'TELEGRAM_CHAT_INVALID' }));
  });

  it('checks the bot, the chat and its right to write there, and names the chat by its title', async () => {
    const { fetchImpl, calls } = bot({
      getMe: [ok({ id: 987654321, is_bot: true })],
      getChat: [ok({ id: -4012345678, type: 'group', title: 'Nhóm bán hàng' })],
      getChatMember: [ok({ status: 'member' })],
    });
    const checked = await checkTelegramChat({ botToken: TOKEN, chat: '-4012345678' }, fetchImpl);
    expect(checked).toEqual({ target: { botToken: TOKEN, chatId: '-4012345678' }, label: 'Nhóm bán hàng' });
    expect(calls.map((c) => c.method)).toEqual(['getMe', 'getChat', 'getChatMember']);
    expect(calls[2]?.json).toEqual({ chat_id: -4012345678, user_id: 987654321 });
    // A private chat with the bot needs no member check; it is named after the person.
    const dm = bot({ getMe: [ok({ id: 1, is_bot: true })], getChat: [ok({ id: 123456789, type: 'private', first_name: 'Lan' })] });
    expect(await checkTelegramChat({ botToken: TOKEN, chat: '123456789' }, dm.fetchImpl)).toEqual({ target: { botToken: TOKEN, chatId: '123456789' }, label: 'Lan' });
    expect(dm.calls.map((c) => c.method)).toEqual(['getMe', 'getChat']);
  });

  it('says why a chat cannot get alerts: a refused token, an unknown chat, a bot that may not write', async () => {
    const check = (answers: Parameters<typeof bot>[0]) => checkTelegramChat({ botToken: TOKEN, chat: '@nhomshop' }, bot(answers).fetchImpl);
    const me = () => [ok({ id: 1, is_bot: true })];
    const group = () => [ok({ id: -1001, type: 'supergroup', title: 'Nhóm' })];
    await expect(check({ getMe: [fail(401, 'Unauthorized')] })).rejects.toMatchObject({ code: 'TELEGRAM_TOKEN_REFUSED' });
    await expect(check({ getMe: me(), getChat: [fail(400, 'Bad Request: chat not found')] })).rejects.toMatchObject({ code: 'TELEGRAM_CHAT_NOT_FOUND' });
    await expect(check({ getMe: me(), getChat: group(), getChatMember: [ok({ status: 'left' })] })).rejects.toMatchObject({ code: 'TELEGRAM_BOT_CANNOT_SEND' });
    await expect(check({ getMe: me(), getChat: group(), getChatMember: [ok({ status: 'restricted', can_send_messages: false })] })).rejects.toMatchObject({ code: 'TELEGRAM_BOT_CANNOT_SEND' });
    await expect(check({ getMe: me(), getChat: [ok({ id: -1001, type: 'channel', title: 'Kênh' })], getChatMember: [ok({ status: 'member' })] })).rejects.toMatchObject({ code: 'TELEGRAM_BOT_CANNOT_SEND' });
    await expect(check({ getMe: [fail(502, 'Bad Gateway')] })).rejects.toMatchObject({ kind: 'provider' });
  });

  it('sends one line of plain text without a link preview, and reads back only a well-formed target', async () => {
    const line = 'Bài «Khai trương» đang chờ duyệt: https://crove.example/o/shop/social/1';
    const { fetchImpl, calls } = bot({ sendMessage: [ok({ message_id: 7 })] });
    await sendTelegramText({ botToken: TOKEN, chatId: '-4012345678' }, line, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe(TOKEN);
    expect(calls[0]?.json).toEqual({ chat_id: '-4012345678', text: line, link_preview_options: { is_disabled: true } });
    const refused = bot({ sendMessage: [fail(403, 'Forbidden: bot was kicked from the group chat')] });
    await expect(sendTelegramText({ botToken: TOKEN, chatId: '-4012345678' }, 'x', refused.fetchImpl)).rejects.toMatchObject({ status: 403 });
    await expect(sendTelegramText({ botToken: TOKEN, chatId: '-4012345678' }, '', refused.fetchImpl)).rejects.toMatchObject({ status: 400 });
    expect(telegramChatTargetOf(JSON.stringify({ botToken: TOKEN, chatId: '-4012345678' }))).toEqual({ botToken: TOKEN, chatId: '-4012345678' });
    expect(telegramChatTargetOf(JSON.stringify({ botToken: TOKEN, chatId: '@nhomshop' }))).toBeNull();
    expect(telegramChatTargetOf('not json')).toBeNull();
  });
});

describe('Telegram pin (#982)', () => {
  const pin = (fetchImpl: Fetch, over: { externalId?: string; silent?: boolean } = {}) =>
    new TelegramPublisher(fetchImpl).pin({ externalAccountId: CHAT, secret: SECRET, externalId: over.externalId ?? `${CHAT}:42`, silent: over.silent ?? false, callKey: 'pin-1' });

  it('pins the message named by the post id, silently when the post was silent', async () => {
    const { fetchImpl, calls } = bot({ pinChatMessage: [ok(true), ok(true)] });
    expect(await pin(fetchImpl)).toEqual({ kind: 'accepted', externalId: `${CHAT}:42` });
    expect(await pin(fetchImpl, { silent: true })).toEqual({ kind: 'accepted', externalId: `${CHAT}:42` });
    expect(calls).toEqual([
      { method: 'pinChatMessage', token: TOKEN, json: { chat_id: CHAT, message_id: 42 }, form: null },
      { method: 'pinChatMessage', token: TOKEN, json: { chat_id: CHAT, message_id: 42, disable_notification: true }, form: null },
    ]);
  });

  it('says when the bot may not pin, and maps a revoked token and a server error', async () => {
    const refused = bot({ pinChatMessage: [fail(400, 'Bad Request: not enough rights to manage pinned messages in the chat')] });
    expect(await pin(refused.fetchImpl)).toEqual({ kind: 'rejected', error: 'permission', code: 'TELEGRAM_CANNOT_PIN', message: 'Bad Request: not enough rights to manage pinned messages in the chat' });
    const admin = bot({ pinChatMessage: [fail(400, 'Bad Request: CHAT_ADMIN_REQUIRED')] });
    expect(await pin(admin.fetchImpl)).toMatchObject({ kind: 'rejected', code: 'TELEGRAM_CANNOT_PIN' });
    const revoked = bot({ pinChatMessage: [fail(401, 'Unauthorized')] });
    expect(await pin(revoked.fetchImpl)).toEqual({ kind: 'rejected', error: 'token_expired', code: 'TELEGRAM_401', message: 'Unauthorized' });
    const down = bot({ pinChatMessage: [fail(502, 'Bad Gateway')] });
    expect(await pin(down.fetchImpl)).toEqual({ kind: 'unknown', code: 'TELEGRAM_502' });
  });

  it('calls nothing for a post of another chat or without a bot token', async () => {
    const none = bot({});
    expect(await pin(none.fetchImpl, { externalId: '-1009999999999:42' })).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await new TelegramPublisher(none.fetchImpl).pin({ externalAccountId: CHAT, secret: '{}', externalId: `${CHAT}:42`, silent: false, callKey: 'pin-1' })).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(none.calls).toHaveLength(0);
  });
});

describe('Telegram remove (#860)', () => {
  const remove = (fetchImpl: Fetch, externalId = `${CHAT}:42`) => new TelegramPublisher(fetchImpl).remove({ externalAccountId: CHAT, secret: SECRET, externalId });

  it('deletes the channel message named by the post id', async () => {
    const { fetchImpl, calls } = bot({ deleteMessage: [ok(true)] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
    expect(calls).toEqual([{ method: 'deleteMessage', token: TOKEN, json: { chat_id: CHAT, message_id: 42 }, form: null }]);
  });

  it('counts a message already gone as removed, and says when Telegram no longer lets the bot delete it', async () => {
    const gone = bot({ deleteMessage: [fail(400, 'Bad Request: message to delete not found')] });
    expect(await remove(gone.fetchImpl)).toEqual({ kind: 'removed' });
    // Past 48 hours a bot may not delete a channel post.
    const old = bot({ deleteMessage: [fail(400, "Bad Request: message can't be deleted")] });
    expect(await remove(old.fetchImpl)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'TELEGRAM_CANNOT_DELETE', message: "Bad Request: message can't be deleted" });
  });

  it('maps a revoked token, a flood wait and a server error, and calls nothing for another chat', async () => {
    const revoked = bot({ deleteMessage: [fail(401, 'Unauthorized')] });
    expect(await remove(revoked.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'TELEGRAM_401' });
    const flood = bot({ deleteMessage: [fail(429, 'Too Many Requests: retry after 7', { parameters: { retry_after: 7 } })] });
    const limited = await remove(flood.fetchImpl);
    expect(limited).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
    expect(limited.kind === 'rejected' && limited.retryAt instanceof Date).toBe(true);
    const down = bot({ deleteMessage: [fail(502, 'Bad Gateway')] });
    expect(await remove(down.fetchImpl)).toEqual({ kind: 'unknown', code: 'TELEGRAM_502' });
    const none = bot({});
    expect(await remove(none.fetchImpl, '-1009999999999:42')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(none.calls).toHaveLength(0);
  });
});
