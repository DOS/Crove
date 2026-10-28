// The notes module (issue #1671, plan docs/plan/notes.md §3, ADR-0037): members' notes, private to their author or
// shared with the org, linked to records. The inputs its commands and queries take and the views they return; the app
// reads the same types.
import { z } from 'zod';
import { DEFAULT_TIME_ZONE, zTimeZone, zonedDate, zonedInstant, zoneOffsetMs } from './calendar.ts';
import { zId } from './schemas.ts';

export const NOTE_VISIBILITIES = ['private', 'org'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];
// The records a note links to in this step; finance, crm and meeting records come later (notes.md §3.4).
export const NOTE_LINK_TARGETS = ['kernel.party', 'kernel.file'] as const;
export type NoteLinkTarget = (typeof NOTE_LINK_TARGETS)[number];
// The lists of the notes screen (notes.md §3.10).
export const NOTE_LIST_VIEWS = ['mine', 'shared', 'pinned', 'archived', 'trash'] as const;
export type NoteListView = (typeof NOTE_LIST_VIEWS)[number];

export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 100_000;
export const NOTE_TAGS_MAX = 20;
export const NOTE_TAG_MAX = 40;
// Days a deleted note stays in the trash, and a former member's private notes stay sealed (ADR-0037 §4).
export const NOTE_TRASH_DAYS = 30;
export const NOTE_MEMBER_PURGE_DAYS = 30;

const zTitle = z.string().trim().min(1).max(NOTE_TITLE_MAX);
const zBody = z.string().max(NOTE_BODY_MAX);
// Lower case, trimmed, each once, at most NOTE_TAGS_MAX.
const zTags = z
  .array(z.string().trim().toLowerCase().min(1).max(NOTE_TAG_MAX))
  .max(NOTE_TAGS_MAX)
  .transform((tags) => [...new Set(tags)]);
export const zNoteLinkTarget = z.strictObject({ targetType: z.enum(NOTE_LINK_TARGETS), targetId: zId });
export type NoteLinkTargetInput = z.infer<typeof zNoteLinkTarget>;

