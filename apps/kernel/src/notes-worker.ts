// The worker's part of the notes module (issue #1671, ADR-0037 §4): a former member's private notes are removed 30 days
// after they left, and the trash is emptied daily. startWorker() works and queues these jobs only when the module is
// installed (Runtime.installed('notes'), CROVE_MODULES), so a deployment without notes neither queues nor works them.
// Jobs carry ids only; the commands run in the org's system context and reach private notes through definers that
// answer counts, never text.
import { sql } from 'kysely';
import type { PgBoss } from 'pg-boss';
import type { Db } from '@crove/db';
import { NOTE_MEMBER_PURGE_DAYS } from '@crove/kernel-contract';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import { trashCutoff } from '@crove/mod-notes';
import { jobKey } from './job-keys.ts';
import { QUEUES } from './jobs-schema.ts';

// After the nightly retention purge (02:30), on the same clock.
export const NOTES_TRASH_CRON = '45 2 * * *';
export const NOTES_TRASH_TZ = 'Asia/Ho_Chi_Minh';
// Orgs one sweep empties at most; the rest wait for the next night.
const TRASH_SWEEP_ORGS = 500;
const MEMBER_PURGE_RETRY_LIMIT = 5;

export interface NotesMemberPurgeJob {
  orgId: string;
  userId: string;
}

const ACTOR = { type: 'system' as const, component: 'notes' };

// A member removed (kernel.member.removed, payload userId): their private notes are removed NOTE_MEMBER_PURGE_DAYS later,
// unless they are a member again by then (the definer checks). One job per removal event. pg-boss keeps a delayed job
// for its retention window counted from its start time, so a job 30 days ahead is not dropped before it runs.
export function queueNotesMemberPurge(boss: PgBoss, row: { org_id: string; event_id: string; type: string; payload: Record<string, unknown> }, now = new Date()) {
  if (row.type !== 'kernel.member.removed' || typeof row.payload.userId !== 'string') return null;
  const userId = row.payload.userId;
  return boss.send(QUEUES.notesMemberPurge, { orgId: row.org_id, userId } satisfies NotesMemberPurgeJob, {
    singletonKey: jobKey(row.org_id, QUEUES.notesMemberPurge, `${userId}:${row.event_id}`),
    startAfter: new Date(now.getTime() + NOTE_MEMBER_PURGE_DAYS * 86_400_000),
    retryLimit: MEMBER_PURGE_RETRY_LIMIT,
    retryDelay: 60,
    retryBackoff: true,
  });
}

// One pass of the trash: every org with notes in the trash past the limit, emptied in its own system context. Logs ids
// and codes only.
export async function sweepNotesTrash(deps: { runtime: Runtime; workerDb: Db }, now = new Date()): Promise<number> {
  const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_notes.trash_due(${trashCutoff(now)}::timestamptz, ${TRASH_SWEEP_ORGS}::int)`.execute(deps.workerDb);
  let removed = 0;
  for (const row of rows) {
    try {
      const done = await deps.runtime.execute<{ removed: number }>('notes.trash.empty', {}, { actor: ACTOR, orgId: row.org_id });
      removed += done.removed;
    } catch (error) {
      console.warn(`[notes-trash] org ${row.org_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
    }
  }
  return removed;
}

// A queued purge: the former member's private notes in that org, unless they are a member again.
export async function runNotesMemberPurge(runtime: Runtime, job: NotesMemberPurgeJob): Promise<void> {
  const done = await runtime.execute<{ removed: number }>('notes.member_items.purge', { userId: job.userId }, { actor: ACTOR, orgId: job.orgId });
  console.log(`[notes-member-purge] org ${job.orgId.slice(0, 8)}: removed ${done.removed}`);
}
