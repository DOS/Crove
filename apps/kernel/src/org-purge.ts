// The `org-purge` image role (issue #1024, plan §7.9 step 3): the deployment operator applies the offboarding
// deletion map (docs/runbooks/org-offboarding.md) to an org and closes it. Run by hand in the worker's container,
// never automatically (the worker login is the only role that may execute crove_kernel.org_purge_check and
// crove_kernel.org_purge, and enter the system context the purge runs in):
//
//   org-purge <org slug or id> --reason <text>
//
// The database decides whether the org may go (crove_kernel.org_purge_refusal): it is in offboarding, has an export of
// the current format that the owner has not asked to replace since, and that export is at least ORG_PURGE_MIN_DAYS old
// (30 at least). The purge runs as one command, kernel.org.purge, in one transaction: the definer deletes the rows,
// sets status = 'closed' and answers the storage keys of the deleted files, whose blobs the command deletes before it
// commits. A failure anywhere rolls the rows back; the blobs already deleted belonged to files the purge deletes
// anyway, so running it again finishes the job. Its audit row holds the counts per table and the reason, no personal
// data. A run on an org it already closed changes nothing.
// Exit codes: 0 done or already closed, 1 refused (a precondition is not met), 2 the command could not run.
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError, defineCommand, type Actor, type BlobStore, type CommandDef, type Runtime } from '@crove/kernel-runtime';

export const ORG_PURGE_EXIT = { ok: 0, refused: 1, failed: 2 } as const;
// The database refuses fewer days (crove_kernel.org_purge_refusal); a deployment may only wait longer.
export const ORG_PURGE_MIN_DAYS_FLOOR = 30;
export const ORG_PURGE_MAX_DAYS = 3650;
// Blob deletes in flight at once, as the retention sweeps.
const BLOB_DELETES_IN_FLIGHT = 10;

const OPERATOR: Actor = { type: 'system', component: 'operator' };

// Why the database refused, for the operator. Same words as the outcomes of crove_kernel.org_purge_refusal.
export const ORG_PURGE_REFUSALS: Record<string, string> = {
  invalid: `ORG_PURGE_MIN_DAYS must be ${ORG_PURGE_MIN_DAYS_FLOOR} to ${ORG_PURGE_MAX_DAYS}`,
  not_found: 'no org has this id or slug',
  closed: 'the org is already closed',
  not_offboarding: 'the org is not in offboarding: its owner starts that (org.offboard)',
  export_missing: 'the org has no finished export of the current format',
  export_pending: 'the owner asked for a newer export, which has not finished',
  too_early: 'the newest export is younger than ORG_PURGE_MIN_DAYS',
};

// Whether a blob is under a retention hold, which the purge then leaves in place and reports. Unset in the operator's
// runtime: the evidence holds of #1009 go only on the original files of posted invoices, and the purge keeps every file
// a purchase document references (crove_kernel.org_purge), so no key it hands back is held by Crove. A store-side hold
// Crove did not set (a bucket default retention) refuses the delete itself on a versioned bucket's version.
export type HeldCheck = (key: string) => Promise<boolean>;

export const zOrgPurge = z.strictObject({
  minDays: z.number().int().min(ORG_PURGE_MIN_DAYS_FLOOR).max(ORG_PURGE_MAX_DAYS),
  reason: z.string().trim().min(1).max(500),
});

export interface OrgPurgeCounts {
  deleted: Record<string, number>;
  pinned: Record<string, number>;
  anonymized: Record<string, number>;
  keptFiles: number;
  keptParties: number;
  keptProposals: number;
}

export interface OrgPurgeResult {
  counts: OrgPurgeCounts;
  blobs: { deleted: number; held: number };
}

// Deletes the blobs no kept file uses; held ones stay.
async function deleteBlobs(store: BlobStore, held: HeldCheck | null, keys: readonly string[]): Promise<{ deleted: number; held: number }> {
  let deleted = 0;
  let kept = 0;
  for (let i = 0; i < keys.length; i += BLOB_DELETES_IN_FLIGHT) {
    await Promise.all(
      keys.slice(i, i + BLOB_DELETES_IN_FLIGHT).map(async (key) => {
        if (held && (await held(key))) {
          kept++;
          return;
        }
        await store.delete(key);
        deleted++;
      }),
    );
  }
  return { deleted, held: kept };
}

// The command, for the operator's runtime only (it needs the blob store). System actor only; the definer checks again
// that the session is the worker's and the context the org's system context.
export function orgPurgeCommand(deps: { store: BlobStore; held?: HeldCheck | null }): CommandDef<z.infer<typeof zOrgPurge>, OrgPurgeResult> {
  return defineCommand({
    name: 'kernel.org.purge',
    input: zOrgPurge,
    risk: 'R3',
    access: 'system',
    handler: async (ctx, input) => {
      // A large org takes longer than the pool's limits (15 s per statement, 10 s idle between them); local to this
      // transaction.
      await sql`SELECT pg_catalog.set_config('statement_timeout', '30min', true), pg_catalog.set_config('idle_in_transaction_session_timeout', '30min', true)`.execute(
        ctx.trx,
      );
      const { rows } = await sql<{ outcome: string; counts: OrgPurgeCounts | null; blob_keys: string[] | null }>`
        SELECT outcome, counts, blob_keys FROM crove_kernel.org_purge(${input.minDays}::int)`.execute(ctx.trx);
      const row = rows[0];
      if (!row) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      if (row.outcome !== 'ok' || !row.counts) {
        throw new DomainError('ORG_PURGE_REFUSED', 409, ORG_PURGE_REFUSALS[row.outcome] ?? row.outcome, { refusal: row.outcome });
      }
      // A failed delete fails the command, so the rows come back; the operator runs it again once the store answers.
      const blobs = await deleteBlobs(deps.store, deps.held ?? null, row.blob_keys ?? []).catch((e: unknown) => {
        throw new DomainError('ORG_PURGE_BLOB_FAILED', 503, `a blob could not be deleted, nothing was purged: ${e instanceof Error ? e.message : String(e)}`);
      });
      ctx.audit({ reason: input.reason, minDays: input.minDays, counts: row.counts, blobs });
      return { counts: row.counts, blobs };
    },
  });
}

