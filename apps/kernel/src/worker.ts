// Worker: relays the outbox into pg-boss queues and runs jobs.
import { hostname } from 'node:os';
import { sql } from 'kysely';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { Db } from '@crove/db';
import { DomainError, inboundKey, type AgentProgram, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { runAgentWake } from '@crove/kernel';
import type { InvoiceReader } from '@crove/agent';
import type { Publisher, Refresher } from '@crove/channel';
import { REFRESH_SWEEP_MS, refreshChannels } from './channel-refresh.ts';
import type { ExtractClient } from '@crove/extract-contract';
import { extractAndPropose, recordExtractionFailure } from '@crove/mod-finance';
import { EVERGREEN_SWEEP_MS, METRICS_SWEEP_MS, PUBLISH_STALE_SECONDS, runPublishJob, sweepEvergreen, sweepMetrics } from '@crove/mod-social';
import { archiveSource, expandArchive, recordArchiveFailure } from './archive.ts';
import { processInboundEmail, type InboundJob } from './inbound.ts';
import { ExportSealer } from './export-seal.ts';
import { JOB_SCHEMA, QUEUES, socialPublishQueue } from './jobs-schema.ts';
import { DEFAULT_EXPORT_RETENTION_DAYS, runOrgExport } from './org-export.ts';
import { RETENTION_CRON, RETENTION_TZ, expireExports, runRetention, sweepInboundBlobs, sweepStaging } from './retention.ts';
import type { SessionRevoker, SignOutTarget } from './sessions.ts';

const SOCIAL_PUBLISH_RETRY_LIMIT = 2;
// The worker looks for due variants this often; a post goes out within this long of its time.
export const SOCIAL_SWEEP_MS = 15_000;
const SOCIAL_SWEEP_LIMIT = 500;
const AGENT_RETRY_LIMIT = 3;
// Every 10 minutes the worker wakes agents whose wake-up is still pending and that can run now
// (crove_kernel.agent_wakeups_due): a run refused earlier by the daily cap, a kill switch or a budget that has since
// lifted, or blocked by a run left live by a crashed worker. Agents still capped, switched off, out of budget or of a
// module this deployment does not enable are left out, so the sweep writes no refused start for them.
export const AGENT_SWEEP_CRON = '*/10 * * * *';
const AGENT_SWEEP_LIMIT = 200;

function sendAgentWake(boss: PgBoss, orgId: string, agentId: string) {
  return boss.send(QUEUES.agentWake, { orgId, agentId } satisfies AgentWakeJob, {
    singletonKey: `${orgId}:${agentId}`,
    retryLimit: AGENT_RETRY_LIMIT,
    retryDelay: 20,
    retryBackoff: true,
  });
}
const EXTRACT_RETRY_LIMIT = 3;
export const EXTRACT_POLL_SECONDS = 0.5;
const INBOUND_RETRY_LIMIT = 3;
const SIGN_OUT_RETRY_LIMIT = 5;
const ORG_EXPORT_RETRY_LIMIT = 3;
// The prober alerts when the freshest heartbeat is older than PROBER_MAX_HEARTBEAT_AGE_SECONDS (default 120).
export const HEARTBEAT_INTERVAL_MS = 30_000;
// Refusal tally windows (issue #162) older than the retention are deleted by the daily retention job, in batches.
export const DEFAULT_REFUSAL_TALLY_RETENTION_DAYS = 7;
const REFUSAL_TALLY_PRUNE_BATCH = 10_000;

interface InboundRow {
  seq: string;
  blob_id: string;
  raw_sha256: string;
  size_bytes: string;
  recipient: string;
}

interface AgentWakeJob {
  orgId: string;
  agentId: string;
}

interface AgentDispatchJob {
  orgId: string;
  eventId: string;
}

interface ExtractJob {
  orgId: string;
  fileId: string;
  version?: number;
}

interface OrgExportJob {
  orgId: string;
}

interface OutboxRow {
  seq: string;
  org_id: string;
  event_id: string;
  type: string;
  payload: Record<string, unknown>;
}

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
  // Days of crove_kernel.refusal_tally windows kept (default DEFAULT_REFUSAL_TALLY_RETENTION_DAYS).
  refusalTallyRetentionDays?: number;
  // The built-in program of each agent template (ADR-0029 section 8), by template key.
  agentPrograms?: Readonly<Record<string, AgentProgram>>;
  // Seals org export blobs at rest (EXPORT_ENCRYPTION_KEY, issue #212). Default: no key, stored unencrypted.
  exportSealer?: ExportSealer;
  // Days an org export is kept before the retention job deletes it (EXPORT_RETENTION_DAYS, 35 to 90).
  exportRetentionDays?: number;
  // Social publishing: the credential broker that opens channel tokens, and the providers this deployment can publish
  // to. Without it, or without the social module, scheduled posts wait.
  channels?: { broker: CredentialBroker; publishers: Readonly<Record<string, Publisher>>; refreshers?: Readonly<Record<string, Refresher>> };
}

