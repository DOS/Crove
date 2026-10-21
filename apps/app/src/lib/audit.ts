// The audit log screen's filter (#672): the form's text fields as the query's filter, and the cursor of the next page.
import { AUDIT_OUTCOMES, type AuditCursor, type AuditFilter, type AuditOutcome, type AuditPage } from '@crove/kernel-contract';

export interface AuditFilterForm {
  actor: string;
  command: string;
  outcome: string;
  target: string;
  from: string;
  to: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Only what the server would accept: a target that is not a whole id is left out (the screen says so) rather than sent.
export function auditFilter(form: AuditFilterForm): AuditFilter {
  const target = form.target.trim().toLowerCase();
  return {
    ...(form.actor ? { actor: form.actor } : {}),
    ...(form.command ? { command: form.command } : {}),
    ...((AUDIT_OUTCOMES as readonly string[]).includes(form.outcome) ? { outcome: form.outcome as AuditOutcome } : {}),
    ...(UUID.test(target) ? { targetId: target } : {}),
    ...(DATE.test(form.from) ? { from: form.from } : {}),
    ...(DATE.test(form.to) ? { to: form.to } : {}),
  };
}

export function nextAuditCursor(page: AuditPage): AuditCursor | undefined {
  const last = page.items.at(-1);
  return page.more && last ? { at: last.at, id: last.id } : undefined;
}
