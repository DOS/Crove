import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changedMigrations, format, formatWaiver, functionsCreated, lex, lintMigration, moduleOf, parseAllowlist, plan } from '../ci/migration-lint.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FILE = 'supabase/migrations/20261101000000_crove_social_sample.sql';

type Finding = { file: string; line: number; rule: string; message: string };
const lint = (sql: string, existing: string[] = []): Finding[] =>
  // contract-header and hot-table-retry have their own tests (migration-lint-contract and -hot-tables).
  lintMigration(FILE, sql, { existingFunctions: new Set(existing), breakingRules: false });
const rules = (sql: string, existing: string[] = []) => lint(sql, existing).map((f) => `${f.line} ${f.rule}`);

// A migration that follows every rule: the base the bad samples below are compared with.
const GOOD = `-- Crove Social: a sample. Idempotent.
SET LOCAL lock_timeout = '2s';
CREATE TABLE IF NOT EXISTS crove_social.sample (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  note text,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS sample_note_idx ON crove_social.sample (org_id, note);
SELECT crove_kernel.apply_tenant_rls('crove_social.sample');
REVOKE UPDATE ON crove_social.sample FROM crove_tenant;
GRANT UPDATE (note) ON crove_social.sample TO crove_tenant;
DROP POLICY IF EXISTS own_sample ON crove_social.sample;
CREATE POLICY own_sample ON crove_social.sample AS RESTRICTIVE FOR ALL TO crove_tenant USING (true);
DO $$
BEGIN
  ALTER TABLE crove_social.sample ADD CONSTRAINT sample_note_len CHECK (length(note) < 100) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE OR REPLACE FUNCTION crove_social.sample_count(p_org uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) FROM crove_social.sample WHERE org_id = p_org; -- BEGIN; TRUNCATE x; in a body is not run here
$$;
REVOKE ALL ON FUNCTION crove_social.sample_count(uuid) FROM PUBLIC, crove_tenant;
GRANT EXECUTE ON FUNCTION crove_social.sample_count(uuid) TO crove_worker;
COMMENT ON TABLE crove_social.sample IS 'BEGIN; COMMIT; TRUNCATE; DROP SCHEMA x; GRANT ALL ON y TO anon';
`;

describe('migration lint: a migration that follows the rules', () => {
  it('passes', () => {
    expect(lint(GOOD)).toEqual([]);
  });

  it('reads the module from the file name', () => {
    expect(moduleOf('supabase/migrations/20261101000000_crove_social_sample.sql')).toBe('social');
    expect(moduleOf('20261101000000_crove_kernel_a_b.sql')).toBe('kernel');
    expect(moduleOf('20261101000000_social_sample.sql')).toBeUndefined();
  });

  it('names the file, the line and the rule in each error', () => {
    const findings = lint('SET LOCAL lock_timeout = \'2s\';\n\nTRUNCATE crove_social.sample;');
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding).toMatchObject({ file: FILE, line: 3, rule: 'no-truncate' });
    expect(format(finding)).toBe(`::error file=${FILE},line=3::${FILE}:3 [no-truncate] ${finding.message}`);
  });
});

