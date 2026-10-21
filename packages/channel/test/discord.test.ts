// Discord against recorded webhook answers (shapes from discord.com/developers/docs/resources/webhook); no live call.
import { describe, expect, it } from 'vitest';
import { connectDiscord, discordChatTargetOf, discordLogin, DiscordPublisher, discordSecretOf, DISCORD_FILE_MAX_BYTES, sendDiscordText, type Fetch, type PublishInput } from '../src/index.ts';

const HOOK = '1234567890123456789';
const TOKEN = `tok_${'A1b2C3d4'.repeat(8)}`;
const GUILD = '987654321098765432';
const CHANNEL = '876543210987654321';
const SECRET = JSON.stringify({ token: TOKEN, guildId: GUILD, channelId: CHANNEL });
const URL_OF = `https://discord.com/api/webhooks/${HOOK}/${TOKEN}`;

type Call = { method: string; url: URL; json: Record<string, unknown> | null; form: FormData | null };

function discord(answers: { status?: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const form = init?.body instanceof FormData ? init.body : null;
    calls.push({ method: init?.method ?? 'GET', url: new URL(input), json: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null, form });
    const answer = answers.shift() ?? { status: 500, body: { code: 0, message: 'no answer' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json', ...answer.headers } });
  };
  return { calls, fetchImpl };
}

const webhook = (over: Record<string, unknown> = {}) => ({ body: { type: 1, id: HOOK, name: ' Crove bot ', channel_id: CHANNEL, guild_id: GUILD, application_id: null, token: TOKEN, ...over } });
const fail = (status: number, code: number, message: string, extra: Record<string, unknown> = {}) => ({ status, body: { code, message, ...extra } });

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: HOOK,
  secret: SECRET,
  content: { body: 'Khai trương! Xem https://example.com/a', title: null, linkUrl: null, media: [] },
  readMedia: async () => new Uint8Array([0xff, 0xd8, 0xff]),
  mediaUrl: async () => null,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});
const photo = (fileId: string, altText: string | null = null) => ({ fileId, mime: 'image/jpeg', sizeBytes: 3, altText });
const content = (body: string, media: PublishInput['content']['media'] = []) => ({ body, title: null, linkUrl: null, media });

