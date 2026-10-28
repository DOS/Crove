// contract-header (#1693, plan §3.5 and §5.5): every contract change in a new migration carries
// `-- crove:contract adr=<id>` on the comment lines right before it.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adrNumbers, BREAKING_RULES_AFTER, breakingRulesApply, lintMigration } from '../ci/migration-lint.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FILE = 'supabase/migrations/20261201000000_crove_social_sample.sql';
const ADRS = new Set(['0028', '0031']);

type Finding = { file: string; line: number; rule: string; message: string };
const lint = (sql: string, options: { existing?: string[]; adrs?: Set<string>; breakingRules?: boolean } = {}): Finding[] =>
  lintMigration(FILE, sql, { existingFunctions: new Set(options.existing ?? []), adrs: options.adrs ?? ADRS, breakingRules: options.breakingRules ?? true })
    .filter((f: Finding) => f.rule === 'contract-header');
const rules = (sql: string, options?: Parameters<typeof lint>[1]) => lint(sql, options).map((f) => f.line);

// Contract changes, each with its header: the good samples.
const GOOD = `-- Crove Social: removes the old note column (ADR-0028 records the change).
-- crove:contract adr=0028
ALTER TABLE crove_social.sample DROP COLUMN IF EXISTS note;
-- crove:contract adr=28 the short form names the same ADR
ALTER TABLE crove_social.sample RENAME COLUMN body TO text;
-- crove:contract adr=0031
-- migration-lint: cross-module the header and a waiver share the comment lines above the statement
ALTER TABLE crove_social.sample ALTER COLUMN score TYPE numeric;
-- crove:contract adr=0028
DROP FUNCTION IF EXISTS crove_social.old_count(uuid);
-- crove:contract adr=0028
DROP VIEW IF EXISTS crove_social.sample_v;
-- crove:contract adr=0028
ALTER TYPE crove_social.kind RENAME VALUE 'a' TO 'b';
DO $$
BEGIN
  -- crove:contract adr=0028
  ALTER TABLE crove_social.sample DROP COLUMN legacy;
  -- crove:contract adr=0028
  EXECUTE format('ALTER TABLE crove_social.%I ALTER COLUMN x SET DATA TYPE text', 'sample');
EXCEPTION WHEN undefined_column THEN NULL;
END $$;
`;

