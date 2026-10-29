// Concurrent index builds (#1791): a file marked `-- crove:concurrent-index` holds only CREATE INDEX CONCURRENTLY IF NOT
// EXISTS statements, which the runner applies outside a transaction, and a new index on a hot table is built that way.
import { describe, expect, it } from 'vitest';
import { concurrentIndexes } from '../../packages/db/src/migrate.ts';
import { CONCURRENT_INDEX_MARKER, HOT_INDEX_RULE_AFTER, hotIndexRuleApplies, lintMigration } from '../ci/migration-lint.mjs';

const FILE = 'supabase/migrations/20261201000000_crove_kernel_sample.sql';

type Finding = { file: string; line: number; rule: string; message: string };
const lint = (sql: string, options: { hotIndexRule?: boolean } = {}): Finding[] => lintMigration(FILE, sql, { hotIndexRule: options.hotIndexRule ?? true });
const rules = (sql: string, options?: { hotIndexRule?: boolean }) => lint(sql, options).map((f) => `${f.line} ${f.rule}`);
const marked = (body: string) => `-- Indexes on the audit log, built without blocking writes.\n${CONCURRENT_INDEX_MARKER}\n\n${body}`;

const GOOD = marked(
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_event_x_idx ON crove_kernel.audit_event (org_id, command);\n' +
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outbox_event_y_key ON crove_kernel.outbox_event (org_id, (payload->>'k'))\n  WHERE status = 'pending';\n",
);

// Marked files the runner refuses, and the line the lint names.
const BAD: Record<string, [string, number]> = {
  'another statement': [marked('CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON crove_kernel.party (a);\nDROP INDEX IF EXISTS crove_kernel.b_idx;\n'), 5],
  'a plain CREATE INDEX': [marked('CREATE INDEX IF NOT EXISTS a_idx ON crove_kernel.party (a);\n'), 4],
  'no IF NOT EXISTS': [marked('CREATE INDEX CONCURRENTLY a_idx ON crove_kernel.party (a);\n'), 4],
  'an unqualified table': [marked('CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON party (a);\n'), 4],
  'transaction control': [marked('BEGIN;\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON crove_kernel.party (a);\n'), 4],
  'a comment after the first statement': [marked('CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON crove_kernel.party (a);\n-- the next one\nCREATE INDEX CONCURRENTLY IF NOT EXISTS b_idx ON crove_kernel.party (b);\n'), 5],
  'a dollar quote': [marked('CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON crove_kernel.party ((crove_kernel.f($q$x$q$)));\n'), 4],
  'a quoted identifier': [marked('CREATE INDEX CONCURRENTLY IF NOT EXISTS "A_idx" ON crove_kernel.party (a);\n'), 4],
  'a backslash': [marked("CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON crove_kernel.party (a) WHERE b = E'\\\\';\n"), 4],
  'nothing to build': [marked(''), 1],
  // Clauses the runner does not read, and a semicolon inside a string, where it splits the file (review probes).
  'NULLS NOT DISTINCT': [marked('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS a_key ON crove_kernel.party (a) NULLS NOT DISTINCT;\n'), 4],
  'a tablespace': [marked('CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON crove_kernel.party (a) TABLESPACE pg_default;\n'), 4],
  'a semicolon in a string': [marked("CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON crove_kernel.party (a) WHERE b = 'x;y';\n"), 4],
};

