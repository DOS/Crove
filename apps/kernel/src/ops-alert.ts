// SPDX-License-Identifier: AGPL-3.0-only
// Operational ALERT lines (#1993): a job's last failed attempt that leaves no dead letter, a sweep that stopped working,
// a stored file whose bytes no longer match its hash. Each is logged as before and, when the deployment has an alert
// webhook (ALERT_WEBHOOK_URL: the prober's chat, which the security alerts and back-pressure use too), posted there as
// well, so the owner learns of it before the design partner does (#309). One kind of alert posts at most once a window
// (SECURITY_ALERT_REPEAT_MINUTES) per process: a sweep failing every minute pages once. A failure that throws to pg-boss
// is not one of these: its dead letter already reaches the prober.
//
// opsAlert only logs and queues: the post is the process's, made by a timer like the back-pressure and security
// alerts, never by the job or request that hit the failure. So a queue's handler reaches no network through it (the
// job egress invariant, #1653), and a webhook that is slow or down never holds a job. The composition root configures
// it once per process (kernel.ts) and flushes it on stop; unconfigured, as in tests and tools, it only logs.
import { postMessage, type WebhookMessage, type WebhookTarget } from './alert.ts';

export interface OpsAlertConfig {
  target: WebhookTarget | null;
  // The window in which one kind of alert posts once.
  repeatSeconds: number;
  post?: typeof postMessage;
  now?: () => number;
  // How often the queued alerts are posted; 0 starts no timer (a test flushes by hand).
  flushMs?: number;
}

// The kinds posted recently, and when, and the alerts waiting to be posted; both bounded.
const MAX_KINDS = 500;
const MAX_PENDING = 50;
const FLUSH_MS = 2_000;
// The longest line posted: a chat refuses a long message, and the log has the rest.
const MAX_POSTED = 300;

let current: OpsAlertConfig | null = null;
const lastPosted = new Map<string, number>();
const pending: WebhookMessage[] = [];
let dropped = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;

export function configureOpsAlerts(config: OpsAlertConfig | null): void {
  if (timer) clearInterval(timer);
  timer = null;
  current = config;
  lastPosted.clear();
  pending.length = 0;
  dropped = 0;
  const flushMs = config?.flushMs ?? FLUSH_MS;
  if (config?.target?.webhookUrl && flushMs > 0) {
    timer = setInterval(() => void flushOpsAlerts(), flushMs);
    timer.unref();
  }
}

// The kind of an alert, for its window: the line with ids, hashes and numbers taken out, so the same failure of
// another org, session, file or count is the same kind.
export function alertKind(line: string): string {
  return line
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    // A session's prefix (sign-out lines) is an id even when it holds no digit (deadbeef).
    .replace(/\bsession [0-9a-f]{6,}\b/gi, 'session <id>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi, '<id>')
    .replace(/\d+/g, '#')
    .slice(0, 300);
}

/**
 * Logs one operational ALERT line (with the error, when there is one, in the log only) and queues the line for the
 * alert webhook, once a window per kind. The line is what the log shows, `[source] ALERT ...`; it names no secret, and
 * no content hash (that stays in the error).
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
  if (pending.length >= MAX_PENDING) {
    dropped += 1;
    return;
  }
  const posted = line.length > MAX_POSTED ? `${line.slice(0, MAX_POSTED - 1)}…` : line;
  pending.push({ text: `[Crove] ${target.instance}: ${posted}`, crove: { kind: 'ops_alert', instance: target.instance, line: posted } });
}

/**
 * Posts the queued alerts, one at a time; one flush at a time. Never throws: a failed post is logged. With a deadline (the
 * stop's), no post outlasts it and what is left stays in the log only.
 */
export function flushOpsAlerts(deadlineMs?: number): Promise<void> {
  if (flushing) return deadlineMs === undefined ? flushing : within(flushing, deadlineMs);
  const until = deadlineMs === undefined ? Infinity : Date.now() + deadlineMs;
  // Cleared in a later microtask, after the assignment: a flush with nothing to post finishes at once.
  flushing = (async () => {
    const config = current;
    const target = config?.target;
    if (!config || !target?.webhookUrl) return;
    const post = config.post ?? postMessage;
    if (dropped > 0) {
      pending.push({ text: `[Crove] ${target.instance}: ${dropped} more operational alert(s) are in the log only`, crove: { kind: 'ops_alert', instance: target.instance, dropped } });
      dropped = 0;
    }
    for (let message = pending.shift(); message; message = pending.shift()) {
      const left = until - Date.now();
      if (left <= 0) {
        console.error(`[ops-alert] ${pending.length + 1} alert(s) not posted before the deadline; they are in the log`);
        pending.length = 0;
        break;
      }
      const options = { webhookUrl: target.webhookUrl, format: target.webhookFormat, telegramChatId: target.telegramChatId, timeoutMs: Math.min(10_000, left) };
      const delivery = await post(message, options).catch(
        (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      if (!delivery.ok) console.error(`[ops-alert] could not post the alert: ${delivery.error ?? 'unknown error'}`);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// Waits for a flush already under way, at most ms.
function within(flush: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void flush.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
