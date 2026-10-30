// Channel connections (ADR-0025, Social plan step S2, issue #232): an org connects a page or account once, and the
// kernel keeps its sealed tokens for every module that publishes to it or reads from it.
//
// Who may do what:
// - Owners and admins connect and disconnect (R2, permission kernel.connection.bind in plan §7.4 terms); every member
//   lists the org's connections. No query ever returns a credential.
// - The command never sees a token: the caller (the OAuth callback, the sandbox route) seals it with the credential
//   broker for the binding (org, provider, account) and passes the envelope, which the credential_put definer
//   stores. Connecting an account that is already connected replaces its tokens on the same connection row.
// - Only the worker reads a credential back (kernel.channel.credential, system actor, credential_get granted to
//   crove_worker alone), and only while the member who connected the account is still in the org.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

// One character is enough: X's id is x (#784).
const zProvider = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const zKeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
// The sealed envelope as base64; its size is checked again by the column (64 KiB).
const zEnvelope = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(90_000);

// Errors the credential_* definers raise, as domain errors. Anything else goes through the runtime's mapping.
function credentialError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'CHANNEL_NOT_FOUND':
      throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    case 'CHANNEL_NOT_ACTIVE':
      throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'Kênh này không còn hoạt động, hãy kết nối lại');
    case 'CHANNEL_OWNER_LEFT':
      throw new DomainError('CHANNEL_OWNER_LEFT', 409, 'Người đã kết nối kênh này không còn quyền quản lý kênh trong tổ chức, hãy kết nối lại');
    case 'CREDENTIAL_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới quản lý được kênh kết nối');
    default:
      throw error;
  }
}

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới kết nối được kênh');
  return ctx.actor.userId;
}

export const zChannelConnect = z.strictObject({
  provider: zProvider,
  externalAccountId: z.string().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  scopes: z.array(z.string().min(1).max(200)).max(100),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  credential: z.strictObject({ keyId: zKeyId, envelope: zEnvelope }),
});
export type ChannelConnectInput = z.infer<typeof zChannelConnect>;

export const channelConnect = defineCommand({
  name: 'kernel.channel.connect',
  input: zChannelConnect,
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const values = {
      display_name: input.displayName,
      scopes: input.scopes,
      expires_at: input.expiresAt,
      status: 'active' as const,
      status_reason: null,
      connected_by: userId,
      updated_at: ctx.now,
    };
    // Two connects of one account at once serialize here, so the second finds the first's row and reconnects
    // instead of failing on the unique index (no row exists yet for FOR UPDATE to lock).
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.channel:${ctx.orgId}:${input.provider}:${input.externalAccountId}`}, 0))`.execute(ctx.trx);
    // Reconnecting a live connection of the same account keeps its row; a revoked one is history and stays. The
    // member who reconnects becomes its connector, so the credential lives on their membership from now on.
    const existing = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('provider', '=', input.provider)
      .where('external_account_id', '=', input.externalAccountId)
      .where('status', '<>', 'revoked')
      .forUpdate()
      .executeTakeFirst();
    let id: string;
    if (existing) {
      await ctx.trx.updateTable('crove_kernel.channel_connection').set(values).where('org_id', '=', ctx.orgId).where('id', '=', existing.id).execute();
      id = existing.id;
    } else {
      const row = await ctx.trx
        .insertInto('crove_kernel.channel_connection')
        .values({ org_id: ctx.orgId, provider: input.provider, external_account_id: input.externalAccountId, ...values })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
    }
    await sql`SELECT crove_kernel.credential_put(${id}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
      .execute(ctx.trx)
      .catch(credentialError);
    ctx.audit({ connection_id: id, provider: input.provider, reconnected: Boolean(existing) });
    await ctx.emit('kernel.channel.connected', { connection_id: id, provider: input.provider, reconnected: Boolean(existing) });
    return { connectionId: id, reconnected: Boolean(existing) };
  },
});

export const channelDisconnect = defineCommand({
  name: 'kernel.channel.disconnect',
  input: z.strictObject({ connectionId: zId }),
  risk: 'R2',
  sideEffect: 'external',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    if (row.status !== 'revoked') {
      await ctx.trx
        .updateTable('crove_kernel.channel_connection')
        .set({ status: 'revoked', status_reason: 'disconnected', updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .execute();
      await ctx.emit('kernel.channel.disconnected', { connection_id: input.connectionId, provider: row.provider });
    }
    // Forget the tokens even when the row was already revoked: a disconnect leaves nothing to decrypt.
    await sql`SELECT crove_kernel.credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(credentialError);
    return { connectionId: input.connectionId, status: 'revoked' as const };
  },
});

