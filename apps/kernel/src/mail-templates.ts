// The templates queued mail is rendered from (#548), by template_key. A module that queues mail adds its template
// here; a queued mail whose template is missing fails with TEMPLATE_UNKNOWN rather than going out empty.
import type { MailTemplates } from './mail-queue.ts';
import { reportMailTemplate } from './report-mail.ts';

export const MAIL_TEMPLATES: MailTemplates = {
  // The scheduled client report (#704).
  'social.report': reportMailTemplate,
};
