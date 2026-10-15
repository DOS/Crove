// Extractions of a file and re-extraction (issue #40, plan §8.4). Every run of the extraction job on a file is a
// numbered version (crove_kernel.extraction.version); a version is never overwritten. The proposal read from a file
// follows its newest successful version: a re-extraction becomes a new revision of the pending proposal, through
// the same revision mechanism as an edit (#87), so an approval of the earlier revision never carries over.
//
// Concurrency: every command that writes a file's extractions locks the file row first (FOR UPDATE), then the
// file's proposal. Approve, edit and reject lock the proposal and then refuse while a re-extraction is pending.
// A pending run is at most one per file (partial UNIQUE index), and the database numbers versions.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { actorRef, addAuthor, eligibleApprovers, parseAuthors, type ActorRef } from './approval.ts';

// Who may ask for a re-extraction: the roles that may edit a proposal (EDITOR_ROLES in approval.ts). A
// re-extraction changes a pending proposal's content as an edit does, and never approves anything.
const REEXTRACT_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];
// A pending run older than this is presumed lost (the worker retries for a few minutes, then records a failure):
// it no longer blocks decisions on the proposal, a new request replaces it, and if its job still finishes, the
// result is kept in the file's history but never applied to a proposal. The rule uses only the database clock
// (created_at against now() or clock_timestamp()), never the app server's, so clock skew between the two cannot
// move it.
export const REEXTRACT_STALE_MINUTES = 15;
// What a pending run that went stale shows as its error.
export const STALE_RUN_ERROR = 'Đọc lại quá lâu nên đã dừng; hãy bấm Đọc lại để thử lại';
// Extraction runs one file may have. Each run can cost an AI call; one pending run at a time is the main limit.
export const MAX_EXTRACTION_VERSIONS = 20;

export const zProposalDraft = z.object({
  kind: z.string(),
  command: z.string(),
  title: z.string().max(300),
  payload: z.record(z.string(), z.unknown()),
  duplicateOf: zId.nullable(),
});

// In flight: created within the stale window, measured at the start of the transaction (now()). A decision that
// passes this check started after the run went stale.
const pendingSince = sql<boolean>`created_at > pg_catalog.now() - pg_catalog.make_interval(mins => ${REEXTRACT_STALE_MINUTES}::int)`;

export interface LatestExtraction {
  id: string;
  version: number;
  status: 'pending' | 'done' | 'failed';
  error: string | null;
  // A pending run that is not stale.
  inFlight: boolean;
}

// The file's newest extraction run, or undefined if it has not been read yet.
export async function latestExtraction(ctx: QueryContext, fileId: string): Promise<LatestExtraction | undefined> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.extraction')
    .select(['id', 'version', 'status', 'error', pendingSince.as('fresh')])
    .where('org_id', '=', ctx.orgId)
    .where('file_id', '=', fileId)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  const inFlight = row.status === 'pending' && row.fresh;
  const error = row.status === 'pending' && !inFlight ? STALE_RUN_ERROR : row.error;
  return { id: row.id, version: row.version, status: row.status, error, inFlight };
}

// Refuses a decision (approve, edit, reject) on a proposal whose file is being read again: the result would
// replace the content being decided on. Called after the proposal row is locked, so a re-extraction requested
// first is seen here, and one requested later finds the decided proposal.
export async function refuseWhileReextracting(ctx: CommandContext, fileId: string | null): Promise<void> {
  if (!fileId) return;
  const pending = await ctx.trx
    .selectFrom('crove_kernel.extraction')
    .select('version')
    .where('org_id', '=', ctx.orgId)
    .where('file_id', '=', fileId)
    .where('status', '=', 'pending')
    .where(pendingSince)
    .executeTakeFirst();
  if (pending) {
    throw new DomainError('EXTRACTION_PENDING', 409, 'Chứng từ đang được đọc lại; hãy chờ kết quả rồi thử lại', { version: pending.version });
  }
}

