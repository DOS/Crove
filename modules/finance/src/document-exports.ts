// The exports a recorded document went out in (#878), for its history on the Inbox page: every journal export, and
// every MISA export of its direction made while it was in force, whose date range took in its entry's date. Exports
// record their range since #878; an older export without one is not guessed at. Since #1398 a purchase's stock lines
// (152, 153, 156) go to the goods file and its other lines to the services file: each lists only documents with lines
// of its kind, and a services file made before the split (no `stockLines` in its audit row) every purchase.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, type DocumentExport } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { latestRevision } from './source-entry.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The most exports one history shows.
export const DOCUMENT_EXPORT_LIMIT = 100;

export const documentExports = defineQuery({
  name: 'finance.document.exports',
  input: z.object({ documentId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<DocumentExport[]> => {
    // The document, its entry's date and when it was posted and voided, all read in the query so dates stay dates.
    const found = await ctx.trx
      .selectFrom('crove_finance.purchase_document')
      .select(['id', 'direction'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.documentId)
      .executeTakeFirst();
    if (!found) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy chứng từ');
    const misa = found.direction === 'sale' ? 'misa_sme_sales' : 'misa_sme_purchases';
    // Never matches for a sale: a sale has no goods file.
    const goods = found.direction === 'sale' ? 'none' : 'misa_sme_goods_purchases';
    // The journal holds every entry, voided or not; a MISA file leaves a voided document out (loadVouchers).
    const { rows } = await sql<{ id: string; occurred_at: Date; actor_id: string | null; format: string | null; from: string | null; to: string | null }>`
      WITH doc AS (
        SELECT j.entry_date, j.created_at AS posted_at, v.created_at AS voided_at,
          EXISTS (SELECT 1 FROM crove_finance.purchase_line l WHERE l.org_id = j.org_id AND l.document_id = j.source_id
            AND l.debit_account ~ '^15[236]') AS has_stock,
          EXISTS (SELECT 1 FROM crove_finance.purchase_line l WHERE l.org_id = j.org_id AND l.document_id = j.source_id
            AND (l.debit_account IS NULL OR l.debit_account !~ '^15[236]')) AS has_other
        FROM crove_finance.journal_entry j
        LEFT JOIN crove_finance.purchase_document_void v ON v.org_id = j.org_id AND v.document_id = j.source_id
        WHERE j.org_id = ${ctx.orgId}::uuid AND j.source_type = 'finance.purchase_document' AND j.source_id = ${found.id}::uuid
          AND j.reverses_entry_id IS NULL AND ${latestRevision('j')}
      )
      SELECT e.id, e.occurred_at, e.actor_id, e.detail ->> 'format' AS format, e.detail ->> 'from' AS "from", e.detail ->> 'to' AS "to"
      FROM crove_kernel.audit_event e, doc
      WHERE e.org_id = ${ctx.orgId}::uuid AND e.command = 'finance.journal.export' AND e.outcome = 'ok'
        AND e.occurred_at >= doc.posted_at
        AND e.detail ? 'from' AND e.detail ? 'to'
        AND (e.detail ->> 'from' IS NULL OR (e.detail ->> 'from')::date <= doc.entry_date)
        AND (e.detail ->> 'to' IS NULL OR (e.detail ->> 'to')::date >= doc.entry_date)
        AND (coalesce(e.detail ->> 'format', 'journal') = 'journal'
          OR ((doc.voided_at IS NULL OR e.occurred_at < doc.voided_at)
            AND ((e.detail ->> 'format' = ${misa} AND (NOT e.detail ? 'stockLines' OR doc.has_other))
              OR (e.detail ->> 'format' = ${goods} AND doc.has_stock))))
      ORDER BY e.occurred_at, e.id
      LIMIT ${DOCUMENT_EXPORT_LIMIT}`.execute(ctx.trx);
    const users = [...new Set(rows.map((r) => r.actor_id).filter((u): u is string => u !== null))];
    const names = new Map<string, string>();
    if (users.length > 0) {
      const { rows: people } = await sql<{ user_id: string; email: string; display_name: string | null }>`
        SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${users}::uuid[])`.execute(ctx.trx);
      for (const p of people) names.set(p.user_id, p.display_name ?? p.email);
    }
    return rows.map((r) => ({
      id: r.id,
      at: r.occurred_at.toISOString(),
      format: r.format === 'misa_sme_purchases' || r.format === 'misa_sme_goods_purchases' || r.format === 'misa_sme_sales' ? r.format : 'journal',
      from: r.from,
      to: r.to,
      actorName: r.actor_id ? (names.get(r.actor_id) ?? null) : null,
    }));
  },
});
