// The CHECK-constraint unions of src/schema.ts against the database (issue #266). On a freshly migrated database it
// reads every CHECK constraint that restricts one column of a table crove_tenant may read to a fixed set of values
// (`col IN (...)`, which PostgreSQL stores as `col = ANY (ARRAY[...])`, or `col = '...'`) and compares the values with
// the const array schema.ts refines that column to; a set in a form it cannot read (an OR chain) fails the test
// instead of being skipped. A migration that widens or narrows such a constraint, or adds one, fails here until
// schema.ts follows. The type of UNIONS ties each array to the column's refined Kysely type, so `pnpm typecheck`
// fails when an array and the refinement drift apart.
//
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the test creates and drops its own database.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { SelectType } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.ts';
import {
  ACTOR_TYPES,
  AGENT_RISKS,
  AGENT_RUNTIMES,
  AGENT_SCOPES,
  AGENT_STATUSES,
  AGENT_WAKEUP_STATUSES,
  AI_RUN_STATUSES,
  AUDIT_OUTCOMES,
  CHANNEL_CONNECTION_STATUSES,
  DOCUMENT_DIRECTIONS,
  EXTERNAL_CALL_ERROR_KINDS,
  EXTERNAL_CALL_RETRY_SAFETIES,
  EXTERNAL_CALL_STATES,
  MAIL_STATUSES,
  MAIL_STREAMS,
  MAIL_EVENT_KINDS,
  MAIL_SUPPRESSION_REASONS,
  MAIL_SUPPRESSION_SCOPES,
  SOCIAL_ACTOR_ORIGINS,
  SOCIAL_DECISIONS,
  SOCIAL_REVIEW_VERDICTS,
  SOCIAL_ERROR_KINDS,
  SOCIAL_ORIGINS,
  SOCIAL_POST_STATUSES,
  SOCIAL_VARIANT_STATUSES,
  EXTRACTION_METHODS,
  EXTRACTION_STATUSES,
  FILE_SOURCES,
  INVITE_ROLES,
  INVITE_STATUSES,
  MEMBER_ROLES,
  PARTY_KINDS,
  PARTY_SOURCE_TRUSTS,
  PORTAL_INVOICE_STATUSES,
  PORTAL_LIST_STATUSES,
  POSITION_STATUSES,
  PROPOSAL_STATUSES,
  TASK_KINDS,
  TASK_SOURCES,
  TASK_STATUSES,
  TENANT_STATUSES,
  VOUCHER_TYPES,
  VAT_FILING_PERIODS,
  type Database,
} from '../src/schema.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SCHEMAS = ['crove_kernel', 'crove_finance', 'crove_social'];
const suite = ADMIN ? describe : describe.skip;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// The values a column of the refined Database holds, null aside: 'crove_kernel.task.status' -> TaskStatus.
type ColumnValues<K> = K extends `${infer S}.${infer T}.${infer C}`
  ? `${S}.${T}` extends keyof Database
    ? C extends keyof Database[`${S}.${T}`]
      ? NonNullable<SelectType<Database[`${S}.${T}`][C]>>
      : never
    : never
  : never;
type Unions<M> = {
  [K in keyof M]: M[K] extends readonly (infer E)[]
    ? Equal<E, ColumnValues<K>> extends true
      ? M[K]
      : 'the array does not match the type schema.ts refines this column to'
    : 'not a const array';
};
const unions = <const M extends Unions<M> & Readonly<Record<string, readonly string[]>>>(map: M): Readonly<Record<string, readonly string[]>> =>
  map;

