// The request for missing purchase invoices and its monthly reminder (#669, template finance.missing_invoices): the
// invoices the tax portal lists and Crove lacks, as finance.missing_invoices.request or .remind stored them. The
// Reply-To is the org's inbound address when the deployment receives mail, so the company's reply, or the seller's
// invoice mail it forwards, reaches the Inbox like any other mail with an invoice.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import type { Runtime } from '@crove/kernel-runtime';
import { MISSING_INVOICE_TEMPLATE, renderMissingInvoiceMail, type RemindResult } from '@crove/mod-finance';
import { mailErrorCode, type MailTemplate } from './mail-queue.ts';

export { MISSING_INVOICE_TEMPLATE };

export const missingInvoiceMailTemplate: MailTemplate = {
  async render(input) {
    if (!input.subject) return null;
    // Merge data that is not what the template needs throws; the queue records TEMPLATE_DATA.
    const body = renderMissingInvoiceMail(input.payload, { replyTo: input.inboundAddress });
    return { subject: input.subject, ...body };
  },
};

// The monthly reminders (#669): every 15 minutes the worker finds the orgs whose reminder is due today
// (crove_finance.missing_invoice_reminders_due: from 08:00 Vietnam time on the reminder's day, once a month) and runs
// finance.missing_invoices.remind in each, which queues the mail or, when nothing is missing, turns the reminder off.
export const MISSING_INVOICE_SWEEP_MS = 15 * 60_000;
const MISSING_INVOICE_SWEEP_LIMIT = 200;
const ACTOR = { type: 'system' as const, component: 'finance.missing_invoices' };

export async function sweepMissingInvoiceReminders(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_finance.missing_invoice_reminders_due(${MISSING_INVOICE_SWEEP_LIMIT}::int)`.execute(deps.workerDb);
  let sent = 0;
  for (const row of rows) {
    // One org that fails (a lost connection) leaves the others to this pass and itself to the next.
    try {
      const done = await deps.runtime.execute<RemindResult>('finance.missing_invoices.remind', {}, { actor: ACTOR, orgId: row.org_id });
      if (done.action === 'sent') sent++;
    } catch (error) {
      console.error(`[missing-invoices] reminder of org ${row.org_id.slice(0, 8)} failed: ${mailErrorCode(error)}`);
    }
  }
  return sent;
}