describe('migration lint: banned statements', () => {
  it('refuses CONCURRENTLY, at top level and in a DO body', () => {
    expect(rules('CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON crove_social.sample (note);')).toEqual(['1 no-concurrently']);
    expect(rules('DO $$ BEGIN\n  REFRESH MATERIALIZED VIEW CONCURRENTLY crove_social.mv;\nEND $$;')).toEqual(['2 no-concurrently']);
    expect(rules("CREATE INDEX IF NOT EXISTS i ON crove_social.sample (note); -- not CONCURRENTLY")).toEqual([]);
  });

  it('refuses transaction control, and lets a PL/pgSQL block begin', () => {
    expect(rules('BEGIN;\nCREATE TABLE IF NOT EXISTS crove_social.t (id int);\nCOMMIT;')).toEqual(['1 no-transaction', '3 no-transaction']);
    expect(rules('START TRANSACTION;')).toEqual(['1 no-transaction']);
    expect(rules('ROLLBACK;\nEND;')).toEqual(['1 no-transaction', '2 no-transaction']);
    expect(rules('DO $$\nBEGIN\n  PERFORM 1;\n  COMMIT;\nEND $$;')).toEqual(['4 no-transaction']);
    expect(rules('DO $$ BEGIN BEGIN PERFORM 1; EXCEPTION WHEN others THEN NULL; END; END $$;')).toEqual([]);
  });

  it('refuses DROP SCHEMA and TRUNCATE, also in SQL a DO body runs', () => {
    expect(rules('DROP SCHEMA IF EXISTS crove_social CASCADE;')).toEqual(['1 no-drop-schema']);
    expect(rules('TRUNCATE crove_social.sample;')).toEqual(['1 no-truncate']);
    expect(rules("DO $$ BEGIN\n  IF true THEN\n    TRUNCATE crove_social.sample;\n  END IF;\nEND $$;")).toEqual(['3 no-truncate']);
    expect(rules("DO $$ BEGIN\n  EXECUTE 'TRUNCATE crove_social.sample';\nEND $$;")).toEqual(['2 no-truncate']);
    expect(rules("DO $$ BEGIN\n  EXECUTE format('DROP SCHEMA %I', 'crove_social');\nEND $$;")).toEqual(['2 no-drop-schema']);
    expect(rules("DO $$ BEGIN RAISE NOTICE 'truncate later'; END $$;")).toEqual([]);
    // Every statement of an EXECUTE's command string, whatever the first one is (review probe P2).
    expect(rules("DO $$ BEGIN\n  EXECUTE 'SELECT 1; TRUNCATE crove_social.t; GRANT SELECT ON crove_social.t TO anon';\nEND $$;")).toEqual(['2 no-truncate', '2 no-public-grant']);
    // Only the command string of an EXECUTE is SQL: format arguments and USING values are data.
    expect(rules("DO $$ BEGIN\n  EXECUTE format('UPDATE crove_social.%I SET note = %L', 'sample', 'truncate');\n  EXECUTE 'UPDATE crove_social.sample SET note = $1' USING 'drop schema x';\nEND $$;")).toEqual([]);
  });

  it('refuses GRANTs to anon, authenticated and PUBLIC', () => {
    expect(rules('GRANT SELECT ON crove_social.sample TO anon;')).toEqual(['1 no-public-grant']);
    expect(rules('GRANT SELECT ON crove_social.sample TO crove_tenant, authenticated;')).toEqual(['1 no-public-grant']);
    expect(rules('GRANT EXECUTE ON FUNCTION crove_social.f() TO PUBLIC;')).toEqual(['1 no-public-grant']);
    expect(rules('GRANT USAGE ON SCHEMA crove_social TO "authenticated";')).toEqual(['1 no-public-grant']);
    expect(rules('ALTER DEFAULT PRIVILEGES IN SCHEMA crove_social GRANT SELECT ON TABLES TO public;')).toEqual(['1 no-public-grant']);
    expect(rules("DO $$ BEGIN\n  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN\n    GRANT SELECT ON crove_social.sample TO anon;\n  END IF;\nEND $$;")).toEqual(['3 no-public-grant']);
    expect(rules('GRANT SELECT ON crove_social.sample TO crove_tenant;\nREVOKE ALL ON crove_social.sample FROM PUBLIC, anon;')).toEqual([]);
  });
});

