// In-app notifications for every module (#671): crove_kernel.notification, one row per member, shown by the bell in the
// org shell. Social keeps its own (#637) until it moves here.
//
// Writing one: notifyMembers(ctx, { kind, users, key, ... }) inside a system command (the module's dispatch of an
// outbox event, a sweep, a reminder such as #676). It keeps only the users who are members now, drops the person who
// acted and those who turned the kind off, writes each member's row once per key (a replayed event or a second sweep
// writes nothing), and prunes the recipients' old rows. It returns how many rows it wrote. kind is '<module>.<kind>'.
//
// The kernel's own kinds come from kernel.notification.dispatch: a proposal waiting for my approval (the eligible
// approvers of its command, P12) and a file that failed to read (whoever asked for the reading, else the uploader,
// else, for a mailed file, the owners and admins), and a task a chart or role change moved to someone because its
// holder could no longer read its legal entity (the target seat's holder, else the owners; #1799). Members read their own (kernel.notification.list), mark them read
// and turn kinds off (kernel.notification.mute); a restrictive policy keeps each member to their own rows.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zNotificationKind } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { eligibleApprovers } from './approval.ts';
import { REROUTED_EVENT_TASKS } from './task-reroute.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The newest notifications a read returns, and the unread count it reports at most.
export const NOTIFICATION_LIST_LIMIT = 30;
export const NOTIFICATION_UNREAD_CAP = 99;
// Read notifications stay this long; unread ones a while longer.
export const NOTIFICATION_READ_KEEP_DAYS = 30;
export const NOTIFICATION_KEEP_DAYS = 90;

export const NOTIFICATION_KIND = /^[a-z]+\.[a-z0-9_]+$/;

// The kernel's kinds.
export const APPROVAL_WAITING = 'kernel.approval_waiting';
export const FILE_UNREADABLE = 'kernel.file_unreadable';
export const TASK_REROUTED = 'kernel.task_rerouted';

export interface NotifyInput {
  // '<module>.<kind>', for example 'finance.bank_attention'.
  kind: string;
  // Who it is for; anyone who is not a member of the org now is left out.
  users: readonly string[];
  // What makes it one notification: each member gets each key once ('proposal:<id>', 'period_closing:2026-09').
  key: string;
  // What it is about, for the link the app opens ('kernel.proposal' and its id).
  subject?: { type: string; id: string } | null;
  // The legal entity it belongs to (#1280): a member limited to other entities never sees it. Default: the org's
  // default entity.
  legalEntityId?: string | null;
  // What the line needs besides its subject: ids, codes, counts, a period; strings only, 2 KB at most. Never a copy of a
  // title, a name or other free text: kernel.notification.list reads the subject's when it shows the notice, so an
  // erasure that redacts it leaves no copy here (#1977).
  detail?: Record<string, string>;
  // The outbox event it comes from.
  eventId?: string | null;
  // The member who acted: never told about their own action.
  actor?: string | null;
}

