// hot-table-retry (#1693, plan §5.5): DDL that locks a hot table runs inside the lock-retry block.
import { describe, expect, it } from 'vitest';
import { inRetryBlock, isHotTable, lex, lintMigration, retryBlocks } from '../ci/migration-lint.mjs';

const FILE = 'supabase/migrations/20261201000000_crove_kernel_sample.sql';

type Finding = { file: string; line: number; rule: string; message: string };
const lint = (sql: string, breakingRules = true): Finding[] =>
  lintMigration(FILE, sql, { breakingRules }).filter((f: Finding) => f.rule === 'hot-table-retry');
const rules = (sql: string) => lint(sql).map((f) => f.line);

// The block of plan §5.5 around one statement.
const retry = (statement: string) => `DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
    ${statement}; EXIT;
  EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random());
  END; END LOOP; END $$;`;

const HOT_DDL = [
  'ALTER TABLE crove_kernel.audit_event ADD COLUMN IF NOT EXISTS surface text',
  'ALTER TABLE IF EXISTS ONLY crove_kernel.outbox_event ENABLE TRIGGER stream_hint',
  'ALTER TABLE crove_kernel.idempotency_key ADD CONSTRAINT k_fk FOREIGN KEY (org_id) REFERENCES crove_kernel.tenant (org_id)',
  'ALTER TABLE crove_kernel.party ADD CONSTRAINT p_fk FOREIGN KEY (org_id, e) REFERENCES crove_kernel.audit_event (org_id, id)',
  'CREATE INDEX IF NOT EXISTS audit_event_x_idx ON crove_kernel.audit_event (org_id, x)',
  'CREATE UNIQUE INDEX IF NOT EXISTS i ON ONLY crove_kernel.processed_message (id)',
  'CREATE TRIGGER t BEFORE INSERT ON crove_kernel.outbox_pending FOR EACH ROW EXECUTE FUNCTION crove_kernel.touch()',
  'CREATE OR REPLACE TRIGGER t AFTER INSERT ON crove_jobs.job FOR EACH ROW EXECUTE FUNCTION crove_kernel.touch()',
  'DROP TRIGGER IF EXISTS t ON crove_kernel.audit_event',
  'CREATE POLICY p ON crove_kernel.record USING (true)',
  'ALTER POLICY p ON crove_kernel.audit_event USING (true)',
  'DROP INDEX IF EXISTS crove_kernel.outbox_event_org_idx',
  'ALTER INDEX crove_jobs.job_i5 SET (fillfactor = 90)',
  'LOCK TABLE crove_jobs.queue IN SHARE MODE',
  'REINDEX TABLE crove_kernel.audit_event',
  'CLUSTER VERBOSE crove_kernel.outbox_event USING outbox_event_pkey',
  'CREATE TABLE IF NOT EXISTS crove_kernel.party_ref (org_id uuid, a uuid, FOREIGN KEY (org_id, a) REFERENCES crove_kernel.audit_event (org_id, id))',
  'CREATE TABLE IF NOT EXISTS crove_jobs.job_x PARTITION OF crove_jobs.job FOR VALUES IN (1)',
];