// A provider refused a connection's token (expired or revoked on the platform): the connection becomes 'expired' until
// an owner or admin reconnects it. Run by provider jobs (system actor) in their own transaction, through ctx.run.
export const channelMarkExpired = defineCommand({
  name: 'kernel.channel.mark_expired',
  // ifVersion: the connection's updated_at the caller saw; a connection changed since (reconnected with a new token)
  // is left alone.
  input: z.strictObject({ connectionId: zId, reason: z.string().min(1).max(200), ifVersion: z.iso.datetime({ offset: true }).optional() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    if (row.status !== 'active') return { connectionId: input.connectionId, status: row.status };
    // Compared at millisecond precision, the precision the caller read it at.
    if (input.ifVersion && Math.floor(row.updated_at.getTime()) !== Date.parse(input.ifVersion)) return { connectionId: input.connectionId, status: row.status };
    await ctx.trx
      .updateTable('crove_kernel.channel_connection')
      .set({ status: 'expired', status_reason: input.reason, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    await ctx.emit('kernel.channel.expired', { connection_id: input.connectionId, provider: row.provider, reason: input.reason });
    return { connectionId: input.connectionId, status: 'expired' as const };
  },
});

// Connecting through a provider's OAuth dialog (Social plan §3.5, S6.1): the API hashes a fresh state and starts an
// attempt for the signed-in owner or admin; the browser comes back with the state, and the same member finishes the
// attempt once, which hands out its PKCE verifier. Both run in the oauth_state_* definers, which bind the attempt to
// the org and user in context; the commands never see the state itself, only its hash.
const zStateHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
// 10 minutes, the longest a user takes in a provider's dialog.
const OAUTH_ATTEMPT_SECONDS = 600;

function oauthError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'OAUTH_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
    case 'OAUTH_TOO_MANY':
      throw new DomainError('OAUTH_TOO_MANY', 429, 'Bạn đã mở quá nhiều lượt kết nối chưa hoàn tất, hãy thử lại sau ít phút');
    case 'OAUTH_STATE_INVALID':
      throw new DomainError('OAUTH_STATE_INVALID', 400, 'Lượt kết nối này không hợp lệ hoặc không phải của bạn, hãy bắt đầu lại');
    case 'OAUTH_STATE_USED':
      throw new DomainError('OAUTH_STATE_USED', 409, 'Lượt kết nối này đã được dùng, hãy bắt đầu lại');
    case 'OAUTH_STATE_EXPIRED':
      throw new DomainError('OAUTH_STATE_EXPIRED', 409, 'Lượt kết nối đã hết hạn, hãy bắt đầu lại');
    default:
      throw error;
  }
}

export const channelOAuthBegin = defineCommand({
  name: 'kernel.channel.oauth_begin',
  input: z.strictObject({ provider: zProvider, stateHash: zStateHash, codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).nullable() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ id: string }>`
      SELECT crove_kernel.oauth_state_create(${input.provider}, ${input.stateHash}, ${input.codeVerifier}, ${OAUTH_ATTEMPT_SECONDS}::integer) AS id`
      .execute(ctx.trx)
      .catch(oauthError);
    const attemptId = rows[0]?.id;
    if (!attemptId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // The audit row names the attempt and provider only: never the hash or the verifier.
    ctx.audit({ attempt_id: attemptId, provider: input.provider });
    return { attemptId, expiresAt: new Date(ctx.now.getTime() + OAUTH_ATTEMPT_SECONDS * 1000).toISOString() };
  },
});

export const channelOAuthConsume = defineCommand({
  name: 'kernel.channel.oauth_consume',
  input: z.strictObject({ provider: zProvider, stateHash: zStateHash }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ code_verifier: string | null }>`
      SELECT code_verifier FROM crove_kernel.oauth_state_consume(${input.provider}, ${input.stateHash})`
      .execute(ctx.trx)
      .catch(oauthError);
    if (rows.length !== 1) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    ctx.audit({ provider: input.provider });
    return { codeVerifier: rows[0]?.code_verifier ?? null };
  },
});

