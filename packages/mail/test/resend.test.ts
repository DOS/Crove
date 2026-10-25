// The Resend adapter (#539): the send request and how each answer maps to a result, and the Svix-signed webhooks
// (a replay outside five minutes, a forged or missing signature and a malformed body are refused).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createResendProvider, parseResendWebhook, WebhookRejected, type WebhookRequest } from '../src/index.ts';

const SECRET = `whsec_${Buffer.from('a-test-signing-secret-of-32-bytes!').toString('base64')}`;
const NOW = Date.parse('2026-10-20T05:00:00Z');
const MAIL = { to: 'khach@example.test', subject: 'Chủ đề', text: 'link', html: '<p>link</p>', messageId: '<0192f0aa-0000-7000-8000-000000000001@mail.example.com>' };

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function signed(body: string, options: { id?: string; at?: number; secret?: string } = {}): WebhookRequest {
  const id = options.id ?? 'msg_2abc';
  const timestamp = String(Math.floor((options.at ?? NOW) / 1000));
  const key = Buffer.from((options.secret ?? SECRET).replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }, body };
}

const event = (type: string, data: Record<string, unknown> = {}) =>
  JSON.stringify({ type, created_at: '2026-10-20T04:59:00.000Z', data: { email_id: 'em_123', created_at: '2026-10-20T04:58:30.000Z', to: ['khach@example.test'], ...data } });

describe('Resend send', () => {
  it('posts the mail to api.resend.com with the key derived from its Message-ID', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ id: 'em_123' }));
    const provider = createResendProvider({ apiKey: 're_test', from: 'Crove <noreply@mail.example.com>', fetch: fetchImpl });
    expect(provider).toMatchObject({ name: 'resend', enabled: true, sendRetrySafety: 'idempotent' });
    expect(await provider.send(MAIL)).toEqual({ status: 'accepted', providerMessageId: 'em_123' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.resend.com/emails');
    expect(call?.init.redirect).toBe('manual');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test');
    expect(headers['idempotency-key']).toBe('crove:0192f0aa-0000-7000-8000-000000000001@mail.example.com');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: 'Crove <noreply@mail.example.com>',
      to: ['khach@example.test'],
      subject: 'Chủ đề',
      text: 'link',
      html: '<p>link</p>',
      headers: { 'Message-ID': MAIL.messageId },
    });
  });

  it('maps each answer to a result that names a code, never a message', async () => {
    const send = async (answer: () => Response | Promise<Response>) => createResendProvider({ apiKey: 'k', from: 'a@b.test', fetch: fakeFetch(answer).fetchImpl }).send(MAIL);
    const json = (status: number, headers: Record<string, string> = {}) => () =>
      Response.json({ statusCode: status, name: 'error', message: 'khach@example.test is not allowed' }, { status, headers });
    expect(await send(json(429, { 'retry-after': '2' }))).toEqual({ status: 'rejected', error: 'rate_limited', code: 'RESEND_429', retryAfterMs: 2_000 });
    expect(await send(json(401))).toEqual({ status: 'rejected', error: 'auth', code: 'RESEND_401' });
    expect(await send(json(403))).toEqual({ status: 'rejected', error: 'auth', code: 'RESEND_403' });
    expect(await send(json(422))).toEqual({ status: 'rejected', error: 'bad_request', code: 'RESEND_422' });
    expect(await send(json(409))).toEqual({ status: 'rejected', error: 'transient', code: 'RESEND_409' });
    // A 5xx or a lost connection may follow an accepted mail: unknown, and safe to repeat under the same key.
    expect(await send(json(503))).toEqual({ status: 'unknown', code: 'RESEND_503' });
    expect(await send(() => Promise.reject(new TypeError('fetch failed')))).toEqual({ status: 'unknown', code: 'RESEND_NETWORK' });
    expect(await send(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))).toEqual({ status: 'unknown', code: 'RESEND_TIMEOUT' });
    // An answer without a usable id still means accepted.
    expect(await send(() => Response.json({ id: 'x'.repeat(300) }))).toEqual({ status: 'accepted' });
  });

  it('sends no idempotency key for a mail without a Message-ID', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ id: 'em_9' }));
    const { messageId: _omitted, ...mail } = MAIL;
    await createResendProvider({ apiKey: 'k', from: 'a@b.test', fetch: fetchImpl }).send(mail);
    expect(Object.keys(calls[0]?.init.headers as object)).not.toContain('idempotency-key');
    expect(JSON.parse(String(calls[0]?.init.body)).headers).toBeUndefined();
  });
});

