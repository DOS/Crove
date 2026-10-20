// Outbound mail in the kernel, step E1a of the Email plan (docs/plan/email.md §3.2-3.3, ADR-0034, issue #538).
// Every mail Crove sends gets a crove_kernel.mail_message row in the transaction of the command that sends it, after a
// check against the org's suppression list, so a mail to an address that bounced hard or was stopped by hand is
// recorded as suppressed and never handed to a mailer. Addresses are matched by a keyed hash
// (crove_kernel.mail_address_hash), which outlives an erasure of the address.
//
// E1a sends nothing itself: the invite mail carries the raw invite token, which no table may hold, so the request
// that holds the token reads the row back (kernel.mail.direct.get), sends the mail unless it is suppressed and records
// the outcome with kernel.mail.record_direct. Queued mail, sent by the
// worker through crove_kernel.external_call, is step E1b.
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
// How long the request that sent a mail may record its outcome.
export const DIRECT_RECORD_WINDOW_MS = 10 * 60 * 1000;

// The keyed hash of an address (lower-cased, trimmed and folded as invite_cap_key folds it).
export async function mailAddressHash(ctx: Pick<CommandContext, 'trx'>, address: string): Promise<string> {
  const { rows } = await sql<{ hash: string | null }>`SELECT crove_kernel.mail_address_hash(${address}) AS hash`.execute(ctx.trx);
  const hash = rows[0]?.hash;
  if (!hash) throw new DomainError('VALIDATION', 422, 'Địa chỉ email trống');
  return hash;
}

// Whether the org must not send mail of this stream to the address: a live suppression of scope 'all', or of scope
// 'marketing' for marketing mail.
export async function isSuppressed(ctx: Pick<CommandContext, 'trx' | 'orgId'>, hash: string, stream: MailStream): Promise<boolean> {
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
  return row !== undefined;
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
  status: 'sending' | 'queued';
  messageIdDomain?: string | undefined;
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
  const status = (await isSuppressed(ctx, hash, mail.stream)) ? 'suppressed' : mail.status;
  const messageIdHeader = `<${randomUUID()}@${mail.messageIdDomain ?? DEFAULT_MESSAGE_ID_DOMAIN}>`;
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
      message_id_header: messageIdHeader,
      status,
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
    return row ? { messageId: row.id, status: row.status, messageIdHeader: row.message_id_header } : null;
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

export const mailCommands = [recordDirectMail, addMailSuppression, liftMailSuppression];
export const mailQueries = [directMailGet];
