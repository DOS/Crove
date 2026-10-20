// No provider configured: send() logs one line naming the subject and sends nothing.
import type { MailProvider } from './types.ts';

export function createLogProvider(log: (line: string) => void = (line) => console.log(line)): MailProvider {
  return {
    name: 'log',
    enabled: false,
    sendRetrySafety: 'safe',
    async send(mail) {
      log(`[mail] not sent, SMTP_HOST is not set: "${mail.subject}"`);
      return { status: 'accepted' };
    },
  };
}