export async function notifyMembers(ctx: CommandContext, input: NotifyInput): Promise<number> {
  if (ctx.actor.type !== 'system') throw new Error('notifyMembers runs in a system command');
  if (!NOTIFICATION_KIND.test(input.kind)) throw new Error(`not a notification kind: ${input.kind}`);
  const wanted = [...new Set(input.users)].filter((u) => u !== input.actor);
  if (wanted.length === 0) return 0;
  // Members now, who have not turned this kind off.
  const { rows } = await sql<{ user_id: string }>`
    SELECT m.user_id FROM crove_kernel.tenant_member m
    WHERE m.org_id = ${ctx.orgId} AND m.user_id = ANY(${wanted}::uuid[])
      AND NOT EXISTS (SELECT 1 FROM crove_kernel.notification_mute x WHERE x.org_id = m.org_id AND x.user_id = m.user_id AND x.kind = ${input.kind})`.execute(ctx.trx);
  if (rows.length === 0) return 0;
  const users = rows.map((r) => r.user_id);
  const inserted = await ctx.trx
    .insertInto('crove_kernel.notification')
    .values(
      users.map((userId) => ({
        org_id: ctx.orgId,
        user_id: userId,
        kind: input.kind,
        dedupe_key: input.key,
        event_id: input.eventId ?? null,
        subject_type: input.subject?.type ?? null,
        subject_id: input.subject?.id ?? null,
        ...(input.legalEntityId ? { legal_entity_id: input.legalEntityId } : {}),
        detail: JSON.stringify(input.detail ?? {}),
        created_at: ctx.now,
      })),
    )
    .onConflict((oc) => oc.columns(['org_id', 'user_id', 'dedupe_key']).doNothing())
    .returning('id')
    .execute();
  // The recipients' old ones go.
  await sql`
    DELETE FROM crove_kernel.notification
    WHERE org_id = ${ctx.orgId} AND user_id = ANY(${users}::uuid[])
      AND (read_at < ${ctx.now}::timestamptz - make_interval(days => ${NOTIFICATION_READ_KEEP_DAYS}::int)
           OR created_at < ${ctx.now}::timestamptz - make_interval(days => ${NOTIFICATION_KEEP_DAYS}::int))`.execute(ctx.trx);
  return inserted.length;
}

// The org's owners and admins, the members who act on what needs a look.
export async function ownersAndAdmins(ctx: Pick<CommandContext, 'trx' | 'orgId'>): Promise<string[]> {
  const rows = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('role', 'in', ['owner', 'admin']).execute();
  return rows.map((r) => r.user_id);
}

