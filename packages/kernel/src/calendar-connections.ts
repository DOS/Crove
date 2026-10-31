// SPDX-License-Identifier: AGPL-3.0-only
// Outside calendars a member connects (issue #2123, part of #1374, plan docs/plan/calendar.md decision CAL-4): the busy
// times of a connected Google calendar block booking slots.
//
// Who may do what:
// - A member who edits (owner, admin, member) connects and disconnects their own calendar and lists their own
//   connections; nobody sees another member's (the table's row policy). No query returns a credential.
// - The connect command never sees a token: the OAuth callback seals it with the credential broker for the binding
//   (org, calendar provider, account) and passes the envelope, which the calendar_credential_put definer stores.
// - Only the worker reads a credential back (kernel.calendar.credential, system actor, calendar_credential_get granted
//   to crove_worker alone), and only while the member is still in the org.
// - The worker's sync replaces the connection's busy blocks as a set (kernel.calendar.busy_replace). A block holds a
//   start and an end, never a title or an attendee.
import { sql } from 'kysely';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CALENDAR_LINK_MAX_ATTEMPTS, CALENDAR_PROVIDERS, GOOGLE_CALENDAR_EVENTS_SCOPE, zCalendarOAuthProvider, zId, type CalendarConnectionView } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const zKeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
// The sealed envelope as base64; its size is checked again by the column (64 KiB).
const zEnvelope = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(90_000);
const zStateHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const zInstant = z.iso.datetime({ offset: true });
// 10 minutes, the longest a member takes in a provider's dialog.
const OAUTH_ATTEMPT_SECONDS = 600;
// A block is at most this long (the table allows 31 days); a longer busy interval is cut into pieces.
const PIECE_MS = 30 * 86_400_000;
const MAX_BUSY = 20_000;

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới kết nối được lịch');
  return ctx.actor.userId;
}

// Errors the calendar_* definers raise, as domain errors. Anything else goes through the runtime's mapping.
function calendarError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'CALENDAR_NOT_FOUND':
      throw new DomainError('CALENDAR_NOT_FOUND', 404, 'Không tìm thấy lịch đã kết nối này');
    case 'CALENDAR_NOT_ACTIVE':
      throw new DomainError('CALENDAR_NOT_ACTIVE', 409, 'Lịch này không còn hoạt động, hãy kết nối lại');
    case 'CALENDAR_OWNER_LEFT':
      throw new DomainError('CALENDAR_OWNER_LEFT', 409, 'Chủ của lịch này không còn là thành viên của tổ chức');
    case 'CALENDAR_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Bạn chỉ quản lý được lịch của chính mình');
    default:
      throw error;
  }
}

function oauthError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'OAUTH_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Người xem không kết nối được lịch');
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

export const calendarOAuthBegin = defineCommand({
  name: 'kernel.calendar.oauth_begin',
  input: z.strictObject({ provider: zCalendarOAuthProvider, stateHash: zStateHash, codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).nullable() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ id: string }>`
      SELECT crove_kernel.calendar_oauth_begin(${input.provider}, ${input.stateHash}, ${input.codeVerifier}, ${OAUTH_ATTEMPT_SECONDS}::integer) AS id`
      .execute(ctx.trx)
      .catch(oauthError);
    const attemptId = rows[0]?.id;
    if (!attemptId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // The audit row names the attempt and provider only: never the hash or the verifier.
    ctx.audit({ attempt_id: attemptId, provider: input.provider });
    return { attemptId, expiresAt: new Date(ctx.now.getTime() + OAUTH_ATTEMPT_SECONDS * 1000).toISOString() };
  },
});

export const calendarOAuthConsume = defineCommand({
  name: 'kernel.calendar.oauth_consume',
  input: z.strictObject({ provider: zCalendarOAuthProvider, stateHash: zStateHash }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const { rows } = await sql<{ code_verifier: string | null }>`
      SELECT code_verifier FROM crove_kernel.calendar_oauth_consume(${input.provider}, ${input.stateHash})`
      .execute(ctx.trx)
      .catch(oauthError);
    if (rows.length !== 1) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    ctx.audit({ provider: input.provider });
    return { codeVerifier: rows[0]?.code_verifier ?? null };
  },
});

export const zCalendarConnect = z.strictObject({
  provider: z.enum(CALENDAR_PROVIDERS),
  externalAccount: z.string().trim().toLowerCase().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  scopes: z.array(z.string().min(1).max(200)).max(20),
  expiresAt: zInstant.nullable(),
  credential: z.strictObject({ keyId: zKeyId, envelope: zEnvelope }),
});

