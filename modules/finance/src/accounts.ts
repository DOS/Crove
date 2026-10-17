// The org's chart of accounts, as the opening balance check reads it. Today every org shares the TT133 chart
// (crove_finance.account, a global table) and every account is in use; sub-accounts per org (#319) will change where
// accounts come from and add deactivated ones. This is the one place to change for that.
import type { QueryContext } from '@crove/kernel-runtime';
import type { OpeningChartAccount } from './domain/opening-balance.ts';

export async function chartOfAccounts(ctx: Pick<QueryContext, 'trx'>): Promise<Map<string, OpeningChartAccount>> {
  const rows = await ctx.trx.selectFrom('crove_finance.account').select(['code', 'name']).execute();
  return new Map(rows.map((a) => [a.code, { code: a.code, name: a.name, active: true }]));
}
