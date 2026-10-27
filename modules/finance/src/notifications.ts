// Finance's in-app notifications (#671), written through the kernel's notifyMembers() (packages/kernel/src/notifications.ts):
// - finance.bank_attention: a bank statement import left lines that need a look (ambiguous ones: the bank's file could
//   not tell them apart from lines already there). The owners and admins, never the person who imported it.
// - finance.portal_attention: the tax portal's purchase list of a period was read, and the period has invoices the
//   portal lists and Crove does not, or whose amounts differ; or the list could not be read. The member who imported
//   it, and the owners and admins.
// - finance.period_closing: the VAT return of a period is due within PERIOD_CLOSING_DAYS days and the period is not
//   locked yet. The owners and admins, once per period, from an hourly sweep (sweepPeriodClosing).
import { sql } from 'kysely';
import { z } from 'zod';
import { nextVatDeadline, zId, zLocalDate, type PortalReconciliation, type VatFilingPeriod } from '@crove/kernel-contract';
import type { Db } from '@crove/db';
import { notifyMembers, outboxEvent, ownersAndAdmins } from '@crove/kernel';
import { DomainError, defineCommand, type Runtime } from '@crove/kernel-runtime';

export const BANK_ATTENTION = 'finance.bank_attention';
export const PORTAL_ATTENTION = 'finance.portal_attention';
export const PERIOD_CLOSING = 'finance.period_closing';

// The events finance.notification.dispatch handles.
export const FINANCE_NOTIFYING_EVENTS = ['finance.bank.imported', 'finance.portal_list.recorded'] as const;

