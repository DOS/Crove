// Dead letters (#1720, plan §4.9 "pg-boss contract"): every queue sends a job that failed its last retry to
// kernel-job.dlq (QUEUES.deadLetter). pg-boss keeps the failed job, which the prober counts and alerts on, and copies
// it there with its data, singleton key and group, the queue it failed on (sourceName), its id (sourceId) and how many
// retries it had. Its worker takes each copy here:
//
// - A job of an org raises an Inbox item kernel.job.dead_lettered in that org, through the system command
//   kernel.job.dead_letter: the queue name, the job id and the retries, never the job's data or its error. One open
//   item per queue and day counts that day's failures (#1747). The org is the one its key or group was built for
//   (job-keys.ts, keyOrg) and the orgId of its data; when they name different orgs, or the data's orgId is not an org
//   id, no org gets an item.
// - A job of no org (a schedule, a sweep, raw inbound mail, a mail provider's event: no org key and no orgId) raises
//   nothing in any org. It is logged here, and the failed job stays where the prober counts it, which alerts the
//   operator (docs/runbooks/incidents.md).
//
// - An org the system may not enter (a closed org, one that no longer exists) gets no item either: logged, and the copy completes,
//   so the one failure does not alert twice.
// - A job that is not a copy pg-boss made (no source queue or id, as when the worker forgot includeMetadata) fails, so
//   the prober counts the dead letter queue's own job too.
//
// A copy taken twice (a retry after the command committed) counts once: the command runs with the failed job's id as
// its idempotency key, so the second take replays the first's answer.
//
// The daily retention run prunes old items (pruneInboxItems): the active orgs crove_kernel.inbox_item_prune_due names,
// page by page, each in its own system context through kernel.inbox.prune.
import { sql } from 'kysely';
import type { JobWithMetadata } from 'pg-boss';
import type { Db } from '@crove/db';
import { inboxPruneCutoffs } from '@crove/kernel';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import { keyOrg } from './job-keys.ts';
import { opsAlert } from './ops-alert.ts';

// Orgs one page of the daily prune names, and pages one run takes at most (past them it logs an ALERT).
const INBOX_PRUNE_PAGE = 500;
const INBOX_PRUNE_PAGES = 100;

const QUEUE_NAME = /^[a-z][a-z0-9_.-]{0,99}$/;
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// How the worker works the dead letter queue: one copy at a time, with the metadata that names its source.
export const DEAD_LETTER_WORK = { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 10 } as const;

/** What the dead letter queue's worker reads of a copy (work() with includeMetadata). */
export type DeadLetter = Pick<JobWithMetadata<unknown>, 'id' | 'data' | 'singletonKey' | 'groupId' | 'sourceName' | 'sourceId' | 'sourceRetryCount'>;

export type DeadLetterOwner =
  | { orgId: string }
  // no_source: not a copy pg-boss made; system: a job of no org; conflict: its key, group and data disagree.
  | { orgId: null; reason: 'no_source' | 'system' | 'conflict' };

/** The org a dead-lettered job belongs to, or why it has none. */
export function deadLetterOrg(job: DeadLetter): DeadLetterOwner {
  const source = job.sourceName;
  if (!source || !QUEUE_NAME.test(source) || !job.sourceId || !UUID.test(job.sourceId)) return { orgId: null, reason: 'no_source' };
  const orgs = new Set<string>();
  for (const key of [job.singletonKey, job.groupId]) {
    const org = keyOrg(key, source);
    if (org) orgs.add(org);
  }
  const data = job.data;
  if (data !== null && typeof data === 'object' && Object.hasOwn(data, 'orgId')) {
    const raw = (data as { orgId: unknown }).orgId;
    const org = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (!ORG_ID.test(org)) return { orgId: null, reason: 'conflict' };
    orgs.add(org);
  }
  if (orgs.size === 0) return { orgId: null, reason: 'system' };
  if (orgs.size > 1) return { orgId: null, reason: 'conflict' };
  return { orgId: [...orgs][0] as string };
}

