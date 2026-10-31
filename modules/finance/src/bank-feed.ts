// SPDX-License-Identifier: AGPL-3.0-only
// Bank feed accounts (ADR-0039 points 2 and 3, #2044): the accounts a bank feed connection reaches, each mapped to one
// of the org's bank accounts in one legal entity. The connection and its sealed credential are the kernel's channel
// layer (ADR-0025); this module only says where a connected account's lines go. Owners and admins map and unmap; every
// member who reads the entity lists the mappings. No network here: the provider is the worker's (part 2b) and the API
// route's, never the module's.
// - finance.bank_feed.map: maps an account of an active bank feed connection to a bank account of an entity, or points
//   an existing mapping at another bank account of the same entity.
// - finance.bank_feed.unmap: removes a mapping; the lines it brought in stay, as imported ones do.
// - finance.bank_feed.accounts: the mappings the caller's entities hold, with their connection's name and status.
// - finance.bank_feed.connections: the live connections, mapped or not, for the Settings card.
// - finance.bank_feed.listed: the accounts a connection reaches, as the worker last listed them.
// The worker's sync (#2044 part 2b, apps/kernel/src/bank-feed-sync.ts) runs two system commands:
// - finance.bank_feed.record_accounts: the accounts the provider lists for a connection, replacing the last listing;
// - finance.bank_feed.record_pull: one page of a mapped account's transactions, stored as the entity's bank lines
//   through the import's path (ingestFeedLines), and the cursor and sync time moved in the same transaction.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { isBankFeedProviderId, zBankFeedMap, zBankFeedRecordAccounts, zBankFeedRecordPull, zId, type BankFeedAccountView, type BankFeedConnectionView, type BankFeedListedAccount, type BankImportResult } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { bankAccount, ingestFeedLines } from './bank.ts';
import { resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

// One answer for a mapping in another entity, whether the caller can read that mapping or row security hides it (#2079).
const accountMapped = () => new DomainError('BANK_FEED_ACCOUNT_MAPPED', 409, 'Tài khoản này đã gắn với một pháp nhân khác; hãy gỡ liên kết trước');

export const bankFeedMap = defineCommand({
  name: 'finance.bank_feed.map',
  input: zBankFeedMap,
  // It decides where a feed's lines are stored and posts nothing (R1, as a bank account is made).
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ feedAccountId: string }> => {
    const connection = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection || !isBankFeedProviderId(connection.provider)) throw new DomainError('BANK_FEED_NOT_FOUND', 404, 'Không tìm thấy kết nối nguồn giao dịch ngân hàng');
    if (connection.status !== 'active') throw new DomainError('BANK_FEED_INACTIVE', 422, 'Kết nối nguồn giao dịch ngân hàng không còn hoạt động; hãy kết nối lại');
    await bankAccount(ctx, input.bankAccount, true);
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    // Two maps of one account at once: the second waits, then finds the first's row and remaps it (a FOR UPDATE of a
    // row that does not exist yet would lock nothing).
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.bank_feed:${ctx.orgId}:${connection.id}:${input.externalAccountId}`}, 0))`.execute(ctx.trx);
    // Only an account the connection reaches, as the worker listed it with the credential.
    const listed = await ctx.trx
      .selectFrom('crove_finance.bank_feed_listed_account')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', connection.id)
      .where('external_account_id', '=', input.externalAccountId)
      .executeTakeFirst();
    if (!listed) throw new DomainError('BANK_FEED_ACCOUNT_UNKNOWN', 422, 'Kết nối này không có tài khoản đó; hãy chọn một tài khoản trong danh sách');
    const existing = await ctx.trx
      .selectFrom('crove_finance.bank_feed_account')
      .select(['id', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', connection.id)
      .where('external_account_id', '=', input.externalAccountId)
      .forUpdate()
      .executeTakeFirst();
    let feedAccountId: string;
    if (existing) {
      // Its lines are already in that entity's books: another entity takes an unmap first.
      if (existing.legal_entity_id !== legalEntityId) throw accountMapped();
      await ctx.trx.updateTable('crove_finance.bank_feed_account').set({ bank_account: input.bankAccount }).where('org_id', '=', ctx.orgId).where('id', '=', existing.id).execute();
      feedAccountId = existing.id;
    } else {
      // Under the account's lock the lookup above has seen every mapping the caller may read. A conflict here is a
      // mapping that row security hides from the caller (in another entity's books): the same answer as a visible one in
      // another entity, never a generic conflict, and nothing says which entity holds it (#2079).
      const inserted = await ctx.trx
        .insertInto('crove_finance.bank_feed_account')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: legalEntityId,
          channel_connection_id: connection.id,
          external_account_id: input.externalAccountId,
          bank_account: input.bankAccount,
          created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        })
        .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id', 'external_account_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) throw accountMapped();
      feedAccountId = inserted.id;
    }
    ctx.audit({ feedAccountId, connectionId: connection.id, provider: connection.provider, bankAccount: input.bankAccount, legalEntityId, remapped: Boolean(existing) });
    // The worker pulls the newly mapped account (part 2b).
    await ctx.emit('finance.bank_feed.sync_requested', { connection_id: connection.id });
    return { feedAccountId };
  },
});

