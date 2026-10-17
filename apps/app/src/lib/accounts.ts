// The org's chart of accounts on screen (issue #319): TT133 accounts plus the org's sub-accounts, as
// finance.accounts.list returns them (inactive sub-accounts included).
import { isTaggedCode } from '@crove/kernel-contract';

export interface ChartAccount {
  code: string;
  name: string;
  parentCode: string | null;
  rootCode: string;
  active: boolean;
  custom: boolean;
}

export const accountLabel = (a: Pick<ChartAccount, 'code' | 'name'>) => (a.name ? `${a.code} · ${a.name}` : a.code);

// The accounts a picker offers: those in use, plus the one already chosen even if it was deactivated since, so the
// picker never shows a blank. Kept in chart order.
export function pickableAccounts(accounts: readonly ChartAccount[], current?: string | null): ChartAccount[] {
  const list = accounts.filter((a) => a.active || a.code === current);
  if (current && !list.some((a) => a.code === current)) list.push({ code: current, name: '', parentCode: null, rootCode: current, active: false, custom: true });
  return list;
}

// The accounts a new sub-account may go under: TT133 accounts and the org's digit sub-accounts that are in use. A
// tagged sub-account (1121.VCB) has no sub-accounts of its own.
export function parentChoices(accounts: readonly ChartAccount[]): ChartAccount[] {
  return accounts.filter((a) => a.active && !isTaggedCode(a.code));
}

// The org's own sub-accounts, in chart order, for the settings list.
export function subAccounts(accounts: readonly ChartAccount[]): ChartAccount[] {
  return accounts.filter((a) => a.custom);
}
