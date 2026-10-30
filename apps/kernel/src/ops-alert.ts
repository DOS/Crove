// SPDX-License-Identifier: AGPL-3.0-only
// Operational ALERT lines (#1993): a job's last failed attempt that leaves no dead letter, a sweep that stopped working,
// a stored file whose bytes no longer match its hash. Each is logged as before and, when the deployment has an alert
// webhook (ALERT_WEBHOOK_URL: the prober's chat, which the security alerts and back-pressure use too), posted there as
// well, so the owner learns of it before the design partner does (#309). One kind of alert posts at most once a window
// (SECURITY_ALERT_REPEAT_MINUTES): a sweep failing every minute pages once. A failure that throws to pg-boss is not one of
// these: its dead letter already reaches the prober.
//
// The composition root configures it once per process (kernel.ts); unconfigured, as in tests and tools, it only logs.
// A post never throws and never waits on the caller: a webhook that fails is logged.
import { postMessage, type WebhookTarget } from './alert.ts';

export interface OpsAlertConfig {
  target: WebhookTarget | null;
  // The window in which one kind of alert posts once.
  repeatSeconds: number;
  post?: typeof postMessage;
  now?: () => number;
}

// The kinds posted recently, and when; the oldest are dropped past this many.
const MAX_KINDS = 500;

let current: OpsAlertConfig | null = null;
const lastPosted = new Map<string, number>();

export function configureOpsAlerts(config: OpsAlertConfig | null): void {
  current = config;
  lastPosted.clear();
}

// The kind of an alert, for its window: the line with ids and numbers taken out, so the same failure of another org,
// or with another count, is the same kind.
export function alertKind(line: string): string {
  return line
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+/g, '#')
    .slice(0, 300);
}

/**
 * Logs one operational ALERT line (with the error, when there is one, in the log only) and posts the line to the
 * alert webhook, once a window per kind. The line is what the log shows, `[source] ALERT ...`; it names no secret.
 */
export function opsAlert(line: string, error?: unknown): void {
  if (error === undefined) console.error(line);
  else console.error(line, error);
  const config = current;
  const target = config?.target;
  if (!config || !target?.webhookUrl) return;
  const now = (config.now ?? Date.now)();
  const kind = alertKind(line);
  const last = lastPosted.get(kind);
  if (last !== undefined && now - last < config.repeatSeconds * 1000) return;
  lastPosted.delete(kind);
  lastPosted.set(kind, now);
  if (lastPosted.size > MAX_KINDS) lastPosted.delete(lastPosted.keys().next().value as string);
  const post = config.post ?? postMessage;
  void post(
    { text: `[Crove] ${target.instance}: ${line}`, crove: { kind: 'ops_alert', instance: target.instance, line } },
    { webhookUrl: target.webhookUrl, format: target.webhookFormat, telegramChatId: target.telegramChatId },
  )
    .then((delivery) => {
      if (!delivery.ok) console.error(`[ops-alert] could not post the alert: ${delivery.error ?? 'unknown error'}`);
    })
    .catch((postError: unknown) => console.error('[ops-alert] could not post the alert', postError instanceof Error ? postError.message : postError));
}