export const bankFeedUnmap = defineCommand({
  name: 'finance.bank_feed.unmap',
  input: z.strictObject({ feedAccountId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<{ feedAccountId: string }> => {
    const removed = await ctx.trx
      .deleteFrom('crove_finance.bank_feed_account')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.feedAccountId)
      .returning(['id', 'bank_account', 'legal_entity_id'])
      .executeTakeFirst();
    if (!removed) throw new DomainError('BANK_FEED_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản của nguồn giao dịch ngân hàng');
    ctx.audit({ feedAccountId: removed.id, bankAccount: removed.bank_account, legalEntityId: removed.legal_entity_id });
    return { feedAccountId: removed.id };
  },
});

export const bankFeedAccounts = defineQuery({
  name: 'finance.bank_feed.accounts',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<BankFeedAccountView[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.bank_feed_account as a')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'a.channel_connection_id', 'c.provider', 'c.display_name', 'c.status', 'a.external_account_id', 'a.bank_account', 'a.legal_entity_id', 'a.last_synced_at'])
      .where('a.org_id', '=', ctx.orgId)
      .orderBy('c.display_name')
      .orderBy('a.external_account_id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.channel_connection_id,
      provider: r.provider,
      connectionName: r.display_name,
      connectionStatus: r.status as BankFeedAccountView['connectionStatus'],
      externalAccountId: r.external_account_id,
      bankAccount: r.bank_account,
      legalEntityId: r.legal_entity_id,
      lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
    }));
  },
});

// The org's live bank feed connections, whether an account of theirs is mapped or not, newest first: the Settings card
// lists them to map from and to say which one expired (#2099). The managers' alone, as the listing is org-wide.
export const bankFeedConnections = defineQuery({
  name: 'finance.bank_feed.connections',
  input: z.object({}),
  access: MANAGERS,
  handler: async (ctx): Promise<BankFeedConnectionView[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'display_name', 'status', 'connected_at'])
      .where('org_id', '=', ctx.orgId)
      .where('provider', 'like', 'bank\\_%')
      .where('status', '<>', 'revoked')
      .orderBy('connected_at', 'desc')
      .limit(500)
      .execute();
    return rows
      .filter((r) => isBankFeedProviderId(r.provider))
      .map((r) => ({ id: r.id, provider: r.provider, displayName: r.display_name, status: r.status as BankFeedConnectionView['status'], connectedAt: new Date(r.connected_at).toISOString() }));
  },
});

// The managers' alone: the listing is org-wide (no entity), and only they map an account.
export const bankFeedListed = defineQuery({
  name: 'finance.bank_feed.listed',
  input: z.object({ connectionId: zId }),
  access: MANAGERS,
  handler: async (ctx, input): Promise<Array<BankFeedListedAccount & { listedAt: string }>> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.bank_feed_listed_account')
      .select(['external_account_id', 'display_name', 'listed_at'])
      .where('org_id', '=', ctx.orgId)
      .where('channel_connection_id', '=', input.connectionId)
      .orderBy('external_account_id')
      .execute();
    return rows.map((r) => ({ externalAccountId: r.external_account_id, displayName: r.display_name, listedAt: new Date(r.listed_at).toISOString() }));
  },
});