export const calendarConnect = defineCommand({
  name: 'kernel.calendar.connect',
  input: zCalendarConnect,
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    // Two connects of one account at once serialize here, so the second finds the first's row and reconnects
    // instead of failing on the unique index.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.calendar:${ctx.orgId}:${userId}:${input.provider}:${input.externalAccount}`}, 0))`.execute(ctx.trx);
    const values = { display_name: input.displayName, scopes: input.scopes, expires_at: input.expiresAt, status: 'active' as const, status_reason: null, updated_at: ctx.now };
    const existing = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('provider', '=', input.provider)
      .where('external_account', '=', input.externalAccount)
      .forUpdate()
      .executeTakeFirst();
    let id: string;
    if (existing) {
      await ctx.trx.updateTable('crove_kernel.calendar_connection').set(values).where('org_id', '=', ctx.orgId).where('id', '=', existing.id).execute();
      id = existing.id;
    } else {
      const row = await ctx.trx
        .insertInto('crove_kernel.calendar_connection')
        .values({ org_id: ctx.orgId, user_id: userId, provider: input.provider, external_account: input.externalAccount, ...values })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
    }
    await sql`SELECT crove_kernel.calendar_credential_put(${id}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
      .execute(ctx.trx)
      .catch(calendarError);
    ctx.audit({ connection_id: id, provider: input.provider, reconnected: Boolean(existing) });
    return { connectionId: id, reconnected: Boolean(existing) };
  },
});

export const calendarDisconnect = defineCommand({
  name: 'kernel.calendar.disconnect',
  input: z.strictObject({ connectionId: zId }),
  risk: 'R2',
  sideEffect: 'external',
  // Every role, a viewer included: a member demoted after connecting can still take their own calendar away.
  access: ['owner', 'admin', 'member', 'viewer'],
  target: (input) => ({ type: 'kernel.calendar_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    // The row policy shows a member only their own, so another member's connection is not found.
    const row = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['provider', 'user_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.user_id !== userId) throw new DomainError('CALENDAR_NOT_FOUND', 404, 'Không tìm thấy lịch đã kết nối này');
    // Asked twice: already on its way out.
    if (row.status === 'disconnecting') return { connectionId: input.connectionId, disconnected: true as const };
    if (row.status === 'expired') {
      // The provider refused the grant already and the token is gone: nothing to revoke. The tokens first, then the
      // row: its foreign keys delete the busy blocks it made.
      await sql`SELECT crove_kernel.calendar_credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(calendarError);
      await ctx.trx.deleteFrom('crove_kernel.calendar_connection').where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).execute();
    } else {
      // The API cannot open the sealed token, so it cannot revoke the grant at the provider: the connection is marked, its
      // busy blocks go now (the slots are free at once) and the worker revokes the grant and finishes the removal
      // (kernel.calendar.finish_disconnect). It no longer shows in the member's list.
      await ctx.trx.deleteFrom('crove_kernel.calendar_event').where('org_id', '=', ctx.orgId).where('source_id', '=', input.connectionId).execute();
      await ctx.trx
        .updateTable('crove_kernel.calendar_connection')
        .set({ status: 'disconnecting', status_reason: null, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.connectionId)
        .execute();
    }
    ctx.audit({ connection_id: input.connectionId, provider: row.provider, revoke_pending: row.status !== 'expired' });
    return { connectionId: input.connectionId, disconnected: true as const };
  },
});

