// The `prober` image role (plan §4.13, issues #39 and #151): reads crove_kernel.health() as crove_prober, compares
// it with thresholds and notifies on news only (alert-gate.ts): a new or changed problem, a resolved one, and the
// same problem again every ALERT_REPEAT_MINUTES. Runs once and exits (cron, a scheduler), or repeats with
// `--every <seconds>` (the Compose profile). `--test-alert` sends a test alert and needs no database, and so does
// `--backup-failed <reason>`, which the backup script runs when a backup fails, and `--backup-ok`, which it runs after
// a good one to ping BACKUP_HEARTBEAT_URL (docs/runbooks/backup-and-restore.md).
//
// Exit codes: 0 healthy (or the test alert was delivered), 1 thresholds exceeded, 2 the health check could not run
// (configuration, connection, permissions), 3 the alert could not be delivered (it was printed to stdout instead).
//
// The prober cannot report its own absence, so with PROBER_HEARTBEAT_URL it also pings an outside dead man's switch
// (issue #309): after each probe that read the database and delivered every notification it owed (exit 0 or 1). The
// outside monitor then pages when the pings stop: the prober or the host is down, the database cannot be read, or
// the alert path is broken.
import { hostname } from 'node:os';
import pg from 'pg';
import { z } from 'zod';
import { effectiveRepeatSeconds, memoryAlertGate, pgAlertGate, problemKey, type AlertGate, type GateResult } from './alert-gate.ts';
import {
  WEBHOOK_FORMATS,
  detectWebhookFormat,
  webhookAlertSink,
  type Alert,
  type AlertSink,
  type AlertSinkOptions,
  type Delivery,
  type Finding,
  type WebhookFormat,
} from './alert.ts';

export const EXIT = { ok: 0, unhealthy: 1, probeFailed: 2, deliveryFailed: 3 } as const;

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));
const seconds = (fallback: number) => z.coerce.number().int().min(0).max(604_800).default(fallback);

const schema = z.object({
  // Connect as crove_prober (password CROVE_PROBER_DB_PASSWORD, set by `migrate`).
  PROBER_DATABASE_URL: optional,
  ALERT_WEBHOOK_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // auto: Slack, Discord and Telegram by their API hosts, generic otherwise (alert.ts).
  ALERT_WEBHOOK_FORMAT: z.enum(['auto', ...WEBHOOK_FORMATS]).default('auto'),
  // Telegram only: the chat the bot posts to, a numeric id (groups and channels are negative) or @channelname.
  ALERT_TELEGRAM_CHAT_ID: optional.pipe(z.string().regex(/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/).optional()),
  // While the same problem lasts, notify again every this many minutes; 0 notifies only when it starts, changes
  // or ends.
  ALERT_REPEAT_MINUTES: z.coerce.number().int().min(0).max(10_080).default(60),
  // Names this deployment in alerts. Default: the host of PUBLIC_URL, else the machine's host name.
  ALERT_INSTANCE: optional,
  // An outside heartbeat monitor's ping URL (Healthchecks.io, Uptime Kuma push, Better Stack heartbeat): a GET after
  // each probe that read the database and delivered what it owed. Like the webhook, it usually carries a secret.
  PROBER_HEARTBEAT_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // The same kind of monitor for backups (issue #351): pinged by `--backup-ok` after each good backup run, so a backup
  // that never runs (the timer disabled, the server off) pages when the pings stop.
  BACKUP_HEARTBEAT_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  PUBLIC_URL: optional,
  PROBER_MAX_OUTBOX_AGE_SECONDS: seconds(300),
  PROBER_MAX_JOB_AGE_SECONDS: seconds(900),
  PROBER_MAX_HEARTBEAT_AGE_SECONDS: seconds(120),
  PROBER_MAX_DEAD_LETTERS: z.coerce.number().int().min(0).max(10_000).default(0),
  // How full the cluster's NOTIFY queue may be, in percent (issue #281). It fills when a listening session stops
  // reading (one stuck in a transaction, say); once full, every commit that sends a NOTIFY fails, including writes to
  // the tables that send stream hints. PostgreSQL itself starts warning in its log at 50.
  PROBER_MAX_NOTIFY_QUEUE_PERCENT: z.coerce.number().int().min(0).max(100).default(50),
  // Failed jobs count for this long. Default: the probe interval plus 60 s with --every (each dead letter alerts
  // once, or twice when it lands in the overlap, never zero times), 3600 otherwise. With cron, set it to the
  // cron interval plus 60.
  PROBER_DEAD_LETTER_WINDOW_SECONDS: optional.pipe(z.coerce.number<string | undefined>().int().min(60).max(604_800).optional()),
});