describe('migration lint: concurrent index builds (#1791)', () => {
  it('accepts a marked file of concurrent index builds, on hot tables too, outside any retry block', () => {
    expect(lint(GOOD)).toEqual([]);
  });

  it('refuses anything else in a marked file', () => {
    for (const [name, [sql, line]] of Object.entries(BAD)) {
      expect(rules(sql).filter((r) => r.endsWith('concurrent-index')), name).toContain(`${line} concurrent-index`);
    }
  });

  it('agrees with the runner on what a marked file may hold', () => {
    expect(concurrentIndexes('a.sql', GOOD)).toHaveLength(2);
    for (const [name, [sql]] of Object.entries(BAD)) expect(() => concurrentIndexes('a.sql', sql), name).toThrow(/marked -- crove:concurrent-index but/);
  });

  it('counts the marker only among the leading comment lines, and refuses it anywhere else', () => {
    const late = `CREATE INDEX IF NOT EXISTS a_idx ON crove_kernel.party (a);\n${CONCURRENT_INDEX_MARKER}\n`;
    expect(concurrentIndexes('a.sql', late)).toBeNull();
    expect(rules(late)).toEqual(['2 concurrent-index']);
    // CONCURRENTLY outside a marked file still fails, and says where it belongs.
    const loose = lint('CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON crove_kernel.party (a);');
    expect(loose.map((f) => f.rule)).toEqual(['no-concurrently']);
    expect(loose[0]?.message).toContain(`marked ${CONCURRENT_INDEX_MARKER}`);
  });

  it('refuses a new index on a hot table built with CREATE INDEX, also in a retry block or an EXECUTE', () => {
    const hot = (sql: string) => lint(sql).filter((f) => f.rule === 'hot-index-concurrently').map((f) => f.line);
    expect(hot('CREATE INDEX IF NOT EXISTS audit_event_x_idx ON crove_kernel.audit_event (org_id, command);')).toEqual([1]);
    expect(hot('SELECT 1;\nCREATE UNIQUE INDEX IF NOT EXISTS k ON crove_jobs.job (id);')).toEqual([2]);
    // Other index builds that lock out writes: a unique, primary key or exclusion constraint without USING INDEX, and
    // REINDEX (review probes).
    expect(hot('ALTER TABLE crove_kernel.audit_event ADD CONSTRAINT audit_event_x_key UNIQUE (org_id, command_id);')).toEqual([1]);
    expect(hot('ALTER TABLE ONLY crove_kernel.outbox_event ADD PRIMARY KEY (org_id, id);')).toEqual([1]);
    expect(hot('ALTER TABLE crove_kernel.record ADD COLUMN x int, ADD EXCLUDE USING gist (x WITH =);')).toEqual([1]);
    expect(hot('REINDEX TABLE crove_kernel.audit_event;\nREINDEX INDEX crove_kernel.outbox_event_pkey;')).toEqual([1, 2]);
    expect(lint('ALTER TABLE crove_kernel.audit_event ADD UNIQUE (id);')[0]?.message).toContain('ADD CONSTRAINT ... USING INDEX');
    // A constraint on an index built concurrently, and a partitioned parent's empty index (ON ONLY), are left alone.
    expect(hot('ALTER TABLE crove_kernel.audit_event ADD CONSTRAINT audit_event_x_key UNIQUE USING INDEX audit_event_x_key;')).toEqual([]);
    expect(hot('ALTER TABLE crove_kernel.audit_event ADD CONSTRAINT audit_event_pk PRIMARY KEY USING INDEX audit_event_pk;')).toEqual([]);
    expect(hot('CREATE UNIQUE INDEX IF NOT EXISTS k ON ONLY crove_jobs.job (id);')).toEqual([]);
    expect(hot(`DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
    CREATE INDEX IF NOT EXISTS outbox_event_x_idx ON crove_kernel.outbox_event (org_id); EXIT;
  EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF;
  END; END LOOP; END $$;`)).toEqual([3]);
    expect(hot("DO $$ BEGIN\n  EXECUTE 'CREATE INDEX IF NOT EXISTS r_idx ON crove_kernel.record (org_id)';\nEND $$;")).toEqual([2]);
    expect(lint('CREATE INDEX IF NOT EXISTS audit_event_x_idx ON crove_kernel.audit_event (org_id);')[0]?.message).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    // Not hot, or a table this file made with a plain CREATE TABLE, or built concurrently: nothing to report.
    expect(hot('CREATE INDEX IF NOT EXISTS party_x_idx ON crove_kernel.party (org_id);')).toEqual([]);
    expect(hot('CREATE TABLE crove_kernel.outbox_new (id int);\nCREATE INDEX outbox_new_idx ON crove_kernel.outbox_new (id);')).toEqual([]);
    expect(hot(GOOD)).toEqual([]);
  });

  it('skips the files on main before the rule, unless a PR adds them', () => {
    expect(lint('CREATE INDEX IF NOT EXISTS audit_event_x_idx ON crove_kernel.audit_event (org_id);', { hotIndexRule: false }).map((f) => f.rule)).not.toContain('hot-index-concurrently');
    // Pinned: the newest migration on main when the rule landed; raising it would exempt later files from the full-tree run.
    expect(HOT_INDEX_RULE_AFTER).toBe('20261104050000');
    expect(hotIndexRuleApplies('20261104050000_crove_notes_member_purge_lock.sql', false)).toBe(false);
    expect(hotIndexRuleApplies('supabase/migrations/20261104050001_crove_kernel_x.sql', false)).toBe(true);
    expect(hotIndexRuleApplies('20261013120000_crove_kernel_bootstrap.sql', true)).toBe(true);
  });
});