// An outbox event, read by id: a dispatch never trusts the job's copy.
export async function outboxEvent(ctx: Pick<CommandContext, 'trx' | 'orgId'>, eventId: string) {
  const event = await ctx.trx
    .selectFrom('crove_kernel.outbox_event')
    .select(['id', 'type', 'payload', 'actor_type', 'actor_id'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event) return null;
  return { ...event, actor: event.actor_type === 'user' ? event.actor_id : null };
}

// The events kernel.notification.dispatch handles.
export const KERNEL_NOTIFYING_EVENTS = ['kernel.proposal.created', 'kernel.file.read_failed', 'kernel.task.rerouted'] as const;

export const notificationDispatch = defineCommand({
  name: 'kernel.notification.dispatch',
  input: z.object({ eventId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    const event = await outboxEvent(ctx, input.eventId);
    if (!event) return { sent: 0 };
    switch (event.type) {
      case 'kernel.proposal.created': {
        const e = z.object({ proposalId: zId }).safeParse(event.payload);
        if (!e.success) return { sent: 0 };
        const proposal = await ctx.trx
          .selectFrom('crove_kernel.proposal')
          .select(['id', 'command', 'status', 'legal_entity_id'])
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', e.data.proposalId)
          .executeTakeFirst();
        // Decided before the worker got to it: nothing waits any more.
        if (proposal?.status !== 'pending') return { sent: 0 };
        const sent = await notifyMembers(ctx, {
          kind: APPROVAL_WAITING,
          users: await eligibleApprovers(ctx.trx, ctx.orgId, proposal.command),
          key: `proposal:${proposal.id}`,
          subject: { type: 'kernel.proposal', id: proposal.id },
          // The proposal's entity (#1538). Its title is read when the notice is shown, never copied (#1977).
          legalEntityId: proposal.legal_entity_id,
          detail: {},
          eventId: event.id,
          actor: event.actor,
        });
        return { sent };
      }
      case 'kernel.file.read_failed': {
        const e = z.object({ fileId: zId, version: z.number().int().positive() }).safeParse(event.payload);
        if (!e.success) return { sent: 0 };
        const file = await ctx.trx
          .selectFrom('crove_kernel.file as f')
          .leftJoin('crove_kernel.extraction as x', (join) => join.onRef('x.org_id', '=', 'f.org_id').onRef('x.file_id', '=', 'f.id').on('x.version', '=', e.data.version))
          .select(['f.id', 'f.created_by', 'x.requested_by', 'x.legal_entity_id'])
          .where('f.org_id', '=', ctx.orgId)
          .where('f.id', '=', e.data.fileId)
          .executeTakeFirst();
        if (!file) return { sent: 0 };
        // Whoever asked for this reading, else the uploader; a mailed file has neither, so the owners and admins.
        const asker = file.requested_by ?? file.created_by;
        const sent = await notifyMembers(ctx, {
          kind: FILE_UNREADABLE,
          users: asker ? [asker] : await ownersAndAdmins(ctx),
          key: `file_unreadable:${file.id}:${e.data.version}`,
          subject: { type: 'kernel.file', id: file.id },
          legalEntityId: file.legal_entity_id,
          // The file's name is read when the notice is shown (#1977).
          detail: {},
          eventId: event.id,
        });
        return { sent };
      }
      case 'kernel.task.rerouted': {
        const e = z
          .object({ toPositionId: zId.nullable(), legalEntityId: zId, count: z.number().int().positive(), taskIds: z.array(zId).min(1).max(REROUTED_EVENT_TASKS) })
          .safeParse(event.payload);
        if (!e.success) return { sent: 0 };
        // The moved tasks still waiting where they went: one moved again since tells its own holder, and a closed one
        // waits for nobody.
        const waiting = await ctx.trx
          .selectFrom('crove_kernel.task')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('id', 'in', e.data.taskIds)
          .where((eb) => (e.data.toPositionId === null ? eb('assignee_position_id', 'is', null) : eb('assignee_position_id', '=', e.data.toPositionId)))
          .where('status', 'not in', ['done', 'cancelled'])
          .orderBy('id')
          .execute();
        const first = waiting[0];
        if (!first) return { sent: 0 };
        const seat = e.data.toPositionId
          ? await ctx.trx.selectFrom('crove_kernel.position').select('holder_user_id').where('org_id', '=', ctx.orgId).where('id', '=', e.data.toPositionId).executeTakeFirst()
          : undefined;
        const owners = async () =>
          (await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('role', '=', 'owner').execute()).map(
            (r) => r.user_id,
          );
        const sent = await notifyMembers(ctx, {
          kind: TASK_REROUTED,
          users: seat?.holder_user_id ? [seat.holder_user_id] : await owners(),
          key: `task_rerouted:${event.id}`,
          // One task opens itself; several open the task list.
          subject: waiting.length === 1 && e.data.count === 1 ? { type: 'kernel.task', id: first.id } : null,
          legalEntityId: e.data.legalEntityId,
          // The event lists the first ids only: when every listed one still waits, so do the rest it counts. One task's
          // title is read when the notice is shown (#1977).
          detail: waiting.length === 1 && e.data.count === 1 ? {} : { count: String(waiting.length === e.data.taskIds.length ? e.data.count : waiting.length) },
          eventId: event.id,
          actor: event.actor,
        });
        return { sent };
      }
      default:
        return { sent: 0 };
    }
  },
});

export interface NotificationItem {
  id: string;
  kind: string;
  subjectType: string | null;
  subjectId: string | null;
  detail: Record<string, string>;
  createdAt: string;
  read: boolean;
}

function requireUser(ctx: Pick<CommandContext, 'actor'>): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// The viewer's newest notifications, how many are unread (up to NOTIFICATION_UNREAD_CAP + 1) and the kinds they turned
// off. A proposal that is no longer pending is not waiting for anyone, so its notification is shown read. The subject's
// title (a proposal's or task's) or file name is read here, as the viewer may read it, never kept with the notice: a
// value the personal-data erasure redacts in the task leaves no copy behind (#1977). A notice written before keeps the
// copy it was written with, which is shown only when its subject is gone; dropping those copies is an owner decision
// (#1958).
export const notificationList = defineQuery({
  name: 'kernel.notification.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<{ items: NotificationItem[]; unread: number; muted: string[] }> => {
    const me = requireUser(ctx);
    const settled = sql<boolean>`(n.kind = ${APPROVAL_WAITING} AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.proposal p WHERE p.org_id = n.org_id AND p.id = n.subject_id AND p.status = 'pending'))`;
    const { rows } = await sql<{
      id: string;
      kind: string;
      subject_type: string | null;
      subject_id: string | null;
      detail: Record<string, unknown>;
      subject_title: string | null;
      subject_filename: string | null;
      created_at: Date;
      read: boolean;
    }>`
      SELECT n.id, n.kind, n.subject_type, n.subject_id, n.detail, n.created_at, (n.read_at IS NOT NULL OR ${settled}) AS read,
             CASE n.subject_type
               WHEN 'kernel.proposal' THEN (SELECT p.title FROM crove_kernel.proposal p WHERE p.org_id = n.org_id AND p.id = n.subject_id)
               WHEN 'kernel.task' THEN (SELECT t.title FROM crove_kernel.task t WHERE t.org_id = n.org_id AND t.id = n.subject_id)
             END AS subject_title,
             CASE WHEN n.subject_type = 'kernel.file'
               THEN (SELECT f.filename FROM crove_kernel.file f WHERE f.org_id = n.org_id AND f.id = n.subject_id)
             END AS subject_filename
      FROM crove_kernel.notification n
      WHERE n.org_id = ${ctx.orgId} AND n.user_id = ${me}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${NOTIFICATION_LIST_LIMIT}`.execute(ctx.trx);
    const unread = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM crove_kernel.notification n
        WHERE n.org_id = ${ctx.orgId} AND n.user_id = ${me} AND n.read_at IS NULL AND NOT ${settled}
        LIMIT ${NOTIFICATION_UNREAD_CAP + 1}
      ) u`.execute(ctx.trx);
    const muted = await ctx.trx.selectFrom('crove_kernel.notification_mute').select('kind').where('org_id', '=', ctx.orgId).where('user_id', '=', me).orderBy('kind').execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        detail: {
          ...Object.fromEntries(Object.entries(r.detail ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
          ...(r.subject_title !== null ? { title: r.subject_title.slice(0, 200) } : {}),
          ...(r.subject_filename !== null ? { filename: r.subject_filename.slice(0, 200) } : {}),
        },
        createdAt: r.created_at.toISOString(),
        read: r.read,
      })),
      unread: unread.rows[0]?.n ?? 0,
      muted: muted.map((m) => m.kind),
    };
  },
});

// Marks the viewer's own notifications read: the ones named, or all of them.
export const notificationRead = defineCommand({
  name: 'kernel.notification.read',
  input: z.union([z.strictObject({ ids: z.array(zId).min(1).max(100) }), z.strictObject({ all: z.literal(true) })]),
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input) => {
    const me = requireUser(ctx);
    let q = ctx.trx.updateTable('crove_kernel.notification').set({ read_at: ctx.now }).where('org_id', '=', ctx.orgId).where('user_id', '=', me).where('read_at', 'is', null);
    if ('ids' in input) q = q.where('id', 'in', input.ids);
    const done = await q.executeTakeFirst();
    return { read: Number(done.numUpdatedRows) };
  },
});

// Turns a kind of notification off, or back on, for the viewer.
export const notificationMute = defineCommand({
  name: 'kernel.notification.mute',
  input: z.strictObject({ kind: zNotificationKind, muted: z.boolean() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input) => {
    const me = requireUser(ctx);
    if (input.muted) {
      await ctx.trx
        .insertInto('crove_kernel.notification_mute')
        .values({ org_id: ctx.orgId, user_id: me, kind: input.kind, created_at: ctx.now })
        .onConflict((oc) => oc.columns(['org_id', 'user_id', 'kind']).doNothing())
        .execute();
    } else {
      await ctx.trx.deleteFrom('crove_kernel.notification_mute').where('org_id', '=', ctx.orgId).where('user_id', '=', me).where('kind', '=', input.kind).execute();
    }
    return { kind: input.kind, muted: input.muted };
  },
});

export const notificationCommands = [notificationDispatch, notificationRead, notificationMute];
export const notificationQueries = [notificationList];
