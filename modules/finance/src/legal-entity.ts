// The legal entity a finance read or write is for (issue #1280, plan §4.6). Every finance book row carries
// legal_entity_id, and each entity keeps its own books: its voucher series, its locked months, its opening balances.
// The caller names an entity (legalEntityId) or leaves it out:
// - left out: the org's default entity when the caller may see it, else the only entity the caller may see;
//   LEGAL_ENTITY_REQUIRED (422) when the caller sees several and none of them is the default;
// - named, or nothing at all visible: LEGAL_ENTITY_NOT_ALLOWED (403) for an entity the caller may not see or that is
//   not the org's (one answer for both, so nothing says whether another entity exists).
// "May see" is the legal-entity scope of the sealed context, applied by crove_kernel.legal_entity's own policy.
import { z } from 'zod';
import type { BookEntity } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

export const legalEntityNotAllowed = () => new DomainError('LEGAL_ENTITY_NOT_ALLOWED', 403, 'Bạn không có quyền với sổ sách của pháp nhân này');
export const legalEntityRequired = () => new DomainError('LEGAL_ENTITY_REQUIRED', 422, 'Hãy chọn pháp nhân để xem hoặc ghi sổ');

// The org's default entity as the caller sees it (null for a caller whose scope leaves it out).
export async function defaultLegalEntityId(ctx: Ctx): Promise<string | null> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.legal_entity')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('is_default', '=', true)
    .executeTakeFirst();
  return row?.id ?? null;
}

// The entity a call is for, by the rule above.
export async function resolveLegalEntity(ctx: Ctx, requested: string | null | undefined): Promise<string> {
  if (requested) {
    const row = await ctx.trx
      .selectFrom('crove_kernel.legal_entity')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', requested)
      .executeTakeFirst();
    if (!row) throw legalEntityNotAllowed();
    return row.id;
  }
  const visible = await ctx.trx
    .selectFrom('crove_kernel.legal_entity')
    .select(['id', 'is_default'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('is_default', 'desc')
    .orderBy('id')
    .limit(2)
    .execute();
  const [first, second] = visible;
  if (!first) throw legalEntityNotAllowed();
  if (first.is_default || !second) return first.id;
  throw legalEntityRequired();
}

// The SQL refusals of an entity (the posting path and the period lock functions, 42501 LEGAL_ENTITY_NOT_ALLOWED; a
// source revision in another entity than the previous one, 23514 SOURCE_LEGAL_ENTITY), or null for any other error.
export function legalEntityError(error: unknown): DomainError | null {
  const pg = error as { code?: string; message?: string } | null;
  if (pg?.code === '42501' && pg.message === 'LEGAL_ENTITY_NOT_ALLOWED') return legalEntityNotAllowed();
  if (pg?.code === '23514' && pg.message === 'SOURCE_LEGAL_ENTITY') {
    return new DomainError('SOURCE_LEGAL_ENTITY', 409, 'Chứng từ này đã ghi sổ ở một pháp nhân khác; không ghi lại sang pháp nhân khác được');
  }
  return null;
}

export const bookEntitiesList = defineQuery({
  name: 'finance.legal_entities.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<BookEntity[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.legal_entity')
      .select(['id', 'name', 'kind', 'tax_code', 'is_default'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('is_default', 'desc')
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, taxCode: r.tax_code, isDefault: r.is_default }));
  },
});
