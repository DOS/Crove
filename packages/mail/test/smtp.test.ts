// How SMTP errors map to results (#539): refusals that will not change are not retried; a 4xx reply or a connection
// that failed may pass later. Codes only, never the server's message.
import { describe, expect, it } from 'vitest';
import { classifySmtpError, createLogProvider, describeMailError } from '../src/index.ts';

const smtpError = (code: string, responseCode?: number) => Object.assign(new Error('550 khach@example.test: no such user'), { code, ...(responseCode ? { responseCode } : {}) });

describe('SMTP errors', () => {
  it('classifies replies and transport errors', () => {
    expect(classifySmtpError(smtpError('EENVELOPE', 550))).toEqual({ status: 'rejected', error: 'invalid_recipient', code: 'EENVELOPE 550' });
    expect(classifySmtpError(smtpError('EMESSAGE', 554))).toEqual({ status: 'rejected', error: 'bad_request', code: 'EMESSAGE 554' });
    expect(classifySmtpError(smtpError('EAUTH', 535))).toEqual({ status: 'rejected', error: 'auth', code: 'EAUTH 535' });
    expect(classifySmtpError(smtpError('EENVELOPE', 451))).toEqual({ status: 'rejected', error: 'transient', code: 'EENVELOPE 451' });
    expect(classifySmtpError(smtpError('ENOAUTH'))).toEqual({ status: 'rejected', error: 'auth', code: 'ENOAUTH' });
    expect(classifySmtpError(smtpError('ETLS'))).toEqual({ status: 'rejected', error: 'bad_request', code: 'ETLS' });
    expect(classifySmtpError(smtpError('ECONNECTION'))).toEqual({ status: 'rejected', error: 'transient', code: 'ECONNECTION' });
    expect(classifySmtpError(new TypeError('x'))).toEqual({ status: 'rejected', error: 'transient', code: 'TypeError' });
    expect(JSON.stringify(classifySmtpError(smtpError('EENVELOPE', 550)))).not.toContain('khach@example.test');
  });

  it('describes an error by its code and reply code', () => {
    expect(describeMailError(smtpError('EENVELOPE', 550))).toBe('EENVELOPE 550');
    expect(describeMailError(null)).toBe('unknown');
  });
});

describe('log provider', () => {
  it('sends nothing and names only the subject', async () => {
    const lines: string[] = [];
    const provider = createLogProvider((l) => lines.push(l));
    expect(provider).toMatchObject({ name: 'log', enabled: false });
    expect(await provider.send({ to: 'khach@example.test', subject: 'Chủ đề', text: 'secret', html: 'secret' })).toEqual({ status: 'accepted' });
    expect(lines).toEqual(['[mail] not sent, SMTP_HOST is not set: "Chủ đề"']);
  });
});