// The worker revoked the grant at the provider (or could not, and says why): the sealed token goes and the connection
// with it. Only for a connection that is disconnecting, so a member who connected the same account again meanwhile
// keeps it. revoked=false names the reason (the member left, the token cannot be opened, the provider kept refusing
// the revoke for days): the grant may still be live at the provider and the member can remove it in their account.
export const calendarFinishDisconnect = defineCommand({
  name: 'kernel.calendar.finish_disconnect',
  input: z.strictObject({ connectionId: zId, revoked: z.boolean(), reason: z.string().min(1).max(100).optional(), ifVersion: zInstant.optional() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.calendar_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['status', 'provider', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { connectionId: input.connectionId, finished: false };
    if (row.status !== 'disconnecting') {
      // The member connected the same account again after the worker read this disconnect, and the provider's revoke ended
      // the whole grant, the new tokens too: the new connection is expired now, so the member connects again at once and
      // does not find out at the next sync.
      const reconnected = row.status === 'active' && input.revoked && input.ifVersion !== undefined && Math.floor(row.updated_at.getTime()) !== Date.parse(input.ifVersion);
      if (reconnected) {
        await ctx.trx
          .updateTable('crove_kernel.calendar_connection')
          .set({ status: 'expired', status_reason: 'grant revoked while reconnecting: connect again', updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', input.connectionId)
          .execute();
        await sql`SELECT crove_kernel.calendar_credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(calendarError);
        ctx.audit({ connection_id: input.connectionId, provider: row.provider, expired_by_revoke: true });
      }
      return { connectionId: input.connectionId, finished: false };
    }
    // Disconnected again after the worker read the older disconnect, which ended without a revoke (it gave up, or could
    // not open the old token): the new disconnect has a newer token the worker has yet to try, so it is left for the next
    // sweep. After a revoke the whole grant is gone, the newer token's too, and it finishes.
    if (!input.revoked && input.ifVersion !== undefined && Math.floor(row.updated_at.getTime()) !== Date.parse(input.ifVersion)) {
      return { connectionId: input.connectionId, finished: false };
    }
    await sql`SELECT crove_kernel.calendar_credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(calendarError);
    await ctx.trx.deleteFrom('crove_kernel.calendar_connection').where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).execute();
    ctx.audit({ connection_id: input.connectionId, provider: row.provider, revoked: input.revoked, ...(input.reason ? { reason: input.reason } : {}) });
    return { connectionId: input.connectionId, finished: true };
  },
});

// The worker's sync could not go on: the provider refused the token (expired: the member revoked the app and reconnects)
// or failed in some other way (retry: the connection stays active, says why, and the next sweep tries again). An
// expired connection loses its sealed token, which is dead anyway; its busy blocks stay until the member reconnects or
// disconnects, so time that may still be busy is not offered meanwhile. ifVersion: the connection's updated_at the caller saw; a connection changed since
// (reconnected with a new token) is left alone.
export const calendarMarkFailed = defineCommand({
  name: 'kernel.calendar.mark_failed',
  input: z.strictObject({ connectionId: zId, status: z.enum(['expired', 'retry']), reason: z.string().min(1).max(200), ifVersion: zInstant.optional() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.calendar_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['status', 'provider', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CALENDAR_NOT_FOUND', 404, 'Không tìm thấy lịch đã kết nối này');
    // A connection on its way out is not marked: the member took it away.
    if (row.status === 'disconnecting') return { connectionId: input.connectionId, marked: false };
    if (input.ifVersion !== undefined && Math.floor(row.updated_at.getTime()) !== Date.parse(input.ifVersion)) return { connectionId: input.connectionId, marked: false };
    await ctx.trx
      .updateTable('crove_kernel.calendar_connection')
      .set(input.status === 'expired' ? { status: 'expired', status_reason: input.reason, updated_at: ctx.now } : { status_reason: input.reason })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    if (input.status === 'expired') await sql`SELECT crove_kernel.calendar_credential_drop(${input.connectionId}::uuid)`.execute(ctx.trx).catch(calendarError);
    ctx.audit({ connection_id: input.connectionId, provider: row.provider, status: input.status, reason: input.reason });
    return { connectionId: input.connectionId, marked: true };
  },
});

// A sync renewed a connection's access token: the new credential is sealed in and the expiry moves, in one transaction.
// ifVersion is the connection's updated_at the refresh started from; a connection changed since is left alone, and the
// answer says so: the caller then drops the new tokens.
export const calendarRefresh = defineCommand({
  name: 'kernel.calendar.refresh',
  input: z.strictObject({ connectionId: zId, ifVersion: zInstant, expiresAt: zInstant.nullable(), credential: z.strictObject({ keyId: zKeyId, envelope: zEnvelope }) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.calendar_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const row = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['status', 'provider', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('CALENDAR_NOT_FOUND', 404, 'Không tìm thấy lịch đã kết nối này');
    // Compared at millisecond precision, the precision the caller read it at.
    if (row.status !== 'active' || Math.floor(row.updated_at.getTime()) !== Date.parse(input.ifVersion)) return { connectionId: input.connectionId, refreshed: false };
    await sql`SELECT crove_kernel.calendar_credential_put(${input.connectionId}::uuid, ${input.credential.keyId}, decode(${input.credential.envelope}, 'base64'))`
      .execute(ctx.trx)
      .catch(calendarError);
    await ctx.trx
      .updateTable('crove_kernel.calendar_connection')
      .set({ expires_at: input.expiresAt, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    ctx.audit({ connection_id: input.connectionId, provider: row.provider });
    return { connectionId: input.connectionId, refreshed: true, updatedAt: ctx.now.toISOString() };
  },
});

export interface BusyPiece {
  start: number;
  end: number;
}

/**
 * The busy intervals a provider answered as the blocks to keep: clipped to the window, empty ones dropped, overlapping
 * or touching ones merged, and any longer than a block may be cut into pieces.
 */
export function busyPieces(busy: ReadonlyArray<{ start: number; end: number }>, from: number, to: number): BusyPiece[] {
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, from), end: Math.min(b.end, to) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: BusyPiece[] = [];
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ ...b });
  }
  const out: BusyPiece[] = [];
  for (const m of merged) for (let s = m.start; s < m.end; s += PIECE_MS) out.push({ start: s, end: Math.min(m.end, s + PIECE_MS) });
  return out;
}

const pieceKey = (p: BusyPiece) => `${p.start}-${p.end}`;

/** `busy` with the time of every cut taken out: what is left of an interval that a cut overlaps is the part outside it. */
export function cutOut(busy: ReadonlyArray<BusyPiece>, cuts: ReadonlyArray<BusyPiece>): BusyPiece[] {
  let rest = busy.map((b) => ({ ...b }));
  for (const cut of cuts) {
    const next: BusyPiece[] = [];
    for (const b of rest) {
      if (cut.end <= b.start || cut.start >= b.end) next.push(b);
      else {
        if (b.start < cut.start) next.push({ start: b.start, end: cut.start });
        if (b.end > cut.end) next.push({ start: cut.end, end: b.end });
      }
    }
    rest = next;
  }
  return rest;
}

// The sync's answer: the connection's busy blocks over [from, to) become exactly these intervals. Blocks that are
// not in the answer go, new ones come in, the rest stay; one transaction, so slot computation never sees half a sync.
export const calendarBusyReplace = defineCommand({
  name: 'kernel.calendar.busy_replace',
  input: z.strictObject({
    connectionId: zId,
    from: zInstant,
    to: zInstant,
    busy: z.array(z.strictObject({ start: zInstant, end: zInstant })).max(MAX_BUSY),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.calendar_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const conn = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['status', 'provider', 'user_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!conn) throw new DomainError('CALENDAR_NOT_FOUND', 404, 'Không tìm thấy lịch đã kết nối này');
    if (conn.status !== 'active') return { connectionId: input.connectionId, replaced: false, added: 0, removed: 0 };
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    // The event the write-back put in the member's calendar comes back in the provider's busy answer. The booking's own
    // calendar event already covers that time, and its copy must not stand in the way of moving the booking (nor of the
    // booking next to it), so the time of every written, unchanged booking is cut out of the answer. A genuine event that
    // overlaps a booking keeps the part outside it; the part under it is covered by the booking until the next sweep.
    const copies = await ctx.trx
      .selectFrom('crove_kernel.calendar_event_link as l')
      .innerJoin('crove_kernel.calendar_event as e', (join) => join.onRef('e.org_id', '=', 'l.org_id').onRef('e.id', '=', 'l.event_id'))
      .select(['l.synced_hash', 'e.starts_at', 'e.ends_at', 'e.title'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.connection_id', '=', input.connectionId)
      .where('l.state', '=', 'written')
      .where('e.status', '=', 'active')
      .where('e.ends_at', '>', new Date(from))
      .execute();
    const cuts: BusyPiece[] = [];
    for (const c of copies) {
      const s = new Date(c.starts_at);
      const e = new Date(c.ends_at);
      if (c.synced_hash === writeBackHash(s, e, c.title)) cuts.push({ start: s.getTime(), end: e.getTime() });
    }
    const answered = input.busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
    const wanted = new Map(busyPieces(cuts.length > 0 ? cutOut(answered, cuts) : answered, from, to).map((p) => [pieceKey(p), p]));
    const existing = await ctx.trx
      .selectFrom('crove_kernel.calendar_event')
      .select(['id', 'external_id'])
      .where('org_id', '=', ctx.orgId)
      .where('source_id', '=', input.connectionId)
      .where('ends_at', '>', new Date(from))
      .execute();
    const have = new Set(existing.map((e) => e.external_id));
    const stale = existing.filter((e) => e.external_id === null || !wanted.has(e.external_id)).map((e) => e.id);
    if (stale.length > 0) await ctx.trx.deleteFrom('crove_kernel.calendar_event').where('org_id', '=', ctx.orgId).where('id', 'in', stale).execute();
    // Blocks that ended before the window are history nobody reads: they go with the sync that moved past them.
    await ctx.trx.deleteFrom('crove_kernel.calendar_event').where('org_id', '=', ctx.orgId).where('source_id', '=', input.connectionId).where('ends_at', '<=', new Date(from)).execute();
    const fresh = [...wanted.entries()].filter(([key]) => !have.has(key));
    for (let i = 0; i < fresh.length; i += 500) {
      await ctx.trx
        .insertInto('crove_kernel.calendar_event')
        .values(
          fresh.slice(i, i + 500).map(([key, p]) => ({
            org_id: ctx.orgId,
            user_id: conn.user_id,
            starts_at: new Date(p.start),
            ends_at: new Date(p.end),
            time_zone: 'UTC',
            title: null,
            kind: conn.provider,
            source_id: input.connectionId,
            external_id: key,
            created_by: conn.user_id,
            created_at: ctx.now,
          })),
        )
        .execute();
    }
    await ctx.trx
      .updateTable('crove_kernel.calendar_connection')
      .set({ last_synced_at: ctx.now, status_reason: null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .execute();
    // Counts only: never the intervals.
    ctx.audit({ connection_id: input.connectionId, provider: conn.provider, added: fresh.length, removed: stale.length });
    return { connectionId: input.connectionId, replaced: true, added: fresh.length, removed: stale.length };
  },
});

export interface SealedCalendarCredential {
  provider: string;
  externalAccount: string;
  keyId: string;
  // base64
  envelope: string;
}

// The sealed credential of an active connection, for the sync in the worker. The caller opens it with the credential
// broker for the binding returned here and drops the plaintext after the call.
export const calendarCredential = defineQuery({
  name: 'kernel.calendar.credential',
  input: z.strictObject({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<SealedCalendarCredential> => {
    const { rows } = await sql<{ key_id: string; envelope: Buffer; provider: string; external_account: string }>`
      SELECT key_id, envelope, provider, external_account FROM crove_kernel.calendar_credential_get(${input.connectionId}::uuid)`
      .execute(ctx.trx)
      .catch(calendarError);
    const row = rows[0];
    if (!row) throw new DomainError('CALENDAR_NOT_FOUND', 404, 'Không tìm thấy lịch đã kết nối này');
    return { provider: row.provider, externalAccount: row.external_account, keyId: row.key_id, envelope: row.envelope.toString('base64') };
  },
});

// The connection as the sync sees it (its version for the guards above); null when it is gone.
export const calendarConnectionState = defineQuery({
  name: 'kernel.calendar.connection_state',
  input: z.strictObject({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input) => {
    const row = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['status', 'provider', 'expires_at', 'updated_at', 'write_back', 'scopes'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      status: row.status,
      provider: row.provider,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      updatedAt: row.updated_at.toISOString(),
      // Bookings are written to this calendar: the member turned it on and the grant carries the events scope.
      writeBack: row.write_back && row.scopes.includes(GOOGLE_CALENDAR_EVENTS_SCOPE),
    };
  },
});

// The member's own connections (the row policy hides everyone else's).
export const calendarConnections = defineQuery({
  name: 'kernel.calendar.connections',
  input: z.strictObject({}),
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx): Promise<CalendarConnectionView[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được lịch đã kết nối');
    const rows = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['id', 'provider', 'display_name', 'status', 'status_reason', 'last_synced_at', 'write_back', 'scopes', 'connected_at'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', ctx.actor.userId)
      // One on its way out (the worker has yet to revoke its grant) is already gone for the member.
      .where('status', '<>', 'disconnecting')
      .orderBy('connected_at')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      displayName: r.display_name,
      status: r.status === 'expired' ? ('expired' as const) : ('active' as const),
      statusReason: r.status_reason,
      lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
      writeBack: r.write_back,
      canWriteBack: r.scopes.includes(GOOGLE_CALENDAR_EVENTS_SCOPE),
      connectedAt: r.connected_at.toISOString(),
    }));
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Write-back of bookings to the connected calendar (#2124). The booking's own calendar event (kind booking, its title
// already "<event type>: <visitor name>") is what is written; the kernel reads nothing of the crm module.
// ---------------------------------------------------------------------------------------------------------------------

const base32hex = (bytes: Buffer): string => {
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
};

/** The provider's event id for a booking event on a connection: the same every time, so a retry cannot make a second event (Google's ids are base32hex, 5 to 1024 characters). */
export function writeBackEventId(orgId: string, eventId: string, connectionId: string): string {
  return base32hex(createHash('sha256').update(`${orgId}:${eventId}:${connectionId}`).digest());
}

/** A fingerprint of what is written for a booking event: the link keeps it, so an unchanged booking costs no call. */
export function writeBackHash(startsAt: Date, endsAt: Date, title: string | null): string {
  return `sha256:${createHash('sha256').update(`${startsAt.getTime()}|${endsAt.getTime()}|${title ?? ''}`).digest('hex')}`;
}
const DELETED_HASH = 'deleted';
// How far back a booking still matters (a day), and the most actions one plan holds.
const WRITE_BACK_BACK_MS = 86_400_000;
const PLAN_LIMIT = 100;
// The events one query of the plan reads, and the most queries one plan makes.
const PLAN_PAGE = 1000;
const PLAN_MAX_PAGES = 50;

export const calendarWriteBackSet = defineCommand({
  name: 'kernel.calendar.write_back.set',
  input: z.strictObject({ connectionId: zId, enabled: z.boolean() }),
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  target: (input) => ({ type: 'kernel.calendar_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const row = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['user_id', 'status', 'scopes', 'provider'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.user_id !== userId) throw new DomainError('CALENDAR_NOT_FOUND', 404, 'Không tìm thấy lịch đã kết nối này');
    if (input.enabled) {
      if (row.status !== 'active') throw new DomainError('CALENDAR_NOT_ACTIVE', 409, 'Lịch này không còn hoạt động, hãy kết nối lại');
      // The grant must carry the events scope: the member connects again, asking for it.
      if (!row.scopes.includes(GOOGLE_CALENDAR_EVENTS_SCOPE)) throw new DomainError('CALENDAR_SCOPE_MISSING', 409, 'Hãy kết nối lại lịch này và cho phép ghi lịch hẹn');
    }
    await ctx.trx.updateTable('crove_kernel.calendar_connection').set({ write_back: input.enabled }).where('org_id', '=', ctx.orgId).where('id', '=', input.connectionId).execute();
    ctx.audit({ connection_id: input.connectionId, provider: row.provider, write_back: input.enabled });
    return { connectionId: input.connectionId, writeBack: input.enabled };
  },
});

export interface WriteBackAction {
  eventId: string;
  externalId: string;
  kind: 'upsert' | 'delete';
  // For an upsert: what to write.
  summary: string | null;
  startsAt: string | null;
  endsAt: string | null;
  // The fingerprint the link keeps after the call (a delete keeps 'deleted').
  hash: string;
}

// What the worker has to make true at the provider for a connection with write-back on: the member's booking events
// that are new or changed since they were written (insert or patch), and the links whose booking was cancelled
// (delete). An unchanged booking, a link in error that used up its attempts and has not changed, and an event the
// member deleted by hand and that has not changed since, produce nothing.
export const calendarWriteBackPlan = defineQuery({
  name: 'kernel.calendar.writeback_plan',
  input: z.strictObject({ connectionId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<{ actions: WriteBackAction[] }> => {
    const conn = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['user_id', 'status', 'write_back', 'scopes'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .executeTakeFirst();
    if (!conn || conn.status !== 'active' || !conn.write_back || !conn.scopes.includes(GOOGLE_CALENDAR_EVENTS_SCOPE)) return { actions: [] };
    const since = new Date(Date.now() - WRITE_BACK_BACK_MS);
    type PlanEvent = { id: string; starts_at: Date | string; ends_at: Date | string; title: string | null; status: string };
    type PlanLink = { event_id: string; external_id: string; state: string; synced_hash: string; attempts: number };
    const actions: WriteBackAction[] = [];
    const linksOf = async (ids: string[]): Promise<Map<string, PlanLink>> => {
      if (ids.length === 0) return new Map();
      const rows = await ctx.trx
        .selectFrom('crove_kernel.calendar_event_link')
        .select(['event_id', 'external_id', 'state', 'synced_hash', 'attempts'])
        .where('org_id', '=', ctx.orgId)
        .where('connection_id', '=', input.connectionId)
        .where('event_id', 'in', ids)
        .execute();
      return new Map(rows.map((l) => [l.event_id, l]));
    };
    const deleteNeeded = (link: PlanLink | undefined, window: boolean): boolean => {
      // No link: a write may have reached the provider without its record (a crash between the two), so a booking cancelled
      // in the window is deleted by its derived id; the provider's "not there" is recorded and ends it. Outside the window
      // only a link that says something is there is looked at.
      if (!link) return window;
      if (link.state === 'written') return true;
      if (link.state === 'error') return link.synced_hash !== DELETED_HASH || link.attempts < CALENDAR_LINK_MAX_ATTEMPTS;
      return false;
    };
    const planEvents = (events: PlanEvent[], links: Map<string, PlanLink>, window: boolean) => {
      for (const e of events) {
        if (actions.length >= PLAN_LIMIT) return;
        const link = links.get(e.id);
        const externalId = link?.external_id ?? writeBackEventId(ctx.orgId, e.id, input.connectionId);
        if (e.status === 'cancelled') {
          if (deleteNeeded(link, window)) actions.push({ eventId: e.id, externalId, kind: 'delete', summary: null, startsAt: null, endsAt: null, hash: DELETED_HASH });
          continue;
        }
        if (!window) continue;
        const hash = writeBackHash(new Date(e.starts_at), new Date(e.ends_at), e.title);
        const unchanged = link !== undefined && link.synced_hash === hash;
        if (unchanged && (link.state === 'written' || link.state === 'removed' || link.attempts >= CALENDAR_LINK_MAX_ATTEMPTS)) continue;
        actions.push({ eventId: e.id, externalId, kind: 'upsert', summary: e.title ?? 'Lịch hẹn', startsAt: new Date(e.starts_at).toISOString(), endsAt: new Date(e.ends_at).toISOString(), hash });
      }
    };
    // The member's booking events of the last day and ahead, in pages by (start, id), until the plan is full: an event that
    // needs nothing never hides one behind it.
    let cursor: { startsAt: Date; id: string } | null = null;
    for (let page = 0; page < PLAN_MAX_PAGES && actions.length < PLAN_LIMIT; page++) {
      const after: { startsAt: Date; id: string } | null = cursor;
      const events: PlanEvent[] = await ctx.trx
        .selectFrom('crove_kernel.calendar_event')
        .select(['id', 'starts_at', 'ends_at', 'title', 'status'])
        .where('org_id', '=', ctx.orgId)
        .where('user_id', '=', conn.user_id)
        .where('kind', '=', 'booking')
        .where('ends_at', '>', since)
        .$if(after !== null, (q) => q.where((eb) => eb.or([eb('starts_at', '>', (after as { startsAt: Date }).startsAt), eb.and([eb('starts_at', '=', (after as { startsAt: Date }).startsAt), eb('id', '>', (after as { id: string }).id)])])))
        .orderBy('starts_at')
        .orderBy('id')
        .limit(PLAN_PAGE)
        .execute();
      if (events.length === 0) break;
      planEvents(events, await linksOf(events.map((e) => e.id)), true);
      const last = events[events.length - 1] as PlanEvent;
      cursor = { startsAt: new Date(last.starts_at), id: last.id };
      if (events.length < PLAN_PAGE) break;
    }
    // A written event whose booking was cancelled and whose delete is still open, however long ago the booking ended
    // (a sweep that did not run for days): the delete is owed whatever the window says.
    if (actions.length < PLAN_LIMIT) {
      const owed = await ctx.trx
        .selectFrom('crove_kernel.calendar_event_link as l')
        .innerJoin('crove_kernel.calendar_event as e', (join) => join.onRef('e.org_id', '=', 'l.org_id').onRef('e.id', '=', 'l.event_id'))
        .select(['e.id', 'e.starts_at', 'e.ends_at', 'e.title', 'e.status'])
        .where('l.org_id', '=', ctx.orgId)
        .where('l.connection_id', '=', input.connectionId)
        .where('e.status', '=', 'cancelled')
        .where('e.ends_at', '<=', since)
        .where((eb) => eb.or([eb('l.state', '=', 'written'), eb.and([eb('l.state', '=', 'error'), eb.or([eb('l.synced_hash', '<>', DELETED_HASH), eb('l.attempts', '<', CALENDAR_LINK_MAX_ATTEMPTS)])])]))
        .orderBy('e.ends_at')
        .limit(PLAN_LIMIT)
        .execute();
      planEvents(owed, await linksOf(owed.map((e) => e.id)), false);
    }
    return { actions: actions.slice(0, PLAN_LIMIT) };
  },
});

// What the worker did for one booking event on one connection: the link row, its state, the fingerprint it now matches,
// the attempts and a short error code. Audits ids and the state only.
export const calendarLinkRecord = defineCommand({
  name: 'kernel.calendar.link.record',
  input: z.strictObject({
    connectionId: zId,
    eventId: zId,
    externalId: z.string().min(5).max(1024),
    state: z.enum(['written', 'removed', 'error']),
    syncedHash: z.string().min(1).max(100),
    error: z.string().min(1).max(100).optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.calendar_connection', id: input.connectionId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    const conn = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select(['user_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.connectionId)
      .forUpdate()
      .executeTakeFirst();
    if (!conn) throw new DomainError('CALENDAR_NOT_FOUND', 404, 'Không tìm thấy lịch đã kết nối này');
    // Only a booking event of the connection's own member is linked.
    const event = await ctx.trx
      .selectFrom('crove_kernel.calendar_event')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.eventId)
      .where('user_id', '=', conn.user_id)
      .where('kind', '=', 'booking')
      .executeTakeFirst();
    if (!event) throw new DomainError('CALENDAR_EVENT_NOT_FOUND', 404, 'Không tìm thấy sự kiện này trên lịch của bạn');
    const existing = await ctx.trx
      .selectFrom('crove_kernel.calendar_event_link')
      .select(['id', 'attempts', 'synced_hash'])
      .where('org_id', '=', ctx.orgId)
      .where('connection_id', '=', input.connectionId)
      .where('event_id', '=', input.eventId)
      .forUpdate()
      .executeTakeFirst();
    const error = input.state === 'error' ? (input.error ?? 'failed') : null;
    if (existing) {
      // Attempts count failures of one thing to write: a booking that changed (or went from written to deleted) starts again.
      const sameWork = existing.synced_hash === input.syncedHash;
      await ctx.trx
        .updateTable('crove_kernel.calendar_event_link')
        .set({ state: input.state, synced_hash: input.syncedHash, attempts: input.state === 'error' ? Math.min((sameWork ? existing.attempts : 0) + 1, 1000) : 0, last_error: error, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
    } else {
      await ctx.trx
        .insertInto('crove_kernel.calendar_event_link')
        .values({
          org_id: ctx.orgId,
          connection_id: input.connectionId,
          event_id: input.eventId,
          user_id: conn.user_id,
          external_id: input.externalId,
          state: input.state,
          synced_hash: input.syncedHash,
          attempts: input.state === 'error' ? 1 : 0,
          last_error: error,
          updated_at: ctx.now,
        })
        .execute();
    }
    ctx.audit({ connection_id: input.connectionId, event_id: input.eventId, state: input.state, ...(error ? { error } : {}) });
    return { connectionId: input.connectionId, eventId: input.eventId, state: input.state };
  },
});

// The active connections of the org in the context that write bookings to the provider, for the job a booking's event
// queues (kernel.calendar.writeback_plan then plans each). The worker's, as the system.
export const calendarWriteBackConnections = defineQuery({
  name: 'kernel.calendar.writeback_connections',
  input: z.strictObject({}),
  access: 'system',
  handler: async (ctx): Promise<string[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.calendar_connection')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'active')
      .where('write_back', '=', true)
      .where(sql<boolean>`scopes @> ARRAY[${GOOGLE_CALENDAR_EVENTS_SCOPE}]::text[]`)
      .orderBy('id')
      // Far more than an org has; a connection beyond it is covered by the 15 minute sweep alone.
      .limit(200)
      .execute();
    return rows.map((r) => r.id);
  },
});
export const calendarConnectionCommands = [calendarOAuthBegin, calendarOAuthConsume, calendarConnect, calendarDisconnect, calendarFinishDisconnect, calendarWriteBackSet, calendarLinkRecord, calendarMarkFailed, calendarRefresh, calendarBusyReplace];
export const calendarConnectionQueries = [calendarCredential, calendarConnectionState, calendarConnections, calendarWriteBackPlan, calendarWriteBackConnections];