async function lockFile(ctx: CommandContext, fileId: string) {
  const file = await ctx.trx
    .selectFrom('crove_kernel.file')
    .select(['id', 'filename', 'created_by'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', fileId)
    .forUpdate()
    .executeTakeFirst();
  if (!file) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp');
  return file;
}

// The file's newest proposal, locked. A file has one proposal unless an earlier one was rejected and the file was
// read again.
async function lockFileProposal(ctx: CommandContext, fileId: string) {
  return ctx.trx
    .selectFrom('crove_kernel.proposal')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('source_file_id', '=', fileId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .forUpdate()
    .executeTakeFirst();
}

// Asks for the file to be read again. The API never parses: this records a pending run and emits
// kernel.file.reextract_requested, which the worker relays to the extraction job, as for an upload.
// R1: internal and it decides nothing (the result is a new revision that still needs an approval).
export const reextractFile = defineCommand({
  name: 'kernel.file.reextract',
  input: z.object({ fileId: zId }),
  risk: 'R1',
  access: REEXTRACT_ROLES,
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới yêu cầu đọc lại được');
    const file = await lockFile(ctx, input.fileId);
    const latest = await latestExtraction(ctx, input.fileId);
    if (!latest) throw new DomainError('EXTRACTION_PENDING', 409, 'Tệp đang được đọc lần đầu; hãy chờ kết quả');
    if (latest.inFlight) {
      throw new DomainError('EXTRACTION_PENDING', 409, 'Tệp đang được đọc lại; hãy chờ kết quả', { version: latest.version });
    }
    if (latest.version >= MAX_EXTRACTION_VERSIONS) {
      throw new DomainError('REEXTRACT_LIMIT', 409, `Tệp này đã được đọc ${latest.version} lần, không đọc lại thêm được`, {
        limit: MAX_EXTRACTION_VERSIONS,
      });
    }
    const proposal = await lockFileProposal(ctx, input.fileId);
    if (proposal?.status === 'executed') {
      throw new DomainError('PROPOSAL_DECIDED', 409, 'Hóa đơn này đã được ghi sổ nên không đọc lại được');
    }
    let superseded: number | null = null;
    if (latest.status === 'pending') {
      // A stale run (presumed lost) is closed as failed; if its job still finishes, it finds no pending run.
      await ctx.trx
        .updateTable('crove_kernel.extraction')
        .set({ status: 'failed', error: 'Quá thời gian chờ đọc lại; đã yêu cầu đọc lại lần nữa', completed_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', latest.id)
        .where('status', '=', 'pending')
        .execute();
      superseded = latest.version;
    }
    const run = await ctx.trx
      .insertInto('crove_kernel.extraction')
      .values({
        org_id: ctx.orgId,
        file_id: input.fileId,
        method: null,
        status: 'pending',
        result: null,
        checks: '[]',
        error: null,
        // The trigger sets it from the sealed context anyway (a tenant role cannot name another requester).
        requested_by: ctx.actor.userId,
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    ctx.audit({
      version: run.version,
      previous_version: latest.version,
      superseded_version: superseded,
      proposal_id: proposal?.id ?? null,
      proposal_revision: proposal?.revision ?? null,
    });
    await ctx.activity('kernel.file', input.fileId, 'extraction.requested', `Yêu cầu đọc lại ${file.filename} (lần đọc ${run.version})`);
    await ctx.emit('kernel.file.reextract_requested', { fileId: input.fileId, version: run.version });
    return { fileId: input.fileId, version: run.version };
  },
});

// Records the result of an extraction run (worker only). Without `version` it is the first extraction of a new
// file (a no-op once the file has any run). With `version` it finishes that pending re-extraction (a no-op if the
// run is no longer pending), and the file's pending proposal gets a new revision with the new content.
export const recordExtraction = defineCommand({
  name: 'kernel.extraction.record',
  input: z.object({
    fileId: zId,
    version: z.number().int().positive().optional(),
    method: z.enum(['einvoice_xml', 'pdf_text_ai', 'image_ai', 'unsupported']),
    status: z.enum(['done', 'failed']),
    result: z.unknown().nullable(),
    checks: z.array(z.object({ id: z.string(), status: z.enum(['pass', 'warn', 'fail']), message: z.string() })),
    error: z.string().max(2000).nullable(),
    proposal: zProposalDraft.nullable(),
  }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input) => {
    const file = await lockFile(ctx, input.fileId);
    const outcome = {
      method: input.method,
      status: input.status,
      result: input.result === null ? null : JSON.stringify(input.result),
      checks: JSON.stringify(input.checks),
      error: input.error,
      completed_at: ctx.now,
    };
    let run: { id: string; version: number; requested_by: string | null };
    let current: Awaited<ReturnType<typeof lockFileProposal>>;
    // Whether this run may change a proposal: always for the first extraction; for a re-extraction only while it is
    // still in flight.
    let applies = true;
    if (input.version === undefined) {
      const existing = await ctx.trx
        .selectFrom('crove_kernel.extraction')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('file_id', '=', input.fileId)
        .limit(1)
        .executeTakeFirst();
      if (existing) return { extractionId: existing.id, proposalId: null, duplicate: true };
      run = await ctx.trx
        .insertInto('crove_kernel.extraction')
        .values({ org_id: ctx.orgId, file_id: input.fileId, ...outcome })
        .returning(['id', 'version', 'requested_by'])
        .executeTakeFirstOrThrow();
      current = undefined;
    } else {
      const pending = await ctx.trx
        .selectFrom('crove_kernel.extraction')
        .select(['id', 'version', 'status', 'requested_by'])
        .where('org_id', '=', ctx.orgId)
        .where('file_id', '=', input.fileId)
        .where('version', '=', input.version)
        .forUpdate()
        .executeTakeFirst();
      if (!pending || pending.status !== 'pending') return { extractionId: pending?.id ?? null, proposalId: null, duplicate: true };
      // The proposal is locked before the run's age is read, and the age is read on the clock at this moment
      // (clock_timestamp()), not at the start of the transaction: a decision that went through because the run was
      // stale either committed before this lock, and then the run is older still here, or waits for this command
      // and then finds a newer revision (STALE_REVISION).
      current = await lockFileProposal(ctx, input.fileId);
      const { rows } = await sql<{ fresh: boolean }>`
        SELECT created_at > pg_catalog.clock_timestamp() - pg_catalog.make_interval(mins => ${REEXTRACT_STALE_MINUTES}::int) AS fresh
        FROM crove_kernel.extraction WHERE org_id = ${ctx.orgId}::uuid AND id = ${pending.id}::uuid`.execute(ctx.trx);
      applies = rows[0]?.fresh === true;
      await ctx.trx
        .updateTable('crove_kernel.extraction')
        .set(outcome)
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', pending.id)
        .execute();
      run = pending;
    }
    ctx.audit({ version: run.version, status: input.status, applied: applies });

    // Authors (P10): the extraction itself, the user who uploaded the source file (the content is read from what
    // they supplied; a forwarded email has no authenticated sender, so it adds nobody) and, for a re-extraction,
    // the user who asked for it (they chose to replace the content with a new reading).
    const readers: ActorRef[] = [actorRef(ctx.actor)];
    if (file.created_by) readers.push({ type: 'user', id: file.created_by });
    if (run.requested_by) readers.push({ type: 'user', id: run.requested_by });
    const withReaders = (authors: ActorRef[]) => readers.reduce(addAuthor, authors);

    if (!input.proposal) {
      await ctx.activity('kernel.file', input.fileId, 'extraction.failed', input.error ?? 'Không đọc được chứng từ');
      if (applies && current?.status === 'pending') {
        await ctx.activity('kernel.proposal', current.id, 'proposal.reextract_failed', `Đọc lại không thành công (lần đọc ${run.version}); đề xuất giữ nguyên bản ${current.revision}`);
      }
      return { extractionId: run.id, proposalId: null, duplicate: false };
    }

    // A run that went stale is presumed lost: decisions and edits may have happened since, so its late result stays
    // in the file's history only. An executed proposal is never followed by a new one: the invoice is in the books,
    // and a request on it is refused.
    if (!applies || current?.status === 'executed') {
      await ctx.activity('kernel.file', input.fileId, 'extraction.not_applied', `Kết quả đọc lại (lần đọc ${run.version}) đến quá muộn hoặc đề xuất đã được xử lý nên không được áp dụng`);
      return { extractionId: run.id, proposalId: null, duplicate: false };
    }

    if (current?.status === 'pending') {
      const authors = parseAuthors(current.authors);
      // A pending proposal always records its authors (constraint proposal_policy_recorded); fail closed anyway.
      if (!authors) throw new DomainError('NOT_EDITABLE', 422, 'Đề xuất thiếu thông tin người soạn nên không cập nhật được');
      const revision = current.revision + 1;
      await ctx.trx
        .updateTable('crove_kernel.proposal')
        .set({
          title: input.proposal.title,
          payload: JSON.stringify(input.proposal.payload),
          duplicate_of: input.proposal.duplicateOf,
          extraction_id: run.id,
          revision,
          authors: JSON.stringify(withReaders(authors)),
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', current.id)
        .execute();
      ctx.audit({ proposal_id: current.id, revision });
      await ctx.activity('kernel.proposal', current.id, 'proposal.reextracted', `Đọc lại chứng từ (lần đọc ${run.version}, bản ${revision}): ${input.proposal.title}`);
      return { extractionId: run.id, proposalId: current.id, duplicate: false };
    }

    // The first proposal of the file, or a new one after a rejected proposal (the file was read again on purpose).
    // A rejection while the run was in flight is refused, so this rejection came before the request.
    const proposal = await ctx.trx
      .insertInto('crove_kernel.proposal')
      .values({
        org_id: ctx.orgId,
        kind: input.proposal.kind,
        command: input.proposal.command,
        title: input.proposal.title,
        payload: JSON.stringify(input.proposal.payload),
        source_file_id: input.fileId,
        extraction_id: run.id,
        duplicate_of: input.proposal.duplicateOf,
        // P12: who may approve this command right now; approval re-checks each one's role live.
        eligible_approvers: await eligibleApprovers(ctx.trx, ctx.orgId, input.proposal.command),
        authors: JSON.stringify(withReaders([])),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (current) ctx.audit({ proposal_id: proposal.id, replaces_proposal_id: current.id });
    await ctx.activity('kernel.proposal', proposal.id, 'proposal.created', input.proposal.title);
    await ctx.emit('kernel.proposal.created', { proposalId: proposal.id, kind: input.proposal.kind });
    return { extractionId: run.id, proposalId: proposal.id, duplicate: false };
  },
});

export const extractionCommands = [reextractFile, recordExtraction];
