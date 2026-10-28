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
  // #1709: a rule's table follows TO, a partition attached or detached is locked as well as its parent, and so is the
  // table of CREATE STATISTICS and the parent of [NO] INHERIT.
  'CREATE OR REPLACE RULE r AS ON INSERT TO crove_kernel.audit_event DO INSTEAD NOTHING',
  'ALTER TABLE crove_kernel.party_p ATTACH PARTITION crove_jobs.job_x FOR VALUES IN (1)',
  'ALTER TABLE IF EXISTS crove_kernel.party_p DETACH PARTITION crove_kernel.outbox_2026',
  'ALTER INDEX crove_kernel.party_p_idx ATTACH PARTITION crove_jobs.job_x_idx',
  'ALTER TABLE crove_kernel.party_x NO INHERIT crove_kernel.audit_event',
  'ALTER TABLE crove_kernel.party_x INHERIT crove_kernel.record',
  'CREATE STATISTICS IF NOT EXISTS crove_kernel.audit_stats (dependencies) ON org_id, command FROM crove_kernel.audit_event',
];

describe('migration lint: hot-table-retry', () => {
  it('accepts DDL on each hot table inside the lock-retry block', () => {
    for (const statement of HOT_DDL) expect(rules(retry(statement)), statement).toEqual([]);
    // The same shape written out: a label, SET LOCAL, DEFAULT 0, >, RETURN, two statements, one through EXECUTE, and
    // a first handler for another error.
    expect(rules([
      'DO $$',
      'DECLARE',
      '  tries integer DEFAULT 0;',
      'BEGIN',
      '  <<retry>>',
      '  LOOP',
      '    BEGIN',
      "      SET LOCAL lock_timeout = '2s';",
      '      ALTER TABLE crove_kernel.audit_event ADD COLUMN IF NOT EXISTS y int;',
      "      EXECUTE 'CREATE INDEX IF NOT EXISTS y_idx ON crove_kernel.audit_event (y)';",
      '      RETURN;',
      '    EXCEPTION',
      '      WHEN duplicate_column THEN RAISE;',
      '      WHEN lock_not_available OR deadlock_detected THEN',
      '        tries := tries + 1;',
      '        IF tries > 15 THEN RAISE; END IF;',
      '        PERFORM pg_sleep(1);',
      '    END;',
      '  END LOOP retry;',
      'END $$;',
    ].join('\n'))).toEqual([]);
  });

  it('refuses a retry that swallows the lock error, may skip the statement or never ends (coordinator review)', () => {
    const base = retry('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int');
    const bounded = 'n := n + 1; IF n >= 15 THEN RAISE; END IF;';
    const handler = (text: string) => base.replace(/EXCEPTION WHEN lock_not_available THEN .*\n/, `EXCEPTION ${text}\n`);
    const variants = {
      'the lock branch swallows, another raises': handler('WHEN lock_not_available THEN NULL; WHEN others THEN RAISE;'),
      'the lock branch catches OTHERS too': handler(`WHEN lock_not_available OR others THEN ${bounded}`),
      'OTHERS before the lock branch': handler(`WHEN others THEN NULL; WHEN lock_not_available THEN ${bounded}`),
      'a bound that never fires': handler('WHEN lock_not_available THEN n := n + 1; IF false THEN RAISE; END IF;'),
      'a bound on another variable': handler('WHEN lock_not_available THEN n := n + 1; IF m >= 15 THEN RAISE; END IF;'),
      'a counter that never counts': handler('WHEN lock_not_available THEN IF n >= 15 THEN RAISE; END IF;'),
      'a counter without 0': base.replace('DECLARE n int := 0;', 'DECLARE n int;'),
      'a raise inside the bound that only logs': handler("WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE NOTICE 'x'; END IF;"),
      'a FOR loop that may end first': base.replace('LOOP BEGIN', 'FOR i IN 1..1 LOOP BEGIN').replace(bounded, 'IF i > 5 THEN RAISE; END IF;'),
      'a FOR loop with the counter': base.replace('LOOP BEGIN', 'FOR i IN 1..1 LOOP BEGIN'),
      'a WHILE loop': base.replace('LOOP BEGIN', 'WHILE false LOOP BEGIN'),
      'the statement in an IF': base.replace('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int;', 'IF false THEN ALTER TABLE crove_kernel.audit_event ADD COLUMN x int; END IF;'),
      'the statement in an inner block': base.replace('ALTER TABLE crove_kernel.audit_event ADD COLUMN x int;', 'BEGIN ALTER TABLE crove_kernel.audit_event ADD COLUMN x int; END;'),
      // #1709: the EXIT must surely run after the statement.
      'the EXIT in an IF': base.replace('EXIT;', 'IF false THEN EXIT; END IF;'),
      'an EXIT WHEN': base.replace('EXIT;', 'EXIT WHEN false;'),
    };
    for (const [name, sql] of Object.entries(variants)) {
      expect(sql, name).not.toBe(base);
      expect(lint(sql).length, name).toBe(1);
    }
  });

  it('refuses DDL on each hot table outside it', () => {
    for (const statement of HOT_DDL) expect(rules(`SELECT 1;\n${statement};`), statement).toEqual([2]);
    const finding = lint('ALTER TABLE crove_kernel.audit_event ADD COLUMN x text;')[0]!;
    expect(finding.message).toContain('DDL on the hot table crove_kernel.audit_event runs in the lock-retry block (plan §5.5)');
    expect(rules("DO $$ BEGIN\n  EXECUTE 'ALTER TABLE crove_jobs.job ADD COLUMN x int';\nEND $$;")).toEqual([2]);
    // The command string is read as PostgreSQL reads it, escapes decoded (#1709 review).
    expect(rules(String.raw`DO $$ BEGIN EXECUTE E'ALTER\x20TABLE crove_kernel.audit_event ADD COLUMN y int'; END $$;`)).toEqual([1]);
    expect(rules(String.raw`DO $$ BEGIN EXECUTE U&'\0041LTER TABLE crove_kernel.audit_event ADD COLUMN y int'; END $$;`)).toEqual([1]);
    expect(rules(String.raw`ALTER TABLE U&"crove\005fkernel".audit_event ADD COLUMN y int;`)).toEqual([1]);
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

  it('refuses a timeout that is undone, may not run, or rounds to 0 or for ever (#1709)', () => {
    const statement = 'ALTER TABLE crove_kernel.audit_event ADD COLUMN x int';
    const base = retry(statement);
    const setting = "PERFORM set_config('lock_timeout', '2s', true);";
    const before = (text: string) => base.replace(`${statement};`, `${text}\n    ${statement};`);
    const variants = {
      'a later SET LOCAL to 0': before('SET LOCAL lock_timeout = 0;'),
      'a later set_config to 0': before("PERFORM set_config('lock_timeout', '0', true);"),
      'a later RESET': before('RESET lock_timeout;'),
      'a later RESET ALL': before('RESET ALL;'),
      'a later session SET': before("SET lock_timeout = '0';"),
      'a later quoted name': before('SET LOCAL "lock_timeout" = DEFAULT;'),
      'a later setting in an IF': before('IF true THEN SET LOCAL lock_timeout = 0; END IF;'),
      'a later EXECUTE that resets it': before("EXECUTE 'SET LOCAL LOCK_TIMEOUT = 0';"),
      'a set_config of a name in a variable': before("PERFORM set_config(v_name, '0', true);"),
      'a set_config of a built name': before("PERFORM set_config('lock_' || 'timeout', '0', true);"),
      'a later EXECUTE of a built string': before("EXECUTE 'SET LOCAL lock_' || 'timeout = 0';"),
      'a later EXECUTE of format()': before("EXECUTE format('SET LOCAL %s = 0', v_name);"),
      'a later EXECUTE of a variable': before('EXECUTE v_sql;'),
      // The name spelled with escapes or quotes (review probes).
      'a later U& identifier': before(String.raw`SET LOCAL U&"lock\005ftimeout" = 0;`),
      'a later U& identifier with UESCAPE': before(`SET LOCAL u&"lock!005ftimeout" UESCAPE '!' TO DEFAULT;`),
      'a later set_config of an E string': before(String.raw`PERFORM set_config(E'lock\x5ftimeout', '0', true);`),
      'a later set_config of a U& string': before(String.raw`PERFORM set_config(U&'lock\005Ftimeout', '0', true);`),
      'a later EXECUTE of an E string': before(String.raw`EXECUTE E'SET LOCAL lock\x5ftimeout = 0';`),
      'a later quoted set_config': before(`PERFORM "set_config"(chr(108) || 'ock_timeout', '0', true);`),
      'a later qualified quoted set_config': before(`PERFORM pg_catalog."set_config"(chr(108) || 'ock_timeout', '0', true);`),
      'a reset in an E string statement': base.replace(`${statement};`, String.raw`EXECUTE E'SET LOCAL lock\x5ftimeout = 0; ${statement}';`),
      'a reset in the statement itself': base.replace(`${statement};`, `EXECUTE 'SET LOCAL lock_timeout = 0; ${statement}';`),
      'the timeout in an IF': base.replace(setting, `IF false THEN ${setting} END IF;`),
      'the timeout in an inner block': base.replace(setting, `BEGIN ${setting} END;`),
      'the timeout in a CASE': base.replace(setting, `CASE WHEN false THEN ${setting} ELSE NULL; END CASE;`),
      'a timeout with more after it': base.replace(setting, "PERFORM set_config('lock_timeout', '2s', true), set_config('lock_timeout', '0', true);"),
      'a timeout cast': base.replace("'2s'", "'2s'::text"),
    };
    for (const [name, sql] of Object.entries(variants)) {
      expect(sql, name).not.toBe(base);
      expect(lint(sql).length, name).toBe(1);
    }
    for (const value of ["'0us'", "'400us'", "'0x0'", "'0x10'", "'0.4'", "'0.4s'", "'0e3'", "'2e3'", "'1_000'", '0.4', '0e3', "'0 ms'", "'2h'", "'1d'", "'61s'", "'2S'", "'-1'", "''", "'2s' || '0'"]) {
      expect(lint(base.replace("'2s'", value)).length, value).toBe(1);
      expect(lint(base.replace(setting, `SET LOCAL lock_timeout = ${value};`)).length, value).toBe(1);
    }
    // What a timeout may be: whole ms, s or min from 1 ms to 1 min, as a number or a string; and a later setting that
    // waits too wins over an earlier reset.
    for (const value of ["'2s'", "'2000'", '2000', "'1min'", "' 500 ms '", "'60s'", "'1ms'", '$v$3s$v$']) {
      expect(lint(base.replace("'2s'", value)), value).toEqual([]);
      expect(lint(base.replace(setting, `SET LOCAL lock_timeout TO ${value};`)), value).toEqual([]);
    }
    expect(lint(before("SET LOCAL lock_timeout = 0;\n    PERFORM pg_catalog.set_config('lock_timeout', '3s', true);"))).toEqual([]);
    // Other settings and reads leave it alone, and so does an EXECUTE of one literal, or of format() as the statement.
    expect(lint(before("PERFORM set_config('statement_timeout', '0', true);\n    PERFORM current_setting('search_path');\n    EXECUTE 'SELECT 1' INTO v;"))).toEqual([]);
    expect(lint(retry("EXECUTE format('ALTER TABLE crove_kernel.%I ADD COLUMN x int', 'audit_event')"))).toEqual([]);
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
