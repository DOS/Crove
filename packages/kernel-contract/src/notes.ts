// The notes module (issue #1671, plan docs/plan/notes.md §3, ADR-0037): members' notes, private to their author or
// shared with the org, linked to records. The inputs its commands and queries take and the views they return; the app
// reads the same types.
import { z } from 'zod';
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