export interface ProberConfig {
  databaseUrl: string | undefined;
  webhookUrl: string | undefined;
  webhookFormat: WebhookFormat;
  telegramChatId: string | undefined;
  // 0: never repeat.
  repeatSeconds: number;
  instance: string;
  thresholds: Thresholds;
  deadLetterWindowSeconds: number;
  // The outside heartbeat monitor's ping URL; unset: no heartbeat.
  heartbeatUrl?: string | undefined;
  // The backup heartbeat monitor's ping URL; unset: --backup-ok pings nothing.
  backupHeartbeatUrl?: string | undefined;
}

export interface Thresholds {
  outboxAgeSeconds: number;
  jobAgeSeconds: number;
  heartbeatAgeSeconds: number;
  deadLetters: number;
  // Percent of the NOTIFY queue.
  notifyQueuePercent: number;
}

export function loadProberConfig(env: NodeJS.ProcessEnv = process.env, everySeconds: number | null = null): ProberConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid prober configuration: ${fields}`);
  }
  const raw = parsed.data;
  const webhookFormat = raw.ALERT_WEBHOOK_FORMAT === 'auto' ? (raw.ALERT_WEBHOOK_URL ? detectWebhookFormat(raw.ALERT_WEBHOOK_URL) : 'generic') : raw.ALERT_WEBHOOK_FORMAT;
  if (raw.ALERT_WEBHOOK_URL && webhookFormat === 'telegram') {
    if (!raw.ALERT_TELEGRAM_CHAT_ID) throw new Error('invalid prober configuration: ALERT_TELEGRAM_CHAT_ID (a Telegram webhook needs the chat id)');
    if (!/\/bot[^/]+\/sendMessage$/.test(new URL(raw.ALERT_WEBHOOK_URL).pathname)) {
      throw new Error('invalid prober configuration: ALERT_WEBHOOK_URL (a Telegram webhook is https://api.telegram.org/bot<token>/sendMessage)');
    }
  }
  return {
    databaseUrl: raw.PROBER_DATABASE_URL,
    webhookUrl: raw.ALERT_WEBHOOK_URL,
    webhookFormat,
    telegramChatId: raw.ALERT_TELEGRAM_CHAT_ID,
    repeatSeconds: raw.ALERT_REPEAT_MINUTES * 60,
    instance: raw.ALERT_INSTANCE ?? hostOf(raw.PUBLIC_URL) ?? hostname(),
    thresholds: {
      outboxAgeSeconds: raw.PROBER_MAX_OUTBOX_AGE_SECONDS,
      jobAgeSeconds: raw.PROBER_MAX_JOB_AGE_SECONDS,
      heartbeatAgeSeconds: raw.PROBER_MAX_HEARTBEAT_AGE_SECONDS,
      deadLetters: raw.PROBER_MAX_DEAD_LETTERS,
      notifyQueuePercent: raw.PROBER_MAX_NOTIFY_QUEUE_PERCENT,
    },
    deadLetterWindowSeconds: raw.PROBER_DEAD_LETTER_WINDOW_SECONDS ?? (everySeconds === null ? 3600 : Math.min(everySeconds + 60, 604_800)),
    heartbeatUrl: raw.PROBER_HEARTBEAT_URL,
    backupHeartbeatUrl: raw.BACKUP_HEARTBEAT_URL,
  };
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One row of crove_kernel.health(), plus pg_notification_queue_usage(). Ages in seconds, null when there is nothing
 * to age.
 */
export interface HealthSnapshot {
  checked_at: string;
  outbox_pending: number;
  outbox_oldest_age_seconds: number | null;
  inbound_pending: number;
  inbound_oldest_age_seconds: number | null;
  jobs_schema_present: boolean;
  jobs_queued: number | null;
  job_oldest_queued_age_seconds: number | null;
  dead_letter_count: number | null;
  worker_heartbeat_age_seconds: number | null;
  // The fraction (0 to 1) of the cluster's NOTIFY queue in use: pg_notification_queue_usage(), a core function any
  // login may call. Read beside health() rather than through it.
  notify_queue_usage: number;
}

const s = (n: number) => `${Math.round(n)} s`;
const percent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

/** The thresholds a snapshot exceeds, as findings; [] when healthy. A missing heartbeat is a finding (absence). */
export function evaluateHealth(h: HealthSnapshot, t: Thresholds, deadLetterWindowSeconds: number): Finding[] {
  const findings: Finding[] = [];
  if (h.outbox_oldest_age_seconds !== null && h.outbox_oldest_age_seconds > t.outboxAgeSeconds) {
    findings.push({
      check: 'outbox',
      value: h.outbox_oldest_age_seconds,
      threshold: t.outboxAgeSeconds,
      message: `oldest unpublished outbox event is ${s(h.outbox_oldest_age_seconds)} old (limit ${s(t.outboxAgeSeconds)}, ${h.outbox_pending} pending): the relay is behind or stopped`,
    });
  }
  if (h.inbound_oldest_age_seconds !== null && h.inbound_oldest_age_seconds > t.outboxAgeSeconds) {
    findings.push({
      check: 'inbound',
      value: h.inbound_oldest_age_seconds,
      threshold: t.outboxAgeSeconds,
      message: `oldest unrelayed inbound email is ${s(h.inbound_oldest_age_seconds)} old (limit ${s(t.outboxAgeSeconds)}, ${h.inbound_pending} pending): the relay is behind or stopped`,
    });
  }
  if (!h.jobs_schema_present) {
    findings.push({ check: 'jobs_schema', value: null, threshold: null, message: 'the job queue schema crove_jobs is missing: run the migrate role' });
  }
  if (h.job_oldest_queued_age_seconds !== null && h.job_oldest_queued_age_seconds > t.jobAgeSeconds) {
    findings.push({
      check: 'job_age',
      value: h.job_oldest_queued_age_seconds,
      threshold: t.jobAgeSeconds,
      message: `oldest queued job has waited ${s(h.job_oldest_queued_age_seconds)} (limit ${s(t.jobAgeSeconds)}, ${h.jobs_queued ?? 0} queued): workers are stuck or too few`,
    });
  }
  if (h.dead_letter_count !== null && h.dead_letter_count > t.deadLetters) {
    findings.push({
      check: 'dead_letters',
      value: h.dead_letter_count,
      threshold: t.deadLetters,
      message: `${h.dead_letter_count} job(s) failed after their last retry in the last ${s(deadLetterWindowSeconds)} (limit ${t.deadLetters}): see the worker log`,
    });
  }
  if (h.worker_heartbeat_age_seconds === null) {
    findings.push({ check: 'heartbeat', value: null, threshold: t.heartbeatAgeSeconds, message: 'no worker heartbeat recorded: the worker has never started' });
  } else if (h.worker_heartbeat_age_seconds > t.heartbeatAgeSeconds) {
    findings.push({
      check: 'heartbeat',
      value: h.worker_heartbeat_age_seconds,
      threshold: t.heartbeatAgeSeconds,
      message: `last worker heartbeat was ${s(h.worker_heartbeat_age_seconds)} ago (limit ${s(t.heartbeatAgeSeconds)}): the worker is down`,
    });
  }
  if (h.notify_queue_usage * 100 > t.notifyQueuePercent) {
    findings.push({
      check: 'notify_queue',
      value: h.notify_queue_usage,
      threshold: t.notifyQueuePercent / 100,
      message: `the NOTIFY queue is ${percent(h.notify_queue_usage)} full (limit ${t.notifyQueuePercent}%): a listening session has stopped reading (look for one idle in transaction); when it is full, writes that send stream hints fail`,
    });
  }
  return findings;
}

/** Reads crove_kernel.health() over its own short-lived connection. Refuses a privileged login. */
export async function readHealth(databaseUrl: string, deadLetterWindowSeconds: number): Promise<HealthSnapshot> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'crove-prober',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  client.on('error', () => {});
  await client.connect();
  try {
    const { rows: who } = await client.query<{ rolname: string; privileged: boolean }>(
      'SELECT rolname, (rolsuper OR rolbypassrls) AS privileged FROM pg_catalog.pg_roles WHERE rolname = current_user',
    );
    if (who[0]?.privileged) {
      throw new Error(`refusing to probe as ${who[0].rolname}, a superuser or BYPASSRLS role: connect PROBER_DATABASE_URL as crove_prober`);
    }
    const { rows } = await client.query<HealthSnapshot>(
      `SELECT checked_at::text AS checked_at, outbox_pending, outbox_oldest_age_seconds, inbound_pending, inbound_oldest_age_seconds,
              jobs_schema_present, jobs_queued, job_oldest_queued_age_seconds, dead_letter_count, worker_heartbeat_age_seconds
       FROM crove_kernel.health($1::int)`,
      [deadLetterWindowSeconds],
    );
    const row = rows[0];
    if (!row) throw new Error('crove_kernel.health() returned no row');
    const { rows: queue } = await client.query<{ usage: number }>('SELECT pg_catalog.pg_notification_queue_usage() AS usage');
    return { ...row, notify_queue_usage: Number(queue[0]?.usage ?? 0) };
  } finally {
    await client.end().catch(() => {});
  }
}

export interface ProbeDeps {
  readHealth?: typeof readHealth;
  fetch?: AlertSinkOptions['fetch'];
  log?: (line: string) => void;
  error?: (line: string) => void;
  now?: () => Date;
  // Replaces the default webhook sink (ADR-0030); fetch is then unused.
  sink?: AlertSink;
  // The deployment-wide de-duplication state. Default: pgAlertGate on PROBER_DATABASE_URL.
  gate?: AlertGate;
  // The state for "the database cannot be read". runProber keeps one across --every probes; default: a fresh one.
  outageGate?: AlertGate;
}

function alertSink(config: ProberConfig, deps: ProbeDeps): AlertSink {
  return (
    deps.sink ??
    webhookAlertSink({
      webhookUrl: config.webhookUrl,
      format: config.webhookFormat,
      telegramChatId: config.telegramChatId,
      fetch: deps.fetch,
      log: deps.log ?? ((line: string) => console.log(line)),
    })
  );
}

const iso = (d: Date | null) => (d ? d.toISOString() : undefined);
const checksOf = (problem: string | null) => (problem ? problem.split(',') : []);

// The notification a gate decision calls for, or null when there is nothing to send.
function notification(gate: GateResult, base: Pick<Alert, 'instance' | 'at' | 'health'>, findings: Finding[]): Alert | null {
  const since = iso(gate.problemSince);
  switch (gate.decision) {
    case 'new':
      return { kind: 'alert', state: 'new', ...base, findings };
    case 'changed':
      return { kind: 'alert', state: 'changed', ...base, findings, ...(since ? { since } : {}), previous: checksOf(gate.previousProblem) };
    case 'repeat':
      return { kind: 'alert', state: 'repeat', ...base, findings, ...(since ? { since } : {}) };
    case 'resolved':
      return { kind: 'resolved', ...base, findings: [], ...(since ? { since } : {}), previous: checksOf(gate.previousProblem) };
    case 'healthy':
    case 'suppressed':
    case 'busy':
      return null;
  }
}

function quietReason(gate: GateResult, repeatSeconds: number): string {
  if (gate.decision === 'busy') return 'another prober is sending the notification for this probe';
  const last = gate.lastNotifiedAt ? ` at ${gate.lastNotifiedAt.toISOString()}` : '';
  const repeat = effectiveRepeatSeconds(repeatSeconds);
  const next =
    repeat === null
      ? ', repeats are off (ALERT_REPEAT_MINUTES=0)'
      : gate.lastNotifiedAt
        ? `, repeats from ${new Date(gate.lastNotifiedAt.getTime() + repeat * 1000).toISOString()}`
        : '';
  return `already notified${last}${next}`;
}

// A sink from an entrypoint (ADR-0030) might throw although the port says it should not: that counts as a failed
// delivery, so the gate is still settled (rolled back) and the probe loop keeps running.
async function safeDeliver(sink: AlertSink, alert: Alert): Promise<Delivery> {
  try {
    return await sink.deliver(alert);
  } catch (e) {
    return { channel: 'webhook', ok: false, error: `${sink.describe()} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * One probe, then the heartbeat ping when it is due: returns the exit code. Never throws. The exit code reports
 * health (0, 1, 2) whether or not a notification went out, and 3 when one was due and could not be delivered; a
 * failed ping is logged and leaves it as it is (the outside monitor notices the missing ping by itself).
 */