// schema.table.column -> the const array of schema.ts the column is refined to.
const UNIONS = unions({
  'crove_kernel.agent.max_risk': AGENT_RISKS,
  'crove_kernel.agent.runtime': AGENT_RUNTIMES,
  'crove_kernel.agent.status': AGENT_STATUSES,
  'crove_kernel.agent_template.max_risk': AGENT_RISKS,
  'crove_kernel.agent_wakeup.status': AGENT_WAKEUP_STATUSES,
  'crove_kernel.ai_run.status': AI_RUN_STATUSES,
  'crove_kernel.audit_event.actor_type': ACTOR_TYPES,
  'crove_kernel.audit_event.outcome': AUDIT_OUTCOMES,
  'crove_kernel.budget_policy.scope': AGENT_SCOPES,
  'crove_kernel.channel_connection.status': CHANNEL_CONNECTION_STATUSES,
  'crove_kernel.external_call.state': EXTERNAL_CALL_STATES,
  'crove_kernel.external_call.retry_safety': EXTERNAL_CALL_RETRY_SAFETIES,
  'crove_kernel.external_call.error_kind': EXTERNAL_CALL_ERROR_KINDS,
  'crove_kernel.mail_message.status': MAIL_STATUSES,
  'crove_kernel.mail_message.stream': MAIL_STREAMS,
  'crove_kernel.mail_event.kind': MAIL_EVENT_KINDS,
  'crove_kernel.mail_suppression.reason': MAIL_SUPPRESSION_REASONS,
  'crove_kernel.mail_suppression.scope': MAIL_SUPPRESSION_SCOPES,
  'crove_kernel.extraction.method': EXTRACTION_METHODS,
  'crove_kernel.extraction.status': EXTRACTION_STATUSES,
  'crove_kernel.file.source': FILE_SOURCES,
  'crove_kernel.kill_switch.scope': AGENT_SCOPES,
  'crove_kernel.member_invite.role': INVITE_ROLES,
  'crove_kernel.member_invite.status': INVITE_STATUSES,
  'crove_kernel.party.kind': PARTY_KINDS,
  'crove_kernel.party.source_trust': PARTY_SOURCE_TRUSTS,
  'crove_kernel.position.status': POSITION_STATUSES,
  'crove_kernel.proposal.status': PROPOSAL_STATUSES,
  'crove_kernel.task.created_by_type': ACTOR_TYPES,
  'crove_kernel.task.kind': TASK_KINDS,
  'crove_kernel.task.source': TASK_SOURCES,
  'crove_kernel.task.status': TASK_STATUSES,
  'crove_kernel.task_comment.author_type': ACTOR_TYPES,
  'crove_kernel.tenant.status': TENANT_STATUSES,
  'crove_kernel.tenant.vat_filing_period': VAT_FILING_PERIODS,
  'crove_kernel.tenant_member.role': MEMBER_ROLES,
  'crove_finance.purchase_document.direction': DOCUMENT_DIRECTIONS,
  'crove_finance.cash_voucher.voucher_type': VOUCHER_TYPES,
  'crove_finance.portal_invoice_list.status': PORTAL_LIST_STATUSES,
  'crove_finance.portal_invoice_row.status': PORTAL_INVOICE_STATUSES,
  'crove_social.post.actor_origin': SOCIAL_ACTOR_ORIGINS,
  'crove_social.post.origin': SOCIAL_ORIGINS,
  'crove_social.post.status': SOCIAL_POST_STATUSES,
  'crove_social.post_approval.actor_origin': SOCIAL_ACTOR_ORIGINS,
  'crove_social.post_approval.decision': SOCIAL_DECISIONS,
  'crove_social.review_feedback.verdict': SOCIAL_REVIEW_VERDICTS,
  'crove_social.post_variant.error_kind': SOCIAL_ERROR_KINDS,
  'crove_social.post_variant.status': SOCIAL_VARIANT_STATUSES,
});

interface Constraint {
  table: string;
  column: string;
  name: string;
  definition: string;
}

const LITERAL = /'((?:[^']|'')*)'::text/g;
const literals = (list: string): string[] | null => {
  const values = [...list.matchAll(LITERAL)].map((m) => (m[1] as string).replaceAll("''", "'"));
  // The list must be nothing but those literals, so a cast or an expression in it is not silently dropped.
  return list === values.map((v) => `'${v.replaceAll("'", "''")}'::text`).join(', ') ? values : null;
};

