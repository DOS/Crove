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
//
// Supabase Auth (issue #1994): each probe also asks Auth's /health, the way signing in reaches it (the kernel's
// /auth/v1 proxy at PUBLIC_URL, or PUBLIC_AUTH_URL when Auth is hosted elsewhere, or PROBER_AUTH_URL to name another
// path), and an `auth` finding goes out after PROBER_AUTH_MISSES failed answers in a row. Before, nobody learned of an
// Auth outage until a member could not sign in.
import { createS3Client } from '@crove/kernel-runtime';
import pg from 'pg';
import { z } from 'zod';
import { isHostedSupabase, modulesSetting } from './config.ts';
import { probeStatus, writeStatusFile } from './status-page.ts';
import { LocalArchiveStore, S3ArchiveStore, readVerifyMarker, type ArchiveS3Sender, type ArchiveStore } from './worm.ts';
import { effectiveRepeatSeconds, memoryAlertGate, pgAlertGate, problemKey, type AlertGate, type GateResult } from './alert-gate.ts';
import {
  WEBHOOK_ENV,
  webhookAlertSink,
  webhookTarget,
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
// An empty or blank value is no value: the default applies, never 0 (which turns a check off). z.coerce.number() would
// read '' as 0, and a variable a deployment leaves empty (an .env line with nothing after the =) must not do that (#2098).
const unsetWhenBlank = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const seconds = (fallback: number) => z.preprocess(unsetWhenBlank, z.coerce.number().int().min(0).max(604_800).default(fallback));

const schema = z.object({
  // Connect as crove_prober (password CROVE_PROBER_DB_PASSWORD, set by `migrate`).
  PROBER_DATABASE_URL: optional,
  // ALERT_WEBHOOK_URL, ALERT_WEBHOOK_FORMAT, ALERT_TELEGRAM_CHAT_ID, ALERT_INSTANCE and PUBLIC_URL (alert.ts).
  ...WEBHOOK_ENV,
  // While the same problem lasts, notify again every this many minutes; 0 notifies only when it starts, changes
  // or ends.
  ALERT_REPEAT_MINUTES: z.coerce.number().int().min(0).max(10_080).default(60),
  // An outside heartbeat monitor's ping URL (Healthchecks.io, Uptime Kuma push, Better Stack heartbeat): a GET after
  // each probe that read the database and delivered what it owed. Like the webhook, it usually carries a secret.
  PROBER_HEARTBEAT_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // The same kind of monitor for backups (issue #351): pinged by `--backup-ok` after each good backup run, so a backup
  // that never runs (the timer disabled, the server off) pages when the pings stop.
  BACKUP_HEARTBEAT_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // Where each probe's result goes for the public status page (#678, status-page.ts): an absolute path on a volume the
  // API reads as STATUS_FILE. Unset: no file.
  PROBER_STATUS_FILE: optional.pipe(z.string().startsWith('/').optional()),
  PROBER_MAX_OUTBOX_AGE_SECONDS: seconds(300),
  PROBER_MAX_JOB_AGE_SECONDS: seconds(900),
  PROBER_MAX_HEARTBEAT_AGE_SECONDS: seconds(120),
  PROBER_MAX_DEAD_LETTERS: z.coerce.number().int().min(0).max(10_000).default(0),
  // How full the cluster's NOTIFY queue may be, in percent (issue #281). It fills when a listening session stops
  // reading (one stuck in a transaction, say); once full, every commit that sends a NOTIFY fails, including writes to
  // the tables that send stream hints. PostgreSQL itself starts warning in its log at 50.
  PROBER_MAX_NOTIFY_QUEUE_PERCENT: z.coerce.number().int().min(0).max(100).default(50),
  // The WORM archive (#1997): the nightly verification older than this (26 h: a day and the slack of one late run), or
  // the oldest audit event not yet archived older than this. The archiver keeps ARCHIVE_LAG_SECONDS
  // (the worker's value, 600 s by default) on purpose, so the lag limit defaults to the larger of 3600 s and that plus
  // 15 minutes. 0 turns either check off.
  PROBER_MAX_ARCHIVE_VERIFY_AGE_SECONDS: seconds(93_600),
  PROBER_MAX_ARCHIVE_LAG_SECONDS: optional.pipe(z.coerce.number<string | undefined>().int().min(0).max(604_800).optional()),
  ARCHIVE_LAG_SECONDS: optional.pipe(z.coerce.number<string | undefined>().int().min(60).max(86_400).optional()),
  // AI document extraction (#1998): more than this many readings in PROBER_EXTRACTION_WINDOW_SECONDS whose every
  // attempt failed (the AI provider refused or did not answer, the parser sandbox was down) alert; a document that
  // cannot be read never does. 0 turns the check off.
  PROBER_MAX_EXTRACTION_FAILURES: z.coerce.number().int().min(0).max(10_000).default(2),
  PROBER_EXTRACTION_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  // Failed jobs count for this long. Default: the probe interval plus 60 s with --every (each dead letter alerts
  // once, or twice when it lands in the overlap, never zero times), 3600 otherwise. With cron, set it to the
  // cron interval plus 60.
  PROBER_DEAD_LETTER_WINDOW_SECONDS: optional.pipe(z.coerce.number<string | undefined>().int().min(60).max(604_800).optional()),
  // The modules the deployment runs, the API's and the worker's value (#1894): their queued jobs count in job_age
  // even when no worker records the module, so a module whose workers all stopped still alerts. Unset or empty: every
  // module, as for the API.
  CROVE_MODULES: modulesSetting,
  // Supabase Auth's base URL, ending in /auth/v1 (#1994). Unset: PUBLIC_AUTH_URL, else PUBLIC_URL/auth/v1 (the
  // kernel's proxy, the way the app signs in). With neither, Auth is not checked.
  PROBER_AUTH_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  PUBLIC_AUTH_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // The publishable key a hosted Supabase project asks for on every request (sent as `apikey`); not a secret.
  PUBLIC_AUTH_ANON_KEY: optional,
  // How many probes in a row Auth must fail to answer before it alerts (one blip is not an outage); 0: no Auth check.
  PROBER_AUTH_MISSES: z.coerce.number().int().min(0).max(100).default(2),
  PROBER_AUTH_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(10),
});

// The verification marker check's own settings (#2082), parsed apart from the rest (#2094): a bad one disables only that
// check, which then reports it, and never stops the other probes or the backup and test alerts.
const DEFAULT_MARKER_AGE_SECONDS = 93_600;
// The newest marker the nightly verification wrote to the WORM store, read from the store itself, older than this (26 h)
// alerts. 0 turns it off. The store is the worker's: ARCHIVE_STORE=s3 reads ARCHIVE_S3_BUCKET with S3_ENDPOINT, S3_REGION
// and S3_FORCE_PATH_STYLE; local reads ARCHIVE_DIR (the image sets /data/archive; mount the archive volume read-only), and
// without ARCHIVE_DIR the check is off. Credentials: PROBER_ARCHIVE_S3_ACCESS_KEY_ID and PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY
// (a read-only key), both or neither. Neither is refused unless PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true says to use the SDK's
// default credential chain (an instance or task role, or whatever AWS_* variables and profile the process has): that
// chain can resolve to a role that writes the archive, and nothing here can tell, so it is opt-in (#2098).
// Never the worker's S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, which read and write every tenant document and write the
// archive: Compose passes the prober none, and with one in its environment and no pair of its own the check refuses.
const markerAge = seconds(DEFAULT_MARKER_AGE_SECONDS);
const archiveStoreSchema = z.object({
  ARCHIVE_STORE: optional.pipe(z.enum(['local', 's3']).optional()),
  ARCHIVE_DIR: optional,
});
// Read only for ARCHIVE_STORE=s3: a malformed S3_* setting of a store the check does not read is no business of the check.
const archiveS3Schema = z.object({
  ARCHIVE_S3_BUCKET: optional,
  S3_ENDPOINT: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  S3_REGION: optional,
  S3_FORCE_PATH_STYLE: optional.pipe(z.enum(['true', 'false']).optional()),
  PROBER_ARCHIVE_S3_ACCESS_KEY_ID: optional,
  PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY: optional,
  // 'true': read the bucket with the SDK's default credential chain instead of a pair of the prober's own (#2098).
  PROBER_ARCHIVE_S3_DEFAULT_CHAIN: optional.pipe(z.enum(['true', 'false']).optional()),
  // Read only to tell that the worker's key is in this environment; never used.
  S3_ACCESS_KEY_ID: optional,
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
  // The status page's file; unset: none is written.
  statusFile?: string | undefined;
  // The modules the deployment runs (CROVE_MODULES; loadProberConfig reads unset as every module). Left out of a
  // config built by hand: only the modules the workers record count.
  modules?: readonly string[] | undefined;
  // Supabase Auth's health URL (<base>/health); unset: Auth is not checked.
  authHealthUrl?: string | undefined;
  // Sent as `apikey` when set (hosted Supabase asks for it).
  authAnonKey?: string | undefined;
  // Failed answers in a row before it alerts (default 2); the time one answer may take (default 10 s).
  authMisses?: number;
  authTimeoutSeconds?: number;
  // The verification marker check (#2082); unset: off. A setting the check cannot use (error) disables the check, which
  // then reports it on every probe: it never stops the other probes or the backup and test alerts (#2094).
  // workerKey: the error is the worker's key in a shared environment, which a deployment's .env always has (the pilot
  // preflight leaves it out).
  archiveMarker?: ({ maxAgeSeconds: number } & ({ store: ArchiveStoreSettings } | { error: string; workerKey?: true })) | undefined;
}

export type ArchiveStoreSettings =
  | { kind: 'local'; dir: string }
  | {
      kind: 's3';
      bucket: string;
      region: string;
      endpoint: string | undefined;
      forcePathStyle: boolean;
      accessKeyId: string | undefined;
      secretAccessKey: string | undefined;
    };

export interface Thresholds {
  outboxAgeSeconds: number;
  jobAgeSeconds: number;
  heartbeatAgeSeconds: number;
  deadLetters: number;
  // Percent of the NOTIFY queue.
  notifyQueuePercent: number;
  // The WORM archive (#1997); 0: not checked. Left out of thresholds built by hand: not checked.
  archiveVerifyAgeSeconds?: number;
  archiveLagSeconds?: number;
  // AI document extraction (#1998): failed readings of the reading service in the window; 0 or left out: not checked.
  extractionFailures?: number;
  extractionWindowSeconds?: number;
}

export function loadProberConfig(env: NodeJS.ProcessEnv = process.env, everySeconds: number | null = null): ProberConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid prober configuration: ${fields}`);
  }
  const raw = parsed.data;
  const target = webhookTarget(raw, 'prober');
  return {
    databaseUrl: raw.PROBER_DATABASE_URL,
    webhookUrl: target.webhookUrl,
    webhookFormat: target.webhookFormat,
    telegramChatId: target.telegramChatId,
    repeatSeconds: raw.ALERT_REPEAT_MINUTES * 60,
    instance: target.instance,
    thresholds: {
      outboxAgeSeconds: raw.PROBER_MAX_OUTBOX_AGE_SECONDS,
      jobAgeSeconds: raw.PROBER_MAX_JOB_AGE_SECONDS,
      heartbeatAgeSeconds: raw.PROBER_MAX_HEARTBEAT_AGE_SECONDS,
      deadLetters: raw.PROBER_MAX_DEAD_LETTERS,
      notifyQueuePercent: raw.PROBER_MAX_NOTIFY_QUEUE_PERCENT,
      archiveVerifyAgeSeconds: raw.PROBER_MAX_ARCHIVE_VERIFY_AGE_SECONDS,
      archiveLagSeconds: raw.PROBER_MAX_ARCHIVE_LAG_SECONDS ?? Math.max(3600, (raw.ARCHIVE_LAG_SECONDS ?? 600) + 900),
      extractionFailures: raw.PROBER_MAX_EXTRACTION_FAILURES,
      extractionWindowSeconds: raw.PROBER_EXTRACTION_WINDOW_SECONDS,
    },
    deadLetterWindowSeconds: raw.PROBER_DEAD_LETTER_WINDOW_SECONDS ?? (everySeconds === null ? 3600 : Math.min(everySeconds + 60, 604_800)),
    heartbeatUrl: raw.PROBER_HEARTBEAT_URL,
    backupHeartbeatUrl: raw.BACKUP_HEARTBEAT_URL,
    statusFile: raw.PROBER_STATUS_FILE,
    modules: raw.CROVE_MODULES,
    authHealthUrl: authHealthUrl(raw),
    authAnonKey: raw.PUBLIC_AUTH_ANON_KEY,
    authMisses: raw.PROBER_AUTH_MISSES,
    authTimeoutSeconds: raw.PROBER_AUTH_TIMEOUT_SECONDS,
    archiveMarker: archiveMarkerSettings(env),
  };
}

function archiveMarkerSettings(env: NodeJS.ProcessEnv): ProberConfig['archiveMarker'] {
  // The limit first: 0 turns the check off whatever else is wrong with the archive settings.
  const age = markerAge.safeParse(env.PROBER_MAX_ARCHIVE_MARKER_AGE_SECONDS);
  if (!age.success) return { maxAgeSeconds: DEFAULT_MARKER_AGE_SECONDS, error: 'invalid archive settings: PROBER_MAX_ARCHIVE_MARKER_AGE_SECONDS' };
  const maxAgeSeconds = age.data;
  if (maxAgeSeconds === 0) return undefined;
  // The names only: a value may be a secret or an internal URL.
  const invalid = (error: z.ZodError) => ({ maxAgeSeconds, error: `invalid archive settings: ${[...new Set(error.issues.map((i) => i.path.join('.')))].join(', ')}` });
  const which = archiveStoreSchema.safeParse(env);
  if (!which.success) return invalid(which.error);
  if (which.data.ARCHIVE_STORE === 's3') {
    const parsed = archiveS3Schema.safeParse(env);
    if (!parsed.success) return invalid(parsed.error);
    const raw = parsed.data;
    if (!raw.ARCHIVE_S3_BUCKET) return { maxAgeSeconds, error: 'ARCHIVE_STORE=s3 needs ARCHIVE_S3_BUCKET' };
    const own = raw.PROBER_ARCHIVE_S3_ACCESS_KEY_ID !== undefined || raw.PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY !== undefined;
    if (own && (!raw.PROBER_ARCHIVE_S3_ACCESS_KEY_ID || !raw.PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY)) {
      return { maxAgeSeconds, error: 'set both PROBER_ARCHIVE_S3_ACCESS_KEY_ID and PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY, or neither' };
    }
    // The prober's key that is the worker's own key: the check must not read the archive with a key that writes.
    if (own && raw.S3_ACCESS_KEY_ID && raw.PROBER_ARCHIVE_S3_ACCESS_KEY_ID === raw.S3_ACCESS_KEY_ID) {
      return { maxAgeSeconds, error: "PROBER_ARCHIVE_S3_ACCESS_KEY_ID is the worker's S3_ACCESS_KEY_ID: give the prober a key of its own that only reads" };
    }
    const defaultChain = raw.PROBER_ARCHIVE_S3_DEFAULT_CHAIN === 'true';
    // A pair and the default chain are two answers to one question: which credentials read the bucket.
    if (own && defaultChain) {
      return { maxAgeSeconds, error: 'PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true and a PROBER_ARCHIVE_S3_* key are both set: use one or the other' };
    }
    // The worker's key in this environment (a prober run from the shared .env, say) and none of its own: the default
    // credential chain could then resolve to the worker's role, which writes. Refuse rather than guess.
    if (!own && raw.S3_ACCESS_KEY_ID) {
      return {
        maxAgeSeconds,
        workerKey: true,
        error:
          "ARCHIVE_STORE=s3 and S3_ACCESS_KEY_ID (the worker's key) is set, but the prober's own PROBER_ARCHIVE_S3_ACCESS_KEY_ID and PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY are not: " +
          "set them to a read-only key, or unset S3_ACCESS_KEY_ID in the prober's environment and set PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true to use the default credential chain",
      };
    }
    // No key of its own: the default credential chain only when asked for (#2098). It resolves to whatever the process
    // can reach (an instance or task role, AWS_* variables, a profile, a web identity), which may be a role that writes
    // the archive, and nothing here can tell.
    if (!own && !defaultChain) {
      return {
        maxAgeSeconds,
        error:
          'ARCHIVE_STORE=s3 and the prober has no key of its own: set PROBER_ARCHIVE_S3_ACCESS_KEY_ID and PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY to a read-only key, ' +
          "or PROBER_ARCHIVE_S3_DEFAULT_CHAIN=true to use the SDK's default credential chain (an instance or task role that only reads)",
      };
    }
    // The prober's own pair, or the default credential chain asked for; never the worker's S3_* key.
    return {
      maxAgeSeconds,
      store: {
        kind: 's3',
        bucket: raw.ARCHIVE_S3_BUCKET,
        region: raw.S3_REGION ?? 'us-east-1',
        endpoint: raw.S3_ENDPOINT,
        forcePathStyle: raw.S3_FORCE_PATH_STYLE === 'true',
        accessKeyId: raw.PROBER_ARCHIVE_S3_ACCESS_KEY_ID,
        secretAccessKey: raw.PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY,
      },
    };
  }
  return which.data.ARCHIVE_DIR ? { maxAgeSeconds, store: { kind: 'local', dir: which.data.ARCHIVE_DIR } } : undefined;
}

// Per call to the store: a store that takes the connection and never answers fails the call, and one more attempt, inside
// the deadline of the whole read (MARKER_TIMEOUT_MS), which also aborts what is still in flight (#2094).
const STORE_TIMEOUTS = { connectionTimeoutMs: 5_000, requestTimeoutMs: 10_000, maxAttempts: 2 };
// One client per settings, so the credentials the SDK resolves (an instance role, say) are kept between probes.
const proberClients = new WeakMap<ArchiveStoreSettings, ArchiveS3Sender>();

// Sends every call with the signal, so aborting it ends the calls still waiting.
function abortable(client: ArchiveS3Sender, signal: AbortSignal): ArchiveS3Sender {
  return { send: ((command: never, options?: object) => client.send(command, { ...options, abortSignal: signal })) as ArchiveS3Sender['send'] };
}

// The prober only reads: list, get and the store's write times. The lock settings are never used.
export function proberArchiveStore(settings: ArchiveStoreSettings, options: { signal?: AbortSignal; client?: ArchiveS3Sender } = {}): ArchiveStore {
  if (settings.kind === 'local') return new LocalArchiveStore(settings.dir);
  let client = options.client ?? proberClients.get(settings);
  if (!client) {
    client = createS3Client(
      {
        bucket: settings.bucket,
        region: settings.region,
        endpoint: settings.endpoint,
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        forcePathStyle: settings.forcePathStyle,
      },
      undefined,
      STORE_TIMEOUTS,
    );
    proberClients.set(settings, client);
  }
  return new S3ArchiveStore({ client: options.signal ? abortable(client, options.signal) : client, bucket: settings.bucket, lockMode: 'GOVERNANCE', retentionDays: 1 });
}

// What the start line says about the marker check, so a prober pointed at the wrong store, or one whose check is
// disabled, shows it at once. Never a credential.
export function describeMarkerCheck(marker: ProberConfig['archiveMarker']): string {
  if (!marker) return 'verification marker check off';
  if ('error' in marker) return `verification marker check disabled (${marker.error})`;
  const store = marker.store;
  if (store.kind === 'local') return `verification markers from local files in ${store.dir}`;
  const where = store.endpoint ? new URL(store.endpoint).host : `AWS ${store.region}`;
  return `verification markers from s3 bucket ${store.bucket} at ${where}, with ${store.accessKeyId ? "the prober's own key" : 'the default credential chain'}`;
}

// Where the Auth check asks (#1994): <base>/health, the base being PROBER_AUTH_URL, else PUBLIC_AUTH_URL, else
// PUBLIC_URL/auth/v1; undefined with none of them, or with PROBER_AUTH_MISSES=0.
function authHealthUrl(raw: {
  PROBER_AUTH_URL?: string | undefined;
  PUBLIC_AUTH_URL?: string | undefined;
  PUBLIC_URL?: string | undefined;
  PUBLIC_AUTH_ANON_KEY?: string | undefined;
  PROBER_AUTH_MISSES: number;
}): string | undefined {
  if (raw.PROBER_AUTH_MISSES === 0) return undefined;
  const base = raw.PROBER_AUTH_URL ?? raw.PUBLIC_AUTH_URL ?? (raw.PUBLIC_URL ? `${raw.PUBLIC_URL.replace(/\/+$/, '')}/auth/v1` : undefined);
  if (!base) return undefined;
  // PUBLIC_URL is not checked to be a URL here (the alert's instance name only reads it); one that is not leaves Auth
  // unchecked rather than the whole prober refused.
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  // A user name or password in it would travel in every request and could reach a log: refused.
  if (url.username || url.password) throw new Error('invalid prober configuration: the Auth URL (PROBER_AUTH_URL, PUBLIC_AUTH_URL or PUBLIC_URL) holds credentials');
  // Hosted Supabase answers 401 without the publishable key: every probe would page about an outage that is not one.
  if (isHostedSupabase(base) && !raw.PUBLIC_AUTH_ANON_KEY) throw new Error('invalid prober configuration: hosted Supabase Auth needs PUBLIC_AUTH_ANON_KEY (the publishable key) for its health check');
  return `${base.replace(/\/+$/, '')}/health`;
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
  // The WORM archive (#1997): since the newest verification run (or the first batch, before any run), and the age of the
  // oldest row not yet archived (every row's, before the first batch); null with no batch for the first, and with every
  // row archived for the second.
  archive_verify_age_seconds: number | null;
  archive_lag_seconds: number | null;
  // AI document extraction (#1998): readings of the window whose every attempt failed (the service), and those whose
  // document could not be read.
  extraction_service_failures: number;
  extraction_document_failures: number;
}

const s = (n: number) => `${Math.round(n)} s`;
const percent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;
const hours = (n: number) => `${Math.round((n / 3600) * 10) / 10} h`;

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
  const verifyLimit = t.archiveVerifyAgeSeconds ?? 0;
  if (verifyLimit > 0 && h.archive_verify_age_seconds !== null && h.archive_verify_age_seconds > verifyLimit) {
    findings.push({
      check: 'archive_verify',
      value: h.archive_verify_age_seconds,
      threshold: verifyLimit,
      message: `the WORM archive last passed verification ${hours(h.archive_verify_age_seconds)} ago (limit ${hours(verifyLimit)}): the nightly verification is not running or keeps failing (docs/runbooks/worm-archive.md)`,
    });
  }
  const lagLimit = t.archiveLagSeconds ?? 0;
  if (lagLimit > 0 && h.archive_lag_seconds !== null && h.archive_lag_seconds > lagLimit) {
    findings.push({
      check: 'archive_lag',
      value: h.archive_lag_seconds,
      threshold: lagLimit,
      message: `the oldest audit event not yet in the WORM archive is ${s(h.archive_lag_seconds)} old (limit ${s(lagLimit)}): the archiver is behind or stopped (docs/runbooks/worm-archive.md)`,
    });
  }
  const extractionLimit = t.extractionFailures ?? 0;
  if (extractionLimit > 0 && h.extraction_service_failures > extractionLimit) {
    findings.push({
      check: 'extraction',
      value: h.extraction_service_failures,
      threshold: extractionLimit,
      message: `${h.extraction_service_failures} document reading(s) failed every attempt in the last ${s(t.extractionWindowSeconds ?? 3600)} (limit ${extractionLimit}): the AI provider refuses or does not answer, or the parser sandbox is down (docs/runbooks/incidents.md)`,
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

/**
 * Reads crove_kernel.health() over its own short-lived connection. Refuses a privileged login. `modules`, the modules
 * the deployment runs, reach health() as the session setting crove.prober_modules: their queues count in the job age
 * whatever the workers record (#1894).
 */
export async function readHealth(databaseUrl: string, deadLetterWindowSeconds: number, modules: readonly string[] = [], extractionWindowSeconds = 3600): Promise<HealthSnapshot> {
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
    // One read-only transaction with the setting local to it: a transaction-mode pooler (PgBouncer, Supavisor) keeps
    // both statements on one server connection and leaves nothing set on it (#1894 review).
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT pg_catalog.set_config('crove.prober_modules', $1, true)`, [modules.join(',')]);
    const { rows } = await client.query<
      Omit<HealthSnapshot, 'notify_queue_usage' | 'archive_verify_age_seconds' | 'archive_lag_seconds' | 'extraction_service_failures' | 'extraction_document_failures'>
    >(
      `SELECT checked_at::text AS checked_at, outbox_pending, outbox_oldest_age_seconds, inbound_pending, inbound_oldest_age_seconds,
              jobs_schema_present, jobs_queued, job_oldest_queued_age_seconds, dead_letter_count, worker_heartbeat_age_seconds
       FROM crove_kernel.health($1::int)`,
      [deadLetterWindowSeconds],
    );
    const row = rows[0];
    if (!row) throw new Error('crove_kernel.health() returned no row');
    // The WORM archive's two ages (#1997), from a function of their own: health()'s columns never change.
    const { rows: archive } = await client.query<Pick<HealthSnapshot, 'archive_verify_age_seconds' | 'archive_lag_seconds'>>(
      'SELECT archive_verify_age_seconds, archive_lag_seconds FROM crove_kernel.archive_health()',
    );
    // Failed document readings of the window (#1998), from a function of their own too.
    const { rows: extraction } = await client.query<{ service_failures: number; document_failures: number }>(
      'SELECT service_failures, document_failures FROM crove_kernel.extraction_health($1::int)',
      [extractionWindowSeconds],
    );
    const { rows: queue } = await client.query<{ usage: number }>('SELECT pg_catalog.pg_notification_queue_usage() AS usage');
    await client.query('COMMIT');
    return {
      ...row,
      notify_queue_usage: Number(queue[0]?.usage ?? 0),
      archive_verify_age_seconds: archive[0]?.archive_verify_age_seconds ?? null,
      archive_lag_seconds: archive[0]?.archive_lag_seconds ?? null,
      extraction_service_failures: Number(extraction[0]?.service_failures ?? 0),
      extraction_document_failures: Number(extraction[0]?.document_failures ?? 0),
    };
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
  // Replaces writing the status page's file (tests).
  writeStatus?: typeof writeStatusFile;
  // Supabase Auth's failed answers in a row (#1994). runProber keeps one across --every probes; without it (one probe
  // a run, from cron) a single failed answer alerts, since nothing counts the runs before.
  authState?: { misses: number };
  // The WORM store the verification marker is read from (#2082). Default: one built from config.archiveMarker, with
  // timeouts and an abort signal for the deadline of the read.
  archiveStore?: ArchiveStore;
  // The S3 client that store is built on instead of the default one (tests).
  archiveClient?: ArchiveS3Sender;
  // The marker check's own alert state, kept in the process like outageGate, never in the database (whose owner the
  // check is about). runProber keeps one across --every probes; default: a fresh one.
  markerGate?: AlertGate;
  // How long the marker read may take before it counts as unreadable (default MARKER_TIMEOUT_MS; tests).
  markerTimeoutMs?: number;
  // When the probe loop started (runProber): with no marker in the store yet, the check waits the marker limit from then,
  // so the first nightly run after an upgrade can write one.
  startedAt?: Date;
}

