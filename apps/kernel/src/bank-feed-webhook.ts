// SPDX-License-Identifier: AGPL-3.0-only
// A bank feed provider's signed notice (ADR-0039 point 2, #2044 part 2b-ii). The API checks the adapter's signature before
// anything else: a forged, stale or malformed notice is refused and stored nowhere. A verified one only names accounts of
// the provider, and the API hands those ids to crove_finance.bank_feed_notice_enqueue() without a tenant context. The
// notice's body is stored nowhere and no transaction is read from it: it is a hint to pull. The worker relay claims the
// ids, finds the connections whose listing holds them (the org comes from that stored listing, never from the notice)
// and queues a sync of each (apps/kernel/src/worker.ts); a sync pulls what the provider reports, as the daily sweep does.
import { sql, type Transaction } from 'kysely';
import type { Database } from '@crove/db';
import { BankFeedWebhookRejected, type BankFeedProvider, type BankFeedWebhookRequest } from '@crove/bank-feed';
import type { Runtime } from '@crove/kernel-runtime';

// A notice names at most 100 accounts; this bounds what the API reads before checking its signature.
export const MAX_BANK_FEED_WEBHOOK_BYTES = 64 * 1024;

// The relay's claim of waiting accounts (crove_finance.bank_feed_notice_claim, the worker login's alone): one row per
// claimed account and connection that lists it, and one row of nulls for a claimed account no connection lists.
export const BANK_FEED_NOTICE_CLAIM = 100;
export async function claimBankFeedNotices(trx: Transaction<Database>): Promise<Array<{ orgId: string | null; connectionId: string | null; provider: string | null }>> {
  const { rows } = await sql<{ org_id: string | null; connection_id: string | null; provider: string | null }>`
    SELECT org_id, connection_id, provider FROM crove_finance.bank_feed_notice_claim(${BANK_FEED_NOTICE_CLAIM}::int)`.execute(trx);
  return rows.map((r) => ({ orgId: r.org_id, connectionId: r.connection_id, provider: r.provider }));
}

export type BankFeedWebhookOutcome =
  | { status: 202; queued: number }
  | { status: 200; queued: 0 }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' };

export async function acceptBankFeedWebhook(runtime: Runtime, provider: BankFeedProvider, request: BankFeedWebhookRequest, now: number = Date.now()): Promise<BankFeedWebhookOutcome> {
  if (!provider.verifyWebhook) throw new Error('the adapter takes no notices');
  let accounts: string[];
  try {
    accounts = provider.verifyWebhook(request, now);
  } catch (error) {
    if (!(error instanceof BankFeedWebhookRejected)) throw error;
    return error.reason === 'malformed' ? { status: 400, code: 'WEBHOOK_MALFORMED' } : { status: 401, code: 'WEBHOOK_SIGNATURE' };
  }
  // A notice naming no account the adapter reads: acknowledged, so the provider stops retrying it.
  if (accounts.length === 0) return { status: 200, queued: 0 };
  const queued = await runtime.orgless(async (db) => {
    const { rows } = await sql<{ queued: number }>`
      SELECT crove_finance.bank_feed_notice_enqueue(${provider.id}, ${accounts}::text[]) AS queued`.execute(db);
    return Number(rows[0]?.queued ?? 0);
  });
  return { status: 202, queued };
}
