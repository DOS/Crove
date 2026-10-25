// The legal entity a finance read or write is for (issue #1280, plan §4.6). Every finance book row carries
// legal_entity_id; until the commands take an entity (#1280 part 2), the books are kept in the org's default entity,
// which this answers as the caller sees it (null for a caller whose legal-entity scope leaves it out).
import type { QueryContext } from '@crove/kernel-runtime';

export async function defaultLegalEntityId(ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<string | null> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.legal_entity')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('is_default', '=', true)
    .executeTakeFirst();
  return row?.id ?? null;
}
