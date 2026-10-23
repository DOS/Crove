import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { format, functionsCreated, lintMigration, moduleOf, parseAllowlist, plan } from '../ci/migration-lint.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FILE = 'supabase/migrations/20261101000000_crove_social_sample.sql';

type Finding = { file: string; line: number; rule: string; message: string };
const lint = (sql: string, existing: string[] = []): Finding[] =>
  lintMigration(FILE, sql, { existingFunctions: new Set(existing) });
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
});