describe('migration lint: required statements', () => {
  it('needs DROP POLICY IF EXISTS for the same policy and table before CREATE POLICY', () => {
    expect(rules('CREATE POLICY p ON crove_social.sample USING (true);')).toEqual(['1 policy-drop-first']);
    expect(rules('DROP POLICY IF EXISTS p ON crove_social.other;\nCREATE POLICY p ON crove_social.sample USING (true);')).toEqual(['2 policy-drop-first']);
    expect(rules('CREATE POLICY p ON crove_social.sample USING (true);\nDROP POLICY IF EXISTS p ON crove_social.sample;')).toEqual(['1 policy-drop-first']);
    expect(rules('DROP POLICY p ON crove_social.sample;\nCREATE POLICY p ON crove_social.sample USING (true);')).toEqual(['2 policy-drop-first']);
    expect(rules('DROP POLICY IF EXISTS p ON crove_social.sample;\nCREATE POLICY p ON crove_social.sample FOR SELECT USING (true);')).toEqual([]);
    expect(rules("DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['a'] LOOP\n  EXECUTE format('DROP POLICY IF EXISTS own ON crove_social.%I', t);\n  EXECUTE format('CREATE POLICY own ON crove_social.%I USING (true)', t);\nEND LOOP; END $$;")).toEqual([]);
    expect(rules("DO $$ BEGIN\n  EXECUTE format('CREATE POLICY own ON crove_social.%I USING (true)', 'sample');\nEND $$;")).toEqual(['2 policy-drop-first']);
  });

  it('needs REVOKE ALL ON FUNCTION ... FROM PUBLIC after every new function', () => {
    const fn = (name: string) => `CREATE OR REPLACE FUNCTION ${name}() RETURNS int LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;`;
    expect(rules(fn('crove_social.f'))).toEqual(['1 function-revoke']);
    expect(rules(`${fn('crove_social.f')}\nREVOKE EXECUTE ON FUNCTION crove_social.f() FROM PUBLIC;`)).toEqual(['1 function-revoke']);
    expect(rules(`${fn('crove_social.f')}\nREVOKE ALL ON FUNCTION crove_social.f() FROM crove_tenant;`)).toEqual(['1 function-revoke']);
    expect(rules(`${fn('crove_social.f')}\nREVOKE ALL ON FUNCTION crove_social.g() FROM PUBLIC;`)).toEqual(['1 function-revoke']);
    expect(rules(`REVOKE ALL ON FUNCTION crove_social.f() FROM PUBLIC;\n${fn('crove_social.f')}`)).toEqual(['2 function-revoke']);
    expect(rules(`${fn('crove_social.f')}\nREVOKE ALL PRIVILEGES ON FUNCTION crove_social.f() FROM PUBLIC, crove_tenant;`)).toEqual([]);
    expect(rules(`${fn('crove_social.f')}\nREVOKE ALL ON ALL FUNCTIONS IN SCHEMA crove_social FROM PUBLIC;`)).toEqual([]);
    expect(rules('CREATE PROCEDURE crove_social.p() LANGUAGE sql AS $$ SELECT 1 $$;')).toEqual(['1 function-revoke']);
    // CREATE OR REPLACE of a function an earlier migration created keeps its privileges.
    expect(rules(fn('crove_social.f'), ['crove_social.f'])).toEqual([]);
    // Unless this file dropped it first: the drop took its privileges, so EXECUTE is back to PUBLIC (review probe P5).
    expect(rules(`DROP FUNCTION crove_social.f(int);\n${fn('crove_social.f')}`, ['crove_social.f'])).toEqual(['2 function-revoke']);
    expect(rules(`DROP FUNCTION IF EXISTS crove_social.g(), crove_social.f(int) CASCADE;\n${fn('crove_social.f')}\nREVOKE ALL ON FUNCTION crove_social.f() FROM PUBLIC;`, ['crove_social.f'])).toEqual([]);
    expect(rules(`${fn('crove_social.f')}\nDROP FUNCTION crove_social.f(int);`, ['crove_social.f'])).toEqual([]);
  });

  it('lists the functions a migration creates', () => {
    expect([...functionsCreated(`${GOOD}\nCREATE PROCEDURE crove_social.p() LANGUAGE sql AS $$ SELECT 1 $$;`)]).toEqual(['crove_social.sample_count', 'crove_social.p']);
  });
});