export async function probeOnce(config: ProberConfig, deps: ProbeDeps = {}): Promise<number> {
  const code = await probe(config, deps);
  if (config.heartbeatUrl && (code === EXIT.ok || code === EXIT.unhealthy)) await pingHeartbeat(config.heartbeatUrl, deps);
  return code;
}

const HEARTBEAT_TIMEOUT_MS = 10_000;

// Logs only the host: the ping URL usually carries the check's secret.
function describeHeartbeat(url: string): string {
  return `heartbeat monitor at ${new URL(url).host}`;
}

// true when the monitor answered 2xx. A failure is logged, never thrown.
async function pingHeartbeat(url: string, deps: ProbeDeps, label = 'heartbeat'): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  try {
    const response = await (deps.fetch ?? fetch)(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    // Drain the body so the connection is released; its content is not logged.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    log(`[prober] ${label} sent to ${describeHeartbeat(url)}`);
    return true;
  } catch (e) {
    error(`[prober] ${label}: ${describeHeartbeat(url)} failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function probe(config: ProberConfig, deps: ProbeDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const sink = alertSink(config, deps);
  const outage = deps.outageGate ?? memoryAlertGate(config.repeatSeconds);

  // Sends what `result` calls for and settles `gate`; false when a due notification could not be delivered.
  const notify = async (gate: AlertGate, result: GateResult, alert: Alert | null): Promise<boolean> => {
    if (!alert) {
      if (result.decision === 'suppressed' || result.decision === 'busy') log(`[prober] notification skipped: ${quietReason(result, config.repeatSeconds)}`);
      await gate.settle(true);
      return true;
    }
    const delivery = await safeDeliver(sink, alert);
    await gate.settle(delivery.ok);
    if (!delivery.ok) {
      error(`[prober] alert delivery: ${delivery.error}`);
      return false;
    }
    log(`[prober] ${alert.kind === 'resolved' ? 'resolved notice' : 'alert'} sent to ${sink.describe()}`);
    return true;
  };

  if (!config.databaseUrl) {
    error('[prober] PROBER_DATABASE_URL is not set; connect it as crove_prober');
    return EXIT.probeFailed;
  }
  let health: HealthSnapshot;
  try {
    health = await (deps.readHealth ?? readHealth)(config.databaseUrl, config.deadLetterWindowSeconds);
  } catch (e) {
    // The database itself is unreachable or health() is refused: that is an outage too, so it alerts. Its state
    // cannot be kept in the database, so the in-process gate de-duplicates it.
    // One line: a driver message with a line break could otherwise start a Markdown heading or quote in a chat.
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
    error(`[prober] FAIL probe: could not read crove_kernel.health(): ${reason}`);
    const findings: Finding[] = [{ check: 'probe', value: null, threshold: null, message: `the prober could not read crove_kernel.health(): ${reason}` }];
    const result = await outage.decide('probe', now);
    const sent = await notify(outage, result, notification(result, { instance: config.instance, at }, findings));
    return sent ? EXIT.probeFailed : EXIT.deliveryFailed;
  }

  // The database answers again after an outage this process alerted about.
  const recovered = await outage.decide(null, now);
  let delivered = await notify(outage, recovered, notification(recovered, { instance: config.instance, at }, []));

  const findings = evaluateHealth(health, config.thresholds, config.deadLetterWindowSeconds);
  if (findings.length === 0) {
    log(
      `[prober] ok: outbox ${health.outbox_pending} pending, inbound ${health.inbound_pending} pending, ` +
        `jobs ${health.jobs_queued ?? 0} queued, dead letters ${health.dead_letter_count ?? 0}, ` +
        `heartbeat ${health.worker_heartbeat_age_seconds === null ? 'none' : s(health.worker_heartbeat_age_seconds)} ago, ` +
        `notify queue ${percent(health.notify_queue_usage)}`,
    );
  } else {
    for (const f of findings) error(`[prober] FAIL ${f.check}: ${f.message}`);
  }

  const problem = problemKey(findings.map((f) => f.check));
  const gate = deps.gate ?? pgAlertGate(config.databaseUrl, config.repeatSeconds);
  let result: GateResult;
  try {
    result = await gate.decide(problem, now);
  } catch (e) {
    // Without the shared state, alert as if the problem were new (and say nothing when healthy): a missed alert is
    // worse than a duplicate.
    const reason = e instanceof Error ? e.message : String(e);
    error(`[prober] alert state unavailable, notifying without de-duplication: ${reason}`);
    result = { decision: problem === null ? 'healthy' : 'new', previousProblem: null, problemSince: null, lastNotifiedAt: null };
  }
  const alert = notification(result, { instance: config.instance, at, health: { ...health } }, findings);
  delivered = (await notify(gate, result, alert)) && delivered;
  if (!delivered) return EXIT.deliveryFailed;
  return findings.length === 0 ? EXIT.ok : EXIT.unhealthy;
}

export async function sendTestAlert(config: ProberConfig, deps: ProbeDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const sink = alertSink(config, deps);
  const delivery = await safeDeliver(sink, { kind: 'test', instance: config.instance, at, findings: [] });
  if (!delivery.ok) {
    error(`[prober] test alert: ${delivery.error}`);
    return EXIT.deliveryFailed;
  }
  log(`[prober] test alert sent to ${sink.describe()}`);
  return EXIT.ok;
}

// The longest backup failure reason sent; the backup log keeps the whole story.
const MAX_BACKUP_REASON = 500;

/**
 * Sends one alert that a backup run failed (issue #307): `tools/backup/backup.sh` calls `prober --backup-failed
 * <reason>` when a run fails, so the failure reaches the same webhook as every other alert. Needs no database and
 * is not de-duplicated: one failed nightly run is one alert. 0 when delivered, 3 when not (printed instead).
 */
export async function sendBackupAlert(config: ProberConfig, reason: string, deps: ProbeDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const at = (deps.now ?? (() => new Date()))().toISOString();
  // One line, like every finding: a line break could otherwise start a Markdown heading or quote in a chat.
  const oneLine = reason.replace(/\s+/g, ' ').trim();
  const short = oneLine.length > MAX_BACKUP_REASON ? `${oneLine.slice(0, MAX_BACKUP_REASON - 3)}...` : oneLine;
  const finding: Finding = { check: 'backup', value: null, threshold: null, message: `backup failed: ${short || 'no reason given'}` };
  error(`[prober] FAIL backup: ${finding.message}`);
  const sink = alertSink(config, deps);
  const delivery = await safeDeliver(sink, { kind: 'alert', state: 'new', instance: config.instance, at, findings: [finding] });
  if (!delivery.ok) {
    error(`[prober] backup alert: ${delivery.error}`);
    return EXIT.deliveryFailed;
  }
  log(`[prober] backup alert sent to ${sink.describe()}`);
  return EXIT.ok;
}

/**
 * Reports a good backup run (issue #351): `tools/backup/backup.sh` calls `prober --backup-ok` at the end of every run
 * that completed, and this pings BACKUP_HEARTBEAT_URL. The outside monitor pages when the pings stop, which no alert
 * from the backup itself can do (a timer that was disabled runs nothing). Needs no database. 0 when pinged or when no
 * URL is set, 3 when the ping failed.
 */
export async function sendBackupHeartbeat(config: ProberConfig, deps: ProbeDeps = {}): Promise<number> {
  if (!config.backupHeartbeatUrl) {
    (deps.log ?? console.log)('[prober] backup ok; BACKUP_HEARTBEAT_URL is not set, so no monitor sees it');
    return EXIT.ok;
  }
  return (await pingHeartbeat(config.backupHeartbeatUrl, deps, 'backup heartbeat')) ? EXIT.ok : EXIT.deliveryFailed;
}

export interface ProberArgs {
  testAlert: boolean;
  everySeconds: number | null;
  // --backup-failed <reason>: send one backup failure alert and exit.
  backupFailed: string | null;
  // --backup-ok: ping the backup heartbeat monitor and exit.
  backupOk: boolean;
}

export function parseProberArgs(argv: readonly string[]): ProberArgs {
  const args: ProberArgs = { testAlert: false, everySeconds: null, backupFailed: null, backupOk: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--test-alert') args.testAlert = true;
    else if (arg === '--every') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 10 || value > 86_400) throw new Error('--every needs a whole number of seconds from 10 to 86400');
      args.everySeconds = value;
    } else if (arg === '--backup-failed') {
      const reason = argv[++i];
      if (reason === undefined) throw new Error('--backup-failed needs the reason');
      args.backupFailed = reason;
    } else if (arg === '--backup-ok') args.backupOk = true;
    else throw new Error(`unknown prober argument ${arg}; use --test-alert, --backup-failed <reason>, --backup-ok or --every <seconds>`);
  }
  return args;
}

/**
 * Entry point for `main.ts prober [--test-alert] [--backup-failed <reason>] [--backup-ok] [--every <seconds>]`. Resolves to the
 * exit code of the last probe.
 */
export async function runProber(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, deps: ProbeDeps = {}): Promise<number> {
  const error = deps.error ?? ((line: string) => console.error(line));
  let args: ProberArgs;
  let config: ProberConfig;
  try {
    args = parseProberArgs(argv);
    config = loadProberConfig(env, args.everySeconds);
  } catch (e) {
    error(`[prober] ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.probeFailed;
  }
  if (args.testAlert) return sendTestAlert(config, deps);
  if (args.backupFailed !== null) return sendBackupAlert(config, args.backupFailed, deps);
  if (args.backupOk) return sendBackupHeartbeat(config, deps);
  if (args.everySeconds === null) return probeOnce(config, deps);
  const every = args.everySeconds;
  const looping = { ...deps, outageGate: deps.outageGate ?? memoryAlertGate(config.repeatSeconds) };
  // Under Docker this is PID 1, which gets no default SIGTERM handling: stop between probes at once.
  process.once('SIGTERM', () => process.exit(EXIT.ok));
  const heartbeat = config.heartbeatUrl ? `, heartbeat to ${describeHeartbeat(config.heartbeatUrl)}` : '';
  (deps.log ?? console.log)(`[prober] probing every ${every} s, alerts to ${alertSink(config, deps).describe()}${heartbeat}`);
  for (;;) {
    await probeOnce(config, looping);
    await new Promise((resolve) => setTimeout(resolve, every * 1000));
  }
}