export const notificationDispatch = defineCommand({
  name: 'finance.notification.dispatch',
  input: z.object({ eventId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    const event = await outboxEvent(ctx, input.eventId);
    if (!event) return { sent: 0 };
    switch (event.type) {
      case 'finance.bank.imported': {
        const e = z.object({ importId: zId, bankAccount: z.string().max(50), ambiguous: z.number().int().positive() }).safeParse(event.payload);
        if (!e.success) return { sent: 0 };
        const sent = await notifyMembers(ctx, {
          kind: BANK_ATTENTION,
          users: await ownersAndAdmins(ctx),
          key: `bank_import:${e.data.importId}`,
          subject: { type: 'finance.bank_import', id: e.data.importId },
          detail: { bankAccount: e.data.bankAccount, lines: String(e.data.ambiguous) },
          eventId: event.id,
          actor: event.actor,
        });
        return { sent };
      }
      case 'finance.portal_list.recorded': {
        const e = z.object({ listId: zId }).safeParse(event.payload);
        if (!e.success) return { sent: 0 };
        const list = await ctx.trx
          .selectFrom('crove_finance.portal_invoice_list')
          .select(['id', 'period', 'status', 'created_by', 'removed_at', 'legal_entity_id'])
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', e.data.listId)
          .executeTakeFirst();
        if (!list || list.removed_at !== null || list.status === 'pending') return { sent: 0 };
        let detail: Record<string, string> = { period: list.period, failed: 'true' };
        if (list.status === 'done') {
          // The reconciliation of the list's legal entity (#1280).
          const found = await ctx.query<PortalReconciliation>('finance.portal_list.reconcile', { period: list.period, legalEntityId: list.legal_entity_id });
          if (found.status !== 'ok') return { sent: 0 };
          const { missing, amountMismatch } = found.value.summary;
          // Everything on the portal is in Crove: nothing to look at.
          if (missing + amountMismatch === 0) return { sent: 0 };
          detail = { period: list.period, missing: String(missing), amountMismatch: String(amountMismatch) };
        }
        const sent = await notifyMembers(ctx, {
          kind: PORTAL_ATTENTION,
          users: [...(list.created_by ? [list.created_by] : []), ...(await ownersAndAdmins(ctx))],
          key: `portal_list:${list.id}`,
          subject: { type: 'finance.portal_list', id: list.id },
          detail,
          eventId: event.id,
        });
        return { sent };
      }
      default:
        return { sent: 0 };
    }
  },
});

// How many days before a VAT return's due date its period is called closing.
export const PERIOD_CLOSING_DAYS = 5;
// How often the sweep runs, and how many orgs one page reads.
export const PERIOD_CLOSING_SWEEP_MS = 60 * 60 * 1000;
const PERIOD_CLOSING_PAGE = 200;

// The last day of a VAT period key ('2026-09' or '2026-Q3').
export function periodEnd(period: string): string {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  const [year, month] = quarter ? [Number(quarter[1]), Number(quarter[2]) * 3] : (period.split('-').map(Number) as [number, number]);
  // Day 0 of the next month is the month's last day.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

// The period whose return is due within PERIOD_CLOSING_DAYS days of today and that the lock does not cover yet, or
// null. An org that never set its filing period files monthly, the default for a new business.
export function closingPeriod(kind: VatFilingPeriod | null, lockedThrough: string | null, today: string): { period: string; dueDate: string } | null {
  const deadline = nextVatDeadline(kind ?? 'month', today);
  if (deadline.daysLeft > PERIOD_CLOSING_DAYS) return null;
  const end = periodEnd(deadline.period);
  // Not ended yet (a quarterly return is never due before its quarter ends, but be sure), or already locked.
  if (end >= today || (lockedThrough !== null && lockedThrough >= end)) return null;
  return { period: deadline.period, dueDate: deadline.dueDate };
}

export const periodClosingRemind = defineCommand({
  name: 'finance.period.closing_remind',
  // Today in Vietnam, from the sweep: the reminder is a notice, so the worker's clock is good enough (the lock itself
  // reads the database's).
  input: z.object({ today: zLocalDate }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    // Read again here: the sweep's page is only a hint.
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['vat_filing_period', 'status']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (org?.status !== 'active') return { sent: 0 };
    // Each legal entity locks its own months (#1280): the period is still open while any entity's books are, so the
    // earliest lock counts (none at all while an entity has never locked).
    const locks = await ctx.trx
      .selectFrom('crove_finance.period_lock')
      .select(sql<string | null>`pg_catalog.to_char(locked_through, 'YYYY-MM-DD')`.as('through'))
      .where('org_id', '=', ctx.orgId)
      .execute();
    const through = locks.some((l) => l.through === null) ? null : (locks.map((l) => l.through as string).sort()[0] ?? null);
    const closing = closingPeriod((org.vat_filing_period as VatFilingPeriod | null) ?? null, through, input.today);
    if (!closing) return { sent: 0 };
    const sent = await notifyMembers(ctx, {
      kind: PERIOD_CLOSING,
      users: await ownersAndAdmins(ctx),
      key: `period_closing:${closing.period}`,
      detail: closing,
    });
    return { sent };
  },
});

const ACTOR = { type: 'system' as const, component: 'finance.period_closing' };

// Pages through the active orgs (crove_finance.period_close_due, worker only) and reminds those whose period is
// closing. Returns how many notifications it wrote.
export async function sweepPeriodClosing(deps: { runtime: Runtime; workerDb: Db; today: string }): Promise<number> {
  let after: string | null = null;
  let sent = 0;
  for (;;) {
    const { rows }: { rows: Array<{ org_id: string; vat_filing_period: string | null; locked_through: string | null }> } = await sql<{
      org_id: string;
      vat_filing_period: string | null;
      locked_through: string | null;
    }>`SELECT org_id, vat_filing_period, pg_catalog.to_char(locked_through, 'YYYY-MM-DD') AS locked_through
       FROM crove_finance.period_close_due(${after}::uuid, ${PERIOD_CLOSING_PAGE}::int)`.execute(deps.workerDb);
    for (const row of rows) {
      if (!closingPeriod((row.vat_filing_period as VatFilingPeriod | null) ?? null, row.locked_through, deps.today)) continue;
      try {
        const done = await deps.runtime.execute<{ sent: number }>('finance.period.closing_remind', { today: deps.today }, { actor: ACTOR, orgId: row.org_id });
        sent += done.sent;
      } catch (error) {
        console.warn(`[period-closing] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.message : error);
      }
    }
    if (rows.length < PERIOD_CLOSING_PAGE) return sent;
    after = rows.at(-1)?.org_id ?? null;
  }
}

export const financeNotificationCommands = [notificationDispatch, periodClosingRemind];