describe('migration lint: the schema of the module', () => {
  it('refuses touching another schema', () => {
    expect(rules('ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS x text;')).toEqual(['1 module-schema']);
    expect(rules('CREATE TABLE IF NOT EXISTS crove_kernel.t (id int);')).toEqual(['1 module-schema']);
    expect(rules('CREATE INDEX IF NOT EXISTS i ON crove_kernel.mail_message (org_id);')).toEqual(['1 module-schema']);
    expect(rules('DROP TRIGGER IF EXISTS t ON crove_finance.voucher;')).toEqual(['1 module-schema']);
    expect(rules('INSERT INTO crove_kernel.agent_template (key) VALUES (1);')).toEqual(['1 module-schema']);
    expect(rules('UPDATE crove_kernel.tenant SET x = 1;\nDELETE FROM crove_kernel.tenant;')).toEqual(['1 module-schema', '2 module-schema']);
    expect(rules('COMMENT ON COLUMN crove_kernel.tenant.x IS \'x\';')).toEqual(['1 module-schema']);
    expect(rules('GRANT SELECT ON crove_kernel.tenant TO crove_tenant;')).toEqual(['1 module-schema']);
    expect(rules('GRANT USAGE ON SCHEMA crove_kernel TO crove_tenant;')).toEqual(['1 module-schema']);
    expect(rules('CREATE SCHEMA IF NOT EXISTS crove_kernel;')).toEqual(['1 module-schema']);
    expect(rules('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;')).toEqual(['1 module-schema']);
    expect(rules('DO $$ BEGIN\n  ALTER TABLE crove_kernel.tenant ADD COLUMN x text;\nEXCEPTION WHEN duplicate_column THEN NULL;\nEND $$;')).toEqual(['2 module-schema']);
    expect(rules("DO $$ BEGIN\n  EXECUTE format('ALTER TABLE crove_kernel.%I ADD COLUMN x text', 'tenant');\nEND $$;")).toEqual(['2 module-schema']);
    const purge = 'CREATE OR REPLACE FUNCTION crove_kernel.org_purge(p_min_days integer) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE ALL ON FUNCTION crove_kernel.org_purge(integer) FROM PUBLIC;';
    expect(rules(purge)).toEqual(['1 module-schema', '2 module-schema']);
    // A rule's table follows TO, not ON (#1709): ON is followed by the event.
    const rule = lint('CREATE OR REPLACE RULE r AS ON INSERT TO crove_kernel.tenant DO INSTEAD NOTHING;');
    expect(rule.map((f) => `${f.line} ${f.rule}`)).toEqual(['1 module-schema']);
    expect(rule[0]!.message).toContain('touches schema crove_kernel');
    expect(rules('CREATE RULE r AS ON UPDATE TO crove_social.sample DO INSTEAD NOTHING;')).toEqual([]);
  });

  it('accepts a cross-module statement with a reasoned waiver on the line before it, and lists the waiver', () => {
    const sql = [
      'CREATE TABLE IF NOT EXISTS crove_social.t (id int);',
      '-- The org purge deletes crove_social.t too.',
      '-- migration-lint: cross-module Social adds its tables to org_purge in the feature migration (#1024)',
      'CREATE OR REPLACE FUNCTION crove_kernel.org_purge(p_min_days integer) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;',
      '-- migration-lint: cross-module   same function: its privileges',
      'REVOKE ALL ON FUNCTION crove_kernel.org_purge(integer) FROM PUBLIC, crove_tenant;',
      'DO $$ BEGIN',
      '  -- migration-lint: cross-module the digest marker is kept with the tenant',
      '  ALTER TABLE crove_kernel.tenant ADD COLUMN x text;',
      'EXCEPTION WHEN duplicate_column THEN NULL;',
      'END $$;',
    ].join('\n');
    const waivers: { file: string; line: number; schemas: string[]; reason: string }[] = [];
    expect(lintMigration(FILE, sql, { waivers })).toEqual([]);
    expect(waivers).toEqual([
      { file: FILE, line: 4, schemas: ['crove_kernel'], reason: 'Social adds its tables to org_purge in the feature migration (#1024)' },
      { file: FILE, line: 6, schemas: ['crove_kernel'], reason: 'same function: its privileges' },
      { file: FILE, line: 9, schemas: ['crove_kernel'], reason: 'the digest marker is kept with the tenant' },
    ]);
    expect(formatWaiver(waivers[0]!)).toBe(`::notice file=${FILE},line=4::${FILE}:4 cross-module waiver for crove_kernel: Social adds its tables to org_purge in the feature migration (#1024)`);
  });

  it('refuses a waiver without a reason, away from its statement, or for a schema no module owns', () => {
    const noReason = lint('-- migration-lint: cross-module\nALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS x text;');
    expect(noReason.map((f) => `${f.line} ${f.rule}`)).toEqual(['2 module-schema']);
    expect(noReason[0]!.message).toContain('the waiver on line 1 has no reason');
    expect(rules('-- migration-lint: cross-module   \nALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS x text;')).toEqual(['2 module-schema']);
    expect(rules('-- migration-lint: cross-module reason\n\nALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS x text;')).toEqual(['3 module-schema']);
    expect(rules('-- migration-lint: cross-module reason\nALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS x text;\nALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS y text;')).toEqual(['3 module-schema']);
    // Only the first statement after the waiver, even when more start on that line (review probe P6).
    expect(rules('-- migration-lint: cross-module reason\nALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS x text; ALTER TABLE crove_kernel.party ADD COLUMN IF NOT EXISTS y text;')).toEqual(['2 module-schema']);
    expect(rules('-- migration-lint: cross-module reason\nSELECT 1; ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS x text;')).toEqual(['2 module-schema']);
    expect(rules('-- migration-lint: cross-module reason\nCREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;')).toEqual(['2 module-schema']);
    expect(rules('-- migration-lint: cross-module reason\nCREATE TABLE IF NOT EXISTS t (id int);')).toEqual(['2 module-schema']);
    // A waiver before a DO does not reach into its body: it goes on the line before the statement inside.
    expect(rules('-- migration-lint: cross-module reason\nDO $$ BEGIN\n  ALTER TABLE crove_kernel.tenant ADD COLUMN x text;\nEND $$;')).toEqual(['3 module-schema']);
    // A waiver inside a string is not a comment.
    expect(rules("SELECT 'x\n-- migration-lint: cross-module reason';\nALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS x text;")).toEqual(['3 module-schema']);
  });

  it('refuses unqualified objects, which land wherever search_path points', () => {
    expect(rules('CREATE TABLE IF NOT EXISTS sample (id int);')).toEqual(['1 module-schema']);
    expect(rules('ALTER TABLE ONLY sample ADD COLUMN x int;')).toEqual(['1 module-schema']);
  });

  it('lets a migration read and call into other schemas', () => {
    expect(rules([
      'CREATE TABLE IF NOT EXISTS crove_social.t (org_id uuid REFERENCES crove_kernel.tenant (org_id), id uuid DEFAULT crove_kernel.uuid_v7());',
      "SELECT crove_kernel.apply_tenant_rls('crove_social.t');",
      "SELECT crove_jobs.create_queue('social-x', '{}'::jsonb);",
      'CREATE INDEX IF NOT EXISTS t_idx ON crove_social.t (org_id);',
      'DROP POLICY IF EXISTS p ON crove_social.t;',
      'CREATE POLICY p ON crove_social.t USING (org_id = (SELECT crove_kernel.ctx_org_id()));',
      'DROP TRIGGER IF EXISTS g ON crove_social.t;',
      'CREATE TRIGGER g BEFORE UPDATE ON crove_social.t FOR EACH ROW EXECUTE FUNCTION crove_kernel.touch();',
      'COMMENT ON TRIGGER g ON crove_social.t IS \'x\';',
      'REVOKE ALL ON crove_social.t FROM PUBLIC;',
      "DO $$ BEGIN EXECUTE format('ALTER TABLE crove_social.%I ADD COLUMN IF NOT EXISTS x int', 't'); EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS y int', 'crove_social.t'); END $$;",
    ].join('\n'))).toEqual([]);
  });

  it('refuses a file name that names no module', () => {
    expect(lintMigration('supabase/migrations/20261101000000_sample.sql', 'SELECT 1;').map((f: Finding) => f.rule)).toEqual(['module-schema']);
  });
});