// A provider job renewed a connection's tokens (Social plan S6.4): the new credential is sealed in and the expiry
// moves, in one transaction, so a rotated single-use refresh token is never lost to a half-done write. ifVersion is the
// connection's updated_at the refresh started from; a connection changed since (reconnected, disconnected, expired) is
// left alone, and the answer says so: the caller then drops the new tokens.
export const channelRefresh = defineCommand({
  name: 'kernel.channel.refresh',
  input: z.strictObject({
    connectionId: zId,
    ifVersion: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    credential: z.strictObject({ keyId: zKeyId, envelope: zEnvelope }),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    // Compared at millisecond precision, the precision the caller read it at.
    if (row.status !== 'active' || Math.floor(row.updated_at.getTime()) !== Date.parse(input.ifVersion)) {
      return { connectionId: input.connectionId, refreshed: false };
    }
    await sql`SELECT crove_kernel.credential_put(${input.connectionId}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
      .execute(ctx.trx)
      .catch(credentialError);
    await ctx.trx
      .updateTable('crove_kernel.channel_connection')
      .set({ expires_at: input.expiresAt, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    ctx.audit({ connection_id: input.connectionId, provider: row.provider });
    return { connectionId: input.connectionId, refreshed: true };
  },
});

// Stores a credential sealed again with the current key after a rotation (#776), for the worker's reseal sweep. The
// envelope is replaced only while it is still the one the worker read (its key id and the sha256 of its bytes): a
// reconnect or refresh in between sealed a newer one, even with the old key on a replica not yet restarted, and the
// answer says nothing was changed. The connection's version is left alone,
// so a refresh about to compare it is not turned away.
export const channelReseal = defineCommand({
  name: 'kernel.channel.reseal',
  input: z.strictObject({ connectionId: zId, fromKeyId: zKeyId, fromEnvelopeSha256: z.string().regex(/^[0-9a-f]{64}$/), credential: z.strictObject({ keyId: zKeyId, envelope: zEnvelope }) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.channel_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['status', 'provider'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.status !== 'active') return { connectionId: input.connectionId, resealed: false };
    const { rows } = await sql<{ key_id: string; envelope_sha256: string }>`
      SELECT key_id, encode(sha256(envelope), 'hex') AS envelope_sha256 FROM crove_kernel.credential_get(${input.connectionId}::uuid)`
      .execute(ctx.trx)
      .catch(credentialError);
    const stored = rows[0];
    if (!stored || stored.key_id !== input.fromKeyId || stored.envelope_sha256 !== input.fromEnvelopeSha256 || input.fromKeyId === input.credential.keyId) {
      return { connectionId: input.connectionId, resealed: false };
    }
    await sql`SELECT crove_kernel.credential_put(${input.connectionId}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
      .execute(ctx.trx)
      .catch(credentialError);
    // Key ids only: they name a key without revealing it.
    ctx.audit({ connection_id: input.connectionId, provider: row.provider, from_key_id: input.fromKeyId, key_id: input.credential.keyId });
    return { connectionId: input.connectionId, resealed: true };
  },
});

export interface ChannelConnectionView {
  id: string;
  provider: string;
  externalAccountId: string;
  displayName: string;
  scopes: string[];
  status: 'active' | 'expired' | 'revoked' | 'error';
  statusReason: string | null;
  connectedBy: string;
  expiresAt: string | null;
  connectedAt: string;
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

// The org's connections, live ones first. Never a credential: the columns are listed, not selected with *.
export const channelsList = defineQuery({
  name: 'kernel.channel.list',
  input: z.object({ includeRevoked: z.boolean().optional() }),
  access: ALL,
  handler: async (ctx: QueryContext, input): Promise<ChannelConnectionView[]> => {
    let q = ctx.trx
      .selectFrom('crove_kernel.channel_connection')
      .select(['id', 'provider', 'external_account_id', 'display_name', 'scopes', 'status', 'status_reason', 'connected_by', 'expires_at', 'connected_at'])
      .where('org_id', '=', ctx.orgId);
    if (!input.includeRevoked) q = q.where('status', '<>', 'revoked');
    const rows = await q.orderBy(sql`status = 'revoked'`).orderBy('connected_at', 'desc').limit(500).execute();
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      externalAccountId: r.external_account_id,
      displayName: r.display_name,
      scopes: r.scopes,
      status: r.status,
      statusReason: r.status_reason,
      connectedBy: r.connected_by,
      expiresAt: iso(r.expires_at),
      connectedAt: iso(r.connected_at) ?? '',
    }));
  },
});

export interface SealedChannelCredential {
  provider: string;
  externalAccountId: string;
  keyId: string;
  // base64
  envelope: string;
}

// The sealed credential of an active connection, for provider jobs in the worker. The caller opens it with the
// credential broker for the binding returned here and drops the plaintext after the call.
export const channelCredential = defineQuery({
  name: 'kernel.channel.credential',
  input: z.strictObject({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<SealedChannelCredential> => {
    const { rows } = await sql<{ key_id: string; envelope: Buffer; provider: string; external_account_id: string }>`
      SELECT key_id, envelope, provider, external_account_id FROM crove_kernel.credential_get(${input.connectionId}::uuid)`
      .execute(ctx.trx)
      .catch(credentialError);
    const row = rows[0];
    if (!row) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Không tìm thấy kênh đã kết nối này');
    return { provider: row.provider, externalAccountId: row.external_account_id, keyId: row.key_id, envelope: row.envelope.toString('base64') };
  },
});

export const channelCommands = [channelConnect, channelDisconnect, channelMarkExpired, channelOAuthBegin, channelOAuthConsume, channelRefresh, channelReseal];
export const channelQueries = [channelsList, channelCredential];
