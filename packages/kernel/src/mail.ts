// Outbound mail in the kernel, step E1a of the Email plan (docs/plan/email.md §3.2-3.3, ADR-0034, issue #538).
// Every mail Crove sends gets a crove_kernel.mail_message row in the transaction of the command that sends it, after a
// check against the org's suppression list, so a mail to an address that bounced hard or was stopped by hand is
// recorded as suppressed and never handed to a mailer. Addresses are matched by a keyed hash
// (crove_kernel.mail_address_hash), which outlives an erasure of the address.
//
// E1a sends nothing itself: the invite mail carries the raw invite token, which no table may hold, so the request
// that holds the token reads the row back (kernel.mail.direct.get), sends the mail unless it is suppressed and records
// the outcome with kernel.mail.record_direct.
//
// Queued mail (step E1b, #548): a command writes the row 'queued' with its merge data, and the worker sends it. One
// send per attempt through crove_kernel.external_call (key mail:<message>:<attempt>): kernel.mail.queue.begin checks
// the suppression list again, marks the mail 'sending' and writes the call 'started' in one transaction; the worker
// renders and sends the mail outside it; kernel.mail.queue.record writes the outcome. An unknown outcome is
// 'ambiguous': marketing is never sent again, transactional mail only through a mailer that dedupes.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zId } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export type MailStream = 'system' | 'transactional' | 'marketing';
export type MailScope = 'all' | 'marketing';

// The right-hand side of the Message-ID when the deployment names none: a reserved name (RFC 2606) no mail system
// resolves, for tests and mail that is only logged.
export const DEFAULT_MESSAGE_ID_DOMAIN = 'crove.invalid';
// The deployment's own domain for the Message-ID (the SMTP_FROM domain, else the PUBLIC_URL host), set once at boot so
// mail a module queues without naming one (the scheduled report, #704) is not sent with the reserved name.
let deploymentMessageIdDomain: string | undefined;
export function setMessageIdDomain(domain: string | undefined): void {
  deploymentMessageIdDomain = domain;
}
// How long the request that sent a mail may record its outcome.
export const DIRECT_RECORD_WINDOW_MS = 10 * 60 * 1000;

// The keyed hash of an address (lower-cased, trimmed and folded as invite_cap_key folds it).
export async function mailAddressHash(ctx: Pick<CommandContext, 'trx'>, address: string): Promise<string> {
  const { rows } = await sql<{ hash: string | null }>`SELECT crove_kernel.mail_address_hash(${address}) AS hash`.execute(ctx.trx);
  const hash = rows[0]?.hash;
  if (!hash) throw new DomainError('VALIDATION', 422, 'Địa chỉ email trống');
  return hash;
}

// Soft bounces (#539, Email plan §3.3): SOFT_BOUNCE_LIMIT of them within SOFT_BOUNCE_WINDOW_MS suppress marketing to
// the address for SOFT_BOUNCE_PAUSE_MS after the last one. Worked out from mail_event when a marketing mail is
// written, so the pause ends by itself and no row has to be lifted.
export const SOFT_BOUNCE_LIMIT = 3;
export const SOFT_BOUNCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SOFT_BOUNCE_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;

async function softBouncePaused(ctx: Pick<CommandContext, 'trx' | 'orgId'>, hash: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - SOFT_BOUNCE_PAUSE_MS - SOFT_BOUNCE_WINDOW_MS);
  const { rows } = await sql<{ at: Date }>`
    SELECT e.occurred_at AS at FROM crove_kernel.mail_event e
    JOIN crove_kernel.mail_message m ON m.org_id = e.org_id AND m.id = e.message_id
    WHERE e.org_id = ${ctx.orgId} AND m.to_hash = ${hash} AND e.kind = 'bounce_soft' AND e.occurred_at >= ${since}
    ORDER BY e.occurred_at`.execute(ctx.trx);
  // A bounce that completes SOFT_BOUNCE_LIMIT within the window, recent enough that its pause still runs.
  return rows.some(
    (row, i) =>
      i >= SOFT_BOUNCE_LIMIT - 1 &&
      row.at.getTime() >= now.getTime() - SOFT_BOUNCE_PAUSE_MS &&
      row.at.getTime() - (rows[i - SOFT_BOUNCE_LIMIT + 1]?.at.getTime() ?? Number.NEGATIVE_INFINITY) < SOFT_BOUNCE_WINDOW_MS,
  );
}

