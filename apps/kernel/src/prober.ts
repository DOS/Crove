// The `prober` image role (plan §4.13, issues #39 and #151): reads crove_kernel.health() as crove_prober, compares
// it with thresholds and notifies on news only (alert-gate.ts): a new or changed problem, a resolved one, and the
// same problem again every ALERT_REPEAT_MINUTES. Runs once and exits (cron, a scheduler), or repeats with
// `--every <seconds>` (the Compose profile). `--test-alert` sends a test alert and needs no database.
//
// Exit codes: 0 healthy (or the test alert was delivered), 1 thresholds exceeded, 2 the health check could not run
// (configuration, connection, permissions), 3 the alert could not be delivered (it was printed to stdout instead).
import { hostname } from 'node:os';
import pg from 'pg';
import { z } from 'zod';
import { memoryAlertGate, pgAlertGate, problemKey, type AlertGate, type GateResult } from './alert-gate.ts';
import {
  WEBHOOK_FORMATS,
  detectWebhookFormat,
  webhookAlertSink,
  type Alert,
  type AlertSink,
  type AlertSinkOptions,
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
  PUBLIC_URL: optional,
  PROBER_MAX_OUTBOX_AGE_SECONDS: seconds(300),
  PROBER_MAX_JOB_AGE_SECONDS: seconds(900),
  PROBER_MAX_HEARTBEAT_AGE_SECONDS: seconds(120),
  PROBER_MAX_DEAD_LETTERS: z.coerce.number().int().min(0).max(10_000).default(0),
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
}

export interface Thresholds {
  outboxAgeSeconds: number;
  jobAgeSeconds: number;
  heartbeatAgeSeconds: number;
  deadLetters: number;
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
    },
    deadLetterWindowSeconds: raw.PROBER_DEAD_LETTER_WINDOW_SECONDS ?? (everySeconds === null ? 3600 : Math.min(everySeconds + 60, 604_800)),
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

/** One row of crove_kernel.health(). Ages in seconds, null when there is nothing to age. */
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
}

const s = (n: number) => `${Math.round(n)} s`;

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
    return row;
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
  const next =
    repeatSeconds > 0 && gate.lastNotifiedAt
      ? `, repeats from ${new Date(gate.lastNotifiedAt.getTime() + Math.max(repeatSeconds, 60) * 1000).toISOString()}`
      : repeatSeconds > 0
        ? ''
        : ', repeats are off (ALERT_REPEAT_MINUTES=0)';
  return `already notified${last}${next}`;
}

/**
 * One probe: returns the exit code. Never throws. The exit code reports health (0, 1, 2) whether or not a
 * notification went out, and 3 when one was due and could not be delivered.
 */
export async function probeOnce(config: ProberConfig, deps: ProbeDeps = {}): Promise<number> {
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
    const delivery = await sink.deliver(alert);
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
    const reason = e instanceof Error ? e.message : String(e);
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
        `heartbeat ${health.worker_heartbeat_age_seconds === null ? 'none' : s(health.worker_heartbeat_age_seconds)} ago`,
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
  const delivery = await sink.deliver({ kind: 'test', instance: config.instance, at, findings: [] });
  if (!delivery.ok) {
    error(`[prober] test alert: ${delivery.error}`);
    return EXIT.deliveryFailed;
  }
  log(`[prober] test alert sent to ${sink.describe()}`);
  return EXIT.ok;
}

export interface ProberArgs {
  testAlert: boolean;
  everySeconds: number | null;
}

export function parseProberArgs(argv: readonly string[]): ProberArgs {
  const args: ProberArgs = { testAlert: false, everySeconds: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--test-alert') args.testAlert = true;
    else if (arg === '--every') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 10 || value > 86_400) throw new Error('--every needs a whole number of seconds from 10 to 86400');
      args.everySeconds = value;
    } else throw new Error(`unknown prober argument ${arg}; use --test-alert or --every <seconds>`);
  }
  return args;
}

/** Entry point for `main.ts prober [--test-alert] [--every <seconds>]`. Resolves to the exit code of the last probe. */
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
  if (args.everySeconds === null) return probeOnce(config, deps);
  const every = args.everySeconds;
  const looping = { ...deps, outageGate: deps.outageGate ?? memoryAlertGate(config.repeatSeconds) };
  // Under Docker this is PID 1, which gets no default SIGTERM handling: stop between probes at once.
  process.once('SIGTERM', () => process.exit(EXIT.ok));
  (deps.log ?? console.log)(`[prober] probing every ${every} s, alerts to ${alertSink(config, deps).describe()}`);
  for (;;) {
    await probeOnce(config, looping);
    await new Promise((resolve) => setTimeout(resolve, every * 1000));
  }
}
