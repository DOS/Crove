// The reading behind org-purge-coverage.db.test.ts (#1217), without a database: what org_purge deletes, read from the
// newest migration that defines it, and the messages on planted catalogs.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KEPT, MIGRATIONS_DIR, purgeCoverageProblems, purgedTables, readMigrations, type PurgeCatalog } from './org-purge-coverage.ts';

const migrations = readMigrations();
const newestSource = (() => {
  const text = readFileSync(`${MIGRATIONS_DIR}/${migrations.newestPurge}`, 'utf8');
  const start = text.indexOf('CREATE OR REPLACE FUNCTION crove_kernel.org_purge(');
  return text.slice(start, text.indexOf('END $$;', start) + 'END $$;'.length);
})();

const source = (lists: string[], deletes: string[] = []) =>
  [
    'DECLARE',
    ...lists.map((l, i) => `  v_l${i} text[] := ARRAY[${l}];`),
    'BEGIN',
    `  FOREACH v_t IN ARRAY ${lists.map((_, i) => `v_l${i}`).join(' || ')} LOOP`,
    "    EXECUTE pg_catalog.format('DELETE FROM %s WHERE org_id = $1', v_t::regclass) USING v_org;",
    '  END LOOP;',
    ...deletes.map((t) => `  DELETE FROM ${t} x WHERE x.org_id = v_org;`),
    'END',
  ].join('\n');

describe('the tables crove_kernel.org_purge deletes (#1217)', () => {
  it('reads the lists and the DELETE statements of the newest definition', () => {
    const purged = purgedTables(newestSource);
    for (const table of ['crove_notes.link', 'crove_kernel.inbox_item', 'crove_crm.event_type', 'crove_social.media_archive', 'crove_kernel.proposal', 'crove_social.post', 'crove_kernel.tenant_member', 'crove_kernel.party', 'crove_kernel.file']) {
      expect(purged.has(table), table).toBe(true);
    }
    // Named only as counts of pinned rows, or updated: not deleted.
    for (const table of ['crove_kernel.task_comment', 'crove_social.post_approval', 'crove_kernel.tenant']) expect(purged.has(table), table).toBe(false);
  });

  it('ignores tables named in comments', () => {
    expect(purgedTables(`${source(["'crove_a.x'"])}\n-- DELETE FROM crove_a.y\n  -- 'crove_a.z'`)).toEqual(new Set(['crove_a.x']));
  });

  it('fails rather than reading fewer tables when the loop or a list changes shape', () => {
    expect(() => purgedTables("DELETE FROM crove_a.x x WHERE x.org_id = v_org;")).toThrow(/FOREACH/);
    expect(() => purgedTables("FOREACH v_t IN ARRAY v_missing LOOP\nEND LOOP;")).toThrow(/v_missing/);
  });
});

describe('purge coverage problems (#1217)', () => {
  const catalog = (tables: string[], over: Partial<PurgeCatalog> = {}): PurgeCatalog => ({
    tables,
    cascades: [],
    purgeSource: source(["'crove_a.deleted'"], ['crove_a.partial']),
    ...over,
  });
  const where: typeof migrations = { newestPurge: '20990101000000_crove_kernel_org_purge_last.sql', createdIn: (t) => (t === 'crove_a.missing' ? '20990101010000_crove_a_missing.sql' : undefined) };

  it('accepts tables the purge deletes, whole or in part, and kept tables', () => {
    expect(purgeCoverageProblems(catalog(['crove_a.deleted', 'crove_a.partial', 'crove_a.kept']), { 'crove_a.kept': 'why' }, where)).toEqual([]);
  });

  it('names a table neither deleted nor kept, the migration that made it and the one to restate', () => {
    const problems = purgeCoverageProblems(catalog(['crove_a.deleted', 'crove_a.missing']), {}, where);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^crove_a\.missing \(created in supabase\/migrations\/20990101010000_crove_a_missing\.sql\) has org_id, but crove_kernel\.org_purge does not delete it/);
    expect(problems[0]).toContain('restates the newest definition (supabase/migrations/20990101000000_crove_kernel_org_purge_last.sql)');
    expect(problems[0]).toContain('KEPT in apps/kernel/test/org-purge-coverage.ts');
  });

  it('counts the children that go with a deleted parent through NOT NULL cascades, transitively', () => {
    const cascades = [
      { child: 'crove_a.child', parent: 'crove_a.deleted' },
      { child: 'crove_a.grandchild', parent: 'crove_a.child' },
      { child: 'crove_a.orphan', parent: 'crove_a.kept' },
    ];
    expect(purgeCoverageProblems(catalog(['crove_a.deleted', 'crove_a.child', 'crove_a.grandchild', 'crove_a.orphan', 'crove_a.kept'], { cascades }), { 'crove_a.kept': 'why' }, where)).toEqual([
      expect.stringMatching(/^crove_a\.orphan has org_id, but crove_kernel\.org_purge does not delete it/),
    ]);
  });

  it('flags a kept entry the purge deletes, or one that is no table with org_id', () => {
    expect(purgeCoverageProblems(catalog(['crove_a.deleted']), { 'crove_a.deleted': 'why', 'crove_a.gone': 'why' }, where)).toEqual([
      'crove_a.deleted is on KEPT but crove_kernel.org_purge deletes it: remove it from KEPT',
      'crove_a.gone is on KEPT but is no crove_* table with org_id: remove it from KEPT',
    ]);
  });

  it('gives every kept table a reason', () => {
    for (const [table, why] of Object.entries(KEPT)) expect(why.trim().length, table).toBeGreaterThan(0);
  });
});