describe('migration lint: the lexer', () => {
  it('reads strings and quoted identifiers as PostgreSQL decodes them (#1709 review)', () => {
    type Token = { t: string; v: string; body?: string; line: number };
    const values = (sql: string) => lex(sql).map((t: Token) => (t.t === 'string' ? `s:${t.body}` : `${t.t}:${t.v}`));
    expect(values(String.raw`E'a\'b''c\\d\n\101\x5f\u0041\U00000042\q'`)).toEqual(["s:a'b'c\\d\nA_ABq"]);
    expect(values(String.raw`U&'d\0061t\+000061' U&'x\\y''z' U&"a""b\005f"`)).toEqual(['s:data', "s:x\\y'z", 'qident:a"b_']);
    // UESCAPE after the literal, past comments, as any string form.
    expect(values(`U&"lock!005ftimeout" /* c */ UESCAPE '!' x`)).toEqual(['qident:lock_timeout', 'word:x']);
    expect(values(`U&'a!0062' -- c\n UESCAPE $q$!$q$`)).toEqual(['s:ab']);
    expect(values(`U&'a!0062' UESCAPE E'!'`)).toEqual(['s:ab']);
    // Pieces after whitespace that holds a newline are one literal; on one line they are two tokens.
    const joined = lex("SELECT 'a'\n  -- note\n  'b''c'\n  'd';\nSELECT E'e'\n'\\x66';");
    expect(joined.map((t: Token) => (t.t === 'string' ? `s:${t.body}` : t.v))).toEqual(['select', "s:ab'cd", ';', 'select', 's:ef', ';']);
    expect(joined[4]!.line).toBe(5);
    // Only a plain quote continues a literal: E'...' after a newline is a token of its own.
    expect(values("'a'\nE'b'")).toEqual(['s:a', 's:b']);
    expect(values("'a' 'b'")).toEqual(['s:a', 's:b']);
    expect(values(`$$a$$\n'b'`)).toEqual(['s:a', 's:b']);
  });

  it('ignores comments, strings, quoted identifiers and function bodies', () => {
    expect(rules([
      '/* BEGIN; TRUNCATE x; /* nested */ DROP SCHEMA y; */',
      "SELECT 'it''s; TRUNCATE x', E'\\'; COMMIT', \"TRUNCATE\" FROM crove_social.sample;",
      'CREATE OR REPLACE FUNCTION crove_social.f() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$',
      'BEGIN TRUNCATE crove_kernel.tenant; COMMIT; END $body$;',
      'REVOKE ALL ON FUNCTION crove_social.f() FROM PUBLIC;',
    ].join('\n'))).toEqual([]);
  });

  it('keeps a SQL-standard function body (BEGIN ATOMIC) in one statement', () => {
    expect(rules([
      'CREATE OR REPLACE FUNCTION crove_social.f() RETURNS int LANGUAGE sql SET search_path = pg_catalog, pg_temp',
      'BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END;',
      'REVOKE ALL ON FUNCTION crove_social.f() FROM PUBLIC;',
    ].join('\n'))).toEqual([]);
  });

  it('lints the code of a DO, not the string naming its language (review probe P1)', () => {
    const banned = ['no-truncate', 'no-public-grant', 'no-drop-schema', 'module-schema'];
    const probe = "DO LANGUAGE 'plpgsql' $$ BEGIN TRUNCATE crove_social.t; GRANT SELECT ON crove_social.t TO anon; DROP SCHEMA crove_kernel CASCADE; END $$;";
    expect(lint(probe).map((f) => f.rule).sort()).toEqual([...banned].sort());
    expect(lint("DO $$ BEGIN TRUNCATE crove_social.t; END $$ LANGUAGE plpgsql;").map((f) => f.rule)).toEqual(['no-truncate']);
    expect(lint('DO LANGUAGE plpgsql $$ BEGIN TRUNCATE crove_social.t; END $$;').map((f) => f.rule)).toEqual(['no-truncate']);
  });

  it('counts BEGIN ATOMIC only in a function or procedure (review probe P3)', () => {
    expect(rules('SELECT begin atomic FROM (SELECT 1 AS begin) s;\nTRUNCATE crove_social.t;\nGRANT SELECT ON crove_social.t TO anon;')).toEqual(['2 no-truncate', '3 no-public-grant']);
    expect(rules('CREATE PROCEDURE crove_social.p() LANGUAGE sql BEGIN ATOMIC SELECT 1; END;\nREVOKE ALL ON PROCEDURE crove_social.p() FROM PUBLIC;\nTRUNCATE crove_social.t;')).toEqual(['3 no-truncate']);
  });

  it('counts lines inside DO bodies from the start of the file', () => {
    expect(rules('SELECT 1;\nDO\n$$\nBEGIN\n  -- x\n  TRUNCATE crove_social.sample;\nEND\n$$;')).toEqual(['6 no-truncate']);
  });
});

