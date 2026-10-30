// A member's own notes and to-dos, whole, for their download (#1678, notes.md section 5 "Tải về", ADR-0037 section 5:
// their private items are personal data the org processes, and this answers their access and portability). Every note
// the caller wrote, private or shared, archived or in the trash, with its links, and every to-do of theirs: filtered on
// the caller as author and owner, so an owner or admin who reads the org's shared notes gets their own only. The app
// turns it into Markdown or JSON in the browser; nothing is stored or sent elsewhere.
import { z } from 'zod';
import { NOTES_EXPORT_LIMIT, type NotesExport } from '@crove/kernel-contract';
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
    const notes = await ctx.trx
      .selectFrom('crove_notes.note')
      .select(['id', 'visibility', 'title', 'body', 'tags', 'pinned', 'created_at', 'updated_at', 'archived_at', 'deleted_at'])
      .where('org_id', '=', ctx.orgId)
      .where('author_user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(NOTES_EXPORT_LIMIT + 1)
      .execute();
    const todos = await ctx.trx
      .selectFrom('crove_notes.todo')
      .select(['id', 'title', 'details', 'checklist', 'status', 'due_on', 'due_at', 'time_zone', 'remind_at', 'created_at', 'updated_at', 'done_at', 'deleted_at'])
      .where('org_id', '=', ctx.orgId)
      .where('owner_user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(NOTES_EXPORT_LIMIT + 1)
      .execute();
    const kept = notes.slice(0, NOTES_EXPORT_LIMIT);
    const ids = kept.map((n) => n.id);
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
      notes: kept.map((n) => ({
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
      todos: todos.slice(0, NOTES_EXPORT_LIMIT).map((t) => ({
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
      })),
      truncated: notes.length > NOTES_EXPORT_LIMIT || todos.length > NOTES_EXPORT_LIMIT,
    };
  },
});

export const exportQueries = [notesExportMine];
