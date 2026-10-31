// Worker: relays the outbox into pg-boss queues and runs jobs.
import { hostname } from 'node:os';
import { CompiledQuery, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { PgBoss, type Db as BossDb, type SendOptions } from 'pg-boss';
import type { Database, Db } from '@crove/db';
import { vietnamToday } from '@crove/kernel-contract';
import { DomainError, inboundKey, type AgentProgram, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { KERNEL_NOTIFYING_EVENTS, PROPOSAL_NUDGE_SWEEP_MS, runAgentWake, sweepProposalNudges, type UsageLimits } from '@crove/kernel';
import { aiDocumentFailure, type InvoiceReader } from '@crove/agent';
import type { CalendarAdapter, Publisher, Refresher } from '@crove/channel';
import { postMessage, type WebhookTarget } from './alert.ts';
import { REFRESH_SWEEP_MS, refreshChannels } from './channel-refresh.ts';
import { RESEAL_SWEEP_MS, resealCredentials, unopenableKeysLog } from './credential-reseal.ts';
import type { ExtractClient } from '@crove/extract-contract';
import { FINANCE_NOTIFYING_EVENTS, PERIOD_CLOSING_SWEEP_MS, extractAndPropose, importPortalList, recordExtractionFailure, recordPortalListFailure, sweepPeriodClosing } from '@crove/mod-finance';
import { ACCOUNT_SWEEP_MS, CHAT_ALERT_TEST_EVENT, CHAT_ALERTING_EVENTS, DIGEST_SWEEP_MS, EVERGREEN_SWEEP_MS, EXTERNAL_SWEEP_MS, FEED_SWEEP_MS, LATE_ID_SWEEP_MS, METRICS_SWEEP_MS, NOTIFYING_EVENTS, PUBLISH_STALE_SECONDS, QUEUE_LOW_SWEEP_MS, RECURRING_SWEEP_MS, REMINDER_SWEEP_MS, REPORT_SCHEDULE_SWEEP_MS, runChannelOptionJob, runCommentJob, runPublishJob, runEditJob, runRemoveJob, runThreadJob, sweepAccounts, sweepDigests, sweepEvergreen, sweepExternalPosts, sweepLateIds, sweepMetrics, sweepQueueLow, sweepRecurring, sweepReminders, sweepAssignmentReminders, sweepReportSchedules, REMOVE_READY, REMOVE_SWEEP_MS, REMOVE_WATCH_AFTER_MS, isProvider, runRemoveWatch, sweepRemovals } from '@crove/mod-social';
import { sweepFeeds } from './feeds.ts';
import { SECURITY_SWEEP_MS, sweepSecuritySignals, type SecurityThresholds } from './security-signals.ts';
import { BACK_PRESSURE_CHECK_MS, DEFAULT_OUTBOX_LAG_PAUSE_SECONDS, PausableWork, checkBackPressure, outboxLagSeconds } from './back-pressure.ts';
import { DEAD_LETTER_WORK, pruneInboxItems, takeDeadLetter } from './dead-letter.ts';
import { ChatAlertSender } from './chat-alerts.ts';
import { archiveSource, expandArchive, recordArchiveFailure, type ArchiveSource } from './archive.ts';
import { backfillImageSizes, IMAGE_SIZE_SWEEP_MS } from './image-size-backfill.ts';
import { EVIDENCE_HOLD_SWEEP_MS, runEvidenceHolds } from './evidence-hold.ts';
import { processInboundEmail, type InboundJob } from './inbound.ts';
import { mailEventJob, processMailEvent, type MailEventJob, type MailEventRow } from './mail-events.ts';
import { MAIL_BULK_GAP_MS, MAIL_BULK_QUEUE, MAIL_SEND_QUEUE, MAIL_SWEEP_MS, mailErrorCode, purgeMail, runMailJob, sweepMail, type MailJob, type MailQueueDeps } from './mail-queue.ts';
import { MISSING_INVOICE_SWEEP_MS, sweepMissingInvoiceReminders } from './missing-invoice-mail.ts';
import { ExportSealer } from './export-seal.ts';
import { AVAILABLE_MODULES } from './config.ts';
import { JOB_SCHEMA, QUEUES, SOCIAL_PUBLISH_QUEUES, socialPublishQueue } from './jobs-schema.ts';
import { jobGroup, jobKey, systemJobKey } from './job-keys.ts';
import { runLinkPreviewJob } from './link-preview.ts';
import { runPushJob, type PushSender } from './web-push.ts';
import { DEFAULT_EXPORT_RETENTION_DAYS, runOrgExport } from './org-export.ts';
import { archiveOutbox } from './outbox-retention.ts';
import { RETENTION_CRON, RETENTION_TZ, expireExports, runRetention, sweepInboundBlobs, sweepStaging } from './retention.ts';
import { NOTES_REMIND_CRON, NOTES_TRASH_CRON, NOTES_TRASH_TZ, queueNotesMemberPurge, runNotesMemberPurge, sweepNotesFormerMembers, sweepNotesReminders, sweepNotesTrash, type NotesMemberPurgeJob } from './notes-worker.ts';
import { PERIOD_BALANCE_VERIFY_CRON, runPeriodBalanceReconciliation } from './period-balance.ts';
import { runYearArchive } from './year-archive.ts';
import {
  ARCHIVE_VERIFY_CRON,
  ARCHIVE_WRITE_CRON,
  ArchiveMismatchError,
  restoreAckAlert,
  restoreAckStoreAlert,
  verifyArchive,
  writeVerifyMarker,
  writeArchive,
  type ArchiveStore,
} from './worm.ts';
import type { SessionRevoker, SignOutTarget } from './sessions.ts';
import { opsAlert } from './ops-alert.ts';
import { BANK_FEEDS_DUE_PAGE, bankFeedsDue, runBankFeedSync, type BankFeedSyncJob } from './bank-feed-sync.ts';
import { CALENDAR_SYNC_SWEEP_MS, runCalendarWriteBack, syncCalendars, type CalendarWriteBackJob } from './calendar-sync.ts';
import { BANK_FEED_NOTICE_CLAIM, claimBankFeedNotices } from './bank-feed-webhook.ts';
import type { BankFeedProvider } from '@crove/bank-feed';

const SOCIAL_PUBLISH_RETRY_LIMIT = 2;
// The worker looks for due variants this often; a post goes out within this long of its time.
export const SOCIAL_SWEEP_MS = 15_000;
const SOCIAL_SWEEP_LIMIT = 500;
// Agent proposal events and the system command that acts on each (ADR-0029 section 6): the command reads the event
// from the outbox; the job carries only its id.
const AGENT_PROPOSAL_COMMANDS: Readonly<Record<string, string>> = {
  'kernel.agent.proposal_requested': 'kernel.agent.proposal.create',
  'kernel.agent.proposal_approved': 'kernel.agent.proposal.approve',
};
const AGENT_RETRY_LIMIT = 3;
const SOCIAL_NOTIFY_RETRY_LIMIT = 3;
// The watch of a planned takedown (#937) that ran too early tries again 1, 2, 4, 8 and 16 minutes later, past the
// stale limit of a remove job that started up to half an hour late.
const REMOVE_WATCH_RETRY_LIMIT = 5;
// In-app notifications of the kernel and finance (#671): the dispatch command of the module whose event it is.
const NOTIFY_COMMANDS: ReadonlyMap<string, { module: string; command: string }> = new Map<string, { module: string; command: string }>([
  ...KERNEL_NOTIFYING_EVENTS.map((type): [string, { module: string; command: string }] => [type, { module: 'kernel', command: 'kernel.notification.dispatch' }]),
  ...FINANCE_NOTIFYING_EVENTS.map((type): [string, { module: string; command: string }] => [type, { module: 'finance', command: 'finance.notification.dispatch' }]),
]);
const NOTIFY_RETRY_LIMIT = 3;
// A booking's confirmation (#1318): a failure retries soon, since the visitor's page is waiting on it.
const BOOKING_RETRY_LIMIT = 3;
const NOTIFYING: ReadonlySet<string> = new Set(NOTIFYING_EVENTS);
// Team chat alerts (#863): one job per alerting event, never retried. pg-boss refuses a second job with the same
// singleton key in the same slot of this many seconds, even once the first is done, so a relay batch sent again after a
// failed claim does not queue the event twice.
const CHAT_ALERTING: ReadonlySet<string> = new Set(CHAT_ALERTING_EVENTS);
const CHAT_ALERT_SINGLETON_SECONDS = 3600;
// An owner's test line: one job per org in a slot this short, on top of the API's few a minute.
const CHAT_ALERT_TEST_SINGLETON_SECONDS = 10;
// Every 10 minutes the worker wakes agents whose wake-up is still pending and that can run now
// (crove_kernel.agent_wakeups_due): a run refused earlier by the daily cap, a kill switch or a budget that has since
// lifted, or blocked by a run left live by a crashed worker. Agents still capped, switched off, out of budget or of a
// module this deployment does not enable are left out, so the sweep writes no refused start for them.
export const AGENT_SWEEP_CRON = '*/10 * * * *';
const AGENT_SWEEP_LIMIT = 200;

function sendAgentWake(boss: JobSender, orgId: string, agentId: string) {
  return boss.send(QUEUES.agentWake, { orgId, agentId } satisfies AgentWakeJob, {
    singletonKey: jobKey(orgId, QUEUES.agentWake, agentId),
    retryLimit: AGENT_RETRY_LIMIT,
    retryDelay: 20,
    retryBackoff: true,
  });
}
const EXTRACT_RETRY_LIMIT = 3;
export const EXTRACT_POLL_SECONDS = 0.5;

// Extract jobs this worker runs at once (#2119): the extract client's own slots toward the sandbox (EXTRACT_WORKER_CONCURRENCY,
// capped by the sandbox's EXTRACT_CONCURRENCY in config.ts), 1 for a client that names none. pg-boss starts that many
// workers on the queue, each taking one job at a time, so never more run at once. The AI call of a PDF or a photo is what
// they overlap; the sandbox calls inside them wait for a slot in the client.
export function extractWorkers(extract: ExtractClient): number {
  return Math.max(1, Math.floor(extract.concurrency ?? 1));
}
const INBOUND_RETRY_LIMIT = 3;
const MAIL_EVENT_RETRY_LIMIT = 5;
const SIGN_OUT_RETRY_LIMIT = 5;
const ORG_EXPORT_RETRY_LIMIT = 3;
// The prober alerts when the freshest heartbeat is older than PROBER_MAX_HEARTBEAT_AGE_SECONDS (default 120).
export const HEARTBEAT_INTERVAL_MS = 30_000;
// Refusal tally windows (issue #162) older than the retention are deleted by the daily retention job, in batches.
export const DEFAULT_REFUSAL_TALLY_RETENTION_DAYS = 7;
const REFUSAL_TALLY_PRUNE_BATCH = 10_000;
// Days of crove_kernel.security_event windows kept (plan §4.9: 30 days).
export const SECURITY_EVENT_RETENTION_DAYS = 30;
const SECURITY_EVENT_PRUNE_BATCH = 10_000;

interface InboundRow {
  seq: string;
  blob_id: string;
  raw_sha256: string;
  size_bytes: string;
  recipient: string;
}

type BookingJob =
  | {
      orgId: string;
      bookingId: string;
      // A visitor's ask from a manage link (#1319); without it, the job confirms the booking.
      requestId?: string;
    }
  // A member who left the org or whose role changed (#1382): their booking feed may need revoking.
  | { orgId: string; memberEventId: string };

interface BookingRemindJob {
  orgId: string;
  bookingId: string;
  startsAt: string;
  lead: '24h' | '1h';
}

// The reminders before a booking (#1319): how long before it each goes out.
const BOOKING_REMINDERS: ReadonlyArray<{ lead: BookingRemindJob['lead']; ms: number }> = [
  { lead: '24h', ms: 24 * 3_600_000 },
  { lead: '1h', ms: 3_600_000 },
];

interface AgentWakeJob {
  orgId: string;
  agentId: string;
}

interface AgentDispatchJob {
  orgId: string;
  eventId: string;
}

interface LinkPreviewJob {
  orgId: string;
  previewId: string;
}
const LINK_PREVIEW_RETRY_LIMIT = 2;

interface PushJob {
  orgId: string;
  notificationId: string;
}
// A push job may run this long (pg-boss expires it after): each post has its own 10-second deadline.
const PUSH_JOB_EXPIRE_SECONDS = 120;

interface ChannelOptionJob {
  orgId: string;
  optionId: string;
}
const CHANNEL_OPTION_RETRY_LIMIT = 2;
// Lists one worker process reads at once (#1131); each holds at most one database connection at a time.
const CHANNEL_OPTION_WORKERS = 4;

interface ExtractJob {
  orgId: string;
  fileId: string;
  version?: number;
}

interface OrgExportJob {
  orgId: string;
}

// A fiscal year's archive package (#922): the year and the command that asked for it.
interface YearArchiveJob {
  orgId: string;
  year: number;
  requestCommandId: string | null;
}
const YEAR_ARCHIVE_RETRY_LIMIT = 3;

interface PortalListJob {
  orgId: string;
  listId: string;
}
const PORTAL_LIST_RETRY_LIMIT = 3;

export interface OutboxRow {
  seq: string;
  org_id: string;
  event_id: string;
  type: string;
  payload: Record<string, unknown>;
}

const EXTRACT_EVENTS: readonly string[] = ['kernel.file.ingested', 'kernel.file.reextract_requested'];

// Fair order on the extraction queue (#432, ADR-0035, docs/adr/0035-fair-extraction-order.md). Every org
// shares one extraction queue and one parser slot, and pg-boss fetches by priority first, then by creation order. Each
// extraction job is sent in its org's group with priority -n, n being how many extraction jobs of that org are already
// queued, retrying or running: the k-th waiting job of every org runs in round k. An org's 500-entry ZIP queues its
// entries at priorities 0 to -499, so another org's single upload, at priority 0, waits only for the job running and
// for other orgs' rank-0 jobs queued before it. Counted per relay batch, one query; jobs of the same org within the
// batch take the next ranks. Several worker processes count apart, so the order is fair to within their number.
export async function extractPriorities(db: Db, rows: readonly OutboxRow[]): Promise<Map<OutboxRow, number>> {
  const extracts = rows.filter((row) => EXTRACT_EVENTS.includes(row.type));
  const priorities = new Map<OutboxRow, number>();
  if (extracts.length === 0) return priorities;
  const groupIds = [...new Set(extracts.map((row) => row.org_id))].map((orgId) => jobGroup(orgId, QUEUES.extract).id);
  const { rows: counted } = await sql<{ group_id: string; n: number }>`
    SELECT group_id, count(*)::int AS n FROM ${sql.table(`${JOB_SCHEMA}.job`)}
    WHERE name = ${QUEUES.extract} AND state IN ('created', 'retry', 'active') AND group_id = ANY(${groupIds}::text[])
    GROUP BY group_id`.execute(db);
  const rank = new Map(counted.map((c) => [c.group_id, c.n]));
  for (const row of extracts) {
    const group = jobGroup(row.org_id, QUEUES.extract).id;
    const n = rank.get(group) ?? 0;
    priorities.set(row, -n);
    rank.set(group, n + 1);
  }
  return priorities;
}

// What the relay sends jobs with: pg-boss itself, or pg-boss on a relay batch's transaction (relayBatch).
export interface JobSender {
  send(name: string, data?: object | null, options?: SendOptions): Promise<string | null>;
}

// One relay batch (#1705): the claim and the jobs it sends commit or roll back together. claim runs on the transaction
// (an outbox, inbound or mail-event claim) and returns one step per claimed row; each step sends its jobs with the
// sender it is given, pg-boss inserting them on that same transaction through its db option. A failed step rolls the
// whole batch back, the claim and the jobs already sent, so the next pass relays the batch again and no job is queued
// twice, whatever the queue's policy. This is chosen over a singleton key per outbox row on every job: a standard
// queue's singleton key dedupes nothing, and a stately queue's only while the first job is still queued, so only the
// shared transaction rules out the second job on every queue and for every handler.
// Every step runs to its end before the transaction closes, and a send that reaches the database after that is
// refused, never run on the pooled connection outside the transaction. Sends go to the connection one at a time (pg
// would queue them, but deprecates query() on a client already running one).
export async function relayBatch(
  workerDb: Db,
  sender: JobSender,
  claim: (trx: Transaction<Database>) => Promise<ReadonlyArray<(boss: JobSender) => Promise<unknown>>>,
): Promise<number> {
  return workerDb.transaction().execute(async (trx) => {
    const steps = await claim(trx);
    let closed = false;
    let tail: Promise<unknown> = Promise.resolve();
    // The first statement of the batch that failed, which aborted the transaction: thrown even when a step caught it
    // (PostgreSQL would answer the COMMIT with a silent rollback), and before the 25P02 errors every later statement
    // gets, so the log names the real cause.
    let aborted: { error: unknown } | null = null;
    const db: BossDb = {
      executeSql: (text, values) => {
        const run = tail.then(async () => {
          if (closed) throw new Error('relay batch closed: a job sent after its transaction ended');
          return (await trx.executeQuery(CompiledQuery.raw(text, values ?? []))).rows;
        });
        tail = run.catch((error: unknown) => {
          if (!closed && !aborted && (error as { code?: unknown } | null)?.code !== '25P02') aborted = { error };
        });
        return run.then((rows) => ({ rows: [...rows] }));
      },
    };
    const onBatch: JobSender = { send: (name, data, options) => sender.send(name, data, { ...options, db }) };
    try {
      const settled = await Promise.allSettled(steps.map((step) => step(onBatch)));
      await tail;
      if (aborted) throw (aborted as { error: unknown }).error;
      const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      closed = true;
      await tail;
    }
    return steps.length;
  });
}

// The extraction job of an ingested file, or of a requested re-extraction (version), in its org's group with its fair
// priority. null for a re-extraction event without a valid version.
export function sendExtractJob(boss: JobSender, row: OutboxRow, priority: number): Promise<string | null> | null {
  const fileId = String(row.payload.fileId);
  const options = { priority, group: jobGroup(row.org_id, QUEUES.extract), retryLimit: EXTRACT_RETRY_LIMIT, retryDelay: 20, retryBackoff: true };
  if (row.type === 'kernel.file.reextract_requested') {
    const version = Number(row.payload.version);
    if (!Number.isInteger(version) || version < 1) return null;
    return boss.send(QUEUES.extract, { orgId: row.org_id, fileId, version } satisfies ExtractJob, { ...options, singletonKey: jobKey(row.org_id, QUEUES.extract, `${fileId}:${version}`) });
  }
  return boss.send(QUEUES.extract, { orgId: row.org_id, fileId } satisfies ExtractJob, { ...options, singletonKey: jobKey(row.org_id, QUEUES.extract, fileId) });
}

// The daily pull of every bank feed (ADR-0039), early morning in Vietnam; a sync retries a few times, then dead-letters.
const BANK_FEED_SYNC_CRON = '30 5 * * *';
const BANK_FEED_SYNC_RETRY_LIMIT = 3;
// A booking's event handed to a calendar write-back job: it fails only when the org's connections cannot be listed (a
// database error), which pg-boss retries a few times, then dead-letters. A failing provider call is left to the 15 minute sweep.
const CALENDAR_WRITEBACK_RETRY_LIMIT = 3;
// A job that finds a connection's write-back held by the sweep or another job tries again this many times, this far apart.
const CALENDAR_WRITEBACK_BUSY_TRIES = 4;
const CALENDAR_WRITEBACK_BUSY_WAIT_MS = 5_000;
// One sync a connection per slot for the signed notices that ask for one.
const BANK_FEED_NOTICE_SLOT_SECONDS = 30;

export interface WorkerDeps {
  connectionString: string;
  workerDb: Db;
  runtime: Runtime;
  store: BlobStore;
  extractor: InvoiceReader | null;
  // crove-extract (plan §7.6): every PDF, XML and MIME parse happens there, never in this process.
  extract: ExtractClient;
  inboundDomain: string | null;
  // Supabase Auth sign-out after a Crove-side revoke (ADR-0028 section 4); null keeps revocation Crove-side only.
  revoker?: SessionRevoker | null;
  // Names this worker in crove_kernel.worker_heartbeat (default: the host name, the container id under Docker).
  instance?: string;
  // The build it records there (#1952); default: none known.
  build?: WorkerBuild;
  // Days of crove_kernel.refusal_tally windows kept (default DEFAULT_REFUSAL_TALLY_RETENTION_DAYS).
  refusalTallyRetentionDays?: number;
  // The built-in program of each agent template (ADR-0029 section 8), by template key.
  agentPrograms?: Readonly<Record<string, AgentProgram>>;
  // Seals org export blobs at rest (EXPORT_ENCRYPTION_KEY, issue #212). Default: no key, stored unencrypted.
  exportSealer?: ExportSealer;
  // Days an org export is kept before the retention job deletes it (EXPORT_RETENTION_DAYS, 35 to 90).
  exportRetentionDays?: number;
  // Days the original file of a posted invoice is held in the bucket from its posting (EVIDENCE_LOCK_DAYS, issue
  // #1009). Unset or 0: no holds.
  evidenceLockDays?: number;
  // Social publishing: the credential broker that opens channel tokens, and the providers this deployment can publish
  // to. Without it, or without the social module, scheduled posts wait.
  // bankFeeds: the bank feed adapters this deployment offers (ADR-0039, #2044), by provider id; the worker alone uses
  // them, with the credentials it opens.
  channels?: {
    broker: CredentialBroker;
    publishers: Readonly<Record<string, Publisher>>;
    refreshers?: Readonly<Record<string, Refresher>>;
    bankFeeds?: Readonly<Record<string, BankFeedProvider>>;
    // The outside calendar adapters this deployment offers (#2123), by OAuth provider id.
    calendars?: Readonly<Partial<Record<string, CalendarAdapter>>>;
  };
  // PUBLIC_URL, where Social short links (#706) point.
  publicUrl?: string;
  // The product name users see (BRAND_NAME, #1045), for the chat alert test line.
  brand?: string;
  // Queued mail (#548): the mailer, the templates queued mail is rendered from, and the bounce domain. Unset: queued
  // mail waits.
  mail?: Omit<MailQueueDeps, 'runtime' | 'publicUrl'>;
  // Browser push for Social notifications (#1238): the sender with the deployment's VAPID keys and the product name
  // the push shows as its title. Unset: no push is queued or sent.
  push?: { sender: PushSender; brand: string };
  // The WORM fact stream (worm.ts, #891): the store batches go to and how long after a row is written it is archived.
  // Unset: nothing is archived.
  // restoreAlertDays: days the verifier alerts on a restore acknowledgement after the store wrote it (#2020).
  archive?: { store: ArchiveStore; lagSeconds: number; restoreAlertDays?: number };
  // The per-org abuse limits (#675). Unset: nothing is checked (use is still recorded).
  usageLimits?: UsageLimits;
  // Detective security alerts (#996): the alert webhook (null: the log only) and the thresholds (default
  // DEFAULT_SECURITY_THRESHOLDS).
  securityAlerts?: { target: WebhookTarget | null; thresholds?: SecurityThresholds };
  // The AI model's price per million input and output tokens, in the unit of the ai_cost limit. Unset: AI costs 0.
  aiPrice?: { inputPerMTok: string; outputPerMTok: string };
  // Back-pressure (#894): above this outbox lag the agent, bulk mail, archive and retention queues stop fetching
  // (default DEFAULT_OUTBOX_LAG_PAUSE_SECONDS).
  outboxLagPauseSeconds?: number;
}

// A person asked for a published variant to come down from its platform (#860).
interface SocialRemoveJob {
  orgId: string;
  variantId: string;
  provider: string;
  // The last remove call the person saw when they asked (null: none was made).
  after: string | null;
  // The watch of a planned takedown (#937), queued with its remove job to run once the ask went stale: it never calls
  // the platform.
  watch?: true;
}

// A person asked for a published variant's text to be corrected on its platform (#1223).
interface SocialEditJob {
  orgId: string;
  variantId: string;
  provider: string;
  // The last edit call the person saw when they asked (null: none was made).
  after: string | null;
}

interface SocialPublishJob {
  orgId: string;
  variantId: string;
  provider: string;
  // A person asked for the variant's first comment again (#587): the job posts the comment, not the post.
  comment?: true;
  // A person asked for the rest of the variant's thread again (#742).
  thread?: true;
  // The last comment (or thread) call the person saw when they asked (null: none was made).
  after?: string | null;
}

/** Sends a publish job for each variant with publishing work, for the providers this worker can publish to. */
export async function sweepSocialPublishing(boss: PgBoss, workerDb: Db, providers: ReadonlySet<string>): Promise<number> {
  const { rows } = await sql<{ org_id: string; variant_id: string; provider: string }>`
    SELECT org_id, variant_id, provider FROM crove_social.publish_due(${SOCIAL_SWEEP_LIMIT}::int, ${PUBLISH_STALE_SECONDS}::int, ${[...providers]}::text[])`.execute(workerDb);
  const due = rows.filter((r) => providers.has(r.provider));
  await Promise.all(
    due.map((r) =>
      boss.send(socialPublishQueue(r.provider), { orgId: r.org_id, variantId: r.variant_id, provider: r.provider } satisfies SocialPublishJob, {
        singletonKey: jobKey(r.org_id, socialPublishQueue(r.provider), r.variant_id),
        retryLimit: SOCIAL_PUBLISH_RETRY_LIMIT,
        retryDelay: 30,
        retryBackoff: true,
      }),
    ),
  );
  return due.length;
}

/**
 * The application_name of this worker's database connections (#1951): 'crove-worker:' and the instance its heartbeat
 * names, which audit_event_stamp writes into every system-context audit row (detail.workerInstance), so an alert can
 * tie one process's work across orgs together. PostgreSQL keeps 63 bytes of it, so the composition root cuts the
 * instance to 50 characters for both (kernel.ts). Behind a transaction-mode pooler that does not track
 * application_name per client, the server connection running a transaction may carry another worker's name; direct
 * connections, the default, are exact.
 */
export function workerApplicationName(instance: string): string {
  return `crove-worker:${instance}`.slice(0, 63);
}

// The build a worker runs (#1952): CROVE_BUILD and CROVE_BUILD_TIME, null for a local build.
export interface WorkerBuild {
  id: string | null;
  time: string | null;
}

/**
 * Records that this worker is alive, the modules whose queues it works and the build it runs
 * (crove_kernel.worker_beat, crove_worker only): the prober ages only those queues, so a module left out does not read
 * as stuck workers (#1877), and the API's /readyz waits while a live worker runs an older build (#1952).
 */
export async function beat(workerDb: Db, instance: string, modules: readonly string[], build: WorkerBuild = { id: null, time: null }): Promise<void> {
  await sql`SELECT crove_kernel.worker_beat(${instance.slice(0, 128)}, ${[...modules]}::text[], ${build.id}::text, ${build.time}::timestamptz)`.execute(workerDb);
}

/**
 * Deletes refusal tally windows older than keepDays (crove_kernel.refusal_tally_prune, crove_worker only), batch by
 * batch until none is left, and returns how many rows went. Several workers may run it at once; each batch is its
 * own statement.
 */
export async function pruneRefusalTally(workerDb: Db, keepDays: number): Promise<number> {
  let total = 0;
  for (;;) {
    const { rows } = await sql<{ n: number }>`
      SELECT crove_kernel.refusal_tally_prune(${keepDays}::integer, ${REFUSAL_TALLY_PRUNE_BATCH}::integer) AS n`.execute(workerDb);
    const n = rows[0]?.n ?? 0;
    total += n;
    if (n < REFUSAL_TALLY_PRUNE_BATCH) return total;
  }
}

/**
 * Deletes security_event windows older than SECURITY_EVENT_RETENTION_DAYS (crove_kernel.security_event_prune,
 * crove_worker only), batch by batch, and returns how many rows went.
 */
export async function pruneSecurityEvents(workerDb: Db): Promise<number> {
  let total = 0;
  for (;;) {
    const { rows } = await sql<{ n: number }>`
      SELECT crove_kernel.security_event_prune(${SECURITY_EVENT_RETENTION_DAYS}::integer, ${SECURITY_EVENT_PRUNE_BATCH}::integer) AS n`.execute(workerDb);
    const n = rows[0]?.n ?? 0;
    total += n;
    if (n < SECURITY_EVENT_PRUNE_BATCH) return total;
  }
}

// The sign-out job's data: the user whose session it is (#1970), or, for a job made from an event emitted before the
// switch, the identity provider subject itself. The job table holds no subject otherwise.
export type SignOutJob = { userId?: string; subject?: string; sessionId: string; scope: 'local' | 'global' };

// The identity provider subject of a user account (crove_kernel.user_auth_subject, crove_worker only), or null.
export async function authSubject(workerDb: Db, userId: string): Promise<string | null> {
  const { rows } = await sql<{ subject: string | null }>`SELECT crove_kernel.user_auth_subject(${userId}::uuid) AS subject`.execute(workerDb);
  return rows[0]?.subject ?? null;
}

/**
 * One attempt of the Supabase Auth sign-out job. Best effort: the revoked record already blocks the session in
 * Crove. A failure is rethrown so pg-boss retries it with backoff; the last one is logged as an ALERT for the
 * operator, because the session's refresh tokens then live on upstream.
 */
export async function runSignOut(revoker: SessionRevoker | null | undefined, target: SignOutTarget, retryCount: number): Promise<void> {
  const label = `${target.scope} sign-out of session ${target.sessionId.slice(0, 8)}`;
  if (!revoker) {
    console.warn(`[signout] ${label}: no Supabase Auth sign-out configured; revoked in Crove only`);
    return;
  }
  try {
    await revoker.signOut(target);
    console.log(`[signout] ${label} done in Supabase Auth`);
  } catch (error) {
    if (retryCount < SIGN_OUT_RETRY_LIMIT) throw error;
    opsAlert(`[signout] ALERT ${label}: Supabase Auth sign-out failed after ${retryCount + 1} attempts; revoked in Crove only`, error);
  }
}

// The extraction job's last attempt failed: records a failed run, so the file never stays "being read". `archive` is
// what the attempt learned about the file (undefined when its lookup failed too). A file whose lookup keeps failing is
// recorded as a document; should the file turn out to be a ZIP (#432), that refusal (ARCHIVE_NOT_READ) records the
// failed opening of an archive instead.
export async function recordLastAttemptFailure(
  runtime: Runtime,
  orgId: string,
  fileId: string,
  version: number | undefined,
  archive: ArchiveSource | null | undefined,
  // The last attempt's error: whether the document or the reading service failed (#1998).
  error?: unknown,
): Promise<void> {
  const known = archive === undefined ? await archiveSource(runtime, orgId, fileId).catch(() => undefined) : archive;
  const failArchive = () => recordArchiveFailure(runtime, orgId, fileId, 'Không mở được tệp ZIP sau nhiều lần thử; hãy tải lại tệp');
  if (known) {
    await failArchive();
    return;
  }
  try {
    // Every attempt threw. The AI refusing this document itself (a request it rejects, an answer that never fits the
    // schema) is the document's failure; anything else is the reading service's, which the prober counts (#1998).
    await recordExtractionFailure(
      runtime,
      orgId,
      fileId,
      'Không đọc được chứng từ sau nhiều lần thử; hãy kiểm tra cấu hình AI hoặc gửi tệp XML',
      version,
      aiDocumentFailure(error) ? 'document' : 'service',
    );
  } catch (error) {
    if (known === undefined && error instanceof DomainError && error.code === 'ARCHIVE_NOT_READ') {
      await failArchive();
      return;
    }
    throw error;
  }
}

export async function startWorker(deps: WorkerDeps): Promise<() => Promise<void>> {
  const boss = new PgBoss({ connectionString: deps.connectionString, schema: JOB_SCHEMA, migrate: false, createSchema: false });
  boss.on('error', (error) => console.error('[pg-boss]', error));
  await boss.start();

  const exportRetentionDays = deps.exportRetentionDays ?? DEFAULT_EXPORT_RETENTION_DAYS;
  const exportSealer = deps.exportSealer ?? new ExportSealer(null);
  if (!deps.exportSealer) console.warn('[org-export] no export sealer configured: exports are stored unencrypted');

  // Jobs of a module this deployment leaves out are not worked and never queued (CROVE_MODULES, plan Decision 12).
  // Reading files is the finance module's job today: without it an uploaded file is stored and stays unread.
  const finance = deps.runtime.installed('finance');
  const social = deps.runtime.installed('social');
  const crm = deps.runtime.installed('crm');
  const notes = deps.runtime.installed('notes');
  // A cron job of a module left out (#1471): a schedule a run with the module saved stays in pg-boss, which would queue
  // ticks nobody works and the prober would report as stuck. So it is taken off, and the ticks it queued (no data) go.
  const dropCron = async (queue: string) => {
    await boss.unschedule(queue);
    await boss.deleteQueuedJobs(queue);
  };
  // Background, agent and bulk queues, paused under back-pressure (#894, plan §4.9). Registered with background.add.
  const background = new PausableWork(boss);

  if (finance) console.log(`[extract] up to ${extractWorkers(deps.extract)} extract job(s) at once`);
  // version: a requested re-extraction (kernel.file.reextract_requested); absent for the first read of a new file.
  // pg-boss waits the polling interval between fetches (2 s by default, less the job's run time), so a batch of 200
  // documents (bulk intake, #314) would wait about 400 s; 0.5 s, the shortest it allows, lets one sandbox call follow
  // the other. An idle worker asks for extraction jobs twice a second.
  if (finance) await boss.work<ExtractJob>(QUEUES.extract, { batchSize: 1, localConcurrency: extractWorkers(deps.extract), pollingIntervalSeconds: EXTRACT_POLL_SECONDS }, async ([job]) => {
    if (!job) return;
    const { orgId, fileId, version } = job.data;
    // A ZIP archive (#314) is opened into documents of its own instead of being read; it is never read again.
    // undefined until it is known; a lookup that fails is retried with the job like any other step.
    let archive: ArchiveSource | null | undefined;
    try {
      archive = await archiveSource(deps.runtime, orgId, fileId);
      if (archive && version !== undefined) return;
      if (archive) {
        const { fileIds } = await expandArchive({ runtime: deps.runtime, store: deps.store, extract: deps.extract }, orgId, archive, job.retryCount);
        console.log(`[extract] archive ${fileId}: ${fileIds.length} file(s)`);
      } else {
        const done = await extractAndPropose(
          { runtime: deps.runtime, store: deps.store, extractor: deps.extractor, extract: deps.extract, limits: deps.usageLimits, aiPrice: deps.aiPrice },
          orgId,
          fileId,
          version,
        );
        // Over its org's daily limit (#675): read once the org is back under it, in its org's group as before.
        if (done.deferred) {
          await boss.send(QUEUES.extract, job.data, {
            group: jobGroup(orgId, QUEUES.extract),
            startAfter: new Date(done.deferred),
            retryLimit: EXTRACT_RETRY_LIMIT,
            retryDelay: 20,
            retryBackoff: true,
          });
          console.log(`[extract] file ${fileId}: over the org's daily limit, deferred to ${done.deferred}`);
        }
      }
    } catch (error) {
      console.error(`[extract] file ${fileId}${version ? ` version ${version}` : ''} attempt ${job.retryCount + 1}`, error);
      if (job.retryCount < EXTRACT_RETRY_LIMIT) throw error;
      // The last attempt records a failed run either way, so the file never stays "being read".
      await recordLastAttemptFailure(deps.runtime, orgId, fileId, version, archive, error);
    }
  });

  // The tax portal's purchase list (#465): read in crove-extract and recorded on its list. After the last failed
  // attempt the list is recorded as failed, so it never stays "being read"; the accountant imports the file again.
  if (finance) await boss.work<PortalListJob>(QUEUES.portalList, { batchSize: 1, pollingIntervalSeconds: EXTRACT_POLL_SECONDS }, async ([job]) => {
    if (!job) return;
    const { orgId, listId } = job.data;
    try {
      const done = await importPortalList({ runtime: deps.runtime, store: deps.store, extract: deps.extract }, orgId, listId, job.retryCount);
      if (done) console.log(`[portal-list] list ${listId}: ${done.rows} row(s)`);
    } catch (error) {
      console.error(`[portal-list] list ${listId} attempt ${job.retryCount + 1}`, error);
      if (job.retryCount < PORTAL_LIST_RETRY_LIMIT) throw error;
      await recordPortalListFailure(deps.runtime, orgId, listId, 'Không đọc được danh sách sau nhiều lần thử; hãy nhập lại tệp');
    }
  });

  // Fiscal year archive packages (#922). A build that keeps failing is logged after its last attempt, as for the org
  // export; the owner sees the request as still in progress until it is recorded, and may ask again an hour later.
  if (finance) await background.add(QUEUES.yearArchive, () => boss.work<YearArchiveJob>(QUEUES.yearArchive, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const { orgId, year, requestCommandId } = job.data;
    try {
      const done = await runYearArchive({ runtime: deps.runtime, store: deps.store, ...(deps.brand ? { brand: deps.brand } : {}) }, orgId, year, { requestCommandId });
      console.log(`[year-archive] org ${orgId} year ${year}: ${done.recorded ? 'built' : 'already built'}`);
    } catch (error) {
      if (job.retryCount < YEAR_ARCHIVE_RETRY_LIMIT) throw error;
      opsAlert(`[year-archive] ALERT archive of org ${orgId} year ${year} failed after ${job.retryCount + 1} attempts`, error);
    }
  }));

  // The raw message is deleted once it is filed or dropped; after the last failed attempt it is kept for
  // investigation (each delivery owns its blob, so no other job can still need it), and the daily retention job
  // deletes it INBOUND_BLOB_MAX_AGE_DAYS later (issue #212).
  await boss.work<InboundJob>(QUEUES.inbound, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const label = job.data.sha256.slice(0, 12);
    try {
      const result = await processInboundEmail(
        { runtime: deps.runtime, store: deps.store, domain: deps.inboundDomain, extract: deps.extract, limits: deps.usageLimits },
        job.data,
        job.retryCount,
      );
      // Over its org's daily limit (#675): queued again for when the org is back under it, with its blob kept.
      if ('deferred' in result) {
        await boss.send(QUEUES.inbound, job.data, { singletonKey: systemJobKey(QUEUES.inbound, job.data.blobId), startAfter: new Date(result.deferred), retryLimit: INBOUND_RETRY_LIMIT, retryDelay: 20, retryBackoff: true });
        console.log(`[inbound] message ${label}: over the org's daily limit, deferred to ${result.deferred}`);
        return;
      }
      console.log(`[inbound] message ${label}: ${'bounce' in result ? `bounce report, ${result.bounce}` : result.duplicate ? 'duplicate' : `${result.fileIds.length} file(s)`}`);
    } catch (error) {
      // A message no org can receive (unknown or closed recipient, invalid content) is dropped, not retried.
      if (!(error instanceof DomainError && error.status !== 409 && error.status < 500)) {
        console.error(`[inbound] message ${label} attempt ${job.retryCount + 1}`, error);
        throw error;
      }
      console.warn(`[inbound] message ${label} dropped: ${error.code}`);
    }
    await deps.store.delete(inboundKey(job.data.blobId));
  });

  // A delivery event (#539): recorded in its mail's org, or dropped when no mail of Crove has the provider's id.
  await boss.work<MailEventJob>(QUEUES.mailEvent, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const label = `${job.data.provider}:${job.data.providerEventId.slice(0, 16)}`;
    try {
      const result = await processMailEvent({ runtime: deps.runtime, workerDb: deps.workerDb }, job.data);
      if ('dropped' in result) console.warn(`[mail-event] ${label} dropped: ${result.dropped}`);
    } catch (error) {
      console.error(`[mail-event] ${label} attempt ${job.retryCount + 1}`, error);
      throw error;
    }
  });

  // Queued mail (#548): a sweep queues what is due; system and transactional mail go out at once, marketing one at a
  // time with a gap. Without a mailer (tests, an embedder) queued mail stays queued.
  const mail = deps.mail;
  if (mail) {
    const mailDeps: MailQueueDeps = { runtime: deps.runtime, ...mail, publicUrl: deps.publicUrl ?? '', workerDb: deps.workerDb };
    const sendMail = async (job: { data: MailJob; retryCount: number } | undefined, gap: number) => {
      if (!job) return;
      const label = job.data.messageId.slice(0, 8);
      try {
        const done = await runMailJob(mailDeps, job.data);
        if (done.action === 'recorded') console.log(`[mail] ${label}: ${done.outcome}${done.code ? ` ${done.code}` : ''}`);
        else if (done.action === 'suppressed') console.log(`[mail] ${label}: suppressed`);
      } catch (error) {
        console.error(`[mail] ${label} attempt ${job.retryCount + 1}: ${mailErrorCode(error)}`);
        throw error;
      } finally {
        if (gap > 0) await new Promise<void>((resolve) => setTimeout(resolve, gap));
      }
    };
    await boss.work<MailJob>(MAIL_SEND_QUEUE, { batchSize: 1 }, async ([job]) => sendMail(job, 0));
    await background.add(MAIL_BULK_QUEUE, () => boss.work<MailJob>(MAIL_BULK_QUEUE, { batchSize: 1 }, async ([job]) => sendMail(job, MAIL_BULK_GAP_MS)));
  }
  let mailSweeping = false;
  const mailSweep = async () => {
    if (mailSweeping || !mail) return;
    mailSweeping = true;
    try {
      await sweepMail(boss, deps.workerDb, deps.runtime, mail.mailer);
    } catch (error) {
      console.error(`[mail] sweep: ${mailErrorCode(error)}`);
    } finally {
      mailSweeping = false;
    }
  };
  const mailTimer = mail ? setInterval(() => void mailSweep(), MAIL_SWEEP_MS) : null;
  void mailSweep();

  await boss.work<SignOutJob>(QUEUES.signOut, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const { sessionId, scope } = job.data;
    const label = `${scope} sign-out of session ${sessionId.slice(0, 8)}`;
    // A job the previous release's relay made from an event of this one has the subject `undefined` and no user: its
    // session cannot be signed out upstream.
    if (job.data.subject === 'undefined') {
      opsAlert(`[signout] ALERT ${label}: the job names no account (made by the previous release from a newer event); revoked in Crove only`);
      return;
    }
    let subject: string | null;
    try {
      subject = job.data.subject ?? (job.data.userId ? await authSubject(deps.workerDb, job.data.userId) : null);
    } catch (error) {
      if (job.retryCount < SIGN_OUT_RETRY_LIMIT) throw error;
      opsAlert(`[signout] ALERT ${label}: the account's subject could not be read after ${job.retryCount + 1} attempts; revoked in Crove only`, error);
      return;
    }
    if (!subject) {
      console.warn(`[signout] ${label}: the account has no identity provider subject; revoked in Crove only`);
      return;
    }
    await runSignOut(deps.revoker, { subject, sessionId, scope }, job.retryCount);
  });

  // Org export after kernel.org.offboard (issue #38). After the last failed attempt the owner can ask again (the same
  // command while the org is offboarding).
  await boss.work<OrgExportJob>(QUEUES.orgExport, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const { orgId } = job.data;
    try {
      const record = await runOrgExport(
        { runtime: deps.runtime, store: deps.store, sealer: exportSealer, retentionDays: exportRetentionDays },
        orgId,
      );
      console.log(`[org-export] org ${orgId}: ${record.parts.length} part(s), ${record.fileCount} file(s), ${record.encryption}, expires ${record.expiresAt}`);
    } catch (error) {
      if (job.retryCount < ORG_EXPORT_RETRY_LIMIT) throw error;
      opsAlert(`[org-export] ALERT export of org ${orgId} failed after ${job.retryCount + 1} attempts`, error);
    }
  });

  // Retention purges (plan §4.9), on a schedule registered idempotently at boot; pg_cron is not required. The same run
  // deletes abandoned staging objects of presigned uploads (issue #223), leftover raw inbound mail and expired org
  // exports (issue #212).
  const keepDays = deps.refusalTallyRetentionDays ?? DEFAULT_REFUSAL_TALLY_RETENTION_DAYS;
  await background.add(QUEUES.retention, () => boss.work(QUEUES.retention, { batchSize: 1 }, async () => {
    try {
      await runRetention(deps.workerDb);
      const mailCleared = await purgeMail(deps.workerDb);
      console.log(`[retention] ${Object.entries(mailCleared).map(([store, n]) => `${store}=${n}`).join(' ')}`);
      const pruned = await pruneRefusalTally(deps.workerDb, keepDays);
      const securityEvents = await pruneSecurityEvents(deps.workerDb);
      // Dismissed and old dead-letter Inbox items (#1747), each org in its own system context.
      const inboxItems = await pruneInboxItems({ runtime: deps.runtime, workerDb: deps.workerDb });
      console.log(`[retention] refusal_tally=${pruned} security_event=${securityEvents} inbox_item=${inboxItems}`);
    } finally {
      // Each catches its own errors; they run even when a database purge failed.
      await sweepStaging(deps.store);
      await sweepInboundBlobs(deps.store, deps.workerDb);
      await expireExports(deps.store, deps.runtime, exportRetentionDays);
      // Outbox events past their keep period (#997): archived to the WORM store, then deleted. Needs the archive.
      if (deps.archive) {
        try {
          const outbox = await archiveOutbox(deps.workerDb, deps.archive.store);
          console.log(`[retention] outbox archived=${outbox.archived} purged=${outbox.purged}${outbox.deferred ? ` deferred=${outbox.deferred}` : ''}`);
        } catch (error) {
          // The error (a database or bucket message may quote values) stays in the log; the post says where to look.
          opsAlert('[retention] ALERT outbox archive failed; the error is in the worker log', error);
        }
      }
    }
  }));
  await boss.schedule(QUEUES.retention, RETENTION_CRON, null, { tz: RETENTION_TZ, missed: 'once' });

  // The WORM fact stream (plan §4.10, #891): batches every minute, the verifier nightly. A failure fails the job: a
  // batch write after its retries, a verifier mismatch at once (retryLimit 0). pg-boss keeps the failed job and the
  // prober alerts on the dead letter (docs/runbooks/worm-archive.md).
  if (deps.archive) {
    const { store, lagSeconds } = deps.archive;
    await background.add(QUEUES.archiveWrite, () => boss.work(QUEUES.archiveWrite, { batchSize: 1 }, async () => {
      const written = await writeArchive(deps.workerDb, store, { lagSeconds });
      if (written > 0) console.log(`[archive] wrote ${written} batch(es)`);
    }));
    await boss.schedule(QUEUES.archiveWrite, ARCHIVE_WRITE_CRON, null, { tz: RETENTION_TZ });
    await background.add(QUEUES.archiveVerify, () => boss.work(QUEUES.archiveVerify, { batchSize: 1 }, async () => {
      // The verifier reads every batch and row, so its time grows with the archive: logged on every run.
      const started = Date.now();
      const elapsed = () => `${Math.round((Date.now() - started) / 1000)} s`;
      const alertOptions = deps.archive?.restoreAlertDays === undefined ? {} : { restoreAlertDays: deps.archive.restoreAlertDays };
      try {
        // First, from the store alone, before any database query: a run the database owner stops has alerted already.
        const early = await restoreAckStoreAlert(store, alertOptions);
        if (early) opsAlert(`[archive] ALERT ${early}`);
        const result = await verifyArchive(deps.workerDb, store, alertOptions);
        // An excuse is never silent (#2020): every run says what a restore acknowledgement excused, and a recent one, by
        // the store's own write time, alerts on every run, passing or failing, so an operator matches it to a real
        // restore and a webhook down for a night loses nothing.
        const alert = restoreAckAlert(result);
        if (alert) opsAlert(`[archive] ALERT ${alert}`);
        if (!result.ok) throw new ArchiveMismatchError(result);
        // The out-of-band heartbeat (#2082): a marker in the archive store, which the prober reads without the database.
        try {
          await writeVerifyMarker(store, result);
        } catch (error) {
          opsAlert(`[archive] ALERT the verification passed, but its marker could not be written to the archive store: the prober will report it stale`, error);
        }
        const excused = result.restoreAck === null ? '' : `, excused ${result.excused} row(s) under restore acknowledgement #${result.restoreAck}`;
        console.log(`[archive] verified ${result.batches} batch(es), ${result.rows} row(s)${excused} in ${elapsed()}`);
      } catch (error) {
        console.error(`[archive] ALERT after ${elapsed()}: ${error instanceof Error ? error.message : 'verification could not run'}`);
        throw error;
      }
    }));
    // An hour before pg-boss counts the run as expired (its default is 15 minutes).
    await boss.schedule(QUEUES.archiveVerify, ARCHIVE_VERIFY_CRON, null, { tz: RETENTION_TZ, missed: 'once', retryLimit: 0, expireInSeconds: 3600 });
  }

  // The period balance reconciliation (#1284): nightly, the deltas the posting definer appended compared with the
  // journal lines. A difference fails the job at once (retryLimit 0); pg-boss keeps the failed job and the prober
  // alerts on the dead letter (docs/runbooks/incidents.md). A finance job: worked only with the module (#1471).
  if (finance) {
    await background.add(QUEUES.periodBalanceVerify, () => boss.work(QUEUES.periodBalanceVerify, { batchSize: 1 }, async () => {
      const started = Date.now();
      const elapsed = () => `${Math.round((Date.now() - started) / 1000)} s`;
      try {
        await runPeriodBalanceReconciliation(deps.workerDb);
        console.log(`[period-balance] deltas match the journal lines (${elapsed()})`);
      } catch (error) {
        console.error(`[period-balance] ALERT after ${elapsed()}: ${error instanceof Error ? error.message : 'reconciliation could not run'}`);
        throw error;
      }
    }));
    await boss.schedule(QUEUES.periodBalanceVerify, PERIOD_BALANCE_VERIFY_CRON, null, { tz: RETENTION_TZ, missed: 'once', retryLimit: 0, expireInSeconds: 3600 });
  } else {
    await dropCron(QUEUES.periodBalanceVerify);
  }

  // Inbox triage: tasks for the agents whose template subscribes to the event. The command reads the event from the
  // outbox; the job carries only its id.
  await background.add(QUEUES.agentDispatch, () => boss.work<AgentDispatchJob>(QUEUES.agentDispatch, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    await deps.runtime.execute('kernel.agent.dispatch_event', { eventId: job.data.eventId }, { actor: { type: 'system', component: 'kernel.agent' }, orgId: job.data.orgId });
  }));

  // Link preview cards (#641): fetch a requested link's page through the egress guard and read its head in crove-extract.
  if (social) {
    await boss.work<LinkPreviewJob>(QUEUES.socialLinkPreview, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      const done = await runLinkPreviewJob({ runtime: deps.runtime, extract: deps.extract }, job.data.orgId, job.data.previewId);
      if (done !== 'none') console.log(`[social-link-preview] ${job.data.previewId.slice(0, 8)}: ${done}`);
    });
  }

  // Bookings of the public booking page (#1318): one job per request, run as the system; the page polls its status.
  if (crm) {
    await boss.work<BookingJob>(QUEUES.crmBooking, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      const actor = { type: 'system' as const, component: 'crm.booking' };
      if ('memberEventId' in job.data) {
        await deps.runtime.execute('crm.booking_feed.revoke_for_member', { eventId: job.data.memberEventId }, { actor, orgId: job.data.orgId });
      } else if (job.data.requestId) {
        await deps.runtime.execute('crm.booking.manage', { bookingId: job.data.bookingId, requestId: job.data.requestId }, { actor, orgId: job.data.orgId });
      } else {
        await deps.runtime.execute('crm.booking.confirm', { bookingId: job.data.bookingId }, { actor, orgId: job.data.orgId });
      }
    });
    // Reminders (#1319): a job per booking, time and lead, run when it is due; the command mails only while the booking
    // is confirmed and still starts then.
    await boss.work<BookingRemindJob>(QUEUES.crmBookingRemind, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      const { orgId, ...input } = job.data;
      await deps.runtime.execute('crm.booking.remind', input, { actor: { type: 'system', component: 'crm.booking' }, orgId });
    });
  }

  // Notes (#1671): a former member's private notes 30 days after they left, the daily trash and the to-do reminders
  // (notes-worker.ts).
  if (notes) {
    await boss.work<NotesMemberPurgeJob>(QUEUES.notesMemberPurge, { batchSize: 1 }, async ([job]) => {
      if (job) await runNotesMemberPurge(deps.runtime, job.data);
    });
    await boss.work(QUEUES.notesTrash, { batchSize: 1 }, async () => {
      console.log(`[notes-trash] removed ${await sweepNotesTrash({ runtime: deps.runtime, workerDb: deps.workerDb })}`);
      // Then the former members whose removal queued no purge (#1733).
      const purged = await sweepNotesFormerMembers({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (purged > 0) console.log(`[notes-member-purge] swept ${purged}`);
    });
    await boss.schedule(QUEUES.notesTrash, NOTES_TRASH_CRON, null, { tz: NOTES_TRASH_TZ, missed: 'once' });
    // To-do reminders (#1675): every 5 minutes; a missed tick needs no catching up, the next one claims what is due.
    await boss.work(QUEUES.notesRemind, { batchSize: 1 }, async () => {
      const sent = await sweepNotesReminders({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (sent > 0) console.log(`[notes-remind] sent ${sent}`);
    });
    await boss.schedule(QUEUES.notesRemind, NOTES_REMIND_CRON, null, { tz: NOTES_TRASH_TZ });
  } else {
    // The member purges stay queued (they carry whose notes to purge) for when notes is installed again.
    await dropCron(QUEUES.notesTrash);
    await dropCron(QUEUES.notesRemind);
  }

  // Bank feeds (ADR-0039, #2044): a connection's sync, queued by the relay above and, once a day, for every active
  // bank feed connection of an active org. The adapters are the deployment's; with none on, the sweep queues nothing.
  const bankFeeds = deps.channels?.bankFeeds;
  const bankFeedBroker = deps.channels?.broker;
  if (finance && bankFeeds && bankFeedBroker && Object.keys(bankFeeds).length > 0) {
    await boss.work<BankFeedSyncJob | { sweep: true }>(QUEUES.bankFeedSync, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      if ('sweep' in job.data) {
        // Every active bank feed, a page of connections at a time by key.
        let after: { orgId: string; connectionId: string } | null = null;
        for (;;) {
          const page = await bankFeedsDue(deps.workerDb, after);
          for (const row of page.filter((r) => Object.hasOwn(bankFeeds, r.provider))) {
            await boss.send(QUEUES.bankFeedSync, { orgId: row.orgId, connectionId: row.connectionId } satisfies BankFeedSyncJob, {
              singletonKey: jobKey(row.orgId, QUEUES.bankFeedSync, row.connectionId),
              retryLimit: BANK_FEED_SYNC_RETRY_LIMIT,
              retryDelay: 30,
              retryBackoff: true,
            });
          }
          const last = page.at(-1);
          if (!last || page.length < BANK_FEEDS_DUE_PAGE) break;
          after = { orgId: last.orgId, connectionId: last.connectionId };
        }
        return;
      }
      const done = await runBankFeedSync({ runtime: deps.runtime, broker: bankFeedBroker, providers: bankFeeds }, job.data);
      console.log(`[bank-feed] ${job.data.connectionId}: ${done.accounts} account(s), ${done.pages} page(s), ${done.stored} line(s) stored`);
    });
    await boss.schedule(QUEUES.bankFeedSync, BANK_FEED_SYNC_CRON, { sweep: true }, { tz: RETENTION_TZ, missed: 'once' });
  } else {
    await dropCron(QUEUES.bankFeedSync);
  }

  // In-app notifications of the kernel and finance (#671): the module's dispatch reads the event from the outbox.
  await boss.work<AgentDispatchJob & { type: string }>(QUEUES.notify, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const notify = NOTIFY_COMMANDS.get(job.data.type);
    if (!notify || !deps.runtime.installed(notify.module)) return;
    await deps.runtime.execute(notify.command, { eventId: job.data.eventId }, { actor: { type: 'system', component: 'kernel.notify' }, orgId: job.data.orgId });
  });

  // Dead letters (#1720): a job that failed its last retry raises an Inbox item in its org (dead-letter.ts).
  await boss.work(QUEUES.deadLetter, DEAD_LETTER_WORK, async ([job]) => {
    if (job) await takeDeadLetter(deps.runtime, job);
  });

  // In-app notifications (#637): the command reads the event from the outbox and writes one row per person; the job
  // carries only its id.
  if (social) {
    await boss.work<AgentDispatchJob & { type?: string }>(QUEUES.socialNotify, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      // A client's answer on a review link may settle variants waiting for it (#770), before the team is told.
      // A member who lost the right to make links (#625): their review and report links stop working.
      if (job.data.type === 'kernel.member.removed' || job.data.type === 'kernel.member.role_changed') {
        await deps.runtime.execute('social.links.revoke_for_member', { eventId: job.data.eventId }, { actor: { type: 'system', component: 'social.links' }, orgId: job.data.orgId });
        return;
      }
      if (job.data.type === 'social.review.answered') {
        await deps.runtime.execute('social.review.client_settle', { eventId: job.data.eventId }, { actor: { type: 'system', component: 'social.review' }, orgId: job.data.orgId });
      }
      const done = await deps.runtime.execute<{ push?: string[] }>('social.notification.dispatch', { eventId: job.data.eventId }, { actor: { type: 'system', component: 'social.notify' }, orgId: job.data.orgId });
      // Browser push (#1238): one job per new notification of a pushed kind, after the dispatch committed. A replayed
      // event wrote none, so nobody is pushed twice; a job lost here leaves the notification and its mail.
      if (deps.push) {
        for (const notificationId of done.push ?? []) {
          await boss
            .send(QUEUES.socialPush, { orgId: job.data.orgId, notificationId } satisfies PushJob, { singletonKey: jobKey(job.data.orgId, QUEUES.socialPush, notificationId), retryLimit: 0, expireInSeconds: PUSH_JOB_EXPIRE_SECONDS })
            .catch((error: unknown) => console.warn(`[social-push] ${notificationId.slice(0, 8)} not queued`, error instanceof Error ? error.name : 'error'));
        }
      }
    });
  }

  // Browser push (#1238): read what to send, post it to each of the member's devices, record the answers.
  const push = deps.push;
  if (social && push) {
    await boss.work<PushJob>(QUEUES.socialPush, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      const done = await runPushJob({ runtime: deps.runtime, sender: push.sender, brand: push.brand }, job.data);
      if (done.sent + done.gone + done.failed > 0) console.log(`[social-push] ${job.data.notificationId.slice(0, 8)}: sent ${done.sent}, gone ${done.gone}, failed ${done.failed}`);
    });
  }

  // Team chat alerts (#863): one short line in the org's Telegram or Discord chat, sent apart from the notices and
  // their mail; the sender logs a failure and never throws, so the job is never retried.
  const chatAlerts = social && deps.channels ? new ChatAlertSender({ runtime: deps.runtime, broker: deps.channels.broker, publicUrl: deps.publicUrl ?? '', ...(deps.brand ? { brand: deps.brand } : {}) }) : null;
  if (chatAlerts) {
    await boss.work<AgentDispatchJob & { test?: true }>(QUEUES.socialChatAlert, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      if (job.data.test) await chatAlerts.test(job.data.orgId, job.data.eventId);
      else await chatAlerts.handle(job.data.orgId, job.data.eventId);
    });
  }

  // Agent proposals and approvals: the worker acts on what an agent recorded, after checking it again.
  await background.add(QUEUES.agentProposal, () => boss.work<AgentDispatchJob & { type: string }>(QUEUES.agentProposal, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const command = Object.hasOwn(AGENT_PROPOSAL_COMMANDS, job.data.type) ? AGENT_PROPOSAL_COMMANDS[job.data.type] : undefined;
    if (!command) return;
    await deps.runtime.execute(command, { eventId: job.data.eventId }, { actor: { type: 'system', component: 'kernel.agent' }, orgId: job.data.orgId });
  }));

  const agentPrograms = deps.agentPrograms ?? {};
  await background.add(QUEUES.agentWake, () => boss.work<AgentWakeJob>(QUEUES.agentWake, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const result = await runAgentWake({ runtime: deps.runtime, programs: agentPrograms }, job.data.orgId, job.data.agentId);
    const label = `agent ${job.data.agentId.slice(0, 8)}`;
    if (result.runId === null) console.log(`[agent] ${label}: no run (${result.reason})`);
    else console.log(`[agent] ${label}: run ${result.runId.slice(0, 8)} ${result.outcome ?? ''}`);
  }));

  await background.add(QUEUES.agentSweep, () => boss.work(QUEUES.agentSweep, { batchSize: 1 }, async () => {
    const { rows } = await sql<{ org_id: string; agent_id: string }>`SELECT * FROM crove_kernel.agent_wakeups_due(${AGENT_SWEEP_LIMIT}::int, ${deps.runtime.modules()}::text[])`.execute(deps.workerDb);
    await Promise.all(rows.map((row) => sendAgentWake(boss, row.org_id, row.agent_id)));
    if (rows.length > 0) console.log(`[agent] sweep woke ${rows.length} agent(s) with pending wake-ups`);
  }));
  await boss.schedule(QUEUES.agentSweep, AGENT_SWEEP_CRON, null, { tz: RETENTION_TZ });

  // Social publishing (Social plan §3.4): a sweep finds due, stale and pending variants and queues one job each; the
  // job runs begin, the provider call and record. A crash anywhere is caught by a later sweep.
  const channels = deps.channels;
  const publishers = deps.runtime.installed('social') && channels ? channels.publishers : {};
  const publishing = new Set(Object.keys(publishers));
  for (const provider of publishing) {
    await boss.work<SocialPublishJob>(socialPublishQueue(provider), { batchSize: 1 }, async ([job]) => {
      if (!job || !channels) return;
      const { orgId, variantId } = job.data;
      if (job.data.thread) {
        const done = await runThreadJob({ runtime: deps.runtime, broker: channels.broker, publishers, store: deps.store }, orgId, variantId, provider, { after: job.data.after ?? null });
        console.log(`[social-thread] ${provider} variant ${variantId.slice(0, 8)}: ${done.action} -> ${done.state ?? done.reason} (${done.parts} parts)`);
        return;
      }
      if (job.data.comment) {
        const done = await runCommentJob({ runtime: deps.runtime, broker: channels.broker, publishers, store: deps.store }, orgId, variantId, provider, { after: job.data.after ?? null });
        console.log(`[social-comment] ${provider} variant ${variantId.slice(0, 8)}: ${done.action} -> ${done.state ?? done.reason}`);
        return;
      }
      const outcome = await runPublishJob({ runtime: deps.runtime, broker: channels.broker, publishers, store: deps.store, ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}) }, orgId, variantId, provider);
      if (outcome.action !== 'none') console.log(`[social-publish] ${provider} variant ${variantId.slice(0, 8)}: ${outcome.action} -> ${outcome.status}`);
    });
  }
  // Removals (#860): one job per ask, on its own queue so a removal never waits behind a channel's publishing.
  if (publishing.size > 0) {
    await boss.work<SocialRemoveJob>(QUEUES.socialRemove, { batchSize: 1 }, async ([job]) => {
      if (!job || !channels) return;
      const { orgId, variantId, provider, after } = job.data;
      if (job.data.watch) {
        const watched = await runRemoveWatch({ runtime: deps.runtime }, orgId, variantId, after);
        console.log(`[social-remove] watch of variant ${variantId.slice(0, 8)}: ${watched.told ? `told ${watched.code}` : watched.reason}`);
        // Too early (the job started late, or clocks differ): pg-boss runs the watch again after its retry delay.
        if (!watched.told && watched.reason === 'not_stale') throw new Error('REMOVE_WATCH_TOO_EARLY');
        return;
      }
      const done = await runRemoveJob({ runtime: deps.runtime, broker: channels.broker, publishers, store: deps.store }, orgId, variantId, provider, after);
      console.log(`[social-remove] ${provider.slice(0, 32)} variant ${variantId.slice(0, 8)}: ${done.action} -> ${done.state ?? done.reason}`);
    });
    // Corrections of published text (#1223): one job per ask, on its own queue like removals.
    await boss.work<SocialEditJob>(QUEUES.socialEdit, { batchSize: 1 }, async ([job]) => {
      if (!job || !channels) return;
      const { orgId, variantId, provider, after } = job.data;
      const done = await runEditJob({ runtime: deps.runtime, broker: channels.broker, publishers, store: deps.store, ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}) }, orgId, variantId, provider, after);
      console.log(`[social-edit] ${provider.slice(0, 32)} variant ${variantId.slice(0, 8)}: ${done.action} -> ${done.state ?? done.reason}`);
    });
    // A channel's options for the composer (#1120): the token is opened here and goes to the adapter only. A few lists
    // are read at once (#1131), so one slow platform or site, within the list's deadline, does not hold every other
    // org's pickers behind it.
    await boss.work<ChannelOptionJob>(QUEUES.socialChannelOption, { batchSize: 1, localConcurrency: CHANNEL_OPTION_WORKERS }, async ([job]) => {
      if (!job || !channels) return;
      const done = await runChannelOptionJob({ runtime: deps.runtime, broker: channels.broker, publishers }, job.data.orgId, job.data.optionId);
      if (done !== 'none') console.log(`[social-channel-option] ${job.data.optionId.slice(0, 8)}: ${done}`);
    });
  }
  let sweeping = false;
  const socialSweep = async () => {
    if (sweeping || publishing.size === 0) return;
    sweeping = true;
    try {
      await sweepSocialPublishing(boss, deps.workerDb, publishing);
    } catch (error) {
      console.error('[social-publish] sweep', error);
    } finally {
      sweeping = false;
    }
  };
  const socialTimer = publishing.size > 0 ? setInterval(() => void socialSweep(), SOCIAL_SWEEP_MS) : null;
  void socialSweep();

  // Planned takedowns (#861): every minute, the published posts whose removal time has come are asked to come down, on
  // the providers this deployment publishes to and whose adapter removes; the remove job above does the rest.
  const removing = new Set([...publishing].filter((p) => isProvider(p) && REMOVE_READY.has(p) && Boolean(publishers[p]?.remove)));
  let sweepingRemovals = false;
  const removeSweep = async () => {
    if (sweepingRemovals || removing.size === 0) return;
    sweepingRemovals = true;
    try {
      const queued = await sweepRemovals({ runtime: deps.runtime, workerDb: deps.workerDb }, removing);
      if (queued > 0) console.log(`[social-remove] sweep asked ${queued} planned removal(s)`);
    } catch (error) {
      console.error(`[social-remove] sweep: ${error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error'}`);
    } finally {
      sweepingRemovals = false;
    }
  };
  const removeTimer = removing.size > 0 ? setInterval(() => void removeSweep(), REMOVE_SWEEP_MS) : null;
  if (removeTimer) void removeSweep();

  // Evergreen posts (S9): every hour, a repost of each one that is due, sent to review.
  let reposting = false;
  const evergreenSweep = async () => {
    if (reposting || !deps.runtime.installed('social')) return;
    reposting = true;
    try {
      const made = await sweepEvergreen({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (made > 0) console.log(`[social-evergreen] reposted ${made}`);
    } catch (error) {
      console.error('[social-evergreen] sweep', error);
    } finally {
      reposting = false;
    }
  };
  const evergreenTimer = deps.runtime.installed('social') ? setInterval(() => void evergreenSweep(), EVERGREEN_SWEEP_MS) : null;
  void evergreenSweep();

  // Recurring posts (#979): every hour, the next copy of each series that is due, planned for its occurrence and sent
  // to review. The log names counts only; a failing post is logged by id and code in sweepRecurring.
  let recurring = false;
  const recurringSweep = async () => {
    if (recurring || !deps.runtime.installed('social')) return;
    recurring = true;
    try {
      const made = await sweepRecurring({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (made > 0) console.log(`[social-recurring] made ${made}`);
    } catch (error) {
      console.error('[social-recurring] sweep', error instanceof Error ? error.name : 'error');
    } finally {
      recurring = false;
    }
  };
  const recurringTimer = deps.runtime.installed('social') ? setInterval(() => void recurringSweep(), RECURRING_SWEEP_MS) : null;
  void recurringSweep();

  // Review reminders (#703): every 15 minutes, the posts whose review has waited a day or whose time is close; then the
  // due date reminders of assigned posts (#1359), due within a day or overdue.
  let reminding = false;
  const reminderSweep = async () => {
    if (reminding) return;
    reminding = true;
    try {
      const sent = await sweepReminders({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (sent > 0) console.log(`[social-reminders] reminded ${sent}`);
    } catch (error) {
      console.error('[social-reminders] sweep', error);
    }
    try {
      const sent = await sweepAssignmentReminders({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (sent > 0) console.log(`[social-assign-reminders] reminded ${sent} assignee(s)`);
    } catch (error) {
      console.error('[social-assign-reminders] sweep', error instanceof Error ? error.name : 'error');
    } finally {
      reminding = false;
    }
  };
  const reminderTimer = deps.runtime.installed('social') ? setInterval(() => void reminderSweep(), REMINDER_SWEEP_MS) : null;
  if (reminderTimer) void reminderSweep();

  // Queues running low (#1079): every hour, each queue with the warning on is measured, and its team told once per dip.
  let measuringQueues = false;
  const queueLowSweep = async () => {
    if (measuringQueues) return;
    measuringQueues = true;
    try {
      const alerted = await sweepQueueLow({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (alerted > 0) console.log(`[social-queue-low] told ${alerted} team(s) of a low queue`);
    } catch (error) {
      console.error('[social-queue-low] sweep', error instanceof Error ? error.name : 'error');
    } finally {
      measuringQueues = false;
    }
  };
  const queueLowTimer = deps.runtime.installed('social') ? setInterval(() => void queueLowSweep(), QUEUE_LOW_SWEEP_MS) : null;
  if (queueLowTimer) void queueLowSweep();

  // The weekly digest (#1104): every hour, the orgs past Monday 08:00 in their zone that have not had this week's;
  // each is claimed once per ISO week in its own transaction. The log names counts only.
  let digesting = false;
  const digestSweep = async () => {
    if (digesting) return;
    digesting = true;
    try {
      const sent = await sweepDigests({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (sent > 0) console.log(`[social-digest] sent the weekly digest of ${sent} org(s)`);
    } catch (error) {
      console.error('[social-digest] sweep', error instanceof Error ? error.name : 'error');
    } finally {
      digesting = false;
    }
  };
  const digestTimer = deps.runtime.installed('social') ? setInterval(() => void digestSweep(), DIGEST_SWEEP_MS) : null;
  if (digestTimer) void digestSweep();

  // Proposal reminders and escalation (#676): every half hour, the pending proposals past the days their org set.
  let nudging = false;
  const proposalNudgeSweep = async () => {
    if (nudging) return;
    nudging = true;
    try {
      const done = await sweepProposalNudges({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (done > 0) console.log(`[proposal-reminders] expired or nudged ${done}`);
    } catch (error) {
      console.error('[proposal-reminders] sweep', error);
    } finally {
      nudging = false;
    }
  };
  const proposalNudgeTimer = setInterval(() => void proposalNudgeSweep(), PROPOSAL_NUDGE_SWEEP_MS);
  void proposalNudgeSweep();

  // Detective security alerts (#996, plan §7.8): every 5 minutes, the signals worth an alert are logged and posted.
  let watching = false;
  const securitySweep = async () => {
    if (watching) return;
    watching = true;
    try {
      await sweepSecuritySignals({ workerDb: deps.workerDb, target: deps.securityAlerts?.target ?? null, thresholds: deps.securityAlerts?.thresholds });
    } catch (error) {
      console.error('[security] sweep', error);
    } finally {
      watching = false;
    }
  };
  const securityTimer = setInterval(() => void securitySweep(), SECURITY_SWEEP_MS);
  void securitySweep();

  // Missing-invoice reminders (#669): every 15 minutes, the orgs whose monthly reminder is due.
  let remindingInvoices = false;
  const missingInvoiceSweep = async () => {
    if (remindingInvoices) return;
    remindingInvoices = true;
    try {
      const sent = await sweepMissingInvoiceReminders({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (sent > 0) console.log(`[missing-invoices] reminded ${sent} org(s)`);
    } catch (error) {
      console.error('[missing-invoices] sweep', error);
    } finally {
      remindingInvoices = false;
    }
  };
  const missingInvoiceTimer = finance ? setInterval(() => void missingInvoiceSweep(), MISSING_INVOICE_SWEEP_MS) : null;
  if (missingInvoiceTimer) void missingInvoiceSweep();
  // Periods closing (#671): every hour, owners and admins of an org whose VAT return is due within days and whose
  // period is not locked yet are told, once per period.
  let closing = false;
  const closingSweep = async () => {
    if (closing) return;
    closing = true;
    try {
      const sent = await sweepPeriodClosing({ runtime: deps.runtime, workerDb: deps.workerDb, today: vietnamToday(new Date()) });
      if (sent > 0) console.log(`[period-closing] told ${sent}`);
    } catch (error) {
      console.error('[period-closing] sweep', error);
    } finally {
      closing = false;
    }
  };
  const closingTimer = deps.runtime.installed('finance') ? setInterval(() => void closingSweep(), PERIOD_CLOSING_SWEEP_MS) : null;
  if (closingTimer) void closingSweep();

  // Scheduled client report mail (#704): every 5 minutes, the schedules due queue their mails (sent by the mail queue).
  let reporting = false;
  const reportSweep = async () => {
    if (reporting) return;
    reporting = true;
    try {
      const ran = await sweepReportSchedules({ runtime: deps.runtime, workerDb: deps.workerDb });
      if (ran > 0) console.log(`[social-report-schedule] ran ${ran}`);
    } catch (error) {
      console.error(`[social-report-schedule] sweep: ${mailErrorCode(error)}`);
    } finally {
      reporting = false;
    }
  };
  const reportTimer = deps.runtime.installed('social') ? setInterval(() => void reportSweep(), REPORT_SCHEDULE_SWEEP_MS) : null;
  if (reportTimer) void reportSweep();

  // Blog feeds (#708): every quarter hour, the feeds due for their hourly read; new items become drafts.
  let readingFeeds = false;
  const feedSweep = async () => {
    if (readingFeeds) return;
    readingFeeds = true;
    try {
      const drafted = await sweepFeeds({ runtime: deps.runtime, workerDb: deps.workerDb, extract: deps.extract });
      if (drafted > 0) console.log(`[social-feeds] drafted ${drafted}`);
    } catch (error) {
      console.error('[social-feeds] sweep', error);
    } finally {
      readingFeeds = false;
    }
  };
  const feedTimer = deps.runtime.installed('social') ? setInterval(() => void feedSweep(), FEED_SWEEP_MS) : null;
  if (feedTimer) void feedSweep();

  // After a credential key rotation (#776), envelopes still sealed with the previous key are sealed again with the
  // current one, a batch at a time, until none is left; the log says how many remain.
  let resealing = false;
  const resealSweep = async () => {
    if (resealing || !channels) return;
    resealing = true;
    try {
      const done = await resealCredentials({ runtime: deps.runtime, broker: channels.broker, workerDb: deps.workerDb });
      if (done.resealed + done.failed + done.leftActive + done.leftInactive + done.leftWaiting > 0) {
        console.log(
          `[credential-reseal] resealed ${done.resealed}, failed ${done.failed}; left under an older key: ${done.leftActive} active, ${done.leftInactive} to reconnect` +
            (done.leftWaiting > 0 ? `, ${done.leftWaiting} team chat alerts waiting for the Social module (keep CREDENTIAL_KEY_PREVIOUS)` : ''),
        );
      }
      // Key ids and counts only (#1888): never a token or an envelope.
      for (const { level, line } of unopenableKeysLog(done.unopenable)) (level === 'error' ? console.error : console.warn)(line);
    } catch (error) {
      console.error('[credential-reseal] sweep', error instanceof Error ? error.name : typeof error);
    } finally {
      resealing = false;
    }
  };
  const resealTimer = channels ? setInterval(() => void resealSweep(), RESEAL_SWEEP_MS) : null;
  if (resealTimer) {
    resealTimer.unref();
    void resealSweep();
  }

  // Channel tokens are renewed before they expire (S6.4), whatever module uses the channel.
  const refreshers = channels?.refreshers ?? {};
  let refreshing = false;
  const refreshSweep = async () => {
    if (refreshing || !channels) return;
    refreshing = true;
    try {
      const done = await refreshChannels({ runtime: deps.runtime, broker: channels.broker, workerDb: deps.workerDb, refreshers });
      if (done.refreshed + done.expired + done.failed > 0) console.log(`[channel-refresh] refreshed ${done.refreshed}, expired ${done.expired}, failed ${done.failed}`);
    } catch (error) {
      console.error('[channel-refresh] sweep', error);
    } finally {
      refreshing = false;
    }
  };
  const refreshTimer = Object.keys(refreshers).length > 0 ? setInterval(() => void refreshSweep(), REFRESH_SWEEP_MS) : null;
  void refreshSweep();

  // Outside calendars (#2123, #1374): the busy times of every active connection are read every 15 minutes, a sweep at a
  // time across worker processes. The adapters are the deployment's; with none on, nothing runs.
  const calendars = channels?.calendars ?? {};
  const calendarWriteBackOn = Object.keys(calendars).length > 0;
  // A session advisory lock on one connection of the worker's pool, so two worker processes never sweep at once.
  const calendarExclusive = <T>(run: () => Promise<T>) =>
    deps.workerDb.connection().execute(async (db) => {
      const { rows } = await sql<{ locked: boolean }>`SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended('crove.calendar-sync', 0)) AS locked`.execute(db);
      if (!rows[0]?.locked) return { ran: false as const };
      try {
        return { ran: true as const, value: await run() };
      } finally {
        await sql`SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended('crove.calendar-sync', 0))`.execute(db);
      }
    });
  // The same, for one connection's write-back (the sweep's batch and the booking-event job's), so a write and a delete of one
  // event never cross: the lock is taken for the plan, the provider calls and their records.
  const calendarConnectionLock = <T>(connectionId: string, run: () => Promise<T>) =>
    deps.workerDb.connection().execute(async (db) => {
      const key = `crove.calendar-writeback:${connectionId}`;
      const { rows } = await sql<{ locked: boolean }>`SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended(${key}, 0)) AS locked`.execute(db);
      if (!rows[0]?.locked) return { ran: false as const };
      try {
        return { ran: true as const, value: await run() };
      } finally {
        await sql`SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(${key}, 0))`.execute(db);
      }
    });
  let calendarSyncing = false;
  const calendarSweep = async () => {
    if (calendarSyncing || !channels) return;
    calendarSyncing = true;
    try {
      const done = await syncCalendars({ runtime: deps.runtime, broker: channels.broker, workerDb: deps.workerDb, adapters: calendars, exclusive: calendarExclusive, lockConnection: calendarConnectionLock });
      if (done.synced + done.expired + done.retry + done.disconnected > 0) console.log(`[calendar-sync] synced ${done.synced}, expired ${done.expired}, to retry ${done.retry}, disconnected ${done.disconnected}`);
    } catch (error) {
      console.error('[calendar-sync] sweep', error instanceof Error ? error.name : typeof error);
    } finally {
      calendarSyncing = false;
    }
  };
  // Also with no adapter on: a member's disconnect is finished (the grant revoked, or given up on after three days, and the
  // sealed token removed) whatever the server has configured.
  const calendarTimer = channels ? setInterval(() => void calendarSweep(), CALENDAR_SYNC_SWEEP_MS) : null;
  calendarTimer?.unref();
  void calendarSweep();

  // A booking confirmed, moved or cancelled (#2124): the events of the org's write-back connections are made to match at once,
  // from a job the relay queues, instead of at the next sweep (which stays as the backstop and does the token renewals).
  if (channels && calendarWriteBackOn) {
    await boss.work<CalendarWriteBackJob>(QUEUES.calendarWriteback, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      // A connection the sweep or another job is working on is tried again a few times, so a booking that committed after their
      // plan was read is still written; held longer than that, the sweep that holds it comes back within 15 minutes.
      for (let attempt = 1; ; attempt++) {
        const done = await runCalendarWriteBack({ runtime: deps.runtime, broker: channels.broker, adapters: channels.calendars ?? {}, lockConnection: calendarConnectionLock }, job.data);
        if (done.busy === 0 || attempt >= CALENDAR_WRITEBACK_BUSY_TRIES) break;
        await new Promise((resolve) => setTimeout(resolve, CALENDAR_WRITEBACK_BUSY_WAIT_MS));
      }
    });
  }

  // Sizes of Social images uploaded before sizes were read at upload (#668): a batch every 10 minutes, a round a day.
  const sizes = { after: null as string | null, pausedUntil: 0 };
  let sizing = false;
  const sizeSweep = async () => {
    if (sizing) return;
    sizing = true;
    try {
      const done = await backfillImageSizes({ runtime: deps.runtime, workerDb: deps.workerDb, store: deps.store }, sizes);
      if (done.recorded + done.unreadable > 0) console.log(`[image-size] recorded ${done.recorded}, unreadable ${done.unreadable}`);
    } catch (error) {
      console.error('[image-size] sweep', error);
    } finally {
      sizing = false;
    }
  };
  const sizeTimer = deps.runtime.installed('social') ? setInterval(() => void sizeSweep(), IMAGE_SIZE_SWEEP_MS) : null;
  if (sizeTimer) void sizeSweep();

  // Retention holds on evidence files (#1009): every 5 minutes, the posted files whose hold is missing or too short.
  const evidenceLockDays = deps.evidenceLockDays ?? 0;
  const holdState = { unavailableReportedAt: 0 };
  let holding = false;
  const holdSweep = async () => {
    if (holding) return;
    holding = true;
    try {
      const done = await runEvidenceHolds({ runtime: deps.runtime, workerDb: deps.workerDb, store: deps.store }, evidenceLockDays, holdState);
      if (done.held + done.failed > 0) console.log(`[evidence-hold] held ${done.held}, failed ${done.failed}`);
    } catch (error) {
      opsAlert('[evidence-hold] ALERT sweep failed; the error is in the worker log', error);
    } finally {
      holding = false;
    }
  };
  const holdTimer = evidenceLockDays > 0 && deps.store.holds && deps.runtime.installed('finance') ? setInterval(() => void holdSweep(), EVIDENCE_HOLD_SWEEP_MS) : null;
  if (holdTimer) void holdSweep();
  else if (evidenceLockDays > 0 && !deps.store.holds) console.warn('[evidence-hold] the file store has no per-object retention (local disk): posted files get no retention hold');

  // Metrics of published posts (S8): every 15 minutes, the variants whose last capture is older than 6 hours.
  let measuring = false;
  const metricsSweep = async () => {
    if (measuring || publishing.size === 0 || !channels) return;
    measuring = true;
    try {
      const done = await sweepMetrics({ runtime: deps.runtime, broker: channels.broker, workerDb: deps.workerDb, publishers });
      if (done.recorded > 0) console.log(`[social-metrics] recorded ${done.recorded}, skipped ${done.skipped}`);
    } catch (error) {
      console.error('[social-metrics] sweep', error);
    } finally {
      measuring = false;
    }
  };
  const metricsTimer = publishing.size > 0 ? setInterval(() => void metricsSweep(), METRICS_SWEEP_MS) : null;

  // Account growth (#645): every hour, the channels with no snapshot for today (UTC) get one.
  let counting = false;
  const accountSweep = async () => {
    if (counting || publishing.size === 0 || !channels) return;
    counting = true;
    try {
      const done = await sweepAccounts({ runtime: deps.runtime, broker: channels.broker, workerDb: deps.workerDb, publishers });
      if (done.recorded > 0) console.log(`[social-accounts] recorded ${done.recorded}, skipped ${done.skipped}`);
    } catch (error) {
      console.error('[social-accounts] sweep', error);
    } finally {
      counting = false;
    }
  };
  const accountTimer = publishing.size > 0 ? setInterval(() => void accountSweep(), ACCOUNT_SWEEP_MS) : null;
  void accountSweep();

  // Posts published outside Crove (#1054): every 15 minutes, the channels not listed for 6 hours are listed again, and
  // the posts brought in whose counts are older than 6 hours are measured.
  let bringing = false;
  const externalSweep = async () => {
    if (bringing || publishing.size === 0 || !channels) return;
    bringing = true;
    try {
      const done = await sweepExternalPosts({ runtime: deps.runtime, broker: channels.broker, workerDb: deps.workerDb, publishers });
      if (done.imported + done.measured + done.expired > 0) console.log(`[social-external] listed ${done.imported}, measured ${done.measured}, expired ${done.expired}, skipped ${done.skipped}`);
    } catch (error) {
      console.error('[social-external] sweep', error);
    } finally {
      bringing = false;
    }
  };
  const externalTimer = publishing.size > 0 ? setInterval(() => void externalSweep(), EXTERNAL_SWEEP_MS) : null;
  // Once at start too, as the account sweep does, so a restart does not wait a whole period.
  void externalSweep();

  // TikTok posts that get their public id later (#1475): every 15 minutes, the published TikTok posts still waiting for
  // their id after moderation, or for the creator to post their inbox draft, are asked about again (a status read only).
  let lateChecking = false;
  const lateIdSweep = async () => {
    if (lateChecking || !publishing.has('tiktok') || !channels) return;
    lateChecking = true;
    try {
      const done = await sweepLateIds({ runtime: deps.runtime, broker: channels.broker, workerDb: deps.workerDb, publishers });
      if (done.checked + done.expired > 0) console.log(`[social-late-ids] checked ${done.checked}, settled ${done.settled}, expired ${done.expired}, skipped ${done.skipped}`);
    } catch (error) {
      console.error('[social-late-ids] sweep', error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
    } finally {
      lateChecking = false;
    }
  };
  const lateIdTimer = publishing.has('tiktok') ? setInterval(() => void lateIdSweep(), LATE_ID_SWEEP_MS) : null;
  if (lateIdTimer) void lateIdSweep();

  // A team chat alert (#863) for an outbox event, queued best effort on pg-boss's own connection, outside the relay
  // batch's transaction, where a failed insert would abort the batch: a failure here is logged and never rolls the claim
  // back, so it holds up neither the relay nor the notices. A batch relayed again within the same singletonSeconds slot
  // does not queue it twice, since the slot refuses the second job (#1705); slots follow the clock, as before.
  const queueChatAlert = (row: OutboxRow, test: boolean) =>
    boss
      .send(QUEUES.socialChatAlert, { orgId: row.org_id, eventId: row.event_id, ...(test ? { test: true as const } : {}) } satisfies AgentDispatchJob & { test?: true }, {
        singletonKey: jobKey(row.org_id, QUEUES.socialChatAlert, test ? 'test' : row.event_id),
        singletonSeconds: test ? CHAT_ALERT_TEST_SINGLETON_SECONDS : CHAT_ALERT_SINGLETON_SECONDS,
        retryLimit: 0,
      })
      .catch((error: unknown) => console.error(`[social-chat-alert] event ${row.event_id.slice(0, 8)}: not queued (${error instanceof Error ? error.name : typeof error})`));

  let running = false;
  let stopped = false;
  const relay = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        const sent = await relayBatch(deps.workerDb, boss, async (trx) => {
          const { rows } = await sql<OutboxRow>`SELECT * FROM crove_kernel.outbox_claim(100)`.execute(trx);
          const priorities = finance ? await extractPriorities(trx, rows) : new Map<OutboxRow, number>();
          // A failed send rolls back the claim and the batch is relayed again. Each row's step gets `boss` on the claim's
          // transaction (relayBatch, #1705), shadowing the worker's own on purpose, so every job it sends rolls back with
          // the claim and none is queued twice.
          return rows.map(
            (row) => async (boss: JobSender) => {
              if (
                !finance &&
                (row.type === 'kernel.file.ingested' ||
                  row.type === 'kernel.file.reextract_requested' ||
                  row.type === 'finance.portal_list.import_requested' ||
                  row.type === 'finance.archive_requested')
              ) {
                return null;
              }
              if (row.type === 'finance.portal_list.import_requested') {
                const listId = String(row.payload.listId);
                return boss.send(QUEUES.portalList, { orgId: row.org_id, listId } satisfies PortalListJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.portalList, listId),
                  retryLimit: PORTAL_LIST_RETRY_LIMIT,
                  retryDelay: 20,
                  retryBackoff: true,
                });
              }
              if (row.type === 'finance.archive_requested') {
                const year = Number(row.payload.year);
                const requestCommandId = typeof row.payload.requestCommandId === 'string' ? row.payload.requestCommandId : null;
                return boss.send(QUEUES.yearArchive, { orgId: row.org_id, year, requestCommandId } satisfies YearArchiveJob, {
                  // One build per org and year queued or running at a time.
                  singletonKey: jobKey(row.org_id, QUEUES.yearArchive, String(year)),
                  retryLimit: YEAR_ARCHIVE_RETRY_LIMIT,
                  retryDelay: 60,
                  retryBackoff: true,
                });
              }
              if (row.type === 'kernel.file.ingested' || row.type === 'kernel.file.reextract_requested') {
                return sendExtractJob(boss, row, priorities.get(row) ?? 0);
              }
              if (row.type === 'kernel.org.export_requested') {
                return boss.send(QUEUES.orgExport, { orgId: row.org_id } satisfies OrgExportJob, {
                  // One export per org queued or running at a time; a request while one runs is not queued twice.
                  singletonKey: jobKey(row.org_id, QUEUES.orgExport, 'org'),
                  retryLimit: ORG_EXPORT_RETRY_LIMIT,
                  retryDelay: 60,
                  retryBackoff: true,
                });
              }
              // A person asked for a first comment again (#587): on the channel's publish queue, keyed apart from its
              // publish job.
              if (row.type === 'social.comment.retry_requested') {
                const provider = String(row.payload.provider);
                const variantId = String(row.payload.variant_id);
                if (!SOCIAL_PUBLISH_QUEUES.includes(socialPublishQueue(provider))) {
                  console.warn(`[social-comment] no publish queue for provider ${provider.slice(0, 32)}, variant ${variantId.slice(0, 8)}: retry dropped`);
                  return null;
                }
                const after = typeof row.payload.after === 'string' ? row.payload.after : null;
                return boss.send(socialPublishQueue(provider), { orgId: row.org_id, variantId, provider, comment: true, after } satisfies SocialPublishJob, {
                  singletonKey: jobKey(row.org_id, socialPublishQueue(provider), `${variantId}:comment:${after ?? '-'}`),
                  retryLimit: 0,
                });
              }
              // A person asked for the rest of a thread again (#742): like a comment retry, keyed apart.
              if (row.type === 'social.thread.retry_requested') {
                const provider = String(row.payload.provider);
                const variantId = String(row.payload.variant_id);
                if (!SOCIAL_PUBLISH_QUEUES.includes(socialPublishQueue(provider))) {
                  console.warn(`[social-thread] no publish queue for provider ${provider.slice(0, 32)}, variant ${variantId.slice(0, 8)}: retry dropped`);
                  return null;
                }
                const after = typeof row.payload.after === 'string' ? row.payload.after : null;
                return boss.send(socialPublishQueue(provider), { orgId: row.org_id, variantId, provider, thread: true, after } satisfies SocialPublishJob, {
                  singletonKey: jobKey(row.org_id, socialPublishQueue(provider), `${variantId}:thread:${after ?? '-'}`),
                  retryLimit: 0,
                });
              }
              // A person asked for a published post to come down (#860): one job per ask, keyed by the call it saw.
              if (social && row.type === 'social.variant.remove_requested') {
                const provider = String(row.payload.provider);
                const variantId = String(row.payload.variant_id);
                const after = typeof row.payload.after === 'string' ? row.payload.after : null;
                const removal = boss.send(QUEUES.socialRemove, { orgId: row.org_id, variantId, provider, after } satisfies SocialRemoveJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.socialRemove, `${variantId}:remove:${after ?? '-'}`),
                  retryLimit: 0,
                });
                if (row.payload.scheduled !== true) return removal;
                // A planned takedown (#861), which nobody watches, also gets its watch (#937): once the ask is stale, it
                // tells the owners and admins if the job never recorded an answer. It never calls the platform, so it
                // may run again.
                return Promise.all([
                  removal,
                  boss.send(QUEUES.socialRemove, { orgId: row.org_id, variantId, provider, after, watch: true } satisfies SocialRemoveJob, {
                    singletonKey: jobKey(row.org_id, QUEUES.socialRemove, `${variantId}:remove-watch:${after ?? '-'}`),
                    startAfter: new Date(Date.now() + REMOVE_WATCH_AFTER_MS),
                    retryLimit: REMOVE_WATCH_RETRY_LIMIT,
                    retryDelay: 60,
                    retryBackoff: true,
                  }),
                ]);
              }
              // A person asked for a published post's text to be corrected (#1223): one job per ask, keyed by the call it saw.
              if (social && row.type === 'social.variant.edit_requested') {
                const provider = String(row.payload.provider);
                const variantId = String(row.payload.variant_id);
                const after = typeof row.payload.after === 'string' ? row.payload.after : null;
                return boss.send(QUEUES.socialEdit, { orgId: row.org_id, variantId, provider, after } satisfies SocialEditJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.socialEdit, `${variantId}:edit:${after ?? '-'}`),
                  retryLimit: 0,
                });
              }
              // A channel's options for the composer (#1120): read by the worker with the channel's token.
              if (social && row.type === 'social.channel_option.requested') {
                const optionId = String(row.payload.option_id);
                return boss.send(QUEUES.socialChannelOption, { orgId: row.org_id, optionId } satisfies ChannelOptionJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.socialChannelOption, optionId),
                  retryLimit: CHANNEL_OPTION_RETRY_LIMIT,
                  retryDelay: 10,
                  retryBackoff: true,
                });
              }
              // A member who left or changed role (#1382): their booking feed stops when they host no more. Queued
              // beside whatever else the event starts (Social revokes its links from the same event).
              if (crm && (row.type === 'kernel.member.removed' || row.type === 'kernel.member.role_changed')) {
                await boss.send(QUEUES.crmBooking, { orgId: row.org_id, memberEventId: row.event_id } satisfies BookingJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.crmBooking, `member:${row.event_id}`),
                  retryLimit: BOOKING_RETRY_LIMIT,
                  retryDelay: 2,
                  retryBackoff: true,
                });
              }
              // A member who left (#1671): their private notes are removed 30 days later, beside the rest.
              if (notes) await queueNotesMemberPurge(boss, row);
              // A bank feed connected, or an account of one mapped (ADR-0039, #2044): its sync lists the accounts and
              // pulls the mapped ones.
              if (
                finance &&
                deps.channels?.bankFeeds &&
                Object.keys(deps.channels.bankFeeds).length > 0 &&
                ((row.type === 'kernel.channel.connected' && String(row.payload.provider).startsWith('bank_')) || row.type === 'finance.bank_feed.sync_requested')
              ) {
                const connectionId = String(row.payload.connection_id);
                await boss.send(QUEUES.bankFeedSync, { orgId: row.org_id, connectionId } satisfies BankFeedSyncJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.bankFeedSync, connectionId),
                  retryLimit: BANK_FEED_SYNC_RETRY_LIMIT,
                  retryDelay: 30,
                  retryBackoff: true,
                });
              }
              // A visitor's booking (#1318): the worker confirms or refuses it as the system.
              if (crm && row.type === 'crm.booking.requested') {
                const bookingId = String(row.payload.booking_id);
                return boss.send(QUEUES.crmBooking, { orgId: row.org_id, bookingId } satisfies BookingJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.crmBooking, bookingId),
                  retryLimit: BOOKING_RETRY_LIMIT,
                  retryDelay: 2,
                  retryBackoff: true,
                });
              }
              // A visitor's ask from a manage link (#1319): the same queue, keyed by the ask.
              if (crm && row.type === 'crm.booking.manage_requested') {
                const bookingId = String(row.payload.booking_id);
                const requestId = String(row.payload.request_id);
                return boss.send(QUEUES.crmBooking, { orgId: row.org_id, bookingId, requestId } satisfies BookingJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.crmBooking, `${bookingId}:${requestId}`),
                  retryLimit: BOOKING_RETRY_LIMIT,
                  retryDelay: 2,
                  retryBackoff: true,
                });
              }
              // A booking confirmed, moved or cancelled (#2124): the events of the org's write-back connections are made to
              // match it, beside whatever else the event starts. One job per event; the jobs name the org only.
              if (crm && calendarWriteBackOn && (row.type === 'crm.booking.scheduled' || row.type === 'crm.booking.cancelled')) {
                await boss.send(QUEUES.calendarWriteback, { orgId: row.org_id } satisfies CalendarWriteBackJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.calendarWriteback, row.event_id),
                  retryLimit: CALENDAR_WRITEBACK_RETRY_LIMIT,
                  retryDelay: 10,
                  retryBackoff: true,
                });
              }
              // A booking confirmed or moved (#1319): its reminders, each due at its lead before the start (none in the past).
              if (crm && row.type === 'crm.booking.scheduled') {
                const bookingId = String(row.payload.booking_id);
                const startsAt = String(row.payload.starts_at);
                const start = Date.parse(startsAt);
                if (Number.isNaN(start)) return null;
                return Promise.all(
                  BOOKING_REMINDERS.filter((r) => start - r.ms > Date.now()).map((r) =>
                    boss.send(QUEUES.crmBookingRemind, { orgId: row.org_id, bookingId, startsAt, lead: r.lead } satisfies BookingRemindJob, {
                      singletonKey: jobKey(row.org_id, QUEUES.crmBookingRemind, `${bookingId}:${startsAt}:${r.lead}`),
                      startAfter: new Date(start - r.ms),
                      retryLimit: BOOKING_RETRY_LIMIT,
                      retryDelay: 30,
                      retryBackoff: true,
                    }),
                  ),
                );
              }
              if (social && row.type === 'social.link_preview.requested') {
                const previewId = String(row.payload.preview_id);
                return boss.send(QUEUES.socialLinkPreview, { orgId: row.org_id, previewId } satisfies LinkPreviewJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.socialLinkPreview, previewId),
                  retryLimit: LINK_PREVIEW_RETRY_LIMIT,
                  retryDelay: 10,
                  retryBackoff: true,
                });
              }
              // A post sent for review also goes to the content manager agent's triage (#799), besides the notices; a
              // booking cancelled goes to the scheduler agent's (#1434), which gives a task for a visitor's cancel only.
              const triage =
                (social && row.type === 'social.post.submitted') || (crm && row.type === 'crm.booking.cancelled')
                  ? boss.send(QUEUES.agentDispatch, { orgId: row.org_id, eventId: row.event_id } satisfies AgentDispatchJob, {
                      singletonKey: jobKey(row.org_id, QUEUES.agentDispatch, row.event_id),
                      retryLimit: AGENT_RETRY_LIMIT,
                      retryDelay: 20,
                      retryBackoff: true,
                    })
                  : null;
              if (triage) await triage;
              // A team chat alert (#863), besides the notices: queued best effort, outside the batch (queueChatAlert).
              if (chatAlerts && (CHAT_ALERTING.has(row.type) || row.type === CHAT_ALERT_TEST_EVENT)) {
                const test = row.type === CHAT_ALERT_TEST_EVENT;
                await queueChatAlert(row, test);
                if (test) return null;
              }
              // An in-app notification (#671), besides whatever else the event starts (an agent's review task).
              const notify = NOTIFY_COMMANDS.get(row.type);
              if (notify && deps.runtime.installed(notify.module)) {
                await boss.send(QUEUES.notify, { orgId: row.org_id, eventId: row.event_id, type: row.type } satisfies AgentDispatchJob & { type: string }, {
                  singletonKey: jobKey(row.org_id, QUEUES.notify, row.event_id),
                  retryLimit: NOTIFY_RETRY_LIMIT,
                  retryDelay: 20,
                  retryBackoff: true,
                });
              }
              if (social && NOTIFYING.has(row.type)) {
                return boss.send(QUEUES.socialNotify, { orgId: row.org_id, eventId: row.event_id, type: row.type } satisfies AgentDispatchJob & { type: string }, {
                  singletonKey: jobKey(row.org_id, QUEUES.socialNotify, row.event_id),
                  retryLimit: SOCIAL_NOTIFY_RETRY_LIMIT,
                  retryDelay: 20,
                  retryBackoff: true,
                });
              }
              if (row.type === 'kernel.agent.wakeup_requested') {
                return sendAgentWake(boss, row.org_id, String(row.payload.agentId));
              }
              if (Object.hasOwn(AGENT_PROPOSAL_COMMANDS, row.type)) {
                return boss.send(QUEUES.agentProposal, { orgId: row.org_id, eventId: row.event_id, type: row.type }, {
                  singletonKey: jobKey(row.org_id, QUEUES.agentProposal, row.event_id),
                  retryLimit: AGENT_RETRY_LIMIT,
                  retryDelay: 20,
                  retryBackoff: true,
                });
              }
              if (row.type === 'kernel.proposal.created') {
                return boss.send(QUEUES.agentDispatch, { orgId: row.org_id, eventId: row.event_id } satisfies AgentDispatchJob, {
                  singletonKey: jobKey(row.org_id, QUEUES.agentDispatch, row.event_id),
                  retryLimit: AGENT_RETRY_LIMIT,
                  retryDelay: 20,
                  retryBackoff: true,
                });
              }
              if (row.type === 'kernel.session.revoked') {
                // The event names the user; the job reads the subject (#1970). An event emitted before the switch still
                // carries the subject itself.
                const target: SignOutJob = {
                  ...(typeof row.payload.subject === 'string' ? { subject: row.payload.subject } : { userId: String(row.payload.userId) }),
                  sessionId: String(row.payload.sessionId),
                  scope: row.payload.scope === 'global' ? 'global' : 'local',
                };
                return boss.send(QUEUES.signOut, target, {
                  singletonKey: jobKey(row.org_id, QUEUES.signOut, `${target.sessionId}:${target.scope}`),
                  retryLimit: SIGN_OUT_RETRY_LIMIT,
                  retryDelay: 10,
                  retryBackoff: true,
                });
              }
              return null;
            },
          );
        });
        if (sent < 100) break;
      }
      for (;;) {
        const sent = await relayBatch(deps.workerDb, boss, async (trx) => {
          const { rows } = await sql<InboundRow>`SELECT * FROM crove_kernel.inbound_claim(100)`.execute(trx);
          return rows.map(
            (row) => (boss: JobSender) =>
              boss.send(
                QUEUES.inbound,
                {
                  blobId: row.blob_id,
                  sha256: row.raw_sha256,
                  sizeBytes: Number(row.size_bytes),
                  recipient: row.recipient || null,
                } satisfies InboundJob,
                { singletonKey: systemJobKey(QUEUES.inbound, row.blob_id), retryLimit: INBOUND_RETRY_LIMIT, retryDelay: 20, retryBackoff: true },
              ),
          );
        });
        if (sent < 100) break;
      }
      for (;;) {
        const sent = await relayBatch(deps.workerDb, boss, async (trx) => {
          const { rows } = await sql<MailEventRow>`SELECT * FROM crove_kernel.mail_event_claim(100)`.execute(trx);
          return rows.map(
            (row) => (boss: JobSender) =>
              boss.send(QUEUES.mailEvent, mailEventJob(row) satisfies MailEventJob, {
                singletonKey: systemJobKey(QUEUES.mailEvent, `${row.provider}:${row.provider_event_id}`),
                retryLimit: MAIL_EVENT_RETRY_LIMIT,
                retryDelay: 20,
                retryBackoff: true,
              }),
          );
        });
        if (sent < 100) break;
      }
      // A bank feed provider's signed notice (ADR-0039, #2044): the connections that list an account it names get a sync.
      // Only where an adapter is on; without one the route does not exist and nothing is waiting.
      if (finance && deps.channels?.broker && deps.channels.bankFeeds && Object.keys(deps.channels.bankFeeds).length > 0) {
        const adapters = deps.channels.bankFeeds;
        for (;;) {
          const claimed = await relayBatch(deps.workerDb, boss, async (trx) => {
            const rows = await claimBankFeedNotices(trx);
            const seen = new Set<string>();
            return rows.map((row) => {
              // A claimed account no connection lists (a row of nulls), a connection already queued in this batch, or an
              // adapter this deployment does not have: nothing to send, but still a claimed row for the batch's count.
              if (!row.orgId || !row.connectionId || !row.provider || !Object.hasOwn(adapters, row.provider) || seen.has(row.connectionId)) return async () => null;
              seen.add(row.connectionId);
              const target = { orgId: row.orgId, connectionId: row.connectionId } satisfies BankFeedSyncJob;
              return (boss: JobSender) =>
                boss.send(QUEUES.bankFeedSync, target, {
                  // A standard queue's singletonKey dedupes nothing by itself; a time slot per connection does: a provider's
                  // retries of a notice, or one replayed inside its window, are one sync a slot. A pull goes on from the
                  // cursor, so what a deduped notice announced comes with the next pull (the next notice, or the daily one).
                  singletonKey: jobKey(target.orgId, QUEUES.bankFeedSync, target.connectionId),
                  singletonSeconds: BANK_FEED_NOTICE_SLOT_SECONDS,
                  retryLimit: BANK_FEED_SYNC_RETRY_LIMIT,
                  retryDelay: 30,
                  retryBackoff: true,
                });
            });
          });
          if (claimed < BANK_FEED_NOTICE_CLAIM) break;
        }
      }
    } catch (error) {
      console.error('[relay]', error);
    } finally {
      running = false;
    }
  };

  const listener = new pg.Client({ connectionString: deps.connectionString, application_name: 'crove-relay-listen' });
  // Without a handler a dropped connection would crash the process; the 1 s timer keeps draining the outbox.
  listener.on('error', (error) => console.error('[relay] listen connection lost', error.message));
  await listener.connect();
  await listener.query('LISTEN crove_outbox');
  listener.on('notification', () => void relay());
  const timer = setInterval(() => void relay(), 1000);
  void relay();
  const instance = deps.instance ?? hostname();
  const worked = AVAILABLE_MODULES.filter((module) => module === 'kernel' || deps.runtime.installed(module));
  // One beat at a time, in order: the stop's beat below lands after any beat still in flight, never before it (#1887).
  let beats: Promise<void> = Promise.resolve();
  const heartbeat = (modules: readonly string[] = worked) =>
    (beats = beats.then(() => beat(deps.workerDb, instance, modules, deps.build)).catch((error) => console.error('[heartbeat]', error)));
  const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
  await heartbeat();
  // Back-pressure (#894): checked every 10 s; one check at a time, none after stop. Its start and end go to the alert
  // webhook too (the security alerts' target, the prober's chat), when one is set.
  const alertTarget = deps.securityAlerts?.target ?? null;
  let pressureChecking = false;
  const pressureCheck = async () => {
    if (pressureChecking || stopped) return;
    pressureChecking = true;
    try {
      await checkBackPressure({
        work: background,
        readLagSeconds: () => outboxLagSeconds(deps.workerDb),
        thresholdSeconds: deps.outboxLagPauseSeconds ?? DEFAULT_OUTBOX_LAG_PAUSE_SECONDS,
        notify: alertTarget?.webhookUrl
          ? async (text) => {
              const delivery = await postMessage(
                { text: `[Crove] Worker on ${alertTarget.instance}: ${text}`, crove: { kind: 'back_pressure', instance: alertTarget.instance } },
                { webhookUrl: alertTarget.webhookUrl, format: alertTarget.webhookFormat, telegramChatId: alertTarget.telegramChatId },
              );
              if (!delivery.ok) console.error(`[back-pressure] could not post the alert: ${delivery.error ?? 'unknown error'}`);
            }
          : undefined,
      });
    } catch (error) {
      console.error('[back-pressure]', error);
    } finally {
      pressureChecking = false;
    }
  };
  const pressureTimer = setInterval(() => void pressureCheck(), BACK_PRESSURE_CHECK_MS);
  console.log('[worker] started');

  return async () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(heartbeatTimer);
    // A clean stop works no module any more, so a module a redeploy leaves out drops out of the prober's job age at
    // once; a worker that dies without this beat keeps its modules counted for 7 days (#1887). Sent first, beside the
    // drain below: a job still running is not queued, and the drain may take the whole stop grace period.
    const lastBeat = heartbeat([]);
    clearInterval(pressureTimer);
    if (socialTimer) clearInterval(socialTimer);
    if (removeTimer) clearInterval(removeTimer);
    if (mailTimer) clearInterval(mailTimer);
    if (evergreenTimer) clearInterval(evergreenTimer);
    if (recurringTimer) clearInterval(recurringTimer);
    if (reminderTimer) clearInterval(reminderTimer);
    if (queueLowTimer) clearInterval(queueLowTimer);
    if (digestTimer) clearInterval(digestTimer);
    if (missingInvoiceTimer) clearInterval(missingInvoiceTimer);
    clearInterval(proposalNudgeTimer);
    clearInterval(securityTimer);
    if (closingTimer) clearInterval(closingTimer);
    if (reportTimer) clearInterval(reportTimer);
    if (feedTimer) clearInterval(feedTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    if (calendarTimer) clearInterval(calendarTimer);
    if (resealTimer) clearInterval(resealTimer);
    if (metricsTimer) clearInterval(metricsTimer);
    if (sizeTimer) clearInterval(sizeTimer);
    if (holdTimer) clearInterval(holdTimer);
    if (accountTimer) clearInterval(accountTimer);
    if (externalTimer) clearInterval(externalTimer);
    if (lateIdTimer) clearInterval(lateIdTimer);
    await listener.end().catch(() => {});
    await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
    // Waited for 5 s at most after the drain: a stop that cannot reach the database leaves the modules counted, as a
    // death does.
    await Promise.race([lastBeat, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
  };
}