describe('migration lint: the allowlist', () => {
  const allowlist = parseAllowlist(readFileSync(`${ROOT}tools/ci/migration-lint-allowlist.txt`, 'utf8'));
  const onDisk = new Set(readdirSync(`${ROOT}supabase/migrations`));

  it('lists only migration files that exist, so a typo cannot exempt a new file', () => {
    expect([...allowlist].filter((name) => !onDisk.has(name))).toEqual([]);
    expect([...allowlist].every((name) => moduleOf(name) !== undefined)).toBe(true);
  });

  it('skips allowlisted files and lints the selected ones in version order', () => {
    const all = ['20261102000000_crove_social_b.sql', '20261101000000_crove_social_a.sql', 'README.md', '20261103000000_crove_kernel_c.sql'];
    const list = new Set(['20261101000000_crove_social_a.sql']);
    expect(plan(all, undefined, list)).toEqual(['20261102000000_crove_social_b.sql', '20261103000000_crove_kernel_c.sql']);
    expect(plan(all, ['20261103000000_crove_kernel_c.sql', '20261101000000_crove_social_a.sql'], list)).toEqual(['20261103000000_crove_kernel_c.sql']);
    expect(parseAllowlist('# comment\n\na.sql  # why\nb.sql\n')).toEqual(new Set(['a.sql', 'b.sql']));
  });

  it('lints the files a PR adds and refuses changing or deleting one already on the base (review probe P4)', () => {
    const { added, edited } = changedMigrations([
      'A\tsupabase/migrations/20261103000000_crove_social_c.sql',
      'M\tsupabase/migrations/20261013120000_crove_kernel_bootstrap.sql',
      'D\tsupabase/migrations/20261014090000_crove_kernel_definer_tenant.sql',
      'A\tsupabase/migrations/README.md',
      '',
    ].join('\n'));
    expect(added).toEqual(['20261103000000_crove_social_c.sql']);
    expect(edited.map((f: Finding) => `${f.file} ${f.rule}`)).toEqual([
      'supabase/migrations/20261013120000_crove_kernel_bootstrap.sql no-edit-applied',
      'supabase/migrations/20261014090000_crove_kernel_definer_tenant.sql no-edit-applied',
    ]);
    expect(edited[0]!.message).toContain('never edit or delete an applied migration');
  });
});