// A new note: private unless the caller shares it (a panel on a record shares by default, notes.md decision N-7),
// optionally linked to one record at once.
export const zNoteCreate = z.strictObject({
  title: zTitle,
  body: zBody.default(''),
  tags: zTags.default([]),
  visibility: z.enum(NOTE_VISIBILITIES).default('private'),
  link: zNoteLinkTarget.optional(),
});
export type NoteCreateInput = z.input<typeof zNoteCreate>;
// The author's edit of the text, against the revision they read (NOTES.REVISION_CONFLICT when it moved on).
export const zNoteUpdate = z.strictObject({ noteId: zId, revision: z.number().int().positive(), title: zTitle, body: zBody, tags: zTags });
export type NoteUpdateInput = z.input<typeof zNoteUpdate>;
export const zNoteSetVisibility = z.strictObject({ noteId: zId, visibility: z.enum(NOTE_VISIBILITIES) });
export const zNoteRef = z.strictObject({ noteId: zId });
export const zNoteLinkAdd = z.strictObject({ noteId: zId, targetType: z.enum(NOTE_LINK_TARGETS), targetId: zId });
export const zNoteLinkRemove = z.strictObject({ linkId: zId });
export const zNoteList = z.strictObject({
  view: z.enum(NOTE_LIST_VIEWS),
  tag: z.string().trim().toLowerCase().min(1).max(NOTE_TAG_MAX).optional(),
  target: zNoteLinkTarget.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type NoteListInput = z.input<typeof zNoteList>;
export const zNoteSearch = z.strictObject({ q: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).default(20) });

// What a command returns: ids and the new revision, never text (idempotency rows keep results, notes.md §3.5).
export const zNoteWritten = z.object({ noteId: z.string(), revision: z.number().int() });
export type NoteWritten = z.infer<typeof zNoteWritten>;
export const zNoteLinkWritten = z.object({ noteId: z.string(), linkId: z.string() });

// A note in a list: its title and tags, not its body. `mine`: the caller wrote it.
export const zNoteSummary = z.object({
  id: z.string(),
  authorUserId: z.string(),
  mine: z.boolean(),
  visibility: z.enum(NOTE_VISIBILITIES),
  title: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  tainted: z.boolean(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});
export type NoteSummary = z.infer<typeof zNoteSummary>;

export const zNoteLinkView = z.object({ id: z.string(), targetType: z.enum(NOTE_LINK_TARGETS), targetId: z.string(), createdAt: z.string() });
export type NoteLink = z.infer<typeof zNoteLinkView>;

export const zNote = zNoteSummary.extend({ body: z.string(), links: z.array(zNoteLinkView) });
export type Note = z.infer<typeof zNote>;

// A record's panel: its pinned notes, then the latest others (notes.md §3.10).
export const zNoteRecordPanelView = z.object({ pinned: z.array(zNoteSummary), latest: z.array(zNoteSummary) });
export type NoteRecordPanel = z.infer<typeof zNoteRecordPanelView>;

// How many private notes a member has, for an owner or admin before removing them (ADR-0037 §4). No text.
export const zNotePrivateCount = z.object({ userId: z.string(), notes: z.number().int() });
export type NotePrivateCount = z.infer<typeof zNotePrivateCount>;

// ---------------------------------------------------------------------------
// Personal to-dos (#1673, notes.md §3.2, §3.8 and step N4): a member's own list, always private (ADR-0037). A to-do
// has a due day and, optionally, a time on that day, both in the to-do's own time zone (the member's browser's when
// it was written), so "today" is the day of that zone.
// ---------------------------------------------------------------------------

export const TODO_STATUSES = ['open', 'done', 'handed_over', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
// The lists of the to-do screen: what is left to do, what is done, and the trash.
export const TODO_LIST_VIEWS = ['open', 'done', 'trash'] as const;
export type TodoListView = (typeof TODO_LIST_VIEWS)[number];
// The groups of My work (notes.md §3.10), by the due day in the to-do's time zone: before today, today, the next 7
// days, later, and no day.
export const TODO_DUE_GROUPS = ['overdue', 'today', 'next7', 'later', 'none'] as const;
export type TodoDueGroup = (typeof TODO_DUE_GROUPS)[number];

// A task title's and description's limits, so a hand-over (N5) never truncates.
export const TODO_TITLE_MAX = 300;
export const TODO_DETAILS_MAX = 10_000;
export const TODO_STEPS_MAX = 50;
export const TODO_STEP_MAX = 300;

const zTodoTitle = z.string().trim().min(1).max(TODO_TITLE_MAX);
const zTodoDetails = z.string().max(TODO_DETAILS_MAX);
export const zTodoStep = z.strictObject({ text: z.string().trim().min(1).max(TODO_STEP_MAX), done: z.boolean() });
export type TodoStep = z.infer<typeof zTodoStep>;
const zChecklist = z.array(zTodoStep).max(TODO_STEPS_MAX);
const zDay = z.iso.date();
// A time of day, 24-hour HH:mm, on the due day in the to-do's time zone.
const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dueTimeNeedsDay = (v: { dueOn: string | null; dueTime: string | null }) => v.dueTime === null || v.dueOn !== null;
const DUE_TIME_NEEDS_DAY = { message: 'A due time needs a due day', path: ['dueTime'] };

// The reminder (notes.md §3.8): 'auto' reminds at TODO_REMIND_TIME on the due day, or TODO_REMIND_BEFORE_MINUTES
// before a due time, and not at all without a due day or once that time has passed; 'off' never; { at } at that
// instant, which must be ahead.
export const TODO_REMIND_TIME = '08:00';
export const TODO_REMIND_BEFORE_MINUTES = 30;
export const zTodoReminder = z.union([z.enum(['auto', 'off']), z.strictObject({ at: z.iso.datetime({ offset: true }) })]);
export type TodoReminder = z.infer<typeof zTodoReminder>;

// A new to-do: the title, and optionally its details, steps and due day and time, in the caller's time zone.
export const zTodoCreate = z
  .strictObject({
    title: zTodoTitle,
    details: zTodoDetails.default(''),
    checklist: zChecklist.default([]),
    dueOn: zDay.nullable().default(null),
    dueTime: zTime.nullable().default(null),
    timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
    reminder: zTodoReminder.default('auto'),
  })
  .refine(dueTimeNeedsDay, DUE_TIME_NEEDS_DAY);
export type TodoCreateInput = z.input<typeof zTodoCreate>;
// The owner's edit, against the revision they read (TODO_REVISION_CONFLICT when it moved on). Without `reminder` the
// reminder stays as it was, unless it was the automatic one, or there was none for want of a due day, and the due day
// or time moved: it then follows them.
export const zTodoUpdate = z
  .strictObject({
    todoId: zId,
    revision: z.number().int().positive(),
    title: zTodoTitle,
    details: zTodoDetails,
    checklist: zChecklist,
    dueOn: zDay.nullable(),
    dueTime: zTime.nullable(),
    timeZone: zTimeZone,
    reminder: zTodoReminder.optional(),
  })
  .refine(dueTimeNeedsDay, DUE_TIME_NEEDS_DAY);
export type TodoUpdateInput = z.input<typeof zTodoUpdate>;
export const zTodoRef = z.strictObject({ todoId: zId });
// Moves a to-do right before or right after another of the owner's (the anchor) in their own order.
export const zTodoReorder = z
  .strictObject({ todoId: zId, place: z.enum(['before', 'after']), anchorId: zId })
  .refine((v) => v.todoId !== v.anchorId, { message: 'A to-do is not moved next to itself', path: ['anchorId'] });
export type TodoReorderInput = z.input<typeof zTodoReorder>;
// `q` keeps the to-dos whose title, details or steps hold every word, typed with or without Vietnamese marks.
export const zTodoList = z.strictObject({
  view: z.enum(TODO_LIST_VIEWS),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export type TodoListInput = z.input<typeof zTodoList>;

// What a command returns: ids and the revision, never text (idempotency rows keep results, notes.md §3.5).
export const zTodoWritten = z.object({ todoId: z.string(), revision: z.number().int() });
export type TodoWritten = z.infer<typeof zTodoWritten>;

// A to-do in a list, in the owner's order. `dueTime` is the due time on the wall clock of `timeZone`; `group` is the
// My work group of an open to-do (null otherwise), and `overdue` says its day, or its time today, has passed.
export const zTodoSummary = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(TODO_STATUSES),
  dueOn: z.string().nullable(),
  dueAt: z.string().nullable(),
  dueTime: z.string().nullable(),
  timeZone: z.string(),
  // When the reminder is due, or null for none.
  remindAt: z.string().nullable(),
  group: z.enum(TODO_DUE_GROUPS).nullable(),
  overdue: z.boolean(),
  steps: z.object({ done: z.number().int(), total: z.number().int() }),
  taskId: z.string().nullable(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  doneAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});
export type TodoSummary = z.infer<typeof zTodoSummary>;
export const zTodo = zTodoSummary.extend({ details: z.string(), checklist: z.array(z.object({ text: z.string(), done: z.boolean() })) });
export type Todo = z.infer<typeof zTodo>;

// How many to-dos each member has, for an owner or admin before removing them (ADR-0037 §4). No text.
export const zTodoCount = z.object({ userId: z.string(), todos: z.number().int() });
export type TodoCount = z.infer<typeof zTodoCount>;

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The My work group of a due day, against today in the same time zone (both YYYY-MM-DD). */
export function todoDueGroup(dueOn: string | null, today: string): TodoDueGroup {
  if (dueOn === null) return 'none';
  if (dueOn < today) return 'overdue';
  if (dueOn === today) return 'today';
  return dueOn <= addDays(today, 7) ? 'next7' : 'later';
}

/** The instant a to-do is due at: its day at `time` (HH:mm) on the wall clock of `timeZone`. */
export function todoDueInstant(dueOn: string, time: string, timeZone: string): Date {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return new Date(zonedInstant(timeZone, dueOn, h * 60 + m));
}

/** The automatic reminder of a due day and time: TODO_REMIND_BEFORE_MINUTES before the time, else TODO_REMIND_TIME on the day. */
export function todoAutoReminder(t: { dueOn: string | null; dueAt: Date | null; timeZone: string }): Date | null {
  if (t.dueAt !== null) return new Date(t.dueAt.getTime() - TODO_REMIND_BEFORE_MINUTES * 60_000);
  return t.dueOn === null ? null : todoDueInstant(t.dueOn, TODO_REMIND_TIME, t.timeZone);
}

/** The wall-clock time (HH:mm) of an instant in `timeZone`. */
export function todoLocalTime(at: Date, timeZone: string): string {
  const local = at.getTime() + zoneOffsetMs(timeZone, at.getTime());
  const minutes = Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60_000);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Where an open to-do stands at `now`: its group by the day in its own time zone, and whether it is late. */
export function todoStanding(t: { dueOn: string | null; dueAt: Date | null; timeZone: string }, now: Date): { group: TodoDueGroup; overdue: boolean } {
  const group = todoDueGroup(t.dueOn, zonedDate(t.timeZone, now.getTime()));
  return { group, overdue: group === 'overdue' || (group === 'today' && t.dueAt !== null && t.dueAt.getTime() < now.getTime()) };
}
