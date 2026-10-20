// Notes on calendar dates (#794): a team's own marks on the calendar, such as a launch, a sale or a client event, next
// to the built-in occasions (#702). A note is a title over one day or a range of up to 31 days, with a colour from the
// app's palette. Owners, admins and members add, change and remove them; everyone in the org reads them. A note is
// only a mark: it never blocks or moves a schedule.
import { sql } from 'kysely';
import { z } from 'zod';
import { SOCIAL_LABEL_COLORS, zId } from '@crove/kernel-contract';
import type { MemberRole, SocialLabelColor } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
// The most notes an org keeps, and a read returns.
export const CALENDAR_NOTES_MAX = 1000;
export const CALENDAR_NOTE_DAYS_MAX = 31;
const DAY_MS = 86_400_000;

export interface CalendarNote {
  id: string;
  startsOn: string;
  endsOn: string;
  title: string;
  color: SocialLabelColor;
  updatedBy: string;
  updatedAt: string;
}

// A calendar day as YYYY-MM-DD, and a real one (no 30 February).
const zDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'not a date');
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

function checkRange(startsOn: string, endsOn: string) {
  const span = daysBetween(startsOn, endsOn);
  if (span < 0) throw new DomainError('CALENDAR_NOTE_RANGE', 422, 'Ngày kết thúc phải sau hoặc trùng ngày bắt đầu');
  if (span >= CALENDAR_NOTE_DAYS_MAX) throw new DomainError('CALENDAR_NOTE_RANGE', 422, `Một ghi chú kéo dài tối đa ${CALENDAR_NOTE_DAYS_MAX} ngày`);
}

export const calendarNoteSave = defineCommand({
  name: 'social.calendar_note.save',
  input: z.strictObject({
    // Absent: a new note.
    noteId: zId.optional(),
    startsOn: zDay,
    endsOn: zDay,
    title: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, ' ').normalize('NFC'))
      .pipe(z.string().min(1).max(120)),
    color: z.enum(SOCIAL_LABEL_COLORS).optional(),
  }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    checkRange(input.startsOn, input.endsOn);
    if (input.noteId) {
      const updated = await ctx.trx
        .updateTable('crove_social.calendar_note')
        .set({ starts_on: input.startsOn, ends_on: input.endsOn, title: input.title, ...(input.color ? { color: input.color } : {}), updated_by: userId, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.noteId)
        .returning('id')
        .executeTakeFirst();
      if (!updated) throw new DomainError('CALENDAR_NOTE_NOT_FOUND', 404, 'Không tìm thấy ghi chú này');
      return { noteId: updated.id };
    }
    // One new note at a time per org, so the count below holds.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_social.calendar_note:${ctx.orgId}`}))`.execute(ctx.trx);
    const count = await ctx.trx.selectFrom('crove_social.calendar_note').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (Number(count.n) >= CALENDAR_NOTES_MAX) throw new DomainError('CALENDAR_NOTE_LIMIT', 409, `Mỗi tổ chức có tối đa ${CALENDAR_NOTES_MAX} ghi chú trên lịch`);
    const row = await ctx.trx
      .insertInto('crove_social.calendar_note')
      .values({ org_id: ctx.orgId, starts_on: input.startsOn, ends_on: input.endsOn, title: input.title, color: input.color ?? 'blue', created_by: userId, updated_by: userId, created_at: ctx.now, updated_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { noteId: row.id };
  },
});

export const calendarNoteRemove = defineCommand({
  name: 'social.calendar_note.remove',
  input: z.strictObject({ noteId: zId }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const removed = await ctx.trx.deleteFrom('crove_social.calendar_note').where('org_id', '=', ctx.orgId).where('id', '=', input.noteId).returning('id').executeTakeFirst();
    return { noteId: input.noteId, removed: Boolean(removed) };
  },
});

// The notes that overlap the days from..to (both included), earliest first.
export const calendarNoteList = defineQuery({
  name: 'social.calendar_note.list',
  input: z.strictObject({ from: zDay, to: zDay }),
  access: ALL,
  handler: async (ctx, input): Promise<CalendarNote[]> => {
    if (daysBetween(input.from, input.to) < 0 || daysBetween(input.from, input.to) > 400) throw new DomainError('CALENDAR_NOTE_RANGE', 422, 'Khoảng ngày không hợp lệ');
    const rows = await ctx.trx
      .selectFrom('crove_social.calendar_note')
      .select(['id', 'starts_on', 'ends_on', 'title', 'color', 'updated_by', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('starts_on', '<=', input.to)
      .where('ends_on', '>=', input.from)
      .orderBy('starts_on')
      .orderBy('id')
      .limit(CALENDAR_NOTES_MAX)
      .execute();
    const day = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
    return rows.map((r) => ({ id: r.id, startsOn: day(r.starts_on), endsOn: day(r.ends_on), title: r.title, color: r.color as SocialLabelColor, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() }));
  },
});

export const calendarNoteCommands = [calendarNoteSave, calendarNoteRemove];
export const calendarNoteQueries = [calendarNoteList];