interface SocialPublishJob {
  orgId: string;
  variantId: string;
  provider: string;
}

/** Sends a publish job for each variant with publishing work, for the providers this worker can publish to. */
export async function sweepSocialPublishing(boss: PgBoss, workerDb: Db, providers: ReadonlySet<string>): Promise<number> {
  const { rows } = await sql<{ org_id: string; variant_id: string; provider: string }>`
    SELECT org_id, variant_id, provider FROM crove_social.publish_due(${SOCIAL_SWEEP_LIMIT}::int, ${PUBLISH_STALE_SECONDS}::int, ${[...providers]}::text[])`.execute(workerDb);
  const due = rows.filter((r) => providers.has(r.provider));
  await Promise.all(
    due.map((r) =>
      boss.send(socialPublishQueue(r.provider), { orgId: r.org_id, variantId: r.variant_id, provider: r.provider } satisfies SocialPublishJob, {
        singletonKey: `${r.org_id}:${r.variant_id}`,
        retryLimit: SOCIAL_PUBLISH_RETRY_LIMIT,
        retryDelay: 30,
        retryBackoff: true,
      }),
    ),
  );
  return due.length;
}

/** Records that this worker is alive (crove_kernel.worker_beat, crove_worker only). */
export async function beat(workerDb: Db, instance: string): Promise<void> {
  await sql`SELECT crove_kernel.worker_beat(${instance.slice(0, 128)})`.execute(workerDb);
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
    console.error(`[signout] ALERT ${label}: Supabase Auth sign-out failed after ${retryCount + 1} attempts; revoked in Crove only`, error);
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

  // version: a requested re-extraction (kernel.file.reextract_requested); absent for the first read of a new file.
  // pg-boss waits the polling interval between fetches (2 s by default, less the job's run time), so a batch of 200
  // documents (bulk intake, #314) would wait about 400 s; 0.5 s, the shortest it allows, lets one sandbox call follow
  // the other. An idle worker asks for extraction jobs twice a second.
  if (finance) await boss.work<ExtractJob>(QUEUES.extract, { batchSize: 1, pollingIntervalSeconds: EXTRACT_POLL_SECONDS }, async ([job]) => {
    if (!job) return;
    const { orgId, fileId, version } = job.data;
    // A ZIP archive (#314) is opened into documents of its own instead of being read; it is never read again.
    const archive = await archiveSource(deps.runtime, orgId, fileId);
    if (archive && version !== undefined) return;
    try {
      if (archive) {
        const { fileIds } = await expandArchive({ runtime: deps.runtime, store: deps.store, extract: deps.extract }, orgId, archive, job.retryCount);
        console.log(`[extract] archive ${fileId}: ${fileIds.length} file(s)`);
      } else {
        await extractAndPropose({ runtime: deps.runtime, store: deps.store, extractor: deps.extractor, extract: deps.extract }, orgId, fileId, version);
      }
    } catch (error) {
      console.error(`[extract] file ${fileId}${version ? ` version ${version}` : ''} attempt ${job.retryCount + 1}`, error);
      if (job.retryCount < EXTRACT_RETRY_LIMIT) throw error;
      if (archive) {
        await recordArchiveFailure(deps.runtime, orgId, fileId, 'Không mở được tệp ZIP sau nhiều lần thử; hãy tải lại tệp');
        return;
      }
      await recordExtractionFailure(
        deps.runtime,
        orgId,
        fileId,
        'Không đọc được chứng từ sau nhiều lần thử; hãy kiểm tra cấu hình AI hoặc gửi tệp XML',
        version,
      );
    }
  });

  // The raw message is deleted once it is filed or dropped; after the last failed attempt it is kept for
  // investigation (each delivery owns its blob, so no other job can still need it), and the daily retention job
  // deletes it INBOUND_BLOB_MAX_AGE_DAYS later (issue #212).
  await boss.work<InboundJob>(QUEUES.inbound, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const label = job.data.sha256.slice(0, 12);
    try {
      const result = await processInboundEmail(
        { runtime: deps.runtime, store: deps.store, domain: deps.inboundDomain, extract: deps.extract },
        job.data,
        job.retryCount,
      );
      console.log(`[inbound] message ${label}: ${result.duplicate ? 'duplicate' : `${result.fileIds.length} file(s)`}`);
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

  await boss.work<SignOutTarget>(QUEUES.signOut, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    await runSignOut(deps.revoker, job.data, job.retryCount);
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
      console.error(`[org-export] ALERT export of org ${orgId} failed after ${job.retryCount + 1} attempts`, error);
    }
  });

  // Retention purges (plan §4.9), on a schedule registered idempotently at boot; pg_cron is not required. The same run
  // deletes abandoned staging objects of presigned uploads (issue #223), leftover raw inbound mail and expired org
  // exports (issue #212).
  const keepDays = deps.refusalTallyRetentionDays ?? DEFAULT_REFUSAL_TALLY_RETENTION_DAYS;
  await boss.work(QUEUES.retention, { batchSize: 1 }, async () => {
    try {
      await runRetention(deps.workerDb);
      const pruned = await pruneRefusalTally(deps.workerDb, keepDays);
      console.log(`[retention] refusal_tally=${pruned}`);
    } finally {
      // Each catches its own errors; they run even when a database purge failed.
      await sweepStaging(deps.store);
      await sweepInboundBlobs(deps.store, deps.workerDb);
      await expireExports(deps.store, deps.runtime, exportRetentionDays);
    }
  });
  await boss.schedule(QUEUES.retention, RETENTION_CRON, null, { tz: RETENTION_TZ, missed: 'once' });

  // Inbox triage: tasks for the agents whose template subscribes to the event. The command reads the event from the
  // outbox; the job carries only its id.
  await boss.work<AgentDispatchJob>(QUEUES.agentDispatch, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    await deps.runtime.execute('kernel.agent.dispatch_event', { eventId: job.data.eventId }, { actor: { type: 'system', component: 'kernel.agent' }, orgId: job.data.orgId });
  });

  const agentPrograms = deps.agentPrograms ?? {};
  await boss.work<AgentWakeJob>(QUEUES.agentWake, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const result = await runAgentWake({ runtime: deps.runtime, programs: agentPrograms }, job.data.orgId, job.data.agentId);
    const label = `agent ${job.data.agentId.slice(0, 8)}`;
    if (result.runId === null) console.log(`[agent] ${label}: no run (${result.reason})`);
    else console.log(`[agent] ${label}: run ${result.runId.slice(0, 8)} ${result.outcome ?? ''}`);
  });

  await boss.work(QUEUES.agentSweep, { batchSize: 1 }, async () => {
    const { rows } = await sql<{ org_id: string; agent_id: string }>`SELECT * FROM crove_kernel.agent_wakeups_due(${AGENT_SWEEP_LIMIT}::int, ${deps.runtime.modules()}::text[])`.execute(deps.workerDb);
    await Promise.all(rows.map((row) => sendAgentWake(boss, row.org_id, row.agent_id)));
    if (rows.length > 0) console.log(`[agent] sweep woke ${rows.length} agent(s) with pending wake-ups`);
  });
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
      const outcome = await runPublishJob({ runtime: deps.runtime, broker: channels.broker, publishers, store: deps.store }, orgId, variantId, provider);
      if (outcome.action !== 'none') console.log(`[social-publish] ${provider} variant ${variantId.slice(0, 8)}: ${outcome.action} -> ${outcome.status}`);
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

  let running = false;
  let stopped = false;
  const relay = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        const sent = await deps.workerDb.transaction().execute(async (trx) => {
          const { rows } = await sql<OutboxRow>`SELECT * FROM crove_kernel.outbox_claim(100)`.execute(trx);
          // A failed send rolls back the claim; singletonKey makes the retry idempotent.
          await Promise.all(
            rows.map((row) => {
              if (!finance && (row.type === 'kernel.file.ingested' || row.type === 'kernel.file.reextract_requested')) return null;
              if (row.type === 'kernel.file.ingested') {
                const fileId = String(row.payload.fileId);
                return boss.send(
                  QUEUES.extract,
                  { orgId: row.org_id, fileId },
                  { singletonKey: `${row.org_id}:${fileId}`, retryLimit: EXTRACT_RETRY_LIMIT, retryDelay: 20, retryBackoff: true },
                );
              }
              if (row.type === 'kernel.file.reextract_requested') {
                const fileId = String(row.payload.fileId);
                const version = Number(row.payload.version);
                if (!Number.isInteger(version) || version < 1) return null;
                return boss.send(
                  QUEUES.extract,
                  { orgId: row.org_id, fileId, version } satisfies ExtractJob,
                  { singletonKey: `${row.org_id}:${fileId}:${version}`, retryLimit: EXTRACT_RETRY_LIMIT, retryDelay: 20, retryBackoff: true },
                );
              }
              if (row.type === 'kernel.org.export_requested') {
                return boss.send(QUEUES.orgExport, { orgId: row.org_id } satisfies OrgExportJob, {
                  // One export per org queued or running at a time; a request while one runs is not queued twice.
                  singletonKey: `${row.org_id}:org-export`,
                  retryLimit: ORG_EXPORT_RETRY_LIMIT,
                  retryDelay: 60,
                  retryBackoff: true,
                });
              }
              if (row.type === 'kernel.agent.wakeup_requested') {
                return sendAgentWake(boss, row.org_id, String(row.payload.agentId));
              }
              if (row.type === 'kernel.proposal.created') {
                return boss.send(QUEUES.agentDispatch, { orgId: row.org_id, eventId: row.event_id } satisfies AgentDispatchJob, {
                  singletonKey: `${row.org_id}:${row.event_id}`,
                  retryLimit: AGENT_RETRY_LIMIT,
                  retryDelay: 20,
                  retryBackoff: true,
                });
              }
              if (row.type === 'kernel.session.revoked') {
                const target: SignOutTarget = {
                  subject: String(row.payload.subject),
                  sessionId: String(row.payload.sessionId),
                  scope: row.payload.scope === 'global' ? 'global' : 'local',
                };
                return boss.send(QUEUES.signOut, target, {
                  singletonKey: `${target.sessionId}:${target.scope}`,
                  retryLimit: SIGN_OUT_RETRY_LIMIT,
                  retryDelay: 10,
                  retryBackoff: true,
                });
              }
              return null;
            }),
          );
          return rows.length;
        });
        if (sent < 100) break;
      }
      for (;;) {
        const sent = await deps.workerDb.transaction().execute(async (trx) => {
          const { rows } = await sql<InboundRow>`SELECT * FROM crove_kernel.inbound_claim(100)`.execute(trx);
          await Promise.all(
            rows.map((row) =>
              boss.send(
                QUEUES.inbound,
                {
                  blobId: row.blob_id,
                  sha256: row.raw_sha256,
                  sizeBytes: Number(row.size_bytes),
                  recipient: row.recipient || null,
                } satisfies InboundJob,
                { singletonKey: row.blob_id, retryLimit: INBOUND_RETRY_LIMIT, retryDelay: 20, retryBackoff: true },
              ),
            ),
          );
          return rows.length;
        });
        if (sent < 100) break;
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
  const heartbeat = () => beat(deps.workerDb, instance).catch((error) => console.error('[heartbeat]', error));
  const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
  await heartbeat();
  console.log('[worker] started');

  return async () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(heartbeatTimer);
    if (socialTimer) clearInterval(socialTimer);
    if (evergreenTimer) clearInterval(evergreenTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    if (metricsTimer) clearInterval(metricsTimer);
    await listener.end().catch(() => {});
    await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
  };
}

// Kept only because the invariant suite on main still calls it, and protected.yml runs main's copy of that suite
// against this code. The schema now comes from the vendored migration (#25), so this does nothing; delete it
// together with those calls once they are gone from main.
export async function migrateJobs(_adminUrl: string): Promise<void> {}