export interface OrgPurgeArgs {
  ref: string;
  reason: string;
}

export function parseOrgPurgeArgs(argv: readonly string[]): OrgPurgeArgs {
  let ref: string | null = null;
  let reason: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--reason') {
      reason = (argv[++i] ?? '').trim();
      if (reason === '' || reason.length > 500) throw new Error('--reason needs a text of 1 to 500 characters');
    } else if (arg?.startsWith('--')) {
      throw new Error(`unknown argument ${arg}; use <org slug or id> --reason <text>`);
    } else if (ref === null && arg) {
      ref = arg.trim();
    } else {
      throw new Error('name one org: <org slug or id> --reason <text>');
    }
  }
  if (!ref || ref.length > 200) throw new Error('name the org: its slug or its id');
  if (reason === null) throw new Error('--reason is required: it goes into the org audit log');
  return { ref, reason };
}

interface CheckRow {
  outcome: string;
  org_id: string | null;
  status: string | null;
  exported_at: Date | null;
  refusal: string | null;
}

export type OrgPurgeOutcome =
  | { kind: 'purged'; orgId: string; result: OrgPurgeResult }
  | { kind: 'already_closed'; orgId: string }
  | { kind: 'refused'; orgId: string | null; refusal: string };

export async function purgeOrg(runtime: Pick<Runtime, 'orgless' | 'execute'>, minDays: number, args: OrgPurgeArgs): Promise<OrgPurgeOutcome> {
  const check = await runtime.orgless(async (db) => {
    const { rows } = await sql<CheckRow>`SELECT outcome, org_id, status, exported_at, refusal FROM crove_kernel.org_purge_check(${args.ref})`.execute(db);
    return rows[0];
  });
  if (!check) throw new Error('crove_kernel.org_purge_check returned no row');
  if (check.outcome !== 'ok' || !check.org_id) return { kind: 'refused', orgId: null, refusal: check.outcome };
  if (check.status === 'closed') return { kind: 'already_closed', orgId: check.org_id };
  try {
    const result = await runtime.execute<OrgPurgeResult>('kernel.org.purge', { minDays, reason: args.reason }, { actor: OPERATOR, orgId: check.org_id });
    return { kind: 'purged', orgId: check.org_id, result };
  } catch (e) {
    if (e instanceof DomainError && e.code === 'ORG_PURGE_REFUSED' && typeof e.details?.refusal === 'string') {
      return { kind: 'refused', orgId: check.org_id, refusal: e.details.refusal };
    }
    throw e;
  }
}

export interface OrgPurgeDeps {
  runtime: Pick<Runtime, 'orgless' | 'execute'>;
  minDays: number;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const sum = (counts: Record<string, number>) => Object.values(counts).reduce((n, c) => n + c, 0);
const nonZero = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table}=${n}`)
    .join(' ') || 'none';

export async function runOrgPurge(deps: OrgPurgeDeps, argv: readonly string[]): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  let args: OrgPurgeArgs;
  try {
    args = parseOrgPurgeArgs(argv);
  } catch (e) {
    error(`[org-purge] ${e instanceof Error ? e.message : String(e)}`);
    return ORG_PURGE_EXIT.failed;
  }
  try {
    const outcome = await purgeOrg(deps.runtime, deps.minDays, args);
    if (outcome.kind === 'refused') {
      error(`[org-purge] refused${outcome.orgId ? ` for org ${outcome.orgId}` : ''}: ${ORG_PURGE_REFUSALS[outcome.refusal] ?? outcome.refusal}`);
      return ORG_PURGE_EXIT.refused;
    }
    if (outcome.kind === 'already_closed') {
      log(`[org-purge] org ${outcome.orgId} is already closed; nothing to do`);
      return ORG_PURGE_EXIT.ok;
    }
    const { counts, blobs } = outcome.result;
    log(`[org-purge] org ${outcome.orgId} is now closed; deleted ${sum(counts.deleted)} row(s): ${nonZero(counts.deleted)}`);
    log(
      `[org-purge] kept ${counts.keptFiles} file(s), ${counts.keptParties} part(ies) and ${counts.keptProposals} proposal(s) the books reference (${nonZero(counts.anonymized)} anonymized); pinned by append-only rows: ${nonZero(counts.pinned)}`,
    );
    log(`[org-purge] blobs deleted ${blobs.deleted}, held ${blobs.held}${blobs.held > 0 ? ' (under a retention hold, left in place)' : ''}`);
    return ORG_PURGE_EXIT.ok;
  } catch (e) {
    error(`[org-purge] ${oneLine(e instanceof Error ? e.message : String(e))}`);
    return ORG_PURGE_EXIT.failed;
  }
}
