// Outbound mail (issue #129): the SMTP adapter against an in-process SMTP server, the log fallback, retries, the
// invite template and the configuration guards.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { acceptUrl, createInviteMailSender, inviteMail, type InviteMailInput } from '../src/invite-mail.ts';
import { classifySmtpError, createLogProvider, createSmtpProvider, type MailProvider, type OutboundMail, type SendResult } from '@crove/mail';
import { createMailer, deliver, describeMailError } from '../src/mail.ts';

const TOKEN = 'T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0kenT0k';
const INVITE: InviteMailInput = {
  to: 'khach@example.test',
  orgName: 'Công ty <b>ABC</b>\r\nBcc: victim@example.test',
  inviterName: 'Chủ "Lan"',
  inviterEmail: 'lan@example.test',
  role: 'admin',
  expiresAt: '2026-10-22T09:30:00.000Z',
  acceptPath: `/-/invite#${TOKEN}`,
};
const MAIL: OutboundMail = { to: 'khach@example.test', subject: 'Chủ đề', text: `link ${TOKEN}`, html: `<a href="x#${TOKEN}">x</a>` };

interface Received {
  from: string;
  to: string[];
  data: string;
}

// Just enough SMTP (RFC 5321) for nodemailer: EHLO, MAIL, RCPT, DATA, QUIT. `reply` can override the answer to
// a command, to inject failures.
function smtpServer(reply: (command: string) => string | null = () => null) {
  const received: Received[] = [];
  const commands: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    let buffer = '';
    let inData = false;
    let current: Received = { from: '', to: [], data: '' };
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(current);
          current = { from: '', to: [], data: '' };
          socket.write('250 OK queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.split(/[ :]/)[0]?.toUpperCase() ?? '';
        commands.push(verb);
        const custom = reply(verb);
        if (custom) {
          socket.write(`${custom}\r\n`);
          continue;
        }
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-test\r\n250 8BITMIME\r\n');
        // Like a real server that does not advertise STARTTLS.
        else if (verb === 'STARTTLS') socket.write('502 5.5.1 STARTTLS not available\r\n');
        else if (verb === 'MAIL') {
          current.from = line;
          socket.write('250 OK\r\n');
        } else if (verb === 'RCPT') {
          current.to.push(line);
          socket.write('250 OK\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
          return;
        } else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return {
    received,
    commands,
    start: () => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Quoted-printable soft line breaks and escapes, enough to search a received body for the link.
function unfoldQp(data: string): string {
  return data.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

describe('SMTP adapter', () => {
  const smtp = smtpServer();
  let port = 0;
  beforeAll(async () => {
    port = await smtp.start();
  });
  afterAll(() => smtp.stop());

  it('sends one mail through the configured server, with the accept link', async () => {
    const mailer = createSmtpProvider({ host: '127.0.0.1', port, from: 'noreply@crove.local' });
    expect(mailer.enabled).toBe(true);
    const logs: string[] = [];
    const send = createInviteMailSender(mailer, 'https://books.example.com/', { log: (l) => logs.push(l) });
    expect((await send(INVITE)).status).toBe('sent');
    expect(smtp.received).toHaveLength(1);
    const [mail] = smtp.received;
    expect(mail?.from).toContain('<noreply@crove.local>');
    expect(mail?.to).toEqual([expect.stringContaining('<khach@example.test>')]);
    const body = unfoldQp(mail?.data ?? '');
    expect(body).toContain(`https://books.example.com/-/invite#${TOKEN}`);
    // The org name cannot add a header.
    expect(mail?.data).not.toMatch(/^Bcc:/im);
    expect(logs).toEqual([]);
  });

  it('sends bounce reports to the mail\'s own address on the inbound domain and keeps the From header (#539)', async () => {
    const mailer = createSmtpProvider({ host: '127.0.0.1', port, from: 'noreply@crove.local' });
    const token = 'a'.repeat(48);
    await createInviteMailSender(mailer, 'https://books.example.com/', {}, 'In.Example.com')({ ...INVITE, bounceToken: token });
    const bounced = smtp.received.at(-1);
    expect(bounced?.from).toBe(`MAIL FROM:<bounce+${token}@in.example.com>`);
    expect(bounced?.to).toEqual([expect.stringContaining('<khach@example.test>')]);
    expect(bounced?.data).toMatch(/^From: Crove <noreply@crove\.local>$/m);
    // Without an inbound domain to receive them, or without a token, the envelope sender is the From address.
    await createInviteMailSender(mailer, 'https://books.example.com/', {}, null)({ ...INVITE, bounceToken: token });
    await createInviteMailSender(mailer, 'https://books.example.com/', {}, 'in.example.com')({ ...INVITE, bounceToken: null });
    expect(smtp.received.slice(-2).map((m) => m.from)).toEqual(['MAIL FROM:<noreply@crove.local>', 'MAIL FROM:<noreply@crove.local>']);
  });
});

describe('SMTP adapter, refusals', () => {
  it('does not send credentials to a server without STARTTLS', async () => {
    const smtp = smtpServer();
    const port = await smtp.start();
    try {
      const logs: string[] = [];
      const mailer = createSmtpProvider({ host: '127.0.0.1', port, user: 'u', pass: 'p', from: 'noreply@crove.local' });
      expect((await deliver(mailer, MAIL, { log: (l) => logs.push(l) })).status).toBe('failed');
      // Not retried: the server will not offer TLS on a second attempt either.
      expect(logs).toEqual([expect.stringMatching(/^\[mail\] mail not sent after 1 attempt\(s\): ETLS/)]);
      expect(smtp.commands).not.toContain('AUTH');
      expect(smtp.received).toEqual([]);
    } finally {
      await smtp.stop();
    }
  });

  it('retries a 4xx reply and gives up at once on a 5xx reply', async () => {
    let busy = 1;
    const smtp = smtpServer((verb) => (verb === 'RCPT' && busy-- > 0 ? '451 4.3.0 try again later' : null));
    const port = await smtp.start();
    const rejecting = smtpServer((verb) => (verb === 'RCPT' ? '550 5.1.1 no such user' : null));
    const rejectingPort = await rejecting.start();
    try {
      const noSleep = async () => undefined;
      expect((await deliver(createSmtpProvider({ host: '127.0.0.1', port, from: 'noreply@crove.local' }), MAIL, { sleep: noSleep })).status).toBe('sent');
      expect(smtp.received).toHaveLength(1);
      const logs: string[] = [];
      const mailer = createSmtpProvider({ host: '127.0.0.1', port: rejectingPort, from: 'noreply@crove.local' });
      expect((await deliver(mailer, MAIL, { sleep: noSleep, log: (l) => logs.push(l) })).status).toBe('failed');
      expect(logs).toEqual(['[mail] mail not sent after 1 attempt(s): EENVELOPE 550']);
    } finally {
      await smtp.stop();
      await rejecting.stop();
    }
  });
});

describe('log fallback', () => {
  it('is used without SMTP_HOST and never logs the body or the recipient', async () => {
    expect(createMailer({ MAIL_PROVIDER: 'smtp', SMTP_HOST: undefined, SMTP_PORT: 587, SMTP_USER: undefined, SMTP_PASS: undefined, SMTP_FROM: undefined, RESEND_API_KEY: undefined, RESEND_WEBHOOK_SECRET: undefined }).enabled).toBe(false);
    const lines: string[] = [];
    const mailer = createLogProvider((l) => lines.push(l));
    expect((await deliver(mailer, MAIL, { log: (l) => lines.push(l) })).status).toBe('off');
    expect(lines).toEqual(['[mail] not sent, SMTP_HOST is not set: "Chủ đề"']);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(MAIL.to);
  });
});

describe('deliver', () => {
  const provider = (send: MailProvider['send'], sendRetrySafety: MailProvider['sendRetrySafety'] = 'never'): MailProvider => ({ name: 'test', enabled: true, sendRetrySafety, send });
  // A provider whose sends meet these SMTP errors in turn, then succeed.
  const failing = (errors: unknown[]): MailProvider & { calls: number } => {
    const m = {
      ...provider(async (): Promise<SendResult> => {
        m.calls++;
        const error = errors.shift();
        return error ? classifySmtpError(error) : { status: 'accepted' };
      }),
      calls: 0,
    };
    return m;
  };
  const smtpError = (code: string, responseCode?: number) =>
    Object.assign(new Error(`failed for khach@example.test: ${TOKEN}`), { code, ...(responseCode ? { responseCode } : {}) });
  const noSleep = async () => undefined;

  it('retries transient errors and reports success', async () => {
    const mailer = failing([smtpError('ECONNECTION'), smtpError('EENVELOPE', 451)]);
    const logs: string[] = [];
    expect((await deliver(mailer, MAIL, { sleep: noSleep, log: (l) => logs.push(l) })).status).toBe('sent');
    expect(mailer.calls).toBe(3);
    expect(logs).toEqual([]);
  });

  it('gives up after the retries, logging codes only', async () => {
    const mailer = failing([smtpError('ETIMEDOUT'), smtpError('ETIMEDOUT'), smtpError('ETIMEDOUT')]);
    const logs: string[] = [];
    expect((await deliver(mailer, MAIL, { sleep: noSleep, log: (l) => logs.push(l), label: 'invite mail' })).status).toBe('failed');
    expect(mailer.calls).toBe(3);
    expect(logs).toEqual(['[mail] invite mail not sent after 3 attempt(s): ETIMEDOUT']);
  });

  it('does not retry permanent errors', async () => {
    for (const error of [smtpError('EENVELOPE', 550), smtpError('EAUTH', 535), smtpError('EMESSAGE')]) {
      const mailer = failing([error]);
      const logs: string[] = [];
      expect((await deliver(mailer, MAIL, { sleep: noSleep, log: (l) => logs.push(l) })).status).toBe('failed');
      expect(mailer.calls).toBe(1);
      expect(logs.join('\n')).not.toContain(TOKEN);
      expect(logs.join('\n')).not.toContain('khach@example.test');
    }
  });

  it('reports a real refused connection as failed', async () => {
    const smtp = smtpServer();
    const port = await smtp.start();
    await smtp.stop();
    const logs: string[] = [];
    const mailer = createSmtpProvider({ host: '127.0.0.1', port, from: 'noreply@crove.local' });
    expect((await deliver(mailer, MAIL, { sleep: noSleep, log: (l) => logs.push(l) })).status).toBe('failed');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[mail\] mail not sent after 3 attempt\(s\): [A-Z]+/);
    expect(logs[0]).not.toContain(TOKEN);
  });

  it('answers within the deadline, whatever the server does', async () => {
    const hanging = provider(() => new Promise<SendResult>(() => undefined));
    const logs: string[] = [];
    const started = Date.now();
    expect((await deliver(hanging, MAIL, { deadlineMs: 50, log: (l) => logs.push(l), label: 'invite mail' })).status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(logs).toEqual(['[mail] invite mail not sent within the deadline (attempt 1)']);
    // No retry starts when its wait would pass the deadline.
    const once = failing([smtpError('ECONNECTION'), smtpError('ECONNECTION')]);
    let clock = 0;
    expect((await deliver(once, MAIL, { deadlineMs: 1_000, retryDelaysMs: [5_000], now: () => clock, sleep: async (ms) => void (clock += ms), log: () => undefined })).status).toBe(
      'failed',
    );
    expect(once.calls).toBe(1);
  });

  it('turns a sender that throws synchronously into a failure', async () => {
    const sync = provider(() => {
      throw Object.assign(new Error(TOKEN), { code: 'EMESSAGE' });
    });
    const logs: string[] = [];
    expect((await deliver(sync, MAIL, { log: (l) => logs.push(l) })).status).toBe('failed');
    expect(logs).toEqual(['[mail] mail not sent after 1 attempt(s): EMESSAGE']);
  });

  it('repeats an unknown outcome only for a provider that drops repeats of the same Message-ID', async () => {
    const outcomes = (): SendResult[] => [{ status: 'unknown', code: 'RESEND_503' }, { status: 'accepted', providerMessageId: 'em_1' }];
    const run = async (safety: MailProvider['sendRetrySafety'], mail: OutboundMail) => {
      const queue = outcomes();
      let calls = 0;
      const result = await deliver(
        provider(async () => {
          calls++;
          return queue.shift() ?? { status: 'accepted' };
        }, safety),
        mail,
        { sleep: noSleep, log: () => undefined },
      );
      return { result, calls };
    };
    const withId = { ...MAIL, messageId: '<a@crove.test>' };
    expect(await run('idempotent', withId)).toEqual({ result: { status: 'sent', provider: 'test', providerMessageId: 'em_1' }, calls: 2 });
    // Plain SMTP, or a mail without a Message-ID to dedupe on: reported as failed, never sent twice.
    expect(await run('never', withId)).toEqual({ result: { status: 'failed', provider: 'test' }, calls: 1 });
    expect(await run('idempotent', MAIL)).toEqual({ result: { status: 'failed', provider: 'test' }, calls: 1 });
  });

  it('waits at least as long as a rate limit asks, and gives up when that passes the deadline', async () => {
    const waits: number[] = [];
    let clock = 0;
    const limited = (retryAfterMs: number) => {
      const queue: SendResult[] = [{ status: 'rejected', error: 'rate_limited', code: 'RESEND_429', retryAfterMs }, { status: 'accepted' }];
      return provider(async () => queue.shift() ?? { status: 'accepted' });
    };
    const options = { now: () => clock, sleep: async (ms: number) => void waits.push(ms), log: () => undefined };
    expect((await deliver(limited(1_500), MAIL, options)).status).toBe('sent');
    expect(waits).toEqual([1_500]);
    expect((await deliver(limited(60_000), MAIL, options)).status).toBe('failed');
    expect(waits).toEqual([1_500]);
  });

  it('describes errors without their message', () => {
    expect(describeMailError(smtpError('EENVELOPE', 550))).toBe('EENVELOPE 550');
    expect(describeMailError(new TypeError(TOKEN))).toBe('TypeError');
    expect(describeMailError(null)).toBe('unknown');
  });
});

describe('invite mail', () => {
  it('links to PUBLIC_URL, in Vietnamese, with user-supplied names escaped', () => {
    const mail = inviteMail(INVITE, 'https://books.example.com');
    const url = `https://books.example.com/-/invite#${TOKEN}`;
    expect(mail.to).toBe('khach@example.test');
    expect(mail.subject).toBe('Lời mời tham gia Công ty <b>ABC</b> Bcc: victim@example.test trên Crove');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain(url);
    expect(mail.text).toContain('với vai trò quản trị');
    // 09:30 UTC is 16:30 in Vietnam.
    expect(mail.text).toContain('hết hạn lúc 16:30 ngày 22/10/2026 (giờ Việt Nam).');
    expect(mail.text).toContain('Chủ "Lan" (lan@example.test) mời bạn');
    expect(mail.text).toContain('đăng nhập hoặc tạo tài khoản bằng đúng địa chỉ email này (khach@example.test)');
    expect(mail.html).toContain(`href="${url}"`);
    expect(mail.html).toContain('Công ty &lt;b&gt;ABC&lt;/b&gt;');
    expect(mail.html).toContain('Chủ &quot;Lan&quot;');
    expect(mail.html).not.toContain('<b>ABC</b>');
  });

  it('strips bidi overrides from names', () => {
    const mail = inviteMail({ ...INVITE, orgName: 'Ngân hàng \u202Egnoh nân\u202C' }, 'https://books.example.com');
    expect(mail.subject).toBe('Lời mời tham gia Ngân hàng gnoh nân trên Crove');
  });

  it('never takes its host from anything but PUBLIC_URL', () => {
    expect(acceptUrl('http://localhost:8080/', '/-/invite#abc')).toBe('http://localhost:8080/-/invite#abc');
  });
});

describe('mail configuration', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth' };

  it('is off by default and needs a sender with a host', () => {
    const config = loadConfig(base);
    expect(config.SMTP_HOST).toBeUndefined();
    expect(config.SMTP_PORT).toBe(587);
    expect(createMailer(config).enabled).toBe(false);
    expect(() => loadConfig({ ...base, SMTP_HOST: 'smtp.example.com' })).toThrow(/SMTP_FROM/);
    expect(() => loadConfig({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'a@example.com', SMTP_USER: 'u' })).toThrow(/SMTP_PASS/);
    const on = loadConfig({ ...base, SMTP_HOST: 'mailpit', SMTP_PORT: '1025', SMTP_FROM: 'noreply@crove.local', SMTP_USER: '', SMTP_PASS: '' });
    expect(on.SMTP_PORT).toBe(1025);
    // SMTP_PORT= in a .env means the default, as before the kernel read it.
    expect(loadConfig({ ...base, SMTP_PORT: '' }).SMTP_PORT).toBe(587);
    expect(() => loadConfig({ ...base, SMTP_PORT: '70000' })).toThrow(/SMTP_PORT/);
    expect(createMailer(on).enabled).toBe(true);
    expect(createMailer(on).name).toBe('smtp');
  });

  it('sends through Resend with MAIL_PROVIDER=resend, which needs a key and a sender', () => {
    expect(loadConfig(base).MAIL_PROVIDER).toBe('smtp');
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' })).toThrow(/SMTP_FROM/);
    expect(() => loadConfig({ ...base, MAIL_PROVIDER: 'ses' })).toThrow(/MAIL_PROVIDER/);
    expect(() => loadConfig({ ...base, RESEND_WEBHOOK_SECRET: 'not-a-secret' })).toThrow(/RESEND_WEBHOOK_SECRET/);
    const resend = loadConfig({ ...base, MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', SMTP_FROM: 'noreply@mail.example.com', RESEND_WEBHOOK_SECRET: `whsec_${Buffer.alloc(24, 1).toString('base64')}` });
    const provider = createMailer(resend);
    expect(provider).toMatchObject({ name: 'resend', enabled: true, sendRetrySafety: 'idempotent' });
    expect(provider.parseWebhook).toBeTypeOf('function');
  });
});
