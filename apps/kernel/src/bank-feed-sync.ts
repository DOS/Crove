// SPDX-License-Identifier: AGPL-3.0-only
// A bank feed connection's sync (ADR-0039 point 2, #2044 part 2b), run by the worker as the system. The credential is
// opened here and nowhere else: the API only seals it (ADR-0025). A sync lists the accounts the connection reaches
// (finance.bank_feed.record_accounts), then pulls each mapped account from its cursor, a page at a time, each page
// stored and the cursor moved in one command (finance.bank_feed.record_pull). A retry or an overlapping pull stores
// nothing twice: every line carries the bank's reference, which keys it (ADR-0021 section 6). The provider is the
// deployment's adapter for the connection's provider; without one (the adapter switched off) the sync does nothing.
// kernel.channel.credential refuses once the member who connected the account may no longer use it, or the connection
// is no longer active: the sync then marks the connection expired, so the daily sweep skips it and an owner or admin
// connects it again, rather than failing every day.
import type { BankFeedProvider } from '@crove/bank-feed';
import { BANK_FEED_MAX_ACCOUNTS } from '@crove/kernel-contract';
import { DomainError, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';

const SYSTEM = { type: 'system' as const, component: 'finance.bank_feed' };
// Pages one sync pulls per account at most; the next sync goes on from the cursor.
const MAX_PAGES = 12;

export interface BankFeedSyncJob {
  orgId: string;
  connectionId: string;
}

export interface BankFeedSyncDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  providers: Readonly<Record<string, BankFeedProvider>>;
}

interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  envelope: string;
}

export async function runBankFeedSync(deps: BankFeedSyncDeps, job: BankFeedSyncJob): Promise<{ accounts: number; pages: number; stored: number }> {
  const options = { actor: SYSTEM, orgId: job.orgId };
  let sealed: SealedChannelCredential;
  try {
    sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: job.connectionId }, options);
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'CHANNEL_OWNER_LEFT' || error.code === 'CHANNEL_NOT_ACTIVE')) {
      if (error.code === 'CHANNEL_OWNER_LEFT') {
        await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: job.connectionId, reason: 'owner_left' }, options);
      }
      return { accounts: 0, pages: 0, stored: 0 };
    }
    throw error;
  }
  if (!Object.hasOwn(deps.providers, sealed.provider)) return { accounts: 0, pages: 0, stored: 0 };
  const provider = deps.providers[sealed.provider] as BankFeedProvider;
  const secret = deps.broker.open(
    { keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') },
    { orgId: job.orgId, provider: sealed.provider, externalAccountId: sealed.externalAccountId },
  );
  const accounts = (await provider.accounts(secret)).slice(0, BANK_FEED_MAX_ACCOUNTS);
  await deps.runtime.execute('finance.bank_feed.record_accounts', { connectionId: job.connectionId, accounts }, options);
  const due = await deps.runtime.query<Array<{ feedAccountId: string; externalAccountId: string; cursor: string | null }>>(
    'finance.bank_feed.pull_due',
    { connectionId: job.connectionId },
    options,
  );
  let pages = 0;
  let stored = 0;
  for (const account of due) {
    let cursor = account.cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const pulled = await provider.pull(secret, account.externalAccountId, cursor);
      const result = await deps.runtime.execute<{ counts?: { new: number; ambiguous: number } }>(
        'finance.bank_feed.record_pull',
        { feedAccountId: account.feedAccountId, fromCursor: cursor, lines: pulled.transactions, cursor: pulled.cursor },
        options,
      );
      pages++;
      stored += (result.counts?.new ?? 0) + (result.counts?.ambiguous ?? 0);
      cursor = pulled.cursor;
      if (!pulled.more) break;
    }
  }
  return { accounts: accounts.length, pages, stored };
}