describe('Resend attachments', () => {
  it('sends an attachment base64-encoded with its content type (#1319)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ id: 'em_7' }));
    const ics = 'BEGIN:VCALENDAR\r\nSUMMARY:Tư vấn\r\nEND:VCALENDAR\r\n';
    await createResendProvider({ apiKey: 'k', from: 'a@b.test', fetch: fetchImpl }).send({
      ...MAIL,
      attachments: [{ filename: 'lich-hen.ics', contentType: 'text/calendar; method=PUBLISH; charset=UTF-8', content: ics }],
    });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.attachments).toEqual([{ filename: 'lich-hen.ics', content_type: 'text/calendar; method=PUBLISH; charset=UTF-8', content: Buffer.from(ics, 'utf8').toString('base64') }]);
  });
});

describe('Resend webhooks', () => {
  it('turns delivered, delayed, complained and bounced into events keyed by the Svix id', () => {
    expect(parseResendWebhook(SECRET, signed(event('email.delivered')), NOW)).toEqual([
      { providerEventId: 'msg_2abc', providerMessageId: 'em_123', kind: 'delivered', occurredAt: '2026-10-20T04:58:30.000Z', detail: {} },
    ]);
    expect(parseResendWebhook(SECRET, signed(event('email.delivery_delayed')), NOW)[0]?.kind).toBe('deferred');
    expect(parseResendWebhook(SECRET, signed(event('email.complained')), NOW)[0]?.kind).toBe('complaint');
    const hard = parseResendWebhook(SECRET, signed(event('email.bounced', { bounce: { type: 'Permanent', subType: 'General', message: 'khach@example.test does not exist' } })), NOW);
    expect(hard).toEqual([expect.objectContaining({ kind: 'bounce_hard', detail: { bounceType: 'Permanent', bounceSubType: 'General' } })]);
    // The bounce message may quote the address: it is not kept.
    expect(JSON.stringify(hard)).not.toContain('khach@example.test');
    expect(parseResendWebhook(SECRET, signed(event('email.bounced', { bounce: { type: 'Transient', subType: 'MailboxFull' } })), NOW)[0]?.kind).toBe('bounce_soft');
    expect(parseResendWebhook(SECRET, signed(event('email.bounced', { bounce: { type: 'Undetermined' } })), NOW)[0]?.kind).toBe('bounce_soft');
    expect(parseResendWebhook(SECRET, signed(event('email.bounced')), NOW)[0]?.kind).toBe('bounce_soft');
  });

  it('records nothing for event types E2 does not use', () => {
    for (const type of ['email.sent', 'email.opened', 'email.clicked', 'contact.created']) {
      expect(parseResendWebhook(SECRET, signed(event(type)), NOW)).toEqual([]);
    }
  });

  it('refuses a forged, missing or stale signature before reading the body', () => {
    const body = event('email.bounced', { bounce: { type: 'Permanent' } });
    const reason = (request: WebhookRequest) => {
      try {
        parseResendWebhook(SECRET, request, NOW);
        return 'accepted';
      } catch (error) {
        return error instanceof WebhookRejected ? error.reason : 'other';
      }
    };
    const other = `whsec_${Buffer.from('another-secret-another-secret-ab').toString('base64')}`;
    expect(reason(signed(body, { secret: other }))).toBe('signature');
    expect(reason({ ...signed(body), body: body.replace('Permanent', 'Transient') })).toBe('signature');
    const { 'svix-signature': _drop, ...unsigned } = signed(body).headers;
    expect(reason({ headers: unsigned, body })).toBe('signature');
    expect(reason({ headers: { ...signed(body).headers, 'svix-signature': 'v1,' }, body })).toBe('signature');
    expect(reason(signed(body, { at: NOW - 6 * 60_000 }))).toBe('stale');
    expect(reason(signed(body, { at: NOW + 6 * 60_000 }))).toBe('stale');
    expect(reason({ headers: { ...signed(body).headers, 'svix-timestamp': 'yesterday' }, body })).toBe('stale');
    // One matching signature among several (a secret being rotated) is enough.
    const good = signed(body);
    expect(reason({ ...good, headers: { ...good.headers, 'svix-signature': `v1,${Buffer.alloc(32).toString('base64')} ${good.headers['svix-signature']}` } })).toBe('accepted');
  });

  it('refuses a signed body that is not an event of a mail', () => {
    expect(() => parseResendWebhook(SECRET, signed('not json'), NOW)).toThrow(WebhookRejected);
    expect(() => parseResendWebhook(SECRET, signed(JSON.stringify({ type: 'email.delivered', data: {} })), NOW)).toThrow(WebhookRejected);
    expect(() => parseResendWebhook(SECRET, signed(event('email.delivered', { email_id: 'x'.repeat(256) })), NOW)).toThrow(WebhookRejected);
  });

  it('is offered only when a webhook secret is configured', () => {
    expect(createResendProvider({ apiKey: 'k', from: 'a@b.test' }).parseWebhook).toBeUndefined();
    const provider = createResendProvider({ apiKey: 'k', from: 'a@b.test', webhookSecret: SECRET });
    expect(provider.parseWebhook?.(signed(event('email.delivered')), NOW)).toHaveLength(1);
  });
});