describe('Discord connect', () => {
  it('reads a webhook URL as Discord shows it, on any of its hosts, and always calls discord.com', () => {
    expect(discordLogin({ webhookUrl: ` ${URL_OF} ` })).toEqual({ webhookId: HOOK, token: TOKEN });
    expect(discordLogin({ webhookUrl: `https://discordapp.com/api/webhooks/${HOOK}/${TOKEN}` })).toEqual({ webhookId: HOOK, token: TOKEN });
    expect(discordLogin({ webhookUrl: `https://canary.discord.com/api/v10/webhooks/${HOOK}/${TOKEN}/` })).toEqual({ webhookId: HOOK, token: TOKEN });
    expect(discordLogin({ webhookUrl: `https://ptb.discord.com/api/webhooks/${HOOK}/${TOKEN}` })).toEqual({ webhookId: HOOK, token: TOKEN });
  });

  it('refuses anything else before any call', () => {
    const invalid = expect.objectContaining({ code: 'DISCORD_WEBHOOK_INVALID' });
    for (const webhookUrl of [
      `https://evil.example/api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com.evil.example/api/webhooks/${HOOK}/${TOKEN}`,
      `http://discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com/api/webhooks/${HOOK}/short-token`,
      `https://discord.com/api/webhooks/123/${TOKEN}`,
      `${URL_OF}?thread_id=1`,
      `${URL_OF}#x`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN}/slack`,
      'not a url',
    ]) {
      expect(() => discordLogin({ webhookUrl }), webhookUrl).toThrow(invalid);
    }
  });

  it('checks the webhook is an incoming one of a server channel, then connects it by its id', async () => {
    const { fetchImpl, calls } = discord([webhook()]);
    const account = await connectDiscord(discordLogin({ webhookUrl: URL_OF }), fetchImpl);
    expect(account).toEqual({ provider: 'discord', externalAccountId: HOOK, displayName: 'Crove bot', scopes: [], expiresAt: null, secret: SECRET });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.host).toBe('discord.com');
    expect(calls[0]?.url.pathname).toBe(`/api/v10/webhooks/${HOOK}/${TOKEN}`);
  });

  it('names a webhook without a name Discord', async () => {
    const account = await connectDiscord({ webhookId: HOOK, token: TOKEN }, discord([webhook({ name: '  ' })]).fetchImpl);
    expect(account.displayName).toBe('Discord');
  });

  it('says why a webhook cannot connect: deleted, a changed token, not an incoming webhook, and a Discord outage', async () => {
    const connect = (answer: Parameters<typeof discord>[0][number]) => connectDiscord({ webhookId: HOOK, token: TOKEN }, discord([answer]).fetchImpl);
    await expect(connect(fail(404, 10015, 'Unknown Webhook'))).rejects.toMatchObject({ code: 'DISCORD_WEBHOOK_REFUSED' });
    await expect(connect(fail(401, 50027, 'Invalid Webhook Token'))).rejects.toMatchObject({ code: 'DISCORD_WEBHOOK_REFUSED' });
    await expect(connect(webhook({ type: 2 }))).rejects.toMatchObject({ code: 'DISCORD_WEBHOOK_REFUSED' });
    await expect(connect(webhook({ id: '1111111111111111111' }))).rejects.toMatchObject({ code: 'DISCORD_WEBHOOK_REFUSED' });
    await expect(connect(webhook({ guild_id: null }))).rejects.toMatchObject({ code: 'DISCORD_WEBHOOK_REFUSED' });
    const outage = await connect(fail(502, 0, 'Bad Gateway')).catch((error: unknown) => error);
    expect(outage).toMatchObject({ kind: 'provider' });
    expect((outage as Error).message).not.toContain(TOKEN);
  });

  it('reads back only a well-formed sealed secret', () => {
    expect(discordSecretOf(SECRET)).toEqual({ token: TOKEN, guildId: GUILD, channelId: CHANNEL });
    expect(discordSecretOf(JSON.stringify({ token: TOKEN, guildId: GUILD }))).toBeNull();
    expect(discordSecretOf(JSON.stringify({ token: 'x', guildId: GUILD, channelId: CHANNEL }))).toBeNull();
    expect(discordSecretOf('not json')).toBeNull();
  });
});

describe('Discord publish', () => {
  it('sends text as JSON, adding a link the text does not hold, and never lets it mention anyone', async () => {
    const { fetchImpl, calls } = discord([{ body: { id: '1300000000000000001', channel_id: CHANNEL } }]);
    const result = await new DiscordPublisher(fetchImpl).publish(input({ content: { body: '@everyone Khai trương! @here <@&123456789012345678>', title: null, linkUrl: 'https://example.com/a', media: [] } }));
    expect(result).toEqual({ kind: 'accepted', externalId: '1300000000000000001', url: `https://discord.com/channels/${GUILD}/${CHANNEL}/1300000000000000001` });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/v10/webhooks/${HOOK}/${TOKEN}`);
    expect(calls[0]?.url.searchParams.get('wait')).toBe('true');
    expect(calls[0]?.json).toEqual({ content: '@everyone Khai trương! @here <@&123456789012345678>\n\nhttps://example.com/a', allowed_mentions: { parse: [] } });
  });

  it('uploads images as files with the payload naming each one and its alt text', async () => {
    const { fetchImpl, calls } = discord([{ body: { id: '1300000000000000002' } }]);
    const media = [photo('f1', 'Bát phở bò'), { fileId: 'f2', mime: 'image/png', sizeBytes: 3, altText: 'x'.repeat(1100) }];
    const result = await new DiscordPublisher(fetchImpl).publish(input({ content: content('Món mới @everyone', media) }));
    expect(result).toMatchObject({ kind: 'accepted', externalId: '1300000000000000002' });
    const form = calls[0]?.form as FormData;
    expect(JSON.parse(form.get('payload_json') as string)).toEqual({
      content: 'Món mới @everyone',
      allowed_mentions: { parse: [] },
      attachments: [
        { id: 0, filename: 'image-1.jpg', description: 'Bát phở bò' },
        { id: 1, filename: 'image-2.png', description: 'x'.repeat(1024) },
      ],
    });
    expect((form.get('files[0]') as File).name).toBe('image-1.jpg');
    expect((form.get('files[1]') as File).type).toBe('image/png');
  });

  it('posts a video alone, without text', async () => {
    const { fetchImpl, calls } = discord([{ body: { id: '1300000000000000003' } }]);
    await new DiscordPublisher(fetchImpl).publish(input({ content: content('', [{ fileId: 'v1', mime: 'video/mp4', sizeBytes: 3, altText: null }]) }));
    expect(JSON.parse(calls[0]?.form?.get('payload_json') as string)).toEqual({ allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: 'video-1.mp4' }] });
  });

  it('refuses what Discord would refuse without calling it, and posts nothing when a file cannot be read', async () => {
    const { fetchImpl, calls } = discord([]);
    const publisher = new DiscordPublisher(fetchImpl);
    expect(await publisher.publish(input({ content: content('x'.repeat(2001)) }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'TEXT_TOO_LONG' });
    expect(await publisher.publish(input({ content: content('x', Array.from({ length: 11 }, (_, i) => photo(`f${i}`))) }))).toMatchObject({ kind: 'rejected', code: 'TOO_MANY_MEDIA' });
    expect(await publisher.publish(input({ content: content('x', [{ ...photo('f1'), sizeBytes: DISCORD_FILE_MAX_BYTES + 1 }]) }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_TOO_LARGE' });
    const big = Array.from({ length: 3 }, (_, i) => ({ ...photo(`f${i}`), sizeBytes: DISCORD_FILE_MAX_BYTES }));
    expect(await publisher.publish(input({ content: content('x', big) }))).toMatchObject({ kind: 'rejected', code: 'MESSAGE_TOO_LARGE' });
    expect(await publisher.publish(input({ content: content('x', [{ fileId: 'd1', mime: 'application/pdf', sizeBytes: 3, altText: null }]) }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_TYPE_UNSUPPORTED' });
    expect(await publisher.publish(input({ content: content('') }))).toMatchObject({ kind: 'rejected', code: 'EMPTY_POST' });
    expect(await publisher.publish(input({ externalAccountId: 'not-an-id' }))).toMatchObject({ kind: 'rejected', code: 'BAD_WEBHOOK_ID' });
    expect(await publisher.publish(input({ secret: '{}' }))).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    const unreadable = input({ content: content('x', [photo('f1')]), readMedia: async () => Promise.reject(new Error('gone')) });
    expect(await publisher.publish(unreadable)).toMatchObject({ kind: 'rejected', code: 'MEDIA_UNREADABLE' });
    expect(calls).toHaveLength(0);
  });

  it('maps answers: a rate limit to a retry time, a deleted webhook, a missing permission, a bad request, and an unclear server error', async () => {
    const publisher = new DiscordPublisher(
      discord([
        fail(429, 0, 'You are being rate limited.', { retry_after: 2.5, global: false }),
        fail(404, 10015, 'Unknown Webhook'),
        fail(401, 50027, 'Invalid Webhook Token'),
        fail(403, 50013, 'Missing Permissions'),
        fail(400, 50035, 'Invalid Form Body'),
        fail(413, 40005, 'Request entity too large'),
        fail(500, 0, 'Internal Server Error'),
        { body: {} },
      ]).fetchImpl,
    );
    const before = Date.now();
    const limited = await publisher.publish(input());
    expect(limited).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: 'DISCORD_429' });
    expect((limited as { retryAt: Date }).retryAt.getTime()).toBeGreaterThanOrEqual(before + 2500);
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'DISCORD_10015' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired', code: 'DISCORD_50027' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'permission' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'DISCORD_50035' });
    expect(await publisher.publish(input())).toMatchObject({ kind: 'rejected', error: 'bad_request' });
    // A webhook cannot be asked whether a message went out, so a server error stays unclear.
    expect(await publisher.publish(input())).toMatchObject({ kind: 'unknown', code: 'DISCORD_500' });
    expect(await publisher.publish(input())).toEqual({ kind: 'unknown', code: 'NO_MESSAGE_ID' });
    expect(publisher.publishSafety).toBe('never');
  });

  it('reads the wait from Retry-After when the body has none, and keeps the token out of every message', async () => {
    const answers = [{ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '3' } }];
    const before = Date.now();
    const limited = await new DiscordPublisher(discord(answers).fetchImpl).publish(input());
    expect((limited as { retryAt: Date }).retryAt.getTime()).toBeGreaterThanOrEqual(before + 3000);
    expect(JSON.stringify(limited)).not.toContain(TOKEN);
    const network: Fetch = async () => Promise.reject(new Error('socket hang up'));
    expect(await new DiscordPublisher(network).publish(input())).toEqual({ kind: 'unknown', code: 'NETWORK' });
  });

  it('never calls a host other than discord.com', async () => {
    const seen: string[] = [];
    const fetchImpl: Fetch = async (url) => {
      seen.push(new URL(url).host);
      return new Response(JSON.stringify({ id: '1300000000000000004' }));
    };
    await new DiscordPublisher(fetchImpl).publish(input());
    await new DiscordPublisher(fetchImpl).publish(input({ content: content('x', [photo('f1')]) }));
    await connectDiscord(discordLogin({ webhookUrl: `https://discordapp.com/api/webhooks/${HOOK}/${TOKEN}` }), async (url) => {
      seen.push(new URL(url).host);
      return new Response(JSON.stringify(webhook().body));
    });
    expect(seen).toEqual(['discord.com', 'discord.com', 'discord.com']);
  });
});

describe('Discord team alerts (#863)', () => {
  it('sends one line with mentions off and no embeds, on the webhook', async () => {
    const line = 'Bài «Khai trương» đã đăng lên Facebook: https://crove.example/o/shop/social/1';
    const { fetchImpl, calls } = discord([{ body: { id: '1111111111111111111', channel_id: CHANNEL } }]);
    await sendDiscordText({ webhookId: HOOK, token: TOKEN }, line, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.toString()).toBe(`https://discord.com/api/v10/webhooks/${HOOK}/${TOKEN}?wait=true`);
    expect(calls[0]?.json).toEqual({ content: line, allowed_mentions: { parse: [] }, flags: 4 });
  });

  it('throws what Discord answered, and reads back only a well-formed target', async () => {
    await expect(sendDiscordText({ webhookId: HOOK, token: TOKEN }, 'x', discord([fail(404, 10015, 'Unknown Webhook')]).fetchImpl)).rejects.toMatchObject({ status: 404 });
    await expect(sendDiscordText({ webhookId: HOOK, token: TOKEN }, 'x'.repeat(2001), discord([]).fetchImpl)).rejects.toMatchObject({ status: 400 });
    expect(discordChatTargetOf(JSON.stringify({ webhookId: HOOK, token: TOKEN }))).toEqual({ webhookId: HOOK, token: TOKEN });
    expect(discordChatTargetOf(JSON.stringify({ webhookId: '1', token: TOKEN }))).toBeNull();
    expect(discordChatTargetOf('{')).toBeNull();
  });
});
