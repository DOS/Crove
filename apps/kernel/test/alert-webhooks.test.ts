// Webhook request shapes for Slack, Discord and Telegram (issue #151), pinned to the vendors' documentation:
//   Slack incoming webhooks: POST JSON {text}; `mrkdwn: false` turns formatting off; &, < and > are control
//     characters sent as &amp; &lt; &gt;; success is HTTP 200 "ok", errors are 400/403/404 with a reason such as
//     invalid_payload or no_text (docs.slack.dev, "Sending messages using incoming webhooks", "Formatting text").
//   Discord execute webhook: POST JSON with content (up to 2000 characters); allowed_mentions {parse: []} suppresses
//     every mention; success is 204 No Content without ?wait=true (docs.discord.com, Webhook and Message resources).
//   Telegram Bot API sendMessage: POST https://api.telegram.org/bot<token>/sendMessage with chat_id and text
//     (1-4096 characters); parse_mode is optional and omitted, so the text is plain; answers {ok, result} or
//     {ok: false, error_code, description} (core.telegram.org/bots/api).
// The recorded shapes are exact JSON; the fake servers below answer as each vendor does, including its errors.
// Real endpoints need the owner's accounts: `pnpm alert:test` sends a test alert to the configured webhook.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCORD_MAX_CONTENT, alertText, deliverAlert, detectWebhookFormat, discordContent, slackEscape, webhookBody, type Alert } from '../src/alert.ts';
import { EXIT, loadProberConfig, runProber } from '../src/prober.ts';

const AT = '2026-10-16T12:00:00.000Z';
const alert: Alert = {
  kind: 'alert',
  state: 'new',
  instance: 'books.example.test',
  at: AT,
  findings: [
    { check: 'outbox', value: 400, threshold: 300, message: 'oldest unpublished outbox event is 400 s old (limit 300 s, 2 pending): the relay is behind or stopped' },
    { check: 'probe', value: null, threshold: null, message: 'crove_kernel.health() said <b>no</b> & @everyone *loud* _x_ `y` ~z~ |s|' },
  ],
};
const text = alertText(alert);