// The mapped accounts of a connection the provider still lists, and where each one's next pull starts, for the
// worker's sync. A mapped account the provider no longer lists keeps its mapping and lines, and is not pulled.
export const bankFeedPullDue = defineQuery({
  name: 'finance.bank_feed.pull_due',
  input: z.object({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<Array<{ feedAccountId: string; externalAccountId: string; cursor: string | null }>> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.bank_feed_account as a')
      .innerJoin('crove_finance.bank_feed_listed_account as l', (j) =>
        j.onRef('l.org_id', '=', 'a.org_id').onRef('l.channel_connection_id', '=', 'a.channel_connection_id').onRef('l.external_account_id', '=', 'a.external_account_id'),
      )
      .select(['a.id', 'a.external_account_id', 'a.cursor'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.channel_connection_id', '=', input.connectionId)
      .orderBy('a.external_account_id')
      .execute();
    return rows.map((r) => ({ feedAccountId: r.id, externalAccountId: r.external_account_id, cursor: r.cursor }));
  },
});

// A bank feed connection's status and version (its updated_at), for the worker's sync; null for none of this org.
export const bankFeedConnection = defineQuery({
  name: 'finance.bank_feed.connection',
  input: z.object({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<{ status: string; updatedAt: string } | null> => {
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['provider', 'status', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!row || !isBankFeedProviderId(row.provider)) return null;
    return { status: row.status, updatedAt: new Date(row.updated_at).toISOString() };
  },
});

export const bankFeedRecordAccounts = defineCommand({
  name: 'finance.bank_feed.record_accounts',
  input: zBankFeedRecordAccounts,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ listed: number; removed: number }> => {
    const connection = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!connection || !isBankFeedProviderId(connection.provider)) throw new DomainError('BANK_FEED_NOT_FOUND', 404, 'Không tìm thấy kết nối nguồn giao dịch ngân hàng');
    if (connection.status !== 'active') throw new DomainError('BANK_FEED_INACTIVE', 422, 'Kết nối nguồn giao dịch ngân hàng không còn hoạt động; hãy kết nối lại');
    const ids = input.accounts.map((a) => a.externalAccountId);
    if (new Set(ids).size !== ids.length) throw new DomainError('BANK_FEED_INVALID', 422, 'Nguồn giao dịch ngân hàng gửi một tài khoản hai lần');
    for (const account of input.accounts) {
      await ctx.trx
        .insertInto('crove_finance.bank_feed_listed_account')
        .values({ org_id: ctx.orgId, channel_connection_id: connection.id, external_account_id: account.externalAccountId, display_name: account.displayName })
        .onConflict((oc) => oc.columns(['org_id', 'channel_connection_id', 'external_account_id']).doUpdateSet({ display_name: account.displayName, listed_at: ctx.now }))
        .execute();
    }
    let gone = ctx.trx.deleteFrom('crove_finance.bank_feed_listed_account').where('org_id', '=', ctx.orgId).where('channel_connection_id', '=', connection.id);
    if (ids.length > 0) gone = gone.where('external_account_id', 'not in', ids);
    const removed = (await gone.returning('id').execute()).length;
    ctx.audit({ connectionId: connection.id, provider: connection.provider, listed: ids.length, removed });
    return { listed: ids.length, removed };
  },
});

export const bankFeedRecordPull = defineCommand({
  name: 'finance.bank_feed.record_pull',
  input: zBankFeedRecordPull,
  // Records the bank's own figures and posts nothing, as an import does (R1). The provider was called by the job.
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<BankImportResult | { importId: null }> => {
    // The account and entity are the mapping's, never the job's input.
    const mapped = await ctx.trx
      .selectFrom('crove_finance.bank_feed_account as a')
      .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'a.org_id').onRef('c.id', '=', 'a.channel_connection_id'))
      .select(['a.id', 'a.bank_account', 'a.legal_entity_id', 'a.cursor', 'c.provider', 'c.status'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.id', '=', input.feedAccountId)
      .forUpdate('a')
      .executeTakeFirst();
    if (!mapped) throw new DomainError('BANK_FEED_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản của nguồn giao dịch ngân hàng');
    if (mapped.status !== 'active') throw new DomainError('BANK_FEED_INACTIVE', 422, 'Kết nối nguồn giao dịch ngân hàng không còn hoạt động; hãy kết nối lại');
    // Under the row lock: another sync recorded a page since this one read the cursor, so this page is stale.
    if (mapped.cursor !== input.fromCursor) throw new DomainError('BANK_FEED_CURSOR_MOVED', 409, 'Một lần đồng bộ khác đã ghi tài khoản này trước; lần này dừng lại');
    const result =
      input.lines.length > 0
        ? await ingestFeedLines(ctx, { bankAccount: mapped.bank_account, legalEntityId: mapped.legal_entity_id, source: mapped.provider, lines: input.lines })
        : null;
    await ctx.trx
      .updateTable('crove_finance.bank_feed_account')
      .set({ cursor: input.cursor, last_synced_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', mapped.id)
      .execute();
    if (!result) ctx.audit({ feedAccountId: mapped.id, lines: 0 });
    return result ?? { importId: null };
  },
});

export const bankFeedCommands = [bankFeedMap, bankFeedUnmap, bankFeedRecordAccounts, bankFeedRecordPull];
export const bankFeedQueries = [bankFeedAccounts, bankFeedConnections, bankFeedListed, bankFeedPullDue, bankFeedConnection];