// The miss count a probe loop starts with: as if the probe before had missed Auth, so a restart during an Auth outage
// keeps the alert open (the first miss alerts at once) instead of sending a recovery the next miss takes back.
export function initialAuthState(config: Pick<ProberConfig, 'authMisses'>): { misses: number } {
  return { misses: Math.max((config.authMisses ?? 2) - 1, 0) };
}

// One answer from Supabase Auth's health URL: ok on a 2xx, else why not, on one short line. The URL is never logged
// or sent: it may name an internal host.
export async function checkAuth(config: ProberConfig, deps: ProbeDeps): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!config.authHealthUrl) return { ok: true };
  try {
    const response = await (deps.fetch ?? fetch)(config.authHealthUrl, {
      method: 'GET',
      redirect: 'error',
      headers: config.authAnonKey ? { apikey: config.authAnonKey } : {},
      signal: AbortSignal.timeout((config.authTimeoutSeconds ?? 10) * 1000),
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${response.status}` };
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { ok: false, reason: `no answer within ${config.authTimeoutSeconds ?? 10} s` };
    // The system's error code only (ECONNREFUSED, ENOTFOUND): a fetch error's message may quote the whole URL.
    const cause = e instanceof Error ? (e.cause as { code?: unknown } | undefined) : undefined;
    const code = typeof cause?.code === 'string' && /^[A-Z_]{3,40}$/.test(cause.code) ? cause.code : null;
    return { ok: false, reason: code ? `connection failed: ${code}` : 'connection failed' };
  }
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
  const { code, failing, at } = await probe(config, deps);
  // Written whether or not an alert went out: the page shows what the probe saw. Not when the probe could not run
  // at all (no PROBER_DATABASE_URL), which says nothing about the deployment.
  if (config.statusFile && at) await writeStatus(config.statusFile, at, failing, config.authHealthUrl !== undefined, deps);
  if (config.heartbeatUrl && (code === EXIT.ok || code === EXIT.unhealthy)) await pingHeartbeat(config.heartbeatUrl, deps);
  return code;
}

// A failed write is logged, never thrown: the page then turns "unknown" once the file is stale.
async function writeStatus(path: string, at: Date, failing: string[] | null, authChecked: boolean, deps: ProbeDeps): Promise<void> {
  try {
    await (deps.writeStatus ?? writeStatusFile)(path, probeStatus(at, failing, authChecked));
  } catch (e) {
    (deps.error ?? ((line: string) => console.error(line)))(`[prober] status file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
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

// The exit code, the failing checks (null when the database could not be read) and when the probe ran (null when
// it could not run at all).
async function probe(config: ProberConfig, deps: ProbeDeps): Promise<{ code: number; failing: string[] | null; at: Date | null }> {
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
    return { code: EXIT.probeFailed, failing: null, at: null };
  }
  // Supabase Auth first (#1994): its own short timeout, and counted even when the database turns out unreadable.
  const authState = deps.authState ?? { misses: 0 };
  const authLimit = deps.authState ? Math.max(config.authMisses ?? 2, 1) : 1;
  const auth = config.authHealthUrl ? await checkAuth(config, deps) : null;
  if (auth) authState.misses = auth.ok ? 0 : authState.misses + 1;
  const authFinding: Finding | null =
    auth && !auth.ok && authState.misses >= authLimit
      ? {
          check: 'auth',
          value: authState.misses,
          threshold: authLimit,
          message: `Supabase Auth did not answer its health check ${authState.misses} time(s) in a row (${auth.reason}): nobody can sign in`,
        }
      : null;
  if (auth && !auth.ok && !authFinding) error(`[prober] Supabase Auth did not answer (${auth.reason}); ${authState.misses} of ${authLimit} misses before it alerts`);
  // The verification marker (#2082), from the WORM store alone and before the database is read, notified through a gate
  // the database does not hold: a database owner who stops the verification can neither hide nor silence it.
  let markerDelivered = true;
  let markerFinding: Finding | null = null;
  if (config.archiveMarker) {
    markerFinding = await checkVerifyMarker(config.archiveMarker, deps, now);
    if (markerFinding) error(`[prober] FAIL ${markerFinding.check}: ${markerFinding.message}`);
    const markerGate = deps.markerGate ?? memoryAlertGate(config.repeatSeconds);
    const markerResult = await markerGate.decide(markerFinding ? markerFinding.check : null, now);
    markerDelivered = await notify(markerGate, markerResult, notification(markerResult, { instance: config.instance, at }, markerFinding ? [markerFinding] : []));
  }
  let health: HealthSnapshot;
  try {
    health = await (deps.readHealth ?? readHealth)(config.databaseUrl, config.deadLetterWindowSeconds, config.modules, config.thresholds.extractionWindowSeconds);
  } catch (e) {
    // The database itself is unreachable or health() is refused: that is an outage too, so it alerts. Its state
    // cannot be kept in the database, so the in-process gate de-duplicates it.
    // One line: a driver message with a line break could otherwise start a Markdown heading or quote in a chat.
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
    error(`[prober] FAIL probe: could not read crove_kernel.health(): ${reason}`);
    const findings: Finding[] = [{ check: 'probe', value: null, threshold: null, message: `the prober could not read crove_kernel.health(): ${reason}` }];
    const result = await outage.decide('probe', now);
    const sent = (await notify(outage, result, notification(result, { instance: config.instance, at }, findings))) && markerDelivered;
    return { code: sent ? EXIT.probeFailed : EXIT.deliveryFailed, failing: null, at: now };
  }

  // The database answers again after an outage this process alerted about.
  const recovered = await outage.decide(null, now);
  let delivered = (await notify(outage, recovered, notification(recovered, { instance: config.instance, at }, []))) && markerDelivered;

  const findings = evaluateHealth(health, config.thresholds, config.deadLetterWindowSeconds);
  if (authFinding) findings.push(authFinding);
  if (findings.length === 0) {
    log(
      `[prober] ok: outbox ${health.outbox_pending} pending, inbound ${health.inbound_pending} pending, ` +
        `jobs ${health.jobs_queued ?? 0} queued, dead letters ${health.dead_letter_count ?? 0}, ` +
        `heartbeat ${health.worker_heartbeat_age_seconds === null ? 'none' : s(health.worker_heartbeat_age_seconds)} ago, ` +
        `notify queue ${percent(health.notify_queue_usage)}${auth?.ok ? ', auth ok' : ''}`,
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
  const failing = [...findings, ...(markerFinding ? [markerFinding] : [])].map((f) => f.check);
  if (!delivered) return { code: EXIT.deliveryFailed, failing, at: now };
  return { code: failing.length === 0 ? EXIT.ok : EXIT.unhealthy, failing, at: now };
}

// A store that accepts the connection and never answers must not hold up the probe: the database checks, the alerts and
// the status file all wait on it.
const MARKER_TIMEOUT_MS = 30_000;
const MAX_STORE_REASON = 300;

// The verification marker check (#2082): null when the newest marker is recent and names a chain hash the store's batch
// holds, or when there is nothing to verify yet.
export async function checkVerifyMarker(settings: NonNullable<ProberConfig['archiveMarker']>, deps: ProbeDeps, now: Date): Promise<Finding | null> {
  const limit = settings.maxAgeSeconds;
  const finding = (value: number | null, message: string): Finding => ({ check: 'archive_marker', value, threshold: limit, message: `${message} (docs/runbooks/worm-archive.md)` });
  if ('error' in settings) return finding(null, `the prober cannot check the WORM verification marker: ${settings.error}`);
  let state;
  let timer: NodeJS.Timeout | undefined;
  // Aborted with the deadline, so a call still in flight ends instead of piling up open sockets in the --every loop.
  const controller = new AbortController();
  try {
    const timeoutMs = deps.markerTimeoutMs ?? MARKER_TIMEOUT_MS;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
    });
    const store = deps.archiveStore ?? proberArchiveStore(settings.store, { signal: controller.signal, ...(deps.archiveClient ? { client: deps.archiveClient } : {}) });
    state = await Promise.race([readVerifyMarker(store, now), timeout]);
  } catch (e) {
    // One line, and short: a store's error text can run long.
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, MAX_STORE_REASON);
    return finding(null, `the prober could not read the verification marker from the WORM archive store: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  if (state.rewritten.length > 0) {
    const names = state.rewritten.slice(0, 3).join(', ') + (state.rewritten.length > 3 ? ` and ${state.rewritten.length - 3} more` : '');
    return finding(null, `the WORM archive store keeps more than one version of verification marker ${names}: a marker was written over, or deleted and written again`);
  }
  if (state.problem) return finding(null, `the newest WORM verification marker ${state.key} cannot be trusted: ${state.problem}`);
  if (state.key && !state.writtenAt) return finding(null, `the WORM archive store cannot tell when it wrote the verification marker ${state.key}`);
  const from = state.writtenAt ?? state.firstBatchAt;
  // No marker and no batch: nothing to verify yet.
  if (!from) return null;
  if (!state.key && deps.startedAt && now.getTime() - deps.startedAt.getTime() <= limit * 1000) return null;
  const age = Math.max(Math.floor((now.getTime() - from.getTime()) / 1000), 0);
  if (age <= limit) return null;
  return state.key
    ? finding(age, `the WORM archive store wrote the newest verification marker ${hours(age)} ago (limit ${hours(limit)}): the nightly verification has not passed since, or never finished`)
    : finding(age, `the WORM archive store holds no verification marker, and wrote its first batch ${hours(age)} ago (limit ${hours(limit)}): no nightly verification has passed`);
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
  const looping = {
    ...deps,
    outageGate: deps.outageGate ?? memoryAlertGate(config.repeatSeconds),
    authState: deps.authState ?? initialAuthState(config),
    markerGate: deps.markerGate ?? memoryAlertGate(config.repeatSeconds),
    startedAt: deps.startedAt ?? (deps.now ?? (() => new Date()))(),
  };
  // Under Docker this is PID 1, which gets no default SIGTERM handling: stop between probes at once.
  process.once('SIGTERM', () => process.exit(EXIT.ok));
  const heartbeat = config.heartbeatUrl ? `, heartbeat to ${describeHeartbeat(config.heartbeatUrl)}` : '';
  // Where the verification marker is read from (#2082): a prober pointed at the wrong store sees no batch and no marker,
  // which reads as nothing to verify yet, so the log says which store it reads. Settings the check cannot use disable
  // only that check (#2094): the other probes run, and archive_marker reports it on every probe until it is fixed.
  if (config.archiveMarker && 'error' in config.archiveMarker) {
    error(`[prober] ERROR ${describeMarkerCheck(config.archiveMarker)}: the other checks run, and archive_marker is reported on every probe until the settings are fixed`);
  }
  (deps.log ?? console.log)(`[prober] probing every ${every} s, alerts to ${alertSink(config, deps).describe()}${heartbeat}, ${describeMarkerCheck(config.archiveMarker)}`);
  for (;;) {
    await probeOnce(config, looping);
    await new Promise((resolve) => setTimeout(resolve, every * 1000));
  }
}
