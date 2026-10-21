// Detective security alerts (issue #996, plan §7.8 "Detective controls (with alerts)"). Every few minutes the worker
// asks crove_kernel.security_signals (worker only) for the signals worth an alert now, logs each as an ALERT line and,
// when ALERT_WEBHOOK_URL is set, posts it to the same chat as the prober's alerts:
//   actor_many_orgs   one user acting in more orgs than SECURITY_ALERT_ORG_THRESHOLD within the window;
//   refusal_spike     more refusals across the deployment than SECURITY_ALERT_REFUSAL_THRESHOLD within the window;
//   privileged_grant  an owner or admin role given in an org.
// The database remembers what was alerted, so several workers alert once and a lasting signal repeats only after the
// repeat interval. Messages hold ids and counts only: no email, name or token.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { postMessage, type WebhookTarget } from './alert.ts';

export const SECURITY_SWEEP_MS = 5 * 60_000;

export interface SecurityThresholds {
  windowSeconds: number;
  orgThreshold: number;
  refusalThreshold: number;
  repeatSeconds: number;
}

export const DEFAULT_SECURITY_THRESHOLDS: SecurityThresholds = { windowSeconds: 300, orgThreshold: 20, refusalThreshold: 500, repeatSeconds: 3600 };

export interface SecuritySignal {
  signal: 'actor_many_orgs' | 'refusal_spike' | 'privileged_grant';
  subject: string;
  value: number;
  orgId: string | null;
  detail: string | null;
}

export interface SecurityAlertDeps {
  workerDb: Db;
  // The alert webhook; null logs only.
  target: WebhookTarget | null;
  thresholds?: SecurityThresholds | undefined;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

// One line per signal, for the log and the chat. Ids and counts only.
export function securityAlertText(signal: SecuritySignal, thresholds: SecurityThresholds): string {
  const window = `${minutes(thresholds.windowSeconds)} min`;
  switch (signal.signal) {
    case 'actor_many_orgs':
      return `user ${signal.subject} acted in ${signal.value} orgs within ${window} (threshold ${thresholds.orgThreshold}): check for cross-org probing or a stolen account (docs/runbooks/alerts.md)`;
    case 'refusal_spike':
      return `${signal.value} refused requests within ${window} across the deployment (threshold ${thresholds.refusalThreshold}): check for probing or a broken client (docs/runbooks/alerts.md)`;
    case 'privileged_grant':
      return `${signal.detail === 'owner' ? 'owner' : 'admin'} role given in org ${signal.orgId ?? 'unknown'} (audit row ${signal.subject}): confirm it was intended`;
  }
}

// The signals due now, alerted at most once per worker pass. Resolves to how many were found.
export async function sweepSecuritySignals(deps: SecurityAlertDeps): Promise<number> {
  const thresholds = deps.thresholds ?? DEFAULT_SECURITY_THRESHOLDS;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const { rows } = await sql<{ signal: SecuritySignal['signal']; subject: string; value: string; org_id: string | null; detail: string | null }>`
    SELECT signal, subject, value::text AS value, org_id, detail
    FROM crove_kernel.security_signals(${thresholds.windowSeconds}::int, ${thresholds.orgThreshold}::int, ${thresholds.refusalThreshold}::int, ${thresholds.repeatSeconds}::int)`.execute(
    deps.workerDb,
  );
  for (const row of rows) {
    const signal: SecuritySignal = { signal: row.signal, subject: row.subject, value: Number(row.value), orgId: row.org_id, detail: row.detail };
    const text = securityAlertText(signal, thresholds);
    log(`[security] ALERT ${signal.signal}: ${text}`);
    if (!deps.target?.webhookUrl) continue;
    const delivery = await postMessage(
      { text: `[Crove] Security alert from ${deps.target.instance}: ${text}`, crove: { kind: 'security', instance: deps.target.instance, ...signal } },
      { webhookUrl: deps.target.webhookUrl, format: deps.target.webhookFormat, telegramChatId: deps.target.telegramChatId, fetch: deps.fetch },
    );
    if (!delivery.ok) log(`[security] could not post the alert: ${delivery.error ?? 'unknown error'}`);
  }
  return rows.length;
}
