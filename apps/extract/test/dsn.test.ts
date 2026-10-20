// Bounce reports (DSN, RFC 3464, #539) read in the parser: each recipient's action and status, the bounced mail's
// Message-ID, and nothing else (no address, no diagnostic text); a mail that is not a report is refused.
import { describe, expect, it } from 'vitest';
import { zExtractSuccess } from '@crove/extract-contract';
import { parse } from '../src/parse.ts';

const report = (status: string, options: { action?: string; headers?: string; extra?: string } = {}) =>
  new TextEncoder().encode(
    [
      'From: Mail Delivery System <MAILER-DAEMON@mx.example.net>',
      'To: bounce+0123@inbound.example.com',
      'Subject: Undelivered Mail Returned to Sender',
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'Your mail to khach@example.test could not be delivered.',
      '--B',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example.net',
      'Arrival-Date: Tue, 20 Oct 2026 05:00:00 +0000',
      '',
      'Final-Recipient: rfc822; khach@example.test',
      `Action: ${options.action ?? 'failed'}`,
      `Status: ${status}`,
      'Diagnostic-Code: smtp; 550 5.1.1 <khach@example.test>: Recipient address',
      '  rejected: User unknown',
      options.extra ?? '',
      '--B',
      'Content-Type: text/rfc822-headers',
      '',
      options.headers ?? 'Message-ID: <0192f0aa-0000-7000-8000-000000000001@mail.example.com>\r\nSubject: Loi moi',
      '',
      '--B--',
      '',
    ].join('\r\n'),
  );

describe('bounce reports', () => {
  it('reads each recipient and the bounced mail, and no address or diagnostic', async () => {
    const result = await parse('dsn', report('5.1.1'));
    expect(result).toEqual({
      ok: true,
      kind: 'dsn',
      report: { originalMessageId: '<0192f0aa-0000-7000-8000-000000000001@mail.example.com>', recipients: [{ action: 'failed', status: '5.1.1' }] },
    });
    expect(zExtractSuccess.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('khach@example.test');
    expect(JSON.stringify(result)).not.toContain('User unknown');
  });

  it('reads a delay, a status with a comment, several recipients and a report without quoted headers', async () => {
    const delayed = await parse('dsn', report('4.4.7 (delivery time expired)', { action: 'delayed', headers: 'Subject: no id here' }));
    expect(delayed).toEqual({ ok: true, kind: 'dsn', report: { originalMessageId: null, recipients: [{ action: 'delayed', status: '4.4.7' }] } });
    const two = await parse('dsn', report('5.2.2', { extra: '\r\nFinal-Recipient: rfc822; b@example.test\r\nAction: Failed (mailbox full)\r\nStatus: 5.2.2\r\n' }));
    expect(two).toMatchObject({ ok: true, report: { recipients: [{ action: 'failed', status: '5.2.2' }, { action: 'failed', status: '5.2.2' }] } });
    const unparsable = await parse('dsn', report('unknown'));
    expect(unparsable).toMatchObject({ ok: true, report: { recipients: [{ action: 'failed', status: null }] } });
  });

  it('refuses a mail that is not a bounce report, or one with no recipient', async () => {
    const plain = new TextEncoder().encode('From: a@example.test\r\nTo: bounce+1@inbound.example.com\r\nSubject: hello\r\n\r\nJust a reply.\r\n');
    expect(await parse('dsn', plain)).toEqual({ ok: false, code: 'invalid', message: 'Thư không phải báo cáo trạng thái gửi (DSN)' });
    expect(await parse('dsn', report('5.1.1', { action: 'whatever' }))).toEqual({ ok: false, code: 'invalid', message: 'Báo cáo trạng thái gửi không có người nhận nào' });
  });
});
