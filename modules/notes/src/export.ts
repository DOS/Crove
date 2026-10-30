// SPDX-License-Identifier: AGPL-3.0-only
// A member's own notes and to-dos, whole, for their download (#1678, notes.md section 5 "Tải về", ADR-0037 section 5:
// their private items are personal data the org processes, and this answers their access and portability). Every note
// the caller wrote, private or shared, archived or in the trash, with its links, and every to-do of theirs: filtered on
// the caller as author and owner, so an owner or admin who reads the org's shared notes gets their own only. The app
// turns it into Markdown or JSON in the browser; nothing is stored or sent elsewhere. The newest first, up to
// NOTES_EXPORT_LIMIT items of each kind and NOTES_EXPORT_TEXT characters of text in all (counted in the database, so an
// answer never grows past what the server and the browser can hold).
import { sql } from 'kysely';
import { z } from 'zod';
import { NOTES_EXPORT_LIMIT, NOTES_EXPORT_TEXT, type NotesExport } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

// Whoever has notes may take them: a member who became a viewer keeps what they wrote.
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

export const notesExportMine = defineQuery({
  name: 'notes.mine.export',
  input: z.strictObject({}),
  access: READERS,
  handler: async (ctx): Promise<NotesExport> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới tải được ghi chú của mình');
    const userId = ctx.actor.userId;
    // The ids of the newest items that fit, by the running length of their text; the text itself is read only for those.
    const { rows: noteIds } = await sql<{ id: string; fits: boolean }>`
      SELECT id, (n <= ${NOTES_EXPORT_LIMIT} AND running <= ${NOTES_EXPORT_TEXT}) AS fits FROM (
        SELECT id, pg_catalog.row_number() OVER w AS n,
               pg_catalog.sum(pg_catalog.length(title) + pg_catalog.length(body) + pg_catalog.length(pg_catalog.array_to_string(tags, ' '))) OVER w AS running
          FROM crove_notes.note
         WHERE org_id = ${ctx.orgId}::uuid AND author_user_id = ${userId}::uuid
        WINDOW w AS (ORDER BY created_at DESC, id)) t
       ORDER BY n LIMIT ${NOTES_EXPORT_LIMIT + 1}`.execute(ctx.trx);
    // The to-dos share what text the notes left.
    const used = Number(
      (
        await sql<{ used: string | null }>`
          SELECT pg_catalog.sum(pg_catalog.length(title) + pg_catalog.length(body) + pg_catalog.length(pg_catalog.array_to_string(tags, ' '))) AS used
            FROM crove_notes.note WHERE org_id = ${ctx.orgId}::uuid AND id = ANY(${noteIds.filter((r) => r.fits).map((r) => r.id)}::uuid[])`.execute(ctx.trx)
      ).rows[0]?.used ?? 0,
    );
    const { rows: todoIds } = await sql<{ id: string; fits: boolean }>`
      SELECT id, (n <= ${NOTES_EXPORT_LIMIT} AND running <= ${NOTES_EXPORT_TEXT - used}) AS fits FROM (
        SELECT id, pg_catalog.row_number() OVER w AS n,
               pg_catalog.sum(pg_catalog.length(title) + COALESCE(pg_catalog.length(details), 0) + pg_catalog.length(checklist::text)) OVER w AS running
          FROM crove_notes.todo
         WHERE org_id = ${ctx.orgId}::uuid AND owner_user_id = ${userId}::uuid
        WINDOW w AS (ORDER BY created_at DESC, id)) t
       ORDER BY n LIMIT ${NOTES_EXPORT_LIMIT + 1}`.execute(ctx.trx);
    const noteKeep = noteIds.filter((r) => r.fits).map((r) => r.id);
    const todoKeep = todoIds.filter((r) => r.fits).map((r) => r.id);
    const notes =
      noteKeep.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_notes.note')
            .select(['id', 'visibility', 'title', 'body', 'tags', 'pinned', 'created_at', 'updated_at', 'archived_at', 'deleted_at'])
            .where('org_id', '=', ctx.orgId)
            .where('author_user_id', '=', userId)
            .where('id', 'in', noteKeep)
            .orderBy('created_at', 'desc')
            .orderBy('id')
            .execute();
    const todos =
      todoKeep.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_notes.todo')
            .select(['id', 'title', 'details', 'checklist', 'status', 'due_on', 'due_at', 'time_zone', 'remind_at', 'created_at', 'updated_at', 'done_at', 'deleted_at', 'source_note_id', 'task_id'])
            .where('org_id', '=', ctx.orgId)
            .where('owner_user_id', '=', userId)
            .where('id', 'in', todoKeep)
            .orderBy('created_at', 'desc')
            .orderBy('id')
            .execute();

    const ids = notes.map((n) => n.id);
    const links =
      ids.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_notes.link')
            .select(['note_id', 'target_type', 'target_id'])
            .where('org_id', '=', ctx.orgId)
            .where('note_id', 'in', ids)
            .orderBy('created_at')
            .orderBy('id')
            .execute();
    const linksOf = new Map<string, { targetType: string; targetId: string }[]>();
    for (const l of links) {
      const list = linksOf.get(l.note_id) ?? [];
      list.push({ targetType: l.target_type, targetId: l.target_id });
      linksOf.set(l.note_id, list);
    }
    return {
      exportedAt: new Date().toISOString(),
      notes: notes.map((n) => ({
        id: n.id,
        visibility: n.visibility,
        title: n.title,
        body: n.body,
        tags: n.tags,
        pinned: n.pinned,
        createdAt: new Date(n.created_at).toISOString(),
        updatedAt: new Date(n.updated_at).toISOString(),
        archivedAt: iso(n.archived_at),
        deletedAt: iso(n.deleted_at),
        links: linksOf.get(n.id) ?? [],
      })),
      todos: todos.map((t) => ({
        id: t.id,
        title: t.title,
        details: t.details ?? '',
        checklist: (Array.isArray(t.checklist) ? (t.checklist as { text: string; done: boolean }[]) : []).map((s) => ({ text: s.text, done: s.done })),
        status: t.status,
        dueOn: t.due_on,
        dueAt: iso(t.due_at),
        timeZone: t.time_zone,
        remindAt: iso(t.remind_at),
        createdAt: new Date(t.created_at).toISOString(),
        updatedAt: new Date(t.updated_at).toISOString(),
        doneAt: iso(t.done_at),
        deletedAt: iso(t.deleted_at),
        sourceNoteId: t.source_note_id,
        taskId: t.task_id,
      })),
      truncated: noteKeep.length < noteIds.length || todoKeep.length < todoIds.length,
    };
  },
});

export const exportQueries = [notesExportMine];
