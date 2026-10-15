// Outbound mail (issue #129): the SMTP adapter against an in-process SMTP server, the log fallback, retries, the
// invite template and the configuration guards.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { acceptUrl, createInviteMailSender, inviteMail, type InviteMailInput } from '../src/invite-mail.ts';
import { createLogMailer, createMailer, createSmtpMailer, deliver, describeMailError, type Mailer, type OutboundMail } from '../src/mail.ts';

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
        const custom = reply(verb);
        if (custom) {
          socket.write(`${custom}\r\n`);
          continue;
        }
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-test\r\n250 8BITMIME\r\n');
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
    const mailer = createSmtpMailer({ host: '127.0.0.1', port, from: 'noreply@crove.local' });
    expect(mailer.enabled).toBe(true);
    const logs: string[] = [];
    const send = createInviteMailSender(mailer, 'https://books.example.com/', { log: (l) => logs.push(l) });
    expect(await send(INVITE)).toBe('sent');
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
});

describe('log fallback', () => {
  it('is used without SMTP_HOST and never logs the body or the recipient', async () => {
    expect(createMailer({ SMTP_HOST: undefined, SMTP_PORT: 587, SMTP_USER: undefined, SMTP_PASS: undefined, SMTP_FROM: undefined }).enabled).toBe(false);
    const lines: string[] = [];
    const mailer = createLogMailer((l) => lines.push(l));
    expect(await deliver(mailer, MAIL, { log: (l) => lines.push(l) })).toBe('off');
    expect(lines).toEqual(['[mail] not sent, SMTP_HOST is not set: "Chủ đề"']);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(MAIL.to);
  });
});

describe('deliver', () => {
  const failing = (errors: unknown[]): Mailer & { calls: number } => {
    const m = {
      enabled: true,
      calls: 0,
      async send() {
        m.calls++;
        const error = errors.shift();
        if (error) throw error;
      },
    };
    return m;
  };
  const smtpError = (code: string, responseCode?: number) =>
    Object.assign(new Error(`failed for khach@example.test: ${TOKEN}`), { code, ...(responseCode ? { responseCode } : {}) });
  const noSleep = async () => undefined;

  it('retries transient errors and reports success', async () => {
    const mailer = failing([smtpError('ECONNECTION'), smtpError('EENVELOPE', 451)]);
    const logs: string[] = [];
    expect(await deliver(mailer, MAIL, { sleep: noSleep, log: (l) => logs.push(l) })).toBe('sent');
    expect(mailer.calls).toBe(3);
    expect(logs).toEqual([]);
  });

  it('gives up after the retries, logging codes only', async () => {
    const mailer = failing([smtpError('ETIMEDOUT'), smtpError('ETIMEDOUT'), smtpError('ETIMEDOUT')]);
    const logs: string[] = [];
    expect(await deliver(mailer, MAIL, { sleep: noSleep, log: (l) => logs.push(l), label: 'invite mail' })).toBe('failed');
    expect(mailer.calls).toBe(3);
    expect(logs).toEqual(['[mail] invite mail not sent after 3 attempt(s): ETIMEDOUT']);
  });

  it('does not retry permanent errors', async () => {
    for (const error of [smtpError('EENVELOPE', 550), smtpError('EAUTH', 535), smtpError('EMESSAGE')]) {
      const mailer = failing([error]);
      const logs: string[] = [];
      expect(await deliver(mailer, MAIL, { sleep: noSleep, log: (l) => logs.push(l) })).toBe('failed');
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
    const mailer = createSmtpMailer({ host: '127.0.0.1', port, from: 'noreply@crove.local' });
    expect(await deliver(mailer, MAIL, { sleep: noSleep, log: (l) => logs.push(l) })).toBe('failed');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[mail\] mail not sent after 3 attempt\(s\): [A-Z]+/);
    expect(logs[0]).not.toContain(TOKEN);
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
    expect(createMailer(on).enabled).toBe(true);
  });
});
