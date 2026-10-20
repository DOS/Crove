// How the Inbox shows a file: being read, read into a proposal (or a likely duplicate), failed, or, for a ZIP archive
// (#314), opened into files of its own. Shared by files.recent and files.batch.
import { sql } from 'kysely';
import { z } from 'zod';
import { ARCHIVE_ENTRY_REASONS, zId, type FileStatus } from '@crove/kernel-contract';
import type { QueryContext } from '@crove/kernel-runtime';
import { EDITOR_ROLES } from './approval.ts';
import { MAX_EXTRACTION_VERSIONS, REEXTRACT_STALE_MINUTES, STALE_RUN_ERROR, voidedProposals } from './extraction.ts';
import { isArchiveType } from './files.ts';

// What kernel.file.archive.record keeps in the archive's extraction result, one item per entry.
export const zStoredArchiveEntry = z.object({
  name: z.string(),
  outcome: z.enum(['stored', 'duplicate', 'rejected']),
  reason: z.enum(ARCHIVE_ENTRY_REASONS).nullable(),
  fileId: zId.nullable(),
});
export type StoredArchiveEntry = z.infer<typeof zStoredArchiveEntry>;

export interface FileStatusRow {
  status: FileStatus;
  // How many entries an opened archive has; null for any other file, and for an archive not opened (yet, or at all).
  // The entries themselves are read apart and in slices (archiveEntries), so no listing loads them all.
  entryCount: number | null;
}

export type FileStatusFilter = { ids: readonly string[] } | { recent: number };

export async function fileStatuses(ctx: QueryContext, filter: FileStatusFilter): Promise<FileStatusRow[]> {
  if ('ids' in filter && filter.ids.length === 0) return [];
  // Per file: its newest extraction run and its newest proposal (a file read again after a rejection has more
  // than one).
  let query = ctx.trx
    .selectFrom('crove_kernel.file as f')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('crove_kernel.extraction as x')
          .select([
            'x.status',
            'x.error',
            'x.version',
            'x.method',
            // Only the size of an opened archive's entry list, from its own column (#432): neither the list nor an
            // invoice's result is loaded here.
            sql<number | null>`CASE WHEN x.method = 'archive' AND x.status = 'done' THEN x.entry_count END`.as('entry_count'),
            sql<boolean>`x.status = 'pending' AND x.created_at > pg_catalog.now() - pg_catalog.make_interval(mins => ${REEXTRACT_STALE_MINUTES}::int)`.as(
              'in_flight',
            ),
          ])
          .whereRef('x.org_id', '=', 'f.org_id')
          .whereRef('x.file_id', '=', 'f.id')
          .orderBy('x.version', 'desc')
          .limit(1)
          .as('e'),
      (join) => join.onTrue(),
    )
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('crove_kernel.proposal as q')
          .select(['q.id', 'q.status', 'q.duplicate_of'])
          .whereRef('q.org_id', '=', 'f.org_id')
          .whereRef('q.source_file_id', '=', 'f.id')
          .orderBy('q.created_at', 'desc')
          .orderBy('q.id', 'desc')
          .limit(1)
          .as('p'),
      (join) => join.onTrue(),
    )
    .select([
      'f.id',
      'f.filename',
      'f.content_type',
      'f.created_at',
      'e.status as extraction_status',
      'e.error',
      'e.version',
      'e.method',
      'e.entry_count',
      'e.in_flight',
      'p.id as proposal_id',
      'p.status as proposal_status',
      'p.duplicate_of',
    ])
    .where('f.org_id', '=', ctx.orgId)
    // Images of Social posts (#372) and import spreadsheets (#465) are not documents, unless the same bytes were also
    // uploaded as one and read.
    .where((eb) => eb.or([eb('f.source', 'not in', ['social', 'import']), eb('e.status', 'is not', null)]));
  query = 'ids' in filter ? query.where('f.id', 'in', [...filter.ids]) : query.orderBy('f.created_at', 'desc').limit(filter.recent);
  const rows = await query.execute();
  // An executed purchase whose document was voided by a reversal (#165) may be read again.
  const voided = await voidedProposals(
    ctx,
    rows.flatMap((r) => (r.proposal_id && r.proposal_status === 'executed' ? [r.proposal_id] : [])),
  );
  const editor = ctx.actor.type === 'user' && ctx.role !== null && EDITOR_ROLES.includes(ctx.role);
  return rows.map((r) => {
    const archive = isArchiveType(r.content_type);
    const status: FileStatus['status'] =
      !r.extraction_status || r.in_flight
        ? 'processing'
        : r.method === 'archive'
          ? r.extraction_status === 'done'
            ? 'expanded'
            : 'failed'
          : r.proposal_id
            ? r.duplicate_of
              ? 'duplicate'
              : 'proposed'
            : 'failed';
    return {
      status: {
        id: r.id,
        filename: r.filename,
        contentType: r.content_type,
        status,
        error: r.extraction_status === 'failed' ? r.error : r.extraction_status === 'pending' && !r.in_flight ? STALE_RUN_ERROR : null,
        proposalId: r.proposal_id,
        version: r.version ?? null,
        // The same checks kernel.file.reextract makes; an archive is opened once and never read again.
        canReextract:
          editor &&
          !archive &&
          Boolean(r.extraction_status) &&
          !r.in_flight &&
          (r.proposal_status !== 'executed' || (r.proposal_id !== null && voided.has(r.proposal_id))) &&
          (r.version ?? 0) < MAX_EXTRACTION_VERSIONS,
        createdAt: r.created_at.toISOString(),
      },
      entryCount: r.entry_count === null || r.entry_count === undefined ? null : Number(r.entry_count),
    };
  });
}

// The first `limit` entries of each opened archive asked for, sliced in the database (jsonpath), so a response holds at
// most the sum of the limits. Archives of other orgs, or not opened, read as missing.
export async function archiveEntries(ctx: QueryContext, slices: ReadonlyArray<{ fileId: string; limit: number }>): Promise<Map<string, StoredArchiveEntry[]>> {
  const wanted = slices.filter((s) => s.limit > 0);
  if (wanted.length === 0) return new Map();
  const { rows } = await sql<{ file_id: string; entries: unknown }>`
    SELECT x.file_id, pg_catalog.jsonb_path_query_array(x.result, '$.entries[0 to $last]', pg_catalog.jsonb_build_object('last', s.n - 1)) AS entries
    FROM ROWS FROM (pg_catalog.unnest(${wanted.map((s) => s.fileId)}::uuid[]), pg_catalog.unnest(${wanted.map((s) => s.limit)}::int[])) AS s(file_id, n)
    JOIN crove_kernel.extraction x ON x.org_id = ${ctx.orgId}::uuid AND x.file_id = s.file_id AND x.method = 'archive' AND x.status = 'done'`.execute(ctx.trx);
  const out = new Map<string, StoredArchiveEntry[]>();
  for (const row of rows) {
    const parsed = z.array(zStoredArchiveEntry).safeParse(row.entries);
    if (parsed.success) out.set(row.file_id, parsed.data);
  }
  return out;
}