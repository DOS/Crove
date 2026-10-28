// The notes module's manifest (plan §5.2, #1588, #1599; notes plan docs/plan/notes.md §3.4): the tables it owns and the
// class of every column. A migration that adds or drops a table or column of crove_notes changes this list in the same
// PR; apps/kernel/test/manifest.db.test.ts checks it against the catalog. A column is internal unless the second
// argument of columns() classifies it. The title, body, tags and their folded search words are a member's free text,
// which may name people, so pii: audit rows keep a marker for them (auditValue), never the text.
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const notesManifest = defineModule({
  id: 'notes',
  dependsOn: ['kernel'],
  tables: {
    crove_notes: {
      link: columns(['org_id', 'id', 'note_id', 'target_type', 'target_id', 'party_id', 'file_id', 'created_by', 'created_at']),
      note: columns(
        ['org_id', 'id', 'author_user_id', 'visibility', 'pinned', 'tainted', 'revision', 'created_at', 'updated_at', 'archived_at', 'deleted_at'],
        { title: 'pii', body: 'pii', tags: 'pii', search: 'pii' },
      ),
    },
  },
  // It owns no permission: access comes from the base role (owners, admins and members write notes), and who reads a
  // note is the database's row policies (ADR-0037).
  permissions: [],
  // Its entities (#1656): the note, which every command names as its audit target.
  entities: [{ type: 'notes.note', table: 'note', legalEntityScoped: false, audit: 'command' }],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @crove/kernel-contract.
  ...MODULE_SCREENS.notes,
});