describe('format detection', () => {
  it('knows the vendors by their API hosts and treats anything else as generic', () => {
    expect(detectWebhookFormat('https://hooks.slack.com/services/T000/B000/xyz')).toBe('slack');
    expect(detectWebhookFormat('https://discord.com/api/webhooks/123/abc')).toBe('discord');
    expect(detectWebhookFormat('https://discordapp.com/api/webhooks/123/abc')).toBe('discord');
    expect(detectWebhookFormat('https://ptb.discord.com/api/webhooks/123/abc')).toBe('discord');
    expect(detectWebhookFormat('https://discord.com/channels/1/2')).toBe('generic');
    expect(detectWebhookFormat('https://api.telegram.org/bot123:ABC/sendMessage')).toBe('telegram');
    expect(detectWebhookFormat('https://chat.example.test/hooks/abc')).toBe('generic');
    expect(detectWebhookFormat('https://hooks.slack.com.evil.test/services/x')).toBe('generic');
  });

  it('reads ALERT_WEBHOOK_FORMAT, and a Telegram webhook needs its chat id and the sendMessage URL', () => {
    expect(loadProberConfig({ ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' }).webhookFormat).toBe('slack');
    expect(loadProberConfig({ ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x', ALERT_WEBHOOK_FORMAT: 'generic' }).webhookFormat).toBe('generic');
    expect(loadProberConfig({ ALERT_WEBHOOK_URL: 'https://relay.example.test/x', ALERT_WEBHOOK_FORMAT: 'discord' }).webhookFormat).toBe('discord');
    expect(loadProberConfig({}).webhookFormat).toBe('generic');
    expect(() => loadProberConfig({ ALERT_WEBHOOK_FORMAT: 'teams' })).toThrow(/ALERT_WEBHOOK_FORMAT/);
    const bot = 'https://api.telegram.org/bot123:ABC/sendMessage';
    expect(() => loadProberConfig({ ALERT_WEBHOOK_URL: bot })).toThrow(/ALERT_TELEGRAM_CHAT_ID/);
    expect(() => loadProberConfig({ ALERT_WEBHOOK_URL: 'https://api.telegram.org/bot123:ABC', ALERT_TELEGRAM_CHAT_ID: '42' })).toThrow(/sendMessage/);
    expect(() => loadProberConfig({ ALERT_WEBHOOK_URL: bot, ALERT_TELEGRAM_CHAT_ID: 'my chat' })).toThrow(/ALERT_TELEGRAM_CHAT_ID/);
    expect(loadProberConfig({ ALERT_WEBHOOK_URL: bot, ALERT_TELEGRAM_CHAT_ID: '-1001234567890' })).toMatchObject({ webhookFormat: 'telegram', telegramChatId: '-1001234567890' });
    expect(loadProberConfig({ ALERT_WEBHOOK_URL: bot, ALERT_TELEGRAM_CHAT_ID: '@crove_alerts' }).telegramChatId).toBe('@crove_alerts');
  });
});

describe('recorded request shapes', () => {
  it('Slack: {text, mrkdwn: false} with only &, < and > escaped', () => {
    expect(webhookBody(alert, 'slack')).toEqual({ text: slackEscape(text), mrkdwn: false });
    expect(slackEscape('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
    expect((webhookBody(alert, 'slack') as { text: string }).text).toContain('said &lt;b&gt;no&lt;/b&gt; &amp; @everyone *loud*');
  });

  it('Discord: {content, allowed_mentions: {parse: []}} with Markdown escaped, within 2000 characters', () => {
    const body = webhookBody(alert, 'discord');
    expect(Object.keys(body)).toEqual(['content', 'allowed_mentions']);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain('said <b>no</b> & @everyone \\*loud\\* \\_x\\_ \\`y\\` \\~z\\~ \\|s\\|');
    expect(body.content).toContain('crove\\_kernel.health()');
    // The findings stay a Markdown list.
    expect(String(body.content).split('\n')[1]).toMatch(/^- oldest unpublished/);
    // Escaping can double the text: the limit holds on what is sent, and no escape is left dangling.
    const stars = discordContent('*'.repeat(1900));
    expect(stars.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT);
    expect(stars.endsWith('...')).toBe(true);
    expect(stars.slice(0, -3)).toMatch(/^(?:\\\*)+$/);
    // 1996 letters and three backslashes escape to 2002 characters; the cut would end on one backslash, which goes.
    expect(discordContent('a'.repeat(1996) + '\\\\\\')).toBe(`${'a'.repeat(1996)}...`);
    expect(discordContent('a'.repeat(1995) + '\\\\\\')).toBe(`${'a'.repeat(1995)}\\\\...`);
  });

  it('Telegram: {chat_id, text, link_preview_options} and no parse_mode, so nothing needs escaping', () => {
    expect(webhookBody(alert, 'telegram', '-1001234567890')).toEqual({ chat_id: '-1001234567890', text, link_preview_options: { is_disabled: true } });
    expect(() => webhookBody(alert, 'telegram')).toThrow(/ALERT_TELEGRAM_CHAT_ID/);
  });

  it('generic: {text, content, crove}', () => {
    const body = webhookBody(alert, 'generic');
    expect(Object.keys(body)).toEqual(['text', 'content', 'crove']);
    expect(body).toMatchObject({ text, content: text, crove: { kind: 'alert', state: 'new', severity: 'critical', instance: 'books.example.test', at: AT } });
  });
});

// One local server playing the three vendors, with each one's validation and answers.
interface Received {
  path: string;
  contentType: string | undefined;
  body: Record<string, unknown>;
}
const TELEGRAM_TOKEN = '123456:TEST-token';
function vendor(req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) {
  const path = req.url ?? '';
  if (path.startsWith('/slack/')) {
    if (path !== '/slack/services/T000/B000/good') return void res.writeHead(404, { 'content-type': 'text/plain' }).end('no_service');
    if (typeof body.text !== 'string' || body.text === '') return void res.writeHead(400, { 'content-type': 'text/plain' }).end('no_text');
    return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  }
  if (path.startsWith('/discord/')) {
    if (path !== '/discord/api/webhooks/1/good') return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"message": "Invalid Webhook Token", "code": 50027}');
    if (typeof body.content !== 'string' || body.content.length > 2000) {
      return void res.writeHead(400, { 'content-type': 'application/json' }).end('{"message": "Invalid Form Body", "code": 50035}');
    }
    return void res.writeHead(204).end();
  }
  if (path.startsWith('/telegram/')) {
    const answer = (status: number, json: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    if (path !== `/telegram/bot${TELEGRAM_TOKEN}/sendMessage`) return void answer(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    if (body.chat_id !== '42') return void answer(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    if (typeof body.text !== 'string' || body.text.length < 1 || body.text.length > 4096) {
      return void answer(400, { ok: false, error_code: 400, description: 'Bad Request: message text is empty' });
    }
    if ('parse_mode' in body) return void answer(400, { ok: false, error_code: 400, description: 'unexpected parse_mode' });
    return void answer(200, { ok: true, result: { message_id: 1, chat: { id: 42 }, text: body.text } });
  }
  res.writeHead(404).end();
}

describe('delivery to fake vendor endpoints', () => {
  let server: Server;
  let base = '';
  const received: Received[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        const body = JSON.parse(data || '{}') as Record<string, unknown>;
        received.push({ path: req.url ?? '', contentType: req.headers['content-type'], body });
        vendor(req, body, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const quiet = { log: () => {} };

  it('Slack accepts the alert; its error reason is reported, the URL secret is not', async () => {
    received.length = 0;
    expect(await deliverAlert(alert, { webhookUrl: `${base}/slack/services/T000/B000/good`, format: 'slack', ...quiet })).toEqual({ channel: 'webhook', ok: true });
    expect(received[0]).toEqual({ path: '/slack/services/T000/B000/good', contentType: 'application/json', body: { text: slackEscape(text), mrkdwn: false } });
    const failed = await deliverAlert(alert, { webhookUrl: `${base}/slack/services/T000/B000/secret-xyz`, format: 'slack', ...quiet });
    expect(failed).toEqual({ channel: 'webhook', ok: false, error: `slack webhook at ${new URL(base).host} failed: HTTP 404: no_service` });
    expect(failed.error).not.toContain('secret-xyz');
  });

  it('Discord accepts the alert with 204 and reports its JSON error message', async () => {
    received.length = 0;
    const long: Alert = { ...alert, findings: Array.from({ length: 80 }, () => ({ check: 'outbox' as const, value: 1, threshold: 0, message: 'a_b*c '.repeat(10) })) };
    expect(await deliverAlert(long, { webhookUrl: `${base}/discord/api/webhooks/1/good`, format: 'discord', ...quiet })).toEqual({ channel: 'webhook', ok: true });
    expect(String(received[0]?.body.content).length).toBeLessThanOrEqual(2000);
    expect(received[0]?.body.allowed_mentions).toEqual({ parse: [] });
    expect(await deliverAlert(alert, { webhookUrl: `${base}/discord/api/webhooks/1/revoked`, format: 'discord', ...quiet })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/discord webhook at .* failed: HTTP 401: Invalid Webhook Token$/),
    });
  });

  it('Telegram accepts the alert and reports its description; the bot token never appears', async () => {
    received.length = 0;
    const url = `${base}/telegram/bot${TELEGRAM_TOKEN}/sendMessage`;
    expect(await deliverAlert(alert, { webhookUrl: url, format: 'telegram', telegramChatId: '42', ...quiet })).toEqual({ channel: 'webhook', ok: true });
    expect(received[0]?.body).toEqual({ chat_id: '42', text, link_preview_options: { is_disabled: true } });
    const wrongChat = await deliverAlert(alert, { webhookUrl: url, format: 'telegram', telegramChatId: '7', ...quiet });
    expect(wrongChat.error).toMatch(/telegram webhook at .* failed: HTTP 400: Bad Request: chat not found$/);
    expect(wrongChat.error).not.toContain(TELEGRAM_TOKEN);
  });

  it('a generic receiver gets the structured payload and its answer is never logged', async () => {
    received.length = 0;
    const failed = await deliverAlert(alert, { webhookUrl: `${base}/elsewhere`, format: 'generic', ...quiet });
    expect(failed.error).toMatch(/^webhook at .* failed: HTTP 404$/);
    expect(Object.keys(received[0]?.body ?? {})).toEqual(['text', 'content', 'crove']);
  });

  it('the test alert reaches each format through the prober entry point', async () => {
    received.length = 0;
    const run = (env: NodeJS.ProcessEnv) => runProber(['--test-alert'], { ALERT_INSTANCE: 'office', ...env }, { log: () => {}, error: () => {}, now: () => new Date(AT) });
    expect(await run({ ALERT_WEBHOOK_URL: `${base}/slack/services/T000/B000/good`, ALERT_WEBHOOK_FORMAT: 'slack' })).toBe(EXIT.ok);
    expect(await run({ ALERT_WEBHOOK_URL: `${base}/discord/api/webhooks/1/good`, ALERT_WEBHOOK_FORMAT: 'discord' })).toBe(EXIT.ok);
    expect(
      await run({ ALERT_WEBHOOK_URL: `${base}/telegram/bot${TELEGRAM_TOKEN}/sendMessage`, ALERT_WEBHOOK_FORMAT: 'telegram', ALERT_TELEGRAM_CHAT_ID: '42' }),
    ).toBe(EXIT.ok);
    const testText = '[Crove] Test alert from office: alert delivery works.';
    expect(received.map((r) => r.body)).toEqual([
      { text: testText, mrkdwn: false },
      { content: testText, allowed_mentions: { parse: [] } },
      { chat_id: '42', text: testText, link_preview_options: { is_disabled: true } },
    ]);
  });
});