describe('migration lint: contract-header', () => {
  it('accepts every contract change with a header right before it', () => {
    expect(lint(GOOD)).toEqual([]);
  });

  it('refuses each contract change without a header', () => {
    const bad = GOOD.split('\n').filter((line) => !line.includes('crove:contract')).join('\n');
    expect(rules(bad)).toEqual([2, 3, 5, 6, 7, 8, 11, 12]);
    expect(lint('DROP TABLE crove_social.sample;')[0]!.message).toContain('DROP TABLE is a contract change: put `-- crove:contract adr=<id>`');
  });

  it('knows each kind of contract change', () => {
    for (const sql of [
      'DROP TABLE IF EXISTS crove_social.a, crove_social.b CASCADE;',
      'DROP MATERIALIZED VIEW crove_social.mv;',
      'DROP SEQUENCE crove_social.s;',
      'DROP TYPE crove_social.t;',
      'DROP DOMAIN crove_social.d;',
      'DROP PROCEDURE crove_social.p();',
      'DROP EXTENSION IF EXISTS crove_x;',
      'DROP ROLE IF EXISTS crove_old;',
      'ALTER TABLE crove_social.sample RENAME TO sample2;',
      'ALTER TABLE ONLY crove_social.sample DROP note;',
      'ALTER TABLE crove_social.sample ADD COLUMN y int, DROP COLUMN x;',
      'ALTER TABLE crove_social.sample ALTER x TYPE text USING x::text;',
      'ALTER TABLE crove_social.sample SET SCHEMA crove_kernel;',
      'ALTER FUNCTION crove_social.f(int) RENAME TO g;',
      'ALTER VIEW crove_social.v RENAME COLUMN a TO b;',
      'ALTER TYPE crove_social.t DROP ATTRIBUTE a;',
      'ALTER TYPE crove_social.t ALTER ATTRIBUTE a SET DATA TYPE text;',
      "DO $$ BEGIN EXECUTE 'ALTER TABLE crove_social.sample DROP COLUMN x'; END $$;",
      "DO $$ BEGIN EXECUTE format('DROP TABLE IF EXISTS crove_social.%I', 'x'); END $$;",
      // #1709: every DROP but the schema's internals, and RENAME or SET SCHEMA wherever an ALTER of another kind puts it.
      'DROP OWNED BY crove_old CASCADE;',
      'DROP COLLATION IF EXISTS crove_social.c;',
      'DROP CAST IF EXISTS (text AS crove_social.t);',
      'DROP CONVERSION crove_social.c;',
      'DROP TEXT SEARCH CONFIGURATION crove_social.ts;',
      'DROP OPERATOR CLASS crove_social.oc USING btree;',
      'DROP OPERATOR FAMILY crove_social.of USING btree;',
      'DROP OPERATOR crove_social.=== (int, int);',
      'DROP SERVER IF EXISTS crove_s;',
      'DROP FOREIGN DATA WRAPPER crove_w;',
      'DROP USER MAPPING FOR crove_x SERVER crove_s;',
      'DROP PUBLICATION crove_p;',
      'DROP SUBSCRIPTION crove_s;',
      'DROP LANGUAGE plx;',
      'DROP TRANSFORM FOR int LANGUAGE plx;',
      'DROP ACCESS METHOD crove_am;',
      'DROP USER crove_u;',
      'DROP GROUP crove_g;',
      'DROP TABLESPACE crove_t;',
      'DROP DATABASE crove_d;',
      'ALTER COLLATION crove_social.c RENAME TO d;',
      'ALTER OPERATOR CLASS crove_social.oc USING btree RENAME TO oc2;',
      'ALTER OPERATOR crove_social.=== (int, int) SET SCHEMA crove_kernel;',
      'ALTER CONVERSION crove_social.c SET SCHEMA crove_kernel;',
      'ALTER SEQUENCE IF EXISTS crove_social.s RENAME TO s2;',
      'ALTER ROLE crove_old RENAME TO crove_new;',
      'ALTER TEXT SEARCH DICTIONARY crove_social.d RENAME TO d2;',
      // Escapes are decoded before the command is read (#1709 review).
      String.raw`DO $$ BEGIN EXECUTE E'\x44ROP TABLE crove_social.sample'; END $$;`,
      String.raw`DO $$ BEGIN EXECUTE U&'DROP \0054ABLE crove_social.sample'; END $$;`,
    ]) {
      expect(rules(sql), sql).toEqual([1]);
      expect(rules(`-- crove:contract adr=0028\n${sql}`), sql).toEqual([]);
    }
  });

  it('leaves alone what is not a contract change', () => {
    expect(rules([
      'DROP POLICY IF EXISTS p ON crove_social.sample;',
      'DROP TRIGGER IF EXISTS t ON crove_social.sample;',
      'DROP INDEX IF EXISTS crove_social.sample_idx;',
      'DROP RULE IF EXISTS r ON crove_social.sample;',
      'ALTER TABLE crove_social.sample DROP CONSTRAINT IF EXISTS c;',
      'ALTER TABLE crove_social.sample ALTER COLUMN x DROP DEFAULT, ALTER COLUMN y DROP NOT NULL, ALTER COLUMN z DROP EXPRESSION;',
      'ALTER TABLE crove_social.sample ALTER COLUMN type SET DEFAULT 1;',
      'ALTER TABLE crove_social.sample RENAME CONSTRAINT a TO b;',
      'ALTER INDEX crove_social.a RENAME TO b;',
      'ALTER TRIGGER a ON crove_social.sample RENAME TO b;',
      'ALTER POLICY a ON crove_social.sample RENAME TO b;',
      'ALTER TABLE crove_social.sample ADD COLUMN IF NOT EXISTS type text;',
      // Columns named like actions (review probe).
      'ALTER TABLE crove_social.sample ADD COLUMN IF NOT EXISTS rename text, ADD COLUMN drop int;',
      'ALTER DOMAIN crove_social.d DROP CONSTRAINT c;',
      "COMMENT ON TABLE crove_social.sample IS 'DROP TABLE x; ALTER TABLE y RENAME TO z';",
      "CREATE OR REPLACE FUNCTION crove_social.f() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$ BEGIN DROP TABLE crove_social.x; END $f$;",
      'REVOKE ALL ON FUNCTION crove_social.f() FROM PUBLIC;',
      'DROP STATISTICS IF EXISTS crove_social.s;',
      'DROP EVENT TRIGGER IF EXISTS crove_social_watch;',
      'ALTER DOMAIN crove_social.d RENAME CONSTRAINT a TO b;',
      'ALTER SEQUENCE crove_social.s RESTART WITH 1;',
      'ALTER FUNCTION crove_social.f(rename int) SET search_path = pg_catalog, pg_temp;',
      'ALTER STATISTICS crove_social.s RENAME TO s2;',
    ].join('\n'))).toEqual([]);
  });

  it('lets a file drop a helper it created, but not an existing object', () => {
    const helper = 'CREATE FUNCTION crove_social.backfill() RETURNS void LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;\nSELECT crove_social.backfill();\nDROP FUNCTION crove_social.backfill();';
    expect(rules(helper)).toEqual([]);
    // The same name an earlier migration created: CREATE OR REPLACE then DROP removes what callers use.
    expect(rules(helper.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'), { existing: ['crove_social.backfill'] })).toEqual([3]);
    // Dropped before it is created: the drop removes the old one (a signature change).
    expect(rules('DROP FUNCTION IF EXISTS crove_social.f(int);\nCREATE FUNCTION crove_social.f(text) RETURNS void LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;', { existing: ['crove_social.f'] })).toEqual([1]);
    expect(rules('CREATE TABLE crove_social.stage (id int);\nDROP TABLE crove_social.stage;')).toEqual([]);
    // IF NOT EXISTS may have found an existing table, so dropping it is a contract change.
    expect(rules('CREATE TABLE IF NOT EXISTS crove_social.stage (id int);\nDROP TABLE crove_social.stage;')).toEqual([2]);
    expect(rules('CREATE TABLE crove_social.stage (id int);\nDROP TABLE crove_social.stage, crove_social.sample;')).toEqual([2]);
    // Only a top-level CREATE surely ran: in a DO it may be skipped or its error swallowed (review probes).
    expect(rules("DO $$ BEGIN CREATE TYPE crove_social.s AS ENUM ('a'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;\nDROP TYPE crove_social.s;")).toEqual([2]);
    expect(rules('DO $$ BEGIN IF false THEN CREATE TABLE crove_social.t (id int); END IF; END $$;\nDROP TABLE crove_social.t CASCADE;')).toEqual([2]);
    // The helper must be of the kind dropped.
    expect(rules('CREATE TYPE crove_social.t AS (a int);\nDROP TABLE crove_social.t;')).toEqual([2]);
  });

  it('matches a dropped helper routine by its arguments, not its name alone (#1709)', () => {
    const create = (args: string) => `CREATE FUNCTION crove_social.h(${args}) RETURNS void LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;`;
    const drop = (args: string, header = '') => rules(`${create('p_org uuid, p_n int DEFAULT 1, OUT done boolean')}\n${header}DROP FUNCTION crove_social.h${args};`);
    // The one this file created, however its arguments are written.
    for (const args of ['(uuid, int)', '(p_org uuid, p_n int)', '(IN uuid, integer)', '(uuid, int4, OUT boolean)', '(pg_catalog.uuid, int)', '']) expect(drop(args), args).toEqual([]);
    // Another overload of the same name: an existing routine as far as the lint knows (one made in a DO, say).
    for (const args of ['(text, int)', '(uuid)', '(uuid, int, int)', '(uuid, bigint)', '()', '(p_n int, p_org uuid)']) {
      expect(drop(args), args).toEqual([2]);
      expect(drop(args, '-- crove:contract adr=0028\n'), args).toEqual([]);
    }
    // Each overload the file created counts, and a list of several drops needs every one to be a helper.
    expect(rules(`${create('int')}\n${create('text')}\nDROP FUNCTION crove_social.h(text), crove_social.h(integer);`)).toEqual([]);
    expect(rules(`${create('int')}\nDROP FUNCTION crove_social.h(int), crove_social.h(text);`)).toEqual([2]);
    expect(rules(`${create('VARIADIC a int[]')}\nDROP FUNCTION crove_social.h(VARIADIC integer[]);`)).toEqual([]);
    expect(rules(`${create('ts timestamptz, x double precision')}\nDROP FUNCTION crove_social.h(timestamp with time zone, float8);`)).toEqual([]);
    // Type modifiers are not part of a signature (review probe).
    expect(rules(`${create('a numeric(10,2), b varchar(5)')}\nDROP FUNCTION crove_social.h(numeric, character varying(9));`)).toEqual([]);
  });

  it('needs the header on the comment lines right before the statement, one statement per header', () => {
    expect(rules('-- crove:contract adr=0028\n\nDROP TABLE crove_social.sample;')).toEqual([3]);
    expect(rules('-- crove:contract adr=0028\nSELECT 1;\nDROP TABLE crove_social.sample;')).toEqual([3]);
    expect(rules('-- crove:contract adr=0028\nDROP TABLE crove_social.a;\nDROP TABLE crove_social.b;')).toEqual([3]);
    expect(rules('-- crove:contract adr=0028\nDROP TABLE crove_social.a; DROP TABLE crove_social.b;')).toEqual([2]);
    expect(rules('-- crove:contract adr=0028\n-- crove:contract adr=0031\nDROP TABLE crove_social.a; DROP TABLE crove_social.b;')).toEqual([]);
    // A header after code on its line, inside a string or in a block comment is not a header.
    expect(rules('SELECT 1; -- crove:contract adr=0028\nDROP TABLE crove_social.sample;')).toEqual([2]);
    expect(rules("SELECT '\n-- crove:contract adr=0028';\nDROP TABLE crove_social.sample;")).toEqual([3]);
    expect(rules('/* crove:contract adr=0028 */\nDROP TABLE crove_social.sample;')).toEqual([2]);
    expect(rules('DO $$ -- crove:contract adr=0028\nBEGIN DROP TABLE crove_social.sample; END $$;')).toEqual([2]);
    expect(rules('-- crove:contractor adr=0028\nDROP TABLE crove_social.sample;')).toEqual([2]);
    // A header before a DO does not reach into its body.
    expect(rules('-- crove:contract adr=0028\nDO $$ BEGIN\n  DROP TABLE crove_social.sample;\nEND $$;')).toEqual([3]);
  });

  it('needs a number of an ADR in docs/adr', () => {
    const at = (sql: string) => lint(sql).map((f) => `${f.line} ${f.message}`);
    expect(at('-- crove:contract\nDROP TABLE crove_social.sample;')).toEqual(['1 the contract header needs adr=<number> (the ADR that records the change), got ""']);
    expect(at('-- crove:contract adr=ADR-28\nDROP TABLE crove_social.sample;')).toEqual(['1 the contract header needs adr=<number> (the ADR that records the change), got "ADR-28"']);
    expect(at('-- crove:contract adr=0099\nDROP TABLE crove_social.sample;')).toEqual(['1 the contract header names ADR 0099, which is not in docs/adr']);
    expect(adrNumbers(['0028-identity.md', '0021', 'README.md', '0031-module-enablement.md'])).toEqual(new Set(['0028', '0031']));
    expect(adrNumbers(readdirSync(`${ROOT}docs/adr`)).has('0028')).toBe(true);
  });

  it('skips the files on main before the rule, unless a PR adds them', () => {
    expect(lint('DROP TABLE crove_social.sample;', { breakingRules: false })).toEqual([]);
    // Pinned: the newest migration on main when the rules landed. Raising it would exempt later files from the
    // full-tree run, so a change here needs a reason in review.
    expect(BREAKING_RULES_AFTER).toBe('20261103090000');
    expect(breakingRulesApply(`20261103090000_crove_finance_stream_legal_entity.sql`, false)).toBe(false);
    expect(breakingRulesApply(`supabase/migrations/${BREAKING_RULES_AFTER}_crove_kernel_x.sql`, false)).toBe(false);
    expect(breakingRulesApply('20261103090001_crove_kernel_x.sql', false)).toBe(true);
    expect(breakingRulesApply('20261013120000_crove_kernel_bootstrap.sql', true)).toBe(true);
  });
});
