// Members' notes (issue #1671, plan docs/plan/notes.md §3.3 to §3.5, ADR-0037). A note is private to its author or
// shared with the org; the database's row policies decide who reads and changes it, so every query here reads only
// what the caller may, and a note another member cannot read answers NOTE_NOT_FOUND as if it did not exist. The
// commands add the rules a row policy cannot express: only the author edits the text, the visibility and the links;
// owners and admins may also pin, archive and delete a shared note (to take down something wrong).
//
// Audit rows are anchored in the WORM stream and outlive an erasure, so a command's audit facts carry ids, the
// visibility and changed field names, and a marker for the text (auditValue), never the title, body or tags. Command
// results carry ids and the revision only, since idempotency rows keep them.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  auditValue,
  zNoteCreate,
  zNoteLinkAdd,
  zNoteLinkRemove,
  zNoteList,
  zNoteLinkTarget,
  zNoteRef,
  zNoteSearch,
  zNoteSetVisibility,
  zNoteUpdate,
  type Note,
  type NoteLink,
  type NoteLinkTarget,
  type NotePrivateCount,
  type NoteRecordPanel,
  type NoteSummary,
  type NoteVisibility,
  type NoteWritten,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { notesManifest } from './manifest.ts';

// Viewers write no note (notes.md decision N-4). They run the reads, where the row policies show them none but their
// own: a member made a viewer still reads what they wrote (ADR-0037 §2).
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const NOTE = notesManifest.tables.crove_notes.note;

const SUMMARY = ['id', 'author_user_id', 'visibility', 'title', 'tags', 'pinned', 'tainted', 'revision', 'created_at', 'updated_at', 'archived_at', 'deleted_at'] as const;

