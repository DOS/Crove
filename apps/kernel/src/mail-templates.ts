// The templates queued mail is rendered from (#548), by template_key. A module that queues mail adds its template
// here; a queued mail whose template is missing fails with TEMPLATE_UNKNOWN rather than going out empty.
import type { MailTemplates } from './mail-queue.ts';
import { bookingMailTemplate } from './booking-mail.ts';
import { digestMailTemplate } from './digest-mail.ts';
import { MISSING_INVOICE_TEMPLATE, missingInvoiceMailTemplate } from './missing-invoice-mail.ts';
import { notificationMailTemplate } from './notification-mail.ts';
import { proposalReminderMailTemplate } from './proposal-reminder-mail.ts';
import { reportMailTemplate } from './report-mail.ts';
import { usageDeferredMailTemplate } from './usage-deferred-mail.ts';

export const MAIL_TEMPLATES: MailTemplates = {
  // The scheduled client report (#704).
  'social.report': reportMailTemplate,
  // Social notifications someone must act on (#579).
  'social.notification': notificationMailTemplate,
  // The weekly digest for the team (#1104).
  'social.digest': digestMailTemplate,
  // Proposals waiting for approval past the days the org set (#676).
  'kernel.proposal.reminder': proposalReminderMailTemplate,
  // Finance's request to a client company for its missing purchase invoices, and the monthly reminder (#669).
  [MISSING_INVOICE_TEMPLATE]: missingInvoiceMailTemplate,
  // An org over a daily abuse limit (#675).
  'kernel.usage.deferred': usageDeferredMailTemplate,
  // A booking of the public booking page confirmed, moved or cancelled, and its reminders (#1319).
  'crm.booking': bookingMailTemplate,
};