const WHY: Readonly<Record<Exclude<DeadLetterOwner, { orgId: string }>['reason'], string>> = {
  no_source: 'not a dead letter pg-boss made',
  system: 'a job of no org',
  conflict: 'its key, group and data name different orgs',
};

/** Takes one dead letter: the Inbox item of its org, or a log line when it has none. */
export async function takeDeadLetter(runtime: Runtime, job: DeadLetter): Promise<'raised' | 'counted' | 'system' | 'conflict' | 'refused'> {
  const owner = deadLetterOrg(job);
  const queue = job.sourceName && QUEUE_NAME.test(job.sourceName) ? job.sourceName : 'an unknown queue';
  const ref = (job.sourceId ?? job.id).slice(0, 8);
  if (owner.orgId === null) {
    if (owner.reason === 'no_source') throw new Error(`[dead-letter] job ${ref}: ${WHY.no_source}`);
    console.warn(`[dead-letter] ${queue} job ${ref}: ${WHY[owner.reason]}, so no Inbox item; the prober counts the failed job`);
    return owner.reason;
  }
  let done: { raised: boolean; failures: number };
  try {
    done = await runtime.execute<{ raised: boolean; failures: number }>(
      'kernel.job.dead_letter',
      // deadLetterOrg checked the source queue and job id.
      { queue, jobId: job.sourceId as string, retries: Math.max(0, job.sourceRetryCount ?? 0) },
      { actor: { type: 'system', component: 'kernel.job' }, orgId: owner.orgId, idempotencyKey: `dead-letter:${job.sourceId as string}` },
    );
  } catch (error) {
    // The system context refuses an org that is not active (TENANT_NOT_ACTIVE, answered FORBIDDEN).
    if (!(error instanceof DomainError) || error.code !== 'FORBIDDEN') throw error;
    console.warn(`[dead-letter] ${queue} job ${ref} of org ${owner.orgId.slice(0, 8)}: the org refused it (closed?), so no Inbox item; the prober counts the failed job`);
    return 'refused';
  }
  console.log(`[dead-letter] ${queue} job ${ref} of org ${owner.orgId.slice(0, 8)}: ${done.raised ? 'Inbox item raised' : `counted on the open item (${done.failures} today)`}`);
  return done.raised ? 'raised' : 'counted';
}

/**
 * The daily prune of old Inbox items (#1747): every org with some, page after page by org id, each in its own system
 * context, so an org that cannot be pruned (or one that fills up again) never holds the others back. The command
 * applies the cut-offs at its own time; these only pick the orgs. Logs org prefixes.
 */
export async function pruneInboxItems(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { dismissedBefore, raisedBefore } = inboxPruneCutoffs(new Date());
  let removed = 0;
  let after: string | null = null;
  for (let page = 0; page < INBOX_PRUNE_PAGES; page++) {
    const { rows }: { rows: Array<{ org_id: string }> } = await sql<{ org_id: string }>`
      SELECT org_id FROM crove_kernel.inbox_item_prune_due(${after}::uuid, ${dismissedBefore}::timestamptz, ${raisedBefore}::timestamptz, ${INBOX_PRUNE_PAGE}::int)`.execute(
      deps.workerDb,
    );
    for (const row of rows) {
      try {
        removed += (await deps.runtime.execute<{ removed: number }>('kernel.inbox.prune', {}, { actor: { type: 'system', component: 'kernel.job' }, orgId: row.org_id })).removed;
      } catch (error) {
        console.warn(`[inbox-prune] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
      }
    }
    if (rows.length < INBOX_PRUNE_PAGE) return removed;
    after = rows[rows.length - 1]?.org_id ?? null;
  }
  opsAlert(`[inbox-prune] ALERT more than ${INBOX_PRUNE_PAGES * INBOX_PRUNE_PAGE} orgs to prune; the rest wait for the next night`);
  return removed;
}