// The fixed set a single-column CHECK restricts its column to, or null when it is not of that form. Returns
// 'unreadable' for one that looks like a set (= ANY, IN) but has a shape this parser does not know, so the test fails
// instead of skipping it.
function allowedValues(column: string, definition: string): string[] | null | 'unreadable' {
  const col = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shapes = [
    new RegExp(`^CHECK \\(\\(${col} = ANY \\(ARRAY\\[(.*)\\]\\)\\)\\)$`),
    new RegExp(`^CHECK \\(\\(\\(${col} IS NULL\\) OR \\(${col} = ANY \\(ARRAY\\[(.*)\\]\\)\\)\\)\\)$`),
    new RegExp(`^CHECK \\(\\(${col} = ('(?:[^']|'')*'::text)\\)\\)$`),
  ];
  for (const shape of shapes) {
    const list = shape.exec(definition)?.[1];
    if (list !== undefined) return literals(list) ?? 'unreadable';
  }
  // A set written another way (an OR chain of equalities, IN) still compares the column with a literal.
  // The column itself (`s = '`, `(s)::text = '`), not a function of it (`jsonb_typeof(s) = '`).
  const literalCompare = new RegExp(`(?<!\\w)(?:${col}|\\(${col}\\)::[\\w ]+) = '`);
  return /= ANY \(|\bIN \(/.test(definition) || literalCompare.test(definition) ? 'unreadable' : null;
}

suite('CHECK-constraint unions of schema.ts against the database', () => {
  const dbName = `crove_test_check_unions_${Date.now()}_${randomBytes(4).toString('hex')}`;
  let admin: pg.Client;
  let created = false;
  let constraints: Constraint[] = [];

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    await migrate({ adminUrl: url.toString(), dir: MIGRATIONS });
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      // Single-column CHECK constraints of the tables in the generated Database (those crove_tenant may read).
      const { rows } = await client.query<Constraint>(
        `SELECT n.nspname || '.' || c.relname AS table, a.attname AS column, con.conname AS name,
                pg_catalog.pg_get_constraintdef(con.oid) AS definition
           FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
          WHERE con.contype = 'c' AND pg_catalog.cardinality(con.conkey) = 1 AND n.nspname = ANY($1)
            AND pg_catalog.has_table_privilege('crove_tenant', c.oid, 'SELECT')
          ORDER BY 1, 2, 3`,
        [SCHEMAS],
      );
      constraints = rows;
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('reads the fixed sets the migrations declare', () => {
    // A guard against a query or parser that finds nothing and so compares nothing.
    const sets = constraints.filter((c) => Array.isArray(allowedValues(c.column, c.definition)));
    expect(sets.length).toBeGreaterThanOrEqual(Object.keys(UNIONS).length);
  });

  it('every fixed set matches the union schema.ts refines its column to', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const c of constraints) {
      const values = allowedValues(c.column, c.definition);
      if (values === null) continue;
      const key = `${c.table}.${c.column}`;
      if (values === 'unreadable') {
        problems.push(`${key}: cannot read the allowed values of ${c.name} (${c.definition}); teach allowedValues() its shape`);
        continue;
      }
      seen.add(key);
      const union = UNIONS[key];
      if (!union) {
        problems.push(
          `${key}: ${c.name} allows [${values.join(', ')}] but schema.ts refines no union for the column ` +
            '(add a const array, refine the column with it and list it in UNIONS)',
        );
        continue;
      }
      const db = [...values].sort();
      const ts = [...union].sort();
      if (db.join('\u0000') !== ts.join('\u0000')) {
        problems.push(`${key}: the database (${c.name}) allows [${db.join(', ')}], schema.ts has [${ts.join(', ')}]`);
      }
    }
    for (const key of Object.keys(UNIONS)) {
      if (!seen.has(key)) problems.push(`${key}: listed in UNIONS but the database has no CHECK constraint with a fixed set on it`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('allowedValues', () => {
  it('reads the shapes PostgreSQL stores and refuses the ones it does not know', () => {
    expect(allowedValues('status', "CHECK ((status = ANY (ARRAY['a'::text, 'b''c'::text])))")).toEqual(['a', "b'c"]);
    expect(allowedValues('method', "CHECK (((method IS NULL) OR (method = ANY (ARRAY['x'::text]))))")).toEqual(['x']);
    expect(allowedValues('kind', "CHECK ((kind = 'only'::text))")).toEqual(['only']);
    expect(allowedValues('line_no', 'CHECK ((line_no > 0))')).toBeNull();
    expect(allowedValues('s', "CHECK (((s)::text = ANY ((ARRAY['a'::character varying])::text[])))")).toBe('unreadable');
    expect(allowedValues('s', "CHECK ((s = ANY (ARRAY['a'::text, lower('B'::text)])))")).toBe('unreadable');
    expect(allowedValues('s', "CHECK (((s = 'a'::text) OR (s = 'b'::text)))")).toBe('unreadable');
    expect(allowedValues('reasons', "CHECK ((jsonb_typeof(reasons) = 'array'::text))")).toBeNull();
  });
});
