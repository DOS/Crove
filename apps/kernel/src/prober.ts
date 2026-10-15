// The `prober` image role (plan §4.13, issue #39): reads crove_kernel.health() as crove_prober, compares it with
// thresholds and sends one alert when any is exceeded. Runs once and exits (cron, a scheduler), or repeats with
// `--every <seconds>` (the Compose profile). `--test-alert` sends a test alert and needs no database.
//
// Exit codes: 0 healthy (or the test alert was delivered), 1 thresholds exceeded, 2 the health check could not run
// (configuration, connection, permissions), 3 the alert could not be delivered (it was printed to stdout instead).
import { hostname } from 'node:os';
import pg from 'pg';
import { z } from 'zod';
import { deliverAlert, describeWebhook, type Alert, type AlertSinkOptions, type Finding } from './alert.ts';

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
  return {
    databaseUrl: raw.PROBER_DATABASE_URL,
    webhookUrl: raw.ALERT_WEBHOOK_URL,
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
}

/** One probe: returns the exit code. Never throws. */
export async function probeOnce(config: ProberConfig, deps: ProbeDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const sink = { webhookUrl: config.webhookUrl, fetch: deps.fetch, log };

  let alert: Alert;
  let code: number;
  if (!config.databaseUrl) {
    error('[prober] PROBER_DATABASE_URL is not set; connect it as crove_prober');
    return EXIT.probeFailed;
  }
  try {
    const health = await (deps.readHealth ?? readHealth)(config.databaseUrl, config.deadLetterWindowSeconds);
    const findings = evaluateHealth(health, config.thresholds, config.deadLetterWindowSeconds);
    if (findings.length === 0) {
      log(
        `[prober] ok: outbox ${health.outbox_pending} pending, inbound ${health.inbound_pending} pending, ` +
          `jobs ${health.jobs_queued ?? 0} queued, dead letters ${health.dead_letter_count ?? 0}, ` +
          `heartbeat ${health.worker_heartbeat_age_seconds === null ? 'none' : s(health.worker_heartbeat_age_seconds)} ago`,
      );
      return EXIT.ok;
    }
    for (const f of findings) error(`[prober] FAIL ${f.check}: ${f.message}`);
    alert = { kind: 'alert', instance: config.instance, at, findings, health: { ...health } };
    code = EXIT.unhealthy;
  } catch (e) {
    // The database itself is unreachable or health() is refused: that is an outage too, so it alerts.
    const reason = e instanceof Error ? e.message : String(e);
    error(`[prober] FAIL probe: could not read crove_kernel.health(): ${reason}`);
    alert = {
      kind: 'alert',
      instance: config.instance,
      at,
      findings: [{ check: 'probe', value: null, threshold: null, message: `the prober could not read crove_kernel.health(): ${reason}` }],
    };
    code = EXIT.probeFailed;
  }
  const delivery = await deliverAlert(alert, sink);
  if (!delivery.ok) {
    error(`[prober] alert delivery: ${delivery.error}`);
    return EXIT.deliveryFailed;
  }
  log(`[prober] alert sent to ${describeWebhook(config.webhookUrl)}`);
  return code;
}

export async function sendTestAlert(config: ProberConfig, deps: ProbeDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const delivery = await deliverAlert({ kind: 'test', instance: config.instance, at, findings: [] }, { webhookUrl: config.webhookUrl, fetch: deps.fetch, log });
  if (!delivery.ok) {
    error(`[prober] test alert: ${delivery.error}`);
    return EXIT.deliveryFailed;
  }
  log(`[prober] test alert sent to ${describeWebhook(config.webhookUrl)}`);
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
  // Under Docker this is PID 1, which gets no default SIGTERM handling: stop between probes at once.
  process.once('SIGTERM', () => process.exit(EXIT.ok));
  (deps.log ?? console.log)(`[prober] probing every ${every} s, alerts to ${describeWebhook(config.webhookUrl)}`);
  for (;;) {
    await probeOnce(config, deps);
    await new Promise((resolve) => setTimeout(resolve, every * 1000));
  }
}
