// SPDX-License-Identifier: AGPL-3.0-only
// The bank feed card in Settings (ADR-0039, #2099): what the screen works out from the API's answers. The server
// decides every rule; these only choose what to show.
import type { BankFeedAccountView } from '@crove/kernel-contract';
import type { ChartAccount } from './accounts.ts';

// A bank feed adapter this deployment offers (`/api/config` bankFeeds): none, and the card is not drawn at all, so
// `docker compose up` shows nothing about banks.
export const bankFeedOffered = (config: { bankFeeds?: { sandbox: boolean } | undefined }): boolean => Boolean(config.bankFeeds?.sandbox);

// Whether Settings draws the card: the finance module is on and the deployment offers a feed.
export const showsBankFeeds = (config: { modules: readonly string[]; bankFeeds?: { sandbox: boolean } | undefined }): boolean => config.modules.includes('finance') && bankFeedOffered(config);

// The org's bank accounts a feed can fill: TT133 accounts under 112 and their sub-accounts (the 112 group itself holds
// none), those in use, plus the one already mapped even if it was deactivated since, so the picker is never blank.
export function bankAccountChoices(accounts: readonly ChartAccount[], current?: string | null): ChartAccount[] {
  return accounts.filter((a) => a.rootCode.startsWith('112') && a.code !== '112' && (a.active || a.code === current));
}

export interface FeedAccountRow {
  externalAccountId: string;
  displayName: string;
  // The mapping this account has, if any.
  mapped: BankFeedAccountView | null;
  // A mapped account the provider's last listing no longer holds: it keeps its mapping and lines, and is not pulled.
  gone: boolean;
}

// The accounts of one connection: those the worker listed (with their mapping when there is one), then the mapped ones
// the provider no longer lists. `listed` is null while the listing is unknown, and then nothing is called gone.
export function feedAccountRows(
  listed: ReadonlyArray<{ externalAccountId: string; displayName: string }> | null,
  mapped: readonly BankFeedAccountView[],
): FeedAccountRow[] {
  const byExternal = new Map(mapped.map((m) => [m.externalAccountId, m] as const));
  const rows: FeedAccountRow[] = (listed ?? []).map((a) => ({ externalAccountId: a.externalAccountId, displayName: a.displayName, mapped: byExternal.get(a.externalAccountId) ?? null, gone: false }));
  if (listed === null) return rows.concat(mapped.map((m) => ({ externalAccountId: m.externalAccountId, displayName: m.externalAccountId, mapped: m, gone: false })));
  const seen = new Set(rows.map((r) => r.externalAccountId));
  for (const m of mapped) if (!seen.has(m.externalAccountId)) rows.push({ externalAccountId: m.externalAccountId, displayName: m.externalAccountId, mapped: m, gone: true });
  return rows;
}

// The mappings of one connection, from the list of every mapping the caller reads.
export const mappedOf = (mapped: readonly BankFeedAccountView[], connectionId: string): BankFeedAccountView[] => mapped.filter((m) => m.connectionId === connectionId);