interface SummaryRow {
  id: string;
  author_user_id: string;
  visibility: NoteVisibility;
  title: string;
  tags: string[];
  pinned: boolean;
  tainted: boolean;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  deleted_at: Date | string | null;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

function summary(r: SummaryRow, userId: string): NoteSummary {
  return {
    id: r.id,
    authorUserId: r.author_user_id,
    mine: r.author_user_id === userId,
    visibility: r.visibility,
    title: r.title,
    tags: r.tags,
    pinned: r.pinned,
    tainted: r.tainted,
    revision: r.revision,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    archivedAt: iso(r.archived_at),
    deletedAt: iso(r.deleted_at),
  };
}

function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const notFound = () => new DomainError('NOTE_NOT_FOUND', 404, 'Không tìm thấy ghi chú này');

// The note as the caller may read it (row policies), locked for a change when `lock` is set.
async function load(ctx: Pick<QueryContext, 'trx' | 'orgId'>, noteId: string, lock: boolean): Promise<SummaryRow> {
  let q = ctx.trx.selectFrom('crove_notes.note').select(SUMMARY).where('org_id', '=', ctx.orgId).where('id', '=', noteId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

// The note for a change: checked against what the caller may read, then locked. FOR UPDATE also applies the update
// policy, which hides a shared note from a plain member, so the check comes first and names the refusal.
async function loadForChange(ctx: CommandContext, noteId: string, check: (row: SummaryRow) => void): Promise<SummaryRow> {
  check(await load(ctx, noteId, false));
  return load(ctx, noteId, true);
}

function assertAuthor(row: SummaryRow, userId: string): void {
  if (row.author_user_id !== userId) throw new DomainError('NOTE_AUTHOR_ONLY', 403, 'Chỉ người viết ghi chú mới làm được việc này');
}

// The author, or for a shared note an owner or admin of the org.
function assertMayManage(ctx: CommandContext, row: SummaryRow, userId: string): void {
  if (row.author_user_id === userId) return;
  if (row.visibility === 'org' && ctx.role !== null && MANAGERS.includes(ctx.role)) return;
  throw new DomainError('NOTE_AUTHOR_ONLY', 403, 'Chỉ người viết ghi chú, hoặc chủ sở hữu và quản trị viên với ghi chú dùng chung, mới làm được việc này');
}

function assertNotInTrash(row: SummaryRow): void {
  if (row.deleted_at !== null) throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
}

// The linked record must be one the writer can open in this org (its row policies apply).
async function assertTarget(ctx: CommandContext, targetType: NoteLinkTarget, targetId: string): Promise<void> {
  const table = targetType === 'kernel.party' ? 'crove_kernel.party' : 'crove_kernel.file';
  const found = await ctx.trx.selectFrom(table).select('id').where('org_id', '=', ctx.orgId).where('id', '=', targetId).executeTakeFirst();
  if (!found) throw new DomainError('NOTE_LINK_TARGET_NOT_FOUND', 404, 'Không tìm thấy bản ghi để gắn ghi chú');
}

async function addLink(ctx: CommandContext, row: Pick<SummaryRow, 'id' | 'visibility'>, userId: string, targetType: NoteLinkTarget, targetId: string): Promise<string> {
  await assertTarget(ctx, targetType, targetId);
  const link = await ctx.trx
    .insertInto('crove_notes.link')
    .values({
      org_id: ctx.orgId,
      note_id: row.id,
      target_type: targetType,
      target_id: targetId,
      party_id: targetType === 'kernel.party' ? targetId : null,
      file_id: targetType === 'kernel.file' ? targetId : null,
      created_by: userId,
      created_at: ctx.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
    .catch((error: unknown) => {
      const pg = error as { code?: string; constraint?: string } | null | undefined;
      if (pg?.code === '23505' && pg.constraint === 'link_note_target_uq') throw new DomainError('NOTE_LINK_EXISTS', 409, 'Ghi chú đã gắn với bản ghi này');
      throw error;
    });
  // A shared note shows on the party's timeline with a fixed summary; a private one writes nothing there (notes.md §3.6).
  if (row.visibility === 'org' && targetType === 'kernel.party') await ctx.activity('kernel.party', targetId, 'notes.note_linked', 'Thêm ghi chú');
  return link.id;
}

const written = (row: Pick<SummaryRow, 'id' | 'revision'>): NoteWritten => ({ noteId: row.id, revision: row.revision });

// A link added or removed changes the note as others see it; touching the note sends its stream hint (#69), so open
// apps read the note and the record's panel again.
async function touch(ctx: CommandContext, noteId: string): Promise<void> {
  await ctx.trx.updateTable('crove_notes.note').set({ updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', noteId).execute();
}
const target = (input: { noteId: string }) => ({ type: 'notes.note', id: input.noteId });

export const noteCreate = defineCommand({
  name: 'notes.note.create',
  input: zNoteCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const row = await ctx.trx
      .insertInto('crove_notes.note')
      .values({
        org_id: ctx.orgId,
        author_user_id: userId,
        visibility: input.visibility,
        title: input.title,
        body: input.body,
        tags: input.tags,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'visibility', 'revision'])
      .executeTakeFirstOrThrow();
    const linkId = input.link ? await addLink(ctx, row, userId, input.link.targetType, input.link.targetId) : null;
    ctx.audit({
      noteId: row.id,
      visibility: row.visibility,
      title: auditValue(NOTE, 'title', input.title),
      tags: auditValue(NOTE, 'tags', input.tags.length > 0 ? input.tags : null),
      ...(input.link ? { linkId, targetType: input.link.targetType, targetId: input.link.targetId } : {}),
    });
    return written(row);
  },
});

export const noteUpdate = defineCommand({
  name: 'notes.note.update',
  input: zNoteUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const before = await loadForChange(ctx, input.noteId, (row) => assertAuthor(row, userId));
    assertNotInTrash(before);
    if (before.revision !== input.revision) {
      throw new DomainError('NOTE_REVISION_CONFLICT', 409, 'Ghi chú vừa được sửa ở nơi khác; hãy tải lại trước khi lưu', { revision: before.revision });
    }
    const current = await ctx.trx.selectFrom('crove_notes.note').select('body').where('org_id', '=', ctx.orgId).where('id', '=', input.noteId).executeTakeFirstOrThrow();
    const changed = [
      ...(before.title !== input.title ? ['title'] : []),
      ...(current.body !== input.body ? ['body'] : []),
      ...(before.tags.join('\u0000') !== input.tags.join('\u0000') ? ['tags'] : []),
    ];
    const row = await ctx.trx
      .updateTable('crove_notes.note')
      .set({ title: input.title, body: input.body, tags: input.tags, revision: before.revision + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({ noteId: row.id, revision: row.revision, changed });
    return written(row);
  },
});

export const noteSetVisibility = defineCommand({
  name: 'notes.note.set_visibility',
  input: zNoteSetVisibility,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<NoteWritten> => {
    const userId = userOf(ctx.actor);
    const before = await loadForChange(ctx, input.noteId, (row) => assertAuthor(row, userId));
    if (before.visibility === input.visibility) return written(before);
    const row = await ctx.trx
      .updateTable('crove_notes.note')
      .set({ visibility: input.visibility, revision: before.revision + 1, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .returning(['id', 'revision'])
      .executeTakeFirstOrThrow();
    ctx.audit({ noteId: row.id, visibility: input.visibility, previousVisibility: before.visibility });
    return written(row);
  },
});

// Pin, archive, delete and their reverses: the author, or an owner or admin for a shared note. They leave the text
// and the revision alone, so they never conflict with the author's edit in progress.
function stateCommand(name: string, change: (now: Date) => { pinned?: boolean; archived_at?: Date | null; deleted_at?: Date | null }, allowInTrash: boolean) {
  return defineCommand({
    name,
    input: zNoteRef,
    risk: 'R1',
    sideEffect: 'internal',
    access: WRITERS,
    target,
    handler: async (ctx, input): Promise<NoteWritten> => {
      const userId = userOf(ctx.actor);
      const before = await loadForChange(ctx, input.noteId, (row) => assertMayManage(ctx, row, userId));
      if (!allowInTrash) assertNotInTrash(before);
      const set = change(ctx.now);
      await ctx.trx.updateTable('crove_notes.note').set(set).where('org_id', '=', ctx.orgId).where('id', '=', input.noteId).execute();
      ctx.audit({ noteId: input.noteId, visibility: before.visibility, authorUserId: before.author_user_id, changed: Object.keys(set) });
      return written(before);
    },
  });
}

export const notePin = stateCommand('notes.note.pin', () => ({ pinned: true }), false);
export const noteUnpin = stateCommand('notes.note.unpin', () => ({ pinned: false }), false);
export const noteArchive = stateCommand('notes.note.archive', (now) => ({ archived_at: now }), false);
// Back from the archive or the trash.
export const noteRestore = stateCommand('notes.note.restore', () => ({ archived_at: null, deleted_at: null }), true);
// To the trash, which the daily job empties after NOTE_TRASH_DAYS.
export const noteDelete = stateCommand('notes.note.delete', (now) => ({ deleted_at: now }), false);

export const linkAdd = defineCommand({
  name: 'notes.link.add',
  input: zNoteLinkAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target,
  handler: async (ctx, input): Promise<{ noteId: string; linkId: string }> => {
    const userId = userOf(ctx.actor);
    const note = await loadForChange(ctx, input.noteId, (row) => assertAuthor(row, userId));
    assertNotInTrash(note);
    const linkId = await addLink(ctx, note, userId, input.targetType, input.targetId);
    await touch(ctx, input.noteId);
    ctx.audit({ noteId: input.noteId, linkId, targetType: input.targetType, targetId: input.targetId });
    return { noteId: input.noteId, linkId };
  },
});

export const linkRemove = defineCommand({
  name: 'notes.link.remove',
  input: zNoteLinkRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  handler: async (ctx, input): Promise<{ noteId: string; linkId: string }> => {
    const userId = userOf(ctx.actor);
    const link = await ctx.trx
      .selectFrom('crove_notes.link')
      .select(['note_id', 'target_type', 'target_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.linkId)
      .executeTakeFirst();
    if (!link) throw new DomainError('NOTE_LINK_NOT_FOUND', 404, 'Không tìm thấy liên kết này');
    await loadForChange(ctx, link.note_id, (row) => assertAuthor(row, userId));
    await ctx.trx.deleteFrom('crove_notes.link').where('org_id', '=', ctx.orgId).where('id', '=', input.linkId).execute();
    await touch(ctx, link.note_id);
    ctx.audit({ noteId: link.note_id, linkId: input.linkId, targetType: link.target_type, targetId: link.target_id });
    return { noteId: link.note_id, linkId: input.linkId };
  },
});

export const noteList = defineQuery({
  name: 'notes.note.list',
  input: zNoteList,
  access: READERS,
  handler: async (ctx, input): Promise<NoteSummary[]> => {
    const userId = userOf(ctx.actor);
    let q = ctx.trx.selectFrom('crove_notes.note as n').select(SUMMARY.map((c) => `n.${c}` as const)).where('n.org_id', '=', ctx.orgId);
    if (input.view === 'trash') q = q.where('n.deleted_at', 'is not', null);
    else {
      q = q.where('n.deleted_at', 'is', null);
      if (input.view === 'archived') q = q.where('n.archived_at', 'is not', null);
      else q = q.where('n.archived_at', 'is', null);
      if (input.view === 'mine') q = q.where('n.author_user_id', '=', userId);
      if (input.view === 'shared') q = q.where('n.visibility', '=', 'org');
      if (input.view === 'pinned') q = q.where('n.pinned', '=', true);
    }
    if (input.tag !== undefined) q = q.where(sql<boolean>`${input.tag} = ANY (n.tags)`);
    const t = input.target;
    if (t) {
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('crove_notes.link as l')
            .select('l.id')
            .whereRef('l.org_id', '=', 'n.org_id')
            .whereRef('l.note_id', '=', 'n.id')
            .where('l.target_type', '=', t.targetType)
            .where('l.target_id', '=', t.targetId),
        ),
      );
    }
    const rows = await q.orderBy('n.pinned', 'desc').orderBy('n.updated_at', 'desc').orderBy('n.id').limit(input.limit).execute();
    return rows.map((r) => summary(r, userId));
  },
});

export const noteGet = defineQuery({
  name: 'notes.note.get',
  input: zNoteRef,
  access: READERS,
  handler: async (ctx, input): Promise<Note> => {
    const userId = userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('crove_notes.note')
      .select([...SUMMARY, 'body'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noteId)
      .executeTakeFirst();
    if (!row) throw notFound();
    const links = await ctx.trx
      .selectFrom('crove_notes.link')
      .select(['id', 'target_type', 'target_id', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('note_id', '=', input.noteId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return {
      ...summary(row, userId),
      body: row.body,
      links: links.map((l): NoteLink => ({ id: l.id, targetType: l.target_type, targetId: l.target_id, createdAt: new Date(l.created_at).toISOString() })),
    };
  },
});

// Words typed without Vietnamese marks find them ("hoa don" finds "hóa đơn"), each as a prefix, in the title, tags and
// body of the notes the caller may read, outside the trash.
export const noteSearch = defineQuery({
  name: 'notes.note.search',
  input: zNoteSearch,
  access: READERS,
  handler: async (ctx, input): Promise<NoteSummary[]> => {
    const userId = userOf(ctx.actor);
    const rows = await ctx.trx
      .selectFrom('crove_notes.note')
      .select(SUMMARY)
      .where('org_id', '=', ctx.orgId)
      .where('deleted_at', 'is', null)
      .where(sql<boolean>`search @@ crove_kernel.search_query(${input.q})`)
      .orderBy('updated_at', 'desc')
      .orderBy('id')
      .limit(input.limit)
      .execute();
    return rows.map((r) => summary(r, userId));
  },
});

// The notes of one record (its panel): pinned first, then the latest PANEL_LATEST others, outside the archive and the trash.
const PANEL_PINNED = 20;
const PANEL_LATEST = 3;
export const recordPanel = defineQuery({
  name: 'notes.record.panel',
  input: zNoteLinkTarget,
  access: READERS,
  handler: async (ctx, input): Promise<NoteRecordPanel> => {
    const userId = userOf(ctx.actor);
    const base = ctx.trx
      .selectFrom('crove_notes.note as n')
      .innerJoin('crove_notes.link as l', (j) => j.onRef('l.org_id', '=', 'n.org_id').onRef('l.note_id', '=', 'n.id'))
      .select(SUMMARY.map((c) => `n.${c}` as const))
      .where('n.org_id', '=', ctx.orgId)
      .where('l.target_type', '=', input.targetType)
      .where('l.target_id', '=', input.targetId)
      .where('n.archived_at', 'is', null)
      .where('n.deleted_at', 'is', null);
    const pinned = await base.where('n.pinned', '=', true).orderBy('n.updated_at', 'desc').orderBy('n.id').limit(PANEL_PINNED).execute();
    const latest = await base.where('n.pinned', '=', false).orderBy('n.updated_at', 'desc').orderBy('n.id').limit(PANEL_LATEST).execute();
    return { pinned: pinned.map((r) => summary(r, userId)), latest: latest.map((r) => summary(r, userId)) };
  },
});

// How many private notes each member has, for an owner or admin before removing one (ADR-0037 §4): a count from
// crove_notes.private_counts(), which checks the caller's role itself, never the text.
export const privateCounts = defineQuery({
  name: 'notes.private_counts',
  input: z.strictObject({}),
  access: MANAGERS,
  handler: async (ctx): Promise<NotePrivateCount[]> => {
    const { rows } = await sql<{ author_user_id: string; notes: string }>`SELECT author_user_id, notes FROM crove_notes.private_counts()`.execute(ctx.trx);
    return rows.map((r) => ({ userId: r.author_user_id, notes: Number(r.notes) }));
  },
});

export const noteCommands = [noteCreate, noteUpdate, noteSetVisibility, notePin, noteUnpin, noteArchive, noteRestore, noteDelete, linkAdd, linkRemove];
export const noteQueries = [noteList, noteGet, noteSearch, recordPanel, privateCounts];
