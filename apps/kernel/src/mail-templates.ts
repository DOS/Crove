// The templates queued mail is rendered from (#548), by template_key. A module that queues mail adds its template
// here; a queued mail whose template is missing fails with TEMPLATE_UNKNOWN rather than going out empty.
import type { MailTemplates } from './mail-queue.ts';
import { MISSING_INVOICE_TEMPLATE, missingInvoiceMailTemplate } from './missing-invoice-mail.ts';
import { notificationMailTemplate } from './notification-mail.ts';
import { proposalReminderMailTemplate } from './proposal-reminder-mail.ts';
import { reportMailTemplate } from './report-mail.ts';

export const MAIL_TEMPLATES: MailTemplates = {
  // The scheduled client report (#704).
  'social.report': reportMailTemplate,
  // Social notifications someone must act on (#579).
  'social.notification': notificationMailTemplate,
  // Proposals waiting for approval past the days the org set (#676).
  'kernel.proposal.reminder': proposalReminderMailTemplate,
  // Finance's request to a client company for its missing purchase invoices, and the monthly reminder (#669).
  [MISSING_INVOICE_TEMPLATE]: missingInvoiceMailTemplate,
};