// Whether the org must not send mail of this stream to the address: a live suppression of scope 'all', or for
// marketing mail one of scope 'marketing' or a run of soft bounces.
export async function isSuppressed(ctx: Pick<CommandContext, 'trx' | 'orgId'>, hash: string, stream: MailStream, now: Date = new Date()): Promise<boolean> {
  const scopes: MailScope[] = stream === 'marketing' ? ['all', 'marketing'] : ['all'];
  const row = await ctx.trx
    .selectFrom('crove_kernel.mail_suppression')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('to_hash', '=', hash)
    .where('scope', 'in', scopes)
    .where('lifted_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  if (row) return true;
  return stream === 'marketing' && softBouncePaused(ctx, hash, now);
}

export interface MailToSend {
  stream: MailStream;
  // The command that sends it and the record it is about.
  source: string;
  sourceId?: string | null;
  templateKey: string;
  to: string;
  subject?: string | null;
  // 'sending': the caller sends it now and records the outcome; 'queued': the worker sends it (step E1b).
  // suppressed: a mail the sender decided not to send (a cap of its own), recorded with errorCode.
  status: 'sending' | 'queued' | 'suppressed';
  errorCode?: string;
  messageIdDomain?: string | undefined;
  // The merge data the worker renders a queued mail from (never a secret); dropped 30 days after a final status.
  payload?: Readonly<Record<string, unknown>> | null;
}

export interface MailRecord {
  id: string;
  status: 'sending' | 'queued' | 'suppressed';
  messageIdHeader: string;
}

// Writes the mail_message row for one mail, as suppressed when the address is suppressed for its stream.
export async function createMailMessage(ctx: CommandContext, mail: MailToSend): Promise<MailRecord> {
  const to = mail.to.trim().toLowerCase();
  const hash = await mailAddressHash(ctx, to);
  const status = (await isSuppressed(ctx, hash, mail.stream, ctx.now)) ? 'suppressed' : mail.status;
  const messageIdHeader = `<${randomUUID()}@${mail.messageIdDomain ?? deploymentMessageIdDomain ?? DEFAULT_MESSAGE_ID_DOMAIN}>`;
  const row = await ctx.trx
    .insertInto('crove_kernel.mail_message')
    .values({
      org_id: ctx.orgId,
      stream: mail.stream,
      source: mail.source,
      source_id: mail.sourceId ?? null,
      template_key: mail.templateKey,
      to_address: to,
      to_hash: hash,
      subject: mail.subject ?? null,
      payload: mail.payload ? JSON.stringify(mail.payload) : null,
      message_id_header: messageIdHeader,
      status,
      ...(status === 'suppressed' && mail.status === 'suppressed' && mail.errorCode ? { error_code: mail.errorCode.slice(0, 200) } : {}),
      created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, status, messageIdHeader };
}

const zSource = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

export interface DirectMail {
  messageId: string;
  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'suppressed' | 'failed' | 'ambiguous';
  messageIdHeader: string;
  // The mail's VERP token (#539): sent over SMTP with the Return-Path bounce+<token>@INBOUND_DOMAIN, so a bounce
  // report names this mail.
  bounceToken: string | null;
}

// The mail a command just wrote for the request to send itself (the invite mail): the newest row of this source and
// record that the member created within DIRECT_RECORD_WINDOW_MS, or null. The request sends it only while it is
// 'sending'. Nobody else's rows: the address stays with the member who sent it.
export const directMailGet = defineQuery({
  name: 'kernel.mail.direct.get',
  input: z.object({ source: zSource, sourceId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<DirectMail | null> => {
    if (ctx.actor.type !== 'user') return null;
    const row = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select(['id', 'status', 'message_id_header'])
      .where('org_id', '=', ctx.orgId)
      .where('source', '=', input.source)
      .where('source_id', '=', input.sourceId)
      .where('created_by', '=', ctx.actor.userId)
      .where('created_at', '>', new Date(Date.now() - DIRECT_RECORD_WINDOW_MS))
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    const { rows } = await sql<{ token: string | null }>`SELECT crove_kernel.mail_bounce_token(${row.id}) AS token`.execute(ctx.trx);
    return { messageId: row.id, status: row.status, messageIdHeader: row.message_id_header, bounceToken: rows[0]?.token ?? null };
  },
});

// The outcome of a mail the request sent itself (the invite mail): only the member whose command created the row,
// only while it is 'sending', and only within DIRECT_RECORD_WINDOW_MS of its creation.
export const recordDirectMail = defineCommand({
  name: 'kernel.mail.record_direct',
  input: z.object({
    messageId: zId,
    outcome: z.enum(['sent', 'failed']),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
    // The provider that took the mail, and the id it gave it (#539): its delivery events find the row by them.
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/)
      .optional(),
    providerMessageId: z.string().min(1).max(255).optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người gửi mới ghi được kết quả gửi thư');
    const row = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select(['id', 'attempts'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.messageId)
      .where('created_by', '=', ctx.actor.userId)
      .where('status', '=', 'sending')
      .where('created_at', '>', new Date(ctx.now.getTime() - DIRECT_RECORD_WINDOW_MS))
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy thư đang gửi');
    await ctx.trx
      .updateTable('crove_kernel.mail_message')
      .set({
        status: input.outcome,
        attempts: row.attempts + 1,
        error_code: input.outcome === 'failed' ? (input.errorCode ?? 'SEND_FAILED') : null,
        sent_at: input.outcome === 'sent' ? ctx.now : null,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.outcome === 'sent' && input.providerMessageId ? { provider_message_id: input.providerMessageId } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', row.id)
      .execute();
    ctx.audit({ message_id: row.id, outcome: input.outcome });
    return { messageId: row.id, status: input.outcome };
  },
});

const zMailAddress = z.email().max(320);
const zScope = z.enum(['all', 'marketing']);

// An owner or admin stops mail to an address (the recipient asked, or the address is known to be wrong). Scope 'all'
// stops every mail but the ones a person asks for on the spot; 'marketing' only campaigns. Adding a live suppression
// again changes nothing.
export const addMailSuppression = defineCommand({
  name: 'kernel.mail.suppression.add',
  input: z.object({ email: zMailAddress, scope: zScope }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới chặn được địa chỉ');
    const hash = await mailAddressHash(ctx, input.email);
    const inserted = await ctx.trx
      .insertInto('crove_kernel.mail_suppression')
      .values({ org_id: ctx.orgId, to_hash: hash, scope: input.scope, reason: 'manual', created_by: ctx.actor.userId })
      .onConflict((oc) => oc.columns(['org_id', 'to_hash', 'scope']).where('lifted_at', 'is', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) ctx.audit({ suppression_id: inserted.id, scope: input.scope });
    return { added: inserted !== undefined };
  },
});

// An owner or admin lifts a live suppression of an address, with a reason (R2: mail goes to that address again).
// A complaint is never lifted this way: only the recipient's own new opt-in may undo it (Email plan §3.3).
export const liftMailSuppression = defineCommand({
  name: 'kernel.mail.suppression.lift',
  input: z.object({ email: zMailAddress, scope: zScope, reason: z.string().trim().min(1).max(500) }),
  risk: 'R2',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới bỏ chặn được địa chỉ');
    const hash = await mailAddressHash(ctx, input.email);
    const live = await ctx.trx
      .selectFrom('crove_kernel.mail_suppression')
      .select(['id', 'reason'])
      .where('org_id', '=', ctx.orgId)
      .where('to_hash', '=', hash)
      .where('scope', '=', input.scope)
      .where('lifted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!live) throw new DomainError('NOT_SUPPRESSED', 404, 'Địa chỉ này không bị chặn');
    if (live.reason === 'complaint') {
      throw new DomainError('MAIL_COMPLAINT_LIFT', 409, 'Người nhận đã báo thư là spam; chỉ chính họ đăng ký lại mới bỏ chặn được');
    }
    await ctx.trx
      .updateTable('crove_kernel.mail_suppression')
      .set({ lifted_at: ctx.now, lifted_by: ctx.actor.userId, lift_reason: input.reason })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', live.id)
      .execute();
    ctx.audit({ suppression_id: live.id, scope: input.scope });
    return { lifted: true };
  },
});

// What an event does to its mail's status, when the move is one the mail may make (a bounce after a complaint, or
// an event for a mail still 'sending', leaves the status as it is; the event is recorded all the same).
const EVENT_STATUS: Partial<Record<MailEventKind, 'delivered' | 'bounced' | 'complained'>> = {
  delivered: 'delivered',
  bounce_hard: 'bounced',
  complaint: 'complained',
};
const STATUS_MOVES: Record<string, readonly string[]> = { sent: ['delivered', 'bounced', 'complained'], delivered: ['bounced', 'complained'] };

export type MailEventKind = 'delivered' | 'deferred' | 'bounce_hard' | 'bounce_soft' | 'complaint';

// One delivery event from the mail provider (#539, Email plan §3.3), recorded by the worker in the system context of
// the mail's org: the org was found from the stored mail, never from the payload. A replayed event (same provider
// and event id) changes nothing. A hard bounce suppresses all of the org's mail to the address; a complaint
// suppresses marketing (and marks the mail complained). Soft bounces are counted at send time (isSuppressed).
export const recordMailEvent = defineCommand({
  name: 'kernel.mail.event.record',
  input: z.object({
    messageId: zId,
    provider: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    providerEventId: z.string().min(1).max(255),
    kind: z.enum(['delivered', 'deferred', 'bounce_hard', 'bounce_soft', 'complaint']),
    occurredAt: z.iso.datetime({ offset: true }),
    detail: z.record(z.string().max(32), z.string().max(64)).refine((d) => Object.keys(d).length <= 8),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    const mail = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select(['id', 'status', 'to_hash'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.messageId)
      .forUpdate()
      .executeTakeFirst();
    if (!mail) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy thư');
    const event = await ctx.trx
      .insertInto('crove_kernel.mail_event')
      .values({
        org_id: ctx.orgId,
        message_id: mail.id,
        provider: input.provider,
        provider_event_id: input.providerEventId,
        kind: input.kind,
        occurred_at: new Date(input.occurredAt),
        detail: JSON.stringify(input.detail),
      })
      .onConflict((oc) => oc.columns(['org_id', 'provider', 'provider_event_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!event) return { recorded: false, status: mail.status, suppressed: null };
    const next = EVENT_STATUS[input.kind];
    let status = mail.status;
    if (next && STATUS_MOVES[mail.status]?.includes(next)) {
      await ctx.trx
        .updateTable('crove_kernel.mail_message')
        .set({ status: next, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', mail.id)
        .execute();
      status = next;
    }
    const suppression =
      input.kind === 'bounce_hard' ? { scope: 'all' as const, reason: 'hard_bounce' as const } : input.kind === 'complaint' ? { scope: 'marketing' as const, reason: 'complaint' as const } : null;
    let suppressed: MailScope | null = null;
    if (suppression) {
      const added = await ctx.trx
        .insertInto('crove_kernel.mail_suppression')
        .values({ org_id: ctx.orgId, to_hash: mail.to_hash, scope: suppression.scope, reason: suppression.reason, source_message_id: mail.id })
        .onConflict((oc) => oc.columns(['org_id', 'to_hash', 'scope']).where('lifted_at', 'is', null).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (added) suppressed = suppression.scope;
    }
    ctx.audit({ message_id: mail.id, event_id: event.id, kind: input.kind, ...(suppressed ? { suppressed } : {}) });
    return { recorded: true, status, suppressed };
  },
});

export type MailRetrySafety = 'safe' | 'idempotent' | 'reconcile_only' | 'never';
// Sends of one transactional mail after an unknown outcome, the first included (crove_kernel.mail_queued_due).
export const MAIL_MAX_ATTEMPTS = 3;
export const mailCallKey = (messageId: string, attempt: number) => `mail:${messageId}:${attempt}`;
const zProviderName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const zSafety = z.enum(['safe', 'idempotent', 'reconcile_only', 'never']);

function requireSystem(ctx: CommandContext): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình nền mới gửi được thư trong hàng đợi');
}

export type QueuedMailBegin =
  | { action: 'none'; reason: string }
  | { action: 'suppressed' }
  | {
      action: 'send';
      attempt: number;
      stream: MailStream;
      templateKey: string;
      templateVersion: number;
      to: string;
      subject: string | null;
      payload: Record<string, unknown>;
      messageIdHeader: string;
      bounceToken: string | null;
      // The org's inbound token (#669): a template whose replies should reach the Inbox names the org's inbound address
      // as the Reply-To.
      inboundToken: string;
    };

// A mail that cannot be sent leaves the queue as 'failed' with the reason, so no later pass picks it up again.
async function stop(ctx: CommandContext, messageId: string, again: boolean, reason: string): Promise<QueuedMailBegin> {
  if (!again) {
    await ctx.trx
      .updateTable('crove_kernel.mail_message')
      .set({ status: 'failed', error_code: reason, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', messageId)
      .execute();
  }
  return { action: 'none', reason };
}

// The worker starts one send of a queued mail (or of a transactional one whose last send is unknown, when the mailer
// dedupes): the suppression list is read again, since an address may have bounced or been stopped since the mail was
// queued, then the mail becomes 'sending' and the call 'started', in this transaction, before the worker calls the
// mailer. Anything else (sent, being sent, marketing after an unknown outcome) is left as it is.
export const beginQueuedMail = defineCommand({
  name: 'kernel.mail.queue.begin',
  input: z.object({ messageId: zId, provider: zProviderName, safety: zSafety }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<QueuedMailBegin> => {
    requireSystem(ctx);
    const mail = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select(['id', 'stream', 'status', 'attempts', 'template_key', 'template_version', 'to_address', 'to_hash', 'subject', 'payload', 'message_id_header'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.messageId)
      .forUpdate()
      .executeTakeFirst();
    if (!mail) return { action: 'none', reason: 'NOT_FOUND' };
    const again = mail.status === 'ambiguous';
    if (mail.status !== 'queued' && !again) return { action: 'none', reason: mail.status.toUpperCase() };
    if (again) {
      if (mail.stream === 'marketing') return { action: 'none', reason: 'MARKETING_NOT_REPEATED' };
      if (input.safety !== 'idempotent' && input.safety !== 'safe') return { action: 'none', reason: 'NOT_REPEATABLE' };
      if (mail.attempts >= MAIL_MAX_ATTEMPTS) return { action: 'none', reason: 'ATTEMPTS' };
    }
    if (!mail.to_address) return stop(ctx, mail.id, again, 'NO_ADDRESS');
    if (await isSuppressed(ctx, mail.to_hash, mail.stream, ctx.now)) {
      // A queued mail is stopped before any call; one whose last send is unknown is not tried again.
      await ctx.trx
        .updateTable('crove_kernel.mail_message')
        .set(again ? { status: 'failed', error_code: 'SUPPRESSED', updated_at: ctx.now } : { status: 'suppressed', updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', mail.id)
        .execute();
      ctx.audit({ message_id: mail.id, outcome: 'suppressed' });
      return { action: 'suppressed' };
    }
    const attempt = mail.attempts + 1;
    const inserted = await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key: mailCallKey(mail.id, attempt), module: 'kernel', target: input.provider, step: 'mail_send', retry_safety: input.safety, started_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return stop(ctx, mail.id, again, 'CALL_EXISTS');
    await ctx.trx
      .updateTable('crove_kernel.mail_message')
      .set({ status: 'sending', attempts: attempt, provider: input.provider, error_code: null, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', mail.id)
      .execute();
    const { rows } = await sql<{ token: string | null }>`SELECT crove_kernel.mail_bounce_token(${mail.id}) AS token`.execute(ctx.trx);
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('inbound_token').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const payload = mail.payload && typeof mail.payload === 'object' && !Array.isArray(mail.payload) ? (mail.payload as Record<string, unknown>) : {};
    return {
      action: 'send',
      attempt,
      stream: mail.stream,
      templateKey: mail.template_key,
      templateVersion: mail.template_version,
      to: mail.to_address,
      subject: mail.subject,
      payload,
      messageIdHeader: mail.message_id_header,
      bounceToken: rows[0]?.token ?? null,
      inboundToken: tenant.inbound_token,
    };
  },
});

// What a refusal from the mailer means for external_call.error_kind.
const CALL_ERROR_KIND = {
  invalid_recipient: 'bad_request',
  suppressed_by_provider: 'bad_request',
  rate_limited: 'rate_limited',
  auth: 'permission',
  bad_request: 'bad_request',
  transient: 'transient',
} as const;

// The outcome of one send the worker started (kernel.mail.queue.begin), for that attempt only: 'sent' with the
// provider's id, 'failed' with a code, or 'ambiguous' when the mailer may have taken it (a timeout, an unknown
// answer, a send lost with its worker). A refusal naming the recipient as invalid is a hard bounce, and one the
// provider makes from its own suppression list a provider stop: both stop the org's mail to the address.
export const recordQueuedMail = defineCommand({
  name: 'kernel.mail.queue.record',
  input: z.object({
    messageId: zId,
    attempt: z.number().int().min(1).max(1000),
    outcome: z.enum(['sent', 'failed', 'ambiguous']),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
    errorKind: z.enum(['invalid_recipient', 'suppressed_by_provider', 'rate_limited', 'auth', 'bad_request', 'transient']).optional(),
    providerMessageId: z.string().min(1).max(255).optional(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    requireSystem(ctx);
    const mail = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select(['id', 'to_hash'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.messageId)
      .where('status', '=', 'sending')
      .where('attempts', '=', input.attempt)
      .forUpdate()
      .executeTakeFirst();
    if (!mail) return { recorded: false };
    const sent = input.outcome === 'sent';
    await ctx.trx
      .updateTable('crove_kernel.mail_message')
      .set({
        status: input.outcome,
        error_code: sent ? null : (input.errorCode ?? (input.outcome === 'failed' ? 'SEND_FAILED' : 'OUTCOME_UNKNOWN')),
        ...(sent ? { sent_at: ctx.now } : {}),
        ...(sent && input.providerMessageId ? { provider_message_id: input.providerMessageId } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', mail.id)
      .execute();
    await ctx.trx
      .updateTable('crove_kernel.external_call')
      .set(
        sent
          ? { state: 'succeeded', external_ref: input.providerMessageId ?? null, finished_at: ctx.now, updated_at: ctx.now }
          : input.outcome === 'failed'
            ? { state: 'failed', error_kind: input.errorKind ? CALL_ERROR_KIND[input.errorKind] : 'unknown', error_code: input.errorCode ?? 'SEND_FAILED', finished_at: ctx.now, updated_at: ctx.now }
            : { state: 'ambiguous', error_kind: 'unknown', error_code: input.errorCode ?? 'OUTCOME_UNKNOWN', updated_at: ctx.now },
      )
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', mailCallKey(mail.id, input.attempt))
      .where('state', 'in', ['started', 'ambiguous'])
      .execute();
    const stop =
      input.outcome === 'failed' && input.errorKind === 'invalid_recipient'
        ? ('hard_bounce' as const)
        : input.outcome === 'failed' && input.errorKind === 'suppressed_by_provider'
          ? ('provider' as const)
          : null;
    if (stop) {
      await ctx.trx
        .insertInto('crove_kernel.mail_suppression')
        .values({ org_id: ctx.orgId, to_hash: mail.to_hash, scope: 'all', reason: stop, source_message_id: mail.id })
        .onConflict((oc) => oc.columns(['org_id', 'to_hash', 'scope']).where('lifted_at', 'is', null).doNothing())
        .execute();
    }
    ctx.audit({ message_id: mail.id, attempt: input.attempt, outcome: input.outcome, ...(stop ? { suppressed: stop } : {}) });
    return { recorded: true };
  },
});

// Mail to the org's own contact (#669): the address an owner or admin set in Settings (tenant.contact_email), never
// one the caller names, so a module's command can queue mail for its org without being able to mail anyone else. Run
// by module commands through ctx.run (Finance's request for missing invoices, and its monthly reminder in the system
// context), never routed to the API. The worker renders the mail from templateKey and payload (apps/kernel/src
// mail-templates.ts).
export const CONTACT_MAIL_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];
// Merge data of one queued mail, as JSON.
export const MAIL_PAYLOAD_MAX_BYTES = 64 * 1024;

export const queueContactMail = defineCommand({
  name: 'kernel.mail.contact.queue',
  input: z.object({
    source: zSource,
    sourceId: zId.optional(),
    templateKey: zSource,
    // One line: a subject never carries a line break or a control character.
    subject: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((v) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v), 'one line'),
    payload: z.record(z.string().max(64), z.unknown()).refine((p) => Buffer.byteLength(JSON.stringify(p), 'utf8') <= MAIL_PAYLOAD_MAX_BYTES, 'too large'),
  }),
  // A mail queued to a contact is an effect outside Crove (plan §4.7: a send derives at least R2; coordinator
  // decision on #1563, 2026-10-26): an agent may not queue one without review.
  risk: 'R2',
  sideEffect: 'external',
  access: CONTACT_MAIL_ROLES,
  handler: async (ctx, input) => {
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('contact_email').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (!tenant.contact_email) {
      throw new DomainError('CONTACT_EMAIL_REQUIRED', 409, 'Công ty chưa có email liên hệ; chủ sở hữu hoặc quản trị viên nhập email này trong Cài đặt');
    }
    const mail = await createMailMessage(ctx, {
      stream: 'transactional',
      source: input.source,
      sourceId: input.sourceId ?? null,
      templateKey: input.templateKey,
      to: tenant.contact_email,
      subject: input.subject,
      payload: input.payload,
      status: 'queued',
    });
    ctx.audit({ message_id: mail.id, status: mail.status, source: input.source });
    return { messageId: mail.id, status: mail.status as 'queued' | 'suppressed' };
  },
});

export const mailCommands = [recordDirectMail, addMailSuppression, liftMailSuppression, recordMailEvent, beginQueuedMail, recordQueuedMail];
export const mailQueries = [directMailGet];
