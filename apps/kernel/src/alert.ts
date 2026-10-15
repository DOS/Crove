// Alert delivery for the prober (plan §4.13, issue #39), behind the AlertSink port (ADR-0030). One generic adapter:
// POST a JSON body to ALERT_WEBHOOK_URL, or print to stdout when no webhook is configured. The body carries `text` (Slack incoming webhooks, Mattermost,
// Google Chat), `content` (Discord) and a structured `crove` object for anything else. The webhook URL usually
// embeds a secret, so it is never logged: only its host is.

export type AlertKind = 'alert' | 'test';

export interface Finding {
  check: 'outbox' | 'inbound' | 'jobs_schema' | 'job_age' | 'dead_letters' | 'heartbeat' | 'probe';
  message: string;
  value: number | null;
  threshold: number | null;
}

export interface Alert {
  kind: AlertKind;
  instance: string;
  at: string;
  findings: Finding[];
  // The health() row the findings came from, when the probe could read it.
  health?: Record<string, unknown>;
}

export interface AlertPayload {
  text: string;
  content: string;
  crove: { kind: AlertKind; severity: 'critical' | 'info'; instance: string; at: string; findings: Finding[]; health?: Record<string, unknown> };
}

// Discord rejects content over 2000 characters.
const MAX_TEXT = 1900;

export function alertText(alert: Alert): string {
  const head =
    alert.kind === 'test'
      ? `[Crove] Test alert from ${alert.instance}: alert delivery works.`
      : `[Crove] ALERT on ${alert.instance}: ${alert.findings.length} health check(s) failed.`;
  const lines = alert.findings.map((f) => `- ${f.message}`);
  const text = [head, ...lines].join('\n');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}

export function alertPayload(alert: Alert): AlertPayload {
  const text = alertText(alert);
  return {
    text,
    content: text,
    crove: {
      kind: alert.kind,
      severity: alert.kind === 'test' ? 'info' : 'critical',
      instance: alert.instance,
      at: alert.at,
      findings: alert.findings,
      ...(alert.health ? { health: alert.health } : {}),
    },
  };
}

export interface AlertSinkOptions {
  webhookUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number;
  log?: ((line: string) => void) | undefined;
}

export interface Delivery {
  channel: 'webhook' | 'stdout';
  ok: boolean;
  error?: string;
}

export function describeWebhook(url: string | undefined): string {
  if (!url) return 'stdout (ALERT_WEBHOOK_URL is not set)';
  try {
    return `webhook at ${new URL(url).host}`;
  } catch {
    return 'webhook (invalid URL)';
  }
}

/** Delivers one alert. Never throws: a failed webhook is reported in the result and the alert is printed instead. */
export async function deliverAlert(alert: Alert, options: AlertSinkOptions): Promise<Delivery> {
  const log = options.log ?? ((line: string) => console.log(line));
  const payload = alertPayload(alert);
  if (!options.webhookUrl) {
    log(payload.text);
    return { channel: 'stdout', ok: true };
  }
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(options.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    // Drain the body so the connection is released; its content is not logged (it may echo the request).
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { channel: 'webhook', ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(payload.text);
    return { channel: 'webhook', ok: false, error: `${describeWebhook(options.webhookUrl)} failed: ${reason}` };
  }
}

// The alert port (ADR-0030): where the prober sends an alert. deliver never throws; a failed delivery is reported in
// its result. describe names the destination for logs and never includes a secret.
export interface AlertSink {
  describe(): string;
  deliver(alert: Alert): Promise<Delivery>;
}

// The open-source default: the generic webhook, or stdout without one.
export function webhookAlertSink(options: AlertSinkOptions): AlertSink {
  return { describe: () => describeWebhook(options.webhookUrl), deliver: (alert) => deliverAlert(alert, options) };
}