describe('migration lint: hot-table-retry', () => {
  it('accepts DDL on each hot table inside the lock-retry block', () => {
    for (const statement of HOT_DDL) expect(rules(retry(statement)), statement).toEqual([]);
    // A block whose loop counts and sets the timeout with SET LOCAL, around a dynamic statement.
    expect(rules([
      'DO $$',
      'DECLARE n int := 0;',
      'BEGIN',
      '  FOR i IN 1..15 LOOP',
      '    BEGIN',
      "      SET LOCAL lock_timeout = '2s';",
      "      EXECUTE format('ALTER TABLE crove_kernel.%I ADD COLUMN IF NOT EXISTS y int', 'audit_event');",
      "      EXECUTE 'CREATE INDEX IF NOT EXISTS y_idx ON crove_kernel.audit_event (y)';",
      '      RETURN;',
      '    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN',
      '      IF i = 15 THEN RAISE; END IF;',
      '    END;',
      '  END LOOP;',
      'END $$;',
    ].join('\n'))).toEqual([]);
  });

  it('refuses DDL on each hot table outside it', () => {
    for (const statement of HOT_DDL) expect(rules(`SELECT 1;\n${statement};`), statement).toEqual([2]);
    const finding = lint('ALTER TABLE crove_kernel.audit_event ADD COLUMN x text;')[0]!;
    expect(finding.message).toContain('DDL on the hot table crove_kernel.audit_event runs in the lock-retry block (plan §5.5)');
    expect(rules("DO $$ BEGIN\n  EXECUTE 'ALTER TABLE crove_jobs.job ADD COLUMN x int';\nEND $$;")).toEqual([2]);
  });

  it('refuses a block that does not retry, does not bound, sets no timeout or never exits', () => {
    const variants = {
      'no loop': "DO $$ BEGIN BEGIN PERFORM set_config('lock_timeout', '2s', true); ALTER TABLE crove_kernel.audit_event ADD COLUMN x int; EXIT; EXCEPTION WHEN lock_not_available THEN RAISE; END; END $$;",
      'another error': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace('lock_not_available', 'duplicate_column'),
      'no bound': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace('IF n >= 15 THEN RAISE; END IF;', ''),
      'a notice for a bound': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace('THEN RAISE;', "THEN RAISE NOTICE 'again';"),
      'a timeout of 0': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace("'2s'", "'0'"),
      'a timeout of 0 ms': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace("PERFORM set_config('lock_timeout', '2s', true);", 'SET LOCAL lock_timeout = 0;'),
      'the default timeout': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace("PERFORM set_config('lock_timeout', '2s', true);", 'SET LOCAL lock_timeout TO DEFAULT;'),
      'a session timeout': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace('true);', 'false);'),
      'SET without LOCAL': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace("PERFORM set_config('lock_timeout', '2s', true);", "SET lock_timeout = '2s';"),
      'no timeout':retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace("PERFORM set_config('lock_timeout', '2s', true);", ''),
      'another setting': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace("'lock_timeout'", "'statement_timeout'"),
      'timeout after': retry("ALTER TABLE crove_kernel.audit_event ADD COLUMN x int; PERFORM set_config('lock_timeout', '2s', true)").replace("PERFORM set_config('lock_timeout', '2s', true);\n", ''),
      'no exit': retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int').replace('EXIT;', ''),
      'in the handler': "DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN PERFORM set_config('lock_timeout', '2s', true); EXIT; EXCEPTION WHEN lock_not_available THEN ALTER TABLE crove_kernel.audit_event ADD COLUMN x int; RAISE; END; END LOOP; END $$;",
      'after the block': `${retry('PERFORM 1').replace(' END $$;', '')}\n  ALTER TABLE crove_kernel.audit_event ADD COLUMN x int;\nEND $$;`,
    };
    for (const [name, sql] of Object.entries(variants)) expect(lint(sql).length, name).toBe(1);
  });

  it('leaves alone what does not lock a hot table', () => {
    expect(rules([
      'ALTER TABLE crove_kernel.party ADD COLUMN IF NOT EXISTS x text;',
      'CREATE INDEX IF NOT EXISTS party_x_idx ON crove_kernel.party (org_id, x);',
      'INSERT INTO crove_kernel.audit_event (org_id) VALUES (NULL);',
      'UPDATE crove_kernel.outbox_event SET x = 1;',
      'GRANT SELECT ON crove_kernel.audit_event TO crove_tenant;',
      "COMMENT ON TABLE crove_kernel.audit_event IS 'ALTER TABLE crove_kernel.audit_event ADD x int';",
      'CREATE OR REPLACE VIEW crove_kernel.v AS SELECT * FROM crove_kernel.audit_event;',
      'CREATE TABLE IF NOT EXISTS crove_kernel.recordings (id int);',
      'ALTER TABLE crove_kernel.record_link ADD COLUMN IF NOT EXISTS x int;',
      "SELECT crove_jobs.create_queue('x', '{}'::jsonb);",
      'CREATE OR REPLACE FUNCTION crove_kernel.f() RETURNS void LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $f$ ALTER TABLE crove_kernel.audit_event ADD x int $f$;',
    ].join('\n'))).toEqual([]);
  });

  it('treats a table this file created with a plain CREATE TABLE as not hot yet', () => {
    expect(rules('CREATE TABLE crove_jobs.job_y (id int);\nCREATE INDEX job_y_idx ON crove_jobs.job_y (id);\nALTER TABLE crove_jobs.job_y ADD COLUMN x int;')).toEqual([]);
    // IF NOT EXISTS may have found the live table.
    expect(rules('CREATE TABLE IF NOT EXISTS crove_kernel.outbox_x (id int);\nCREATE INDEX IF NOT EXISTS outbox_x_idx ON crove_kernel.outbox_x (id);')).toEqual([2]);
    // A CREATE in a DO may not have run (review probes).
    expect(rules('DO $$ BEGIN CREATE TABLE crove_kernel.outbox_event (id int); EXCEPTION WHEN duplicate_table THEN NULL; END $$;\nALTER TABLE crove_kernel.outbox_event ADD COLUMN x int;')).toEqual([2]);
    expect(rules("DO $$ BEGIN IF to_regclass('crove_kernel.audit_event') IS NULL THEN CREATE TABLE crove_kernel.audit_event (id int); END IF; END $$;\nALTER TABLE crove_kernel.audit_event ADD COLUMN x int;")).toEqual([2]);
  });

  it('knows the hot tables and the shape of the block', () => {
    const hot = ['crove_jobs.job', 'crove_jobs.anything', 'crove_kernel.outbox_event', 'crove_kernel.outbox_archive', 'crove_kernel.audit_event', 'crove_kernel.record', 'crove_kernel.idempotency_key', 'crove_kernel.processed_message'];
    const cold = ['crove_kernel.party', 'crove_kernel.record_link', 'crove_social.audit_event', 'crove_kernel.outbox'];
    const table = (name: string) => ({ schema: name.split('.')[0], name: name.split('.')[1] });
    expect(hot.filter((name) => !isHotTable(table(name)))).toEqual([]);
    expect(cold.filter((name) => isHotTable(table(name)))).toEqual([]);
    const tokens = lex(retry('ALTER TABLE crove_kernel.audit_event ADD x int').replace(/^DO \$\$|\$\$;$/g, ''));
    const blocks = retryBlocks(tokens);
    expect(blocks).toHaveLength(1);
    expect(inRetryBlock(blocks, tokens.findIndex((t: { v: string }) => t.v === 'alter'))).toBe(true);
    expect(inRetryBlock(blocks, tokens.findIndex((t: { v: string }) => t.v === 'perform'))).toBe(false);
  });

  it('skips the files on main before the rule', () => {
    expect(lint('ALTER TABLE crove_kernel.audit_event ADD COLUMN x text;', false)).toEqual([]);
  });
});