// #1225: the three blind spots that could change what a migration does to another module or how the file is read.
describe('migration lint: writes in a CTE, ownership, string mode (#1225)', () => {
  it('reads the writes of a WITH as the writes they are', () => {
    // A data-modifying CTE, and the statement after the CTE list, in another module's schema.
    expect(rules('WITH d AS (DELETE FROM crove_kernel.tenant RETURNING 1) SELECT count(*) FROM d;')).toEqual(['1 module-schema']);
    expect(rules('WITH u AS (UPDATE crove_kernel.tenant SET x = 1 RETURNING org_id),\n  i AS (INSERT INTO crove_finance.voucher (id) SELECT org_id FROM u RETURNING id)\nSELECT 1;')).toEqual([
      '1 module-schema',
      '2 module-schema',
    ]);
    expect(rules('WITH v AS (SELECT 1 AS n)\nINSERT INTO crove_kernel.number_series (n) SELECT n FROM v;')).toEqual(['2 module-schema']);
    expect(rules('WITH RECURSIVE v AS (SELECT 1)\nMERGE INTO crove_kernel.tenant t USING v ON true WHEN MATCHED THEN DO NOTHING;')).toEqual(['2 module-schema']);
    expect(rules('DO $$ BEGIN\n  WITH d AS (DELETE FROM crove_kernel.tenant RETURNING 1) SELECT 1 INTO STRICT n;\nEND $$;')).toEqual(['2 module-schema']);
    // Its own schema, a read, a row lock and an upsert's DO UPDATE are not writes elsewhere.
    expect(rules('WITH d AS (DELETE FROM crove_social.sample RETURNING id) INSERT INTO crove_social.sample_log (id) SELECT id FROM d;')).toEqual([]);
    expect(rules('WITH v AS (SELECT org_id FROM crove_kernel.tenant FOR UPDATE) SELECT * FROM v;')).toEqual([]);
    expect(rules('WITH v AS (SELECT 1 AS id) INSERT INTO crove_social.sample (id) SELECT id FROM v ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id;')).toEqual([]);
    // The same waiver as a top-level write covers it.
    const waived = '-- migration-lint: cross-module the numbers are recorded in the kernel series\nWITH v AS (SELECT 1 AS n)\nINSERT INTO crove_kernel.number_series (n) SELECT n FROM v;';
    const waivers: { file: string; line: number; schemas: string[]; reason: string }[] = [];
    expect(lintMigration(FILE, waived, { waivers })).toEqual([]);
    expect(waivers.map((w) => w.schemas)).toEqual([['crove_kernel']]);
  });

  it('hands ownership only to the roles definer functions run as', () => {
    for (const role of ['crove_definer_tenant', 'crove_auth_reader', 'CURRENT_USER']) {
      expect(rules(`ALTER FUNCTION crove_social.f(int) OWNER TO ${role};`), role).toEqual([]);
    }
    for (const sql of [
      'ALTER TABLE crove_social.sample OWNER TO crove_app;',
      'ALTER FUNCTION crove_social.f(int) OWNER TO "crove_worker";',
      'ALTER SEQUENCE crove_social.s OWNER TO crove_tenant;',
      'REASSIGN OWNED BY crove_definer_tenant TO crove_app;',
      'CREATE SCHEMA IF NOT EXISTS crove_social AUTHORIZATION crove_app;',
      "DO $$ BEGIN\n  EXECUTE 'ALTER TABLE crove_social.sample OWNER TO crove_app';\nEND $$;",
    ]) {
      expect(rules(sql).filter((r) => r.endsWith('owner-to')), sql).toHaveLength(1);
    }
    expect(lint('ALTER TABLE crove_social.sample OWNER TO crove_app;')[0]?.message).toContain('login roles own nothing');
    // A column, constraint or value named owner is renamed, not handed over.
    expect(rules('ALTER TABLE crove_social.sample RENAME COLUMN owner TO owner_id;')).toEqual([]);
    expect(rules('ALTER TABLE crove_social.sample RENAME owner TO owner_id;')).toEqual([]);
    expect(rules('ALTER TABLE crove_social.sample RENAME CONSTRAINT owner TO owner_key;')).toEqual([]);
  });

  it('refuses a change of standard_conforming_strings in any form', () => {
    for (const sql of [
      'SET standard_conforming_strings = off;',
      'SET LOCAL standard_conforming_strings TO off;',
      'RESET standard_conforming_strings;',
      "SELECT set_config('standard_conforming_strings', 'off', true);",
      "DO $$ BEGIN\n  PERFORM pg_catalog.set_config('Standard_Conforming_Strings', 'off', true);\nEND $$;",
      'ALTER FUNCTION crove_social.f(int) SET standard_conforming_strings = off;',
    ]) {
      expect(rules(sql).some((r) => r.endsWith('string-mode')), sql).toBe(true);
    }
    expect(rules("SELECT set_config('lock_timeout', '2s', true);")).toEqual([]);
  });
});
