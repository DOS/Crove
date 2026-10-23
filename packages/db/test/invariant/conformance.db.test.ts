// Schema conformance of the tenant conventions (plan §5.4 "Tenant conventions", gate G3, #1200) on a real
// PostgreSQL 17 after every migration. The cases come from the catalog: a tenant table is a table in a crove_*
// schema with an org_id column. The rules:
//   pk            every tenant table has PRIMARY KEY (org_id, id);
//   fk-shape      a foreign key between tenant tables leads with org_id on both sides and is composite (only the
//                 org itself, crove_kernel.tenant, is referenced by org_id alone), so a row cannot point into
//                 another org;
//   fk-index      such a foreign key has a supporting index: a valid index whose leading key columns are exactly the
//                 key's columns, either total or partial on "<key column> IS NOT NULL" only (a NULL key is never
//                 checked), so deleting a parent (an org purge) never scans the child;
//   timestamp     no column in a crove_* schema is timestamp without time zone (directly, as an array, or through
//                 a domain);
//   money         a money column (named by MONEY_NAME, or listed in MONEY_COLUMNS) is numeric, directly or through a
//                 domain such as crove_finance.amount, and no column has the locale-bound money type;
//   cross-module  a foreign key from a crove_* table stays in its own schema or points to crove_kernel: modules
//                 never reference each other, the kernel never references a module, and nothing references a
//                 schema outside crove_*;
//   trigger       no trigger running a crove_* function sits on a table outside the crove_* schemas.
// Existing deviations are explicit exceptions below, one reason each, recorded with their exact shape: a new
// deviation, a changed one, or an exception that no longer matches anything fails. Every rule is also shown failing
// on deliberately broken fixtures, built inside a transaction that is rolled back.
// Scope: the catalog of this database only. Tables without org_id (user_account, the pg-boss queue) are global and
// only meet the timestamp, money, cross-module and trigger rules; triggers that Supabase-managed schemas would add
// on a hosted database are not seen here, since plain PostgreSQL has none.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/migrate.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

// The org itself: the only table a tenant foreign key may reference by org_id alone.
const ORG_TABLE = 'crove_kernel.tenant';
// pg-boss's own schema (`pnpm db:vendor:pgboss`): its DDL is pg-boss's, so the column rules skip it. It has no tenant
// table; a table with org_id there would still meet every tenant rule.
const VENDORED_SCHEMAS = new Set(['crove_jobs']);
// Column names that hold an amount of money.
const MONEY_NAME = /(^|_)(amount|cost|price|subtotal|total|debit|credit|balance|fee)$/;
// Money columns the naming rule does not catch.
const MONEY_COLUMNS = new Set(['crove_kernel.budget_policy.monthly_limit']);

// Tenant tables whose primary key is not (org_id, id), with the key they have. Every one still leads with org_id
// except outbox_pending, whose rows belong to no org until the worker moves them.
const PK_EXCEPTIONS: Record<string, { pk: string; reason: string }> = {
  'crove_finance.journal_line': { pk: 'org_id,entry_id,line_no', reason: 'A line of an append-only journal entry, keyed by its entry and line number.' },
  'crove_finance.portal_invoice_row': { pk: 'org_id,list_id,row_no', reason: 'A row of an imported tax-portal invoice list, keyed by its list and row number.' },
  'crove_finance.purchase_document_void': { pk: 'org_id,document_id', reason: 'At most one void per purchase document: the document is the key.' },
  'crove_finance.purchase_line': { pk: 'org_id,document_id,line_no', reason: 'A line of a purchase document, keyed by its document and line number.' },
  'crove_finance.purchase_tax_rate': { pk: 'org_id,document_id,row_no', reason: 'A VAT rate row of a purchase document, keyed by its document and row number.' },
  'crove_finance.vendor_account_rule': { pk: 'org_id,party_id', reason: 'One posting rule per vendor: the party is the key.' },
  'crove_kernel.auth_session_org': { pk: 'org_id,user_id,session_id', reason: 'Which org a login session acts in: a pairing of session, user and org.' },
  'crove_kernel.credential': { pk: 'org_id,connection_id', reason: 'The sealed secret of one channel connection (ADR-0025): the connection is the key.' },
  'crove_kernel.idempotency_key': { pk: 'org_id,actor_key,key', reason: 'A command idempotency key is unique per org and actor; it has no id of its own.' },
  'crove_kernel.inbound_drop': { pk: 'org_id,address_id', reason: 'The drop counter of one inbound address (#37): the address is the key.' },
  'crove_kernel.notification_mute': { pk: 'org_id,user_id,kind', reason: 'A mute is a set membership of (user, notification kind).' },
  'crove_kernel.outbox_archive': { pk: 'org_id,day', reason: 'One archive batch per org and day.' },
  'crove_kernel.outbox_pending': { pk: 'seq', reason: 'The global outbox hand-off queue, ordered by its sequence; definer-only machinery.' },
  'crove_kernel.refusal_tally': { pk: 'org_id,window_start,actor_key,command,code', reason: 'A refusal counter per time window, actor, command and code.' },
  'crove_kernel.tenant': { pk: 'org_id', reason: 'The org itself: its id is org_id.' },
  'crove_kernel.tenant_member': { pk: 'org_id,user_id', reason: 'Membership is a pairing of org and user.' },
  'crove_social.chat_alert_target': { pk: 'org_id,alert_id', reason: 'The sealed target of one team chat alert (#863): the alert is the key.' },
  'crove_social.notification_mute': { pk: 'org_id,user_id,kind', reason: 'A mute is a set membership of (user, notification kind).' },
};
// Tenant foreign keys (<table>.<constraint>) that have no supporting index yet; #1212 adds them.
const FK_INDEX_EXCEPTIONS: Record<string, string> = {
  'crove_finance.input_vat_check.input_vat_check_voucher_fk': 'Index missing, tracked in #1212.',
  'crove_kernel.agent_wakeup.agent_wakeup_org_id_agent_id_fkey': 'Index missing, tracked in #1212: only a partial unique index on pending wakeups.',
  'crove_kernel.agent_wakeup.agent_wakeup_org_id_run_id_fkey': 'Index missing, tracked in #1212.',
  'crove_kernel.proposal.proposal_decided_by_agent_fk': 'Index missing, tracked in #1212.',
  'crove_kernel.proposal.proposal_requested_by_run_fk': 'Index missing, tracked in #1212.',
  'crove_social.notification.notification_post_fk': 'Index missing, tracked in #1212.',
  'crove_social.post_approval.post_approval_variant_fk': 'Index missing, tracked in #1212: the index on (org_id, variant_id, created_at) does not cover post_id.',
  'crove_social.post_comment.post_comment_variant_fk': 'Index missing, tracked in #1212: the partial index on (org_id, variant_id) does not cover post_id.',
  'crove_social.post_variant.post_variant_post_fk': 'Index missing, tracked in #1212: only a partial unique index on live variants.',
  'crove_social.watermark.watermark_file_fk': 'Index missing, tracked in #1212.',
};
// Exceptions whose object an open PR adds or fixes. CI runs main's copy of this file on that PR, so the entry has to
// be on main first; while it is listed here, an exception that matches nothing is not stale. Remove the key once the
// PR is merged. One key per line, sorted, with a trailing comma.
const PENDING_EXCEPTIONS = new Set<string>([
  // 'crove_schema.table_name',
]);

type Rule = 'pk' | 'fk-shape' | 'fk-index' | 'timestamp' | 'money' | 'cross-module' | 'trigger';
interface Violation {
  rule: Rule;
  // The table, column (<table>.<column>), constraint or trigger (<table>.<name>) at fault.
  key: string;
  // The shape found, compared with an exception's recorded shape.
  detail: string;
}

const suite = ADMIN ? describe : describe.skip;

const IS_NOT_NULL = /^\(*("[^"]+"|[a-z_][a-z0-9_$]*)\s+IS NOT NULL\)*$/;
const unquote = (name: string) => (name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name);

// True when every conjunct of a partial index predicate is "<column> IS NOT NULL" for one of the key's columns.
function onlyKeyNotNull(predicate: string, keyColumns: string[]): boolean {
  return predicate.split(' AND ').every((part) => {
    const match = IS_NOT_NULL.exec(part.trim());
    return match !== null && keyColumns.includes(unquote(match[1] as string));
  });
}

// Every deviation from the conventions in the database, exceptions included.
async function findViolations(client: pg.ClientBase): Promise<Violation[]> {
  const out: Violation[] = [];
  const vendored = [...VENDORED_SCHEMAS];

  const tenants = await client.query<{ name: string; pk: string | null }>(
    `SELECT pg_catalog.format('%I.%I', n.nspname, c.relname) AS name,
            (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
             FROM pg_catalog.pg_constraint p
             CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = p.conrelid AND a.attnum = k.attnum
             WHERE p.conrelid = c.oid AND p.contype = 'p') AS pk
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND starts_with(n.nspname, 'crove_')
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped)
     ORDER BY 1`,
  );
  for (const { name, pk } of tenants.rows) {
    if (pk !== 'org_id,id') out.push({ rule: 'pk', key: name, detail: pk ?? 'none' });
  }

  // Foreign keys between tenant tables, with the indexes of the referencing table.
  const fks = await client.query<{
    key: string;
    target: string;
    cols: string[];
    refcols: string[];
    attnums: number[];
    indexes: { keys: number[]; pred: string | null }[];
  }>(
    `WITH tenant AS (
       SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND starts_with(n.nspname, 'crove_')
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
     SELECT pg_catalog.format('%s.%I', co.conrelid::regclass, co.conname) AS key,
            co.confrelid::regclass::text AS target,
            ARRAY(SELECT a.attname::text FROM unnest(co.conkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols,
            ARRAY(SELECT a.attname::text FROM unnest(co.confkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = co.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS refcols,
            co.conkey::int[] AS attnums,
            COALESCE((SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
                        'keys', (i.indkey::int2[])[0:i.indnkeyatts - 1],
                        'pred', pg_catalog.pg_get_expr(i.indpred, i.indrelid)))
                      FROM pg_catalog.pg_index i WHERE i.indrelid = co.conrelid AND i.indisvalid), '[]') AS indexes
     FROM pg_catalog.pg_constraint co
     WHERE co.contype = 'f' AND co.conrelid IN (SELECT oid FROM tenant) AND co.confrelid IN (SELECT oid FROM tenant)
     ORDER BY 1`,
  );
  for (const fk of fks.rows) {
    const leadsWithOrg = fk.cols[0] === 'org_id' && fk.refcols[0] === 'org_id';
    if (!leadsWithOrg || (fk.cols.length < 2 && fk.target !== ORG_TABLE)) {
      out.push({ rule: 'fk-shape', key: fk.key, detail: `(${fk.cols.join(',')}) -> ${fk.target} (${fk.refcols.join(',')})` });
    }
    const wanted = new Set(fk.attnums);
    const supported = fk.indexes.some((index) => {
      const lead = index.keys.slice(0, wanted.size);
      return (
        lead.length === wanted.size &&
        lead.every((attnum) => wanted.has(attnum)) &&
        (index.pred === null || onlyKeyNotNull(index.pred, fk.cols))
      );
    });
    if (!supported) out.push({ rule: 'fk-index', key: fk.key, detail: fk.cols.join(',') });
  }

  // Column types, resolved through domains and arrays down to their base type.
  const columns = await client.query<{ key: string; type: string; chain: string[] }>(
    `WITH RECURSIVE col AS (
       SELECT pg_catalog.format('%I.%I.%I', n.nspname, c.relname, a.attname) AS key,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.atttypid AS start
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND starts_with(n.nspname, 'crove_') AND n.nspname <> ALL ($1::text[])
         AND a.attnum > 0 AND NOT a.attisdropped),
     chain(start, oid) AS (
       SELECT DISTINCT start, start FROM col
       UNION
       SELECT chain.start, CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.typelem END
       FROM chain JOIN pg_catalog.pg_type t ON t.oid = chain.oid
       WHERE t.typtype = 'd' OR (t.typcategory = 'A' AND t.typelem <> 0))
     SELECT col.key, col.type, ARRAY(SELECT chain.oid::regtype::text FROM chain WHERE chain.start = col.start) AS chain
     FROM col ORDER BY 1`,
    [vendored],
  );
  for (const { key, type, chain } of columns.rows) {
    if (chain.includes('timestamp without time zone')) out.push({ rule: 'timestamp', key, detail: type });
    const column = key.slice(key.lastIndexOf('.') + 1);
    const isMoney = MONEY_NAME.test(column) || MONEY_COLUMNS.has(key);
    if (chain.includes('money') || (isMoney && !chain.includes('numeric'))) out.push({ rule: 'money', key, detail: type });
  }

  // Foreign keys from any crove_* table to another schema than its own or crove_kernel.
  const crossing = await client.query<{ key: string; target: string }>(
    `SELECT pg_catalog.format('%s.%I', co.conrelid::regclass, co.conname) AS key, co.confrelid::regclass::text AS target
     FROM pg_catalog.pg_constraint co
     JOIN pg_catalog.pg_class c ON c.oid = co.conrelid
     JOIN pg_catalog.pg_class r ON r.oid = co.confrelid
     WHERE co.contype = 'f' AND starts_with(c.relnamespace::regnamespace::text, 'crove_')
       AND r.relnamespace <> c.relnamespace AND r.relnamespace <> 'crove_kernel'::regnamespace
     ORDER BY 1`,
  );
  for (const { key, target } of crossing.rows) out.push({ rule: 'cross-module', key, detail: target });

  const triggers = await client.query<{ key: string; fn: string }>(
    `SELECT pg_catalog.format('%s.%I', t.tgrelid::regclass, t.tgname) AS key, t.tgfoid::regprocedure::text AS fn
     FROM pg_catalog.pg_trigger t
     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND NOT starts_with(c.relnamespace::regnamespace::text, 'crove_')
       AND starts_with(p.pronamespace::regnamespace::text, 'crove_')
     ORDER BY 1`,
  );
  for (const { key, fn } of triggers.rows) out.push({ rule: 'trigger', key, detail: fn });

  return out;
}

// The deviations no exception covers, and the exceptions that no longer match a deviation exactly.
function compare(violations: Violation[]) {
  const recorded = new Map<string, string>();
  for (const [table, { pk }] of Object.entries(PK_EXCEPTIONS)) recorded.set(`pk ${table}`, pk);
  for (const [key] of Object.entries(FK_INDEX_EXCEPTIONS)) recorded.set(`fk-index ${key}`, '');
  const matched = new Set<string>();
  const unexpected: string[] = [];
  for (const v of violations) {
    const id = `${v.rule} ${v.key}`;
    const shape = recorded.get(id);
    if (shape !== undefined && (shape === '' || shape === v.detail)) matched.add(id);
    else unexpected.push(`${id}: ${v.detail}${shape ? ` (exception records ${shape})` : ''}`);
  }
  const stale = [...recorded.keys()].filter((id) => !matched.has(id) && !PENDING_EXCEPTIONS.has(id.slice(id.indexOf(' ') + 1)));
  return { unexpected, stale };
}

suite('tenant schema conformance (G3)', () => {
  const dbName = `crove_test_conformance_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let admin: pg.Client;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    await migrate({ adminUrl: url.toString(), dir: MIGRATIONS });
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
  }, 300_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('finds tenant tables to check', async () => {
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       WHERE a.attname = 'org_id' AND c.relkind IN ('r', 'p') AND starts_with(c.relnamespace::regnamespace::text, 'crove_')`,
    );
    expect(rows[0]?.n).toBeGreaterThan(50);
  });

  it('every crove_* table meets the tenant conventions or is a recorded exception', async () => {
    const { unexpected, stale } = compare(await findViolations(admin));
    expect(unexpected, 'deviations from the tenant conventions: fix the migration, or record an exception with its reason').toEqual([]);
    expect(stale, 'exceptions that match no deviation any more: remove them (or list them in PENDING_EXCEPTIONS)').toEqual([]);
  });

  it('keeps the exception lists sorted and reasoned', () => {
    for (const keys of [Object.keys(PK_EXCEPTIONS), Object.keys(FK_INDEX_EXCEPTIONS), [...PENDING_EXCEPTIONS]]) {
      expect(keys).toEqual([...keys].sort());
    }
    for (const reason of [...Object.values(PK_EXCEPTIONS).map((e) => e.reason), ...Object.values(FK_INDEX_EXCEPTIONS)]) {
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });

  // Broken fixtures, one transaction each, rolled back: the rule must name exactly the broken objects.
  async function withFixture(sql: string): Promise<Violation[]> {
    await admin.query('BEGIN');
    try {
      await admin.query(sql);
      return await findViolations(admin);
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  const FIXTURE = 'crove_g3_fixture';
  const named = (violations: Violation[], rule: Rule) =>
    violations
      .filter((v) => v.rule === rule && (v.key.startsWith(`${FIXTURE}.`) || v.key.includes('g3_fixture')))
      .map((v) => `${v.key}: ${v.detail}`)
      .sort();
  const parent = `CREATE SCHEMA ${FIXTURE};
    CREATE TABLE ${FIXTURE}.parent (org_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (org_id, id), UNIQUE (id), UNIQUE (id, org_id));`;

  it('fails a tenant table without PRIMARY KEY (org_id, id)', async () => {
    const found = await withFixture(`${parent}
      CREATE TABLE ${FIXTURE}.by_id (org_id uuid NOT NULL, id uuid PRIMARY KEY);
      CREATE TABLE ${FIXTURE}.swapped (org_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (id, org_id));
      CREATE TABLE ${FIXTURE}.keyless (org_id uuid NOT NULL, id uuid NOT NULL);`);
    expect(named(found, 'pk')).toEqual([`${FIXTURE}.by_id: id`, `${FIXTURE}.keyless: none`, `${FIXTURE}.swapped: id,org_id`]);
  });

  it('fails a foreign key between tenant tables that does not lead with org_id on both sides', async () => {
    const found = await withFixture(`${parent}
      CREATE TABLE ${FIXTURE}.child (org_id uuid NOT NULL, id uuid NOT NULL, parent_id uuid, PRIMARY KEY (org_id, id),
        CONSTRAINT single FOREIGN KEY (parent_id) REFERENCES ${FIXTURE}.parent (id),
        CONSTRAINT org_last FOREIGN KEY (parent_id, org_id) REFERENCES ${FIXTURE}.parent (id, org_id),
        CONSTRAINT crossed FOREIGN KEY (org_id, parent_id) REFERENCES ${FIXTURE}.parent (id, org_id),
        CONSTRAINT org_only FOREIGN KEY (org_id) REFERENCES ${FIXTURE}.parent (id),
        CONSTRAINT good FOREIGN KEY (org_id, parent_id) REFERENCES ${FIXTURE}.parent (org_id, id),
        CONSTRAINT to_org FOREIGN KEY (org_id) REFERENCES crove_kernel.tenant (org_id));
      CREATE INDEX ON ${FIXTURE}.child (org_id, parent_id);`);
    expect(named(found, 'fk-shape')).toEqual([
      `${FIXTURE}.child.crossed: (org_id,parent_id) -> ${FIXTURE}.parent (id,org_id)`,
      `${FIXTURE}.child.org_last: (parent_id,org_id) -> ${FIXTURE}.parent (id,org_id)`,
      `${FIXTURE}.child.org_only: (org_id) -> ${FIXTURE}.parent (id)`,
      `${FIXTURE}.child.single: (parent_id) -> ${FIXTURE}.parent (id)`,
    ]);
  });

  it('fails a tenant foreign key without a supporting index', async () => {
    const found = await withFixture(`${parent}
      CREATE TABLE ${FIXTURE}.child (org_id uuid NOT NULL, id uuid NOT NULL, a uuid, b uuid, c uuid, d uuid, e uuid,
        status text, PRIMARY KEY (org_id, id),
        CONSTRAINT bare FOREIGN KEY (org_id, a) REFERENCES ${FIXTURE}.parent (org_id, id),
        CONSTRAINT other_partial FOREIGN KEY (org_id, b) REFERENCES ${FIXTURE}.parent (org_id, id),
        CONSTRAINT wrong_lead FOREIGN KEY (org_id, c) REFERENCES ${FIXTURE}.parent (org_id, id),
        CONSTRAINT not_null_partial FOREIGN KEY (org_id, d) REFERENCES ${FIXTURE}.parent (org_id, id),
        CONSTRAINT reordered FOREIGN KEY (org_id, e) REFERENCES ${FIXTURE}.parent (org_id, id));
      CREATE INDEX ON ${FIXTURE}.child (org_id, b) WHERE status = 'open';
      CREATE INDEX ON ${FIXTURE}.child (org_id, id, c);
      CREATE INDEX ON ${FIXTURE}.child (org_id, d, status) WHERE d IS NOT NULL;
      CREATE INDEX ON ${FIXTURE}.child (e, org_id);`);
    expect(named(found, 'fk-index')).toEqual([`${FIXTURE}.child.bare: org_id,a`, `${FIXTURE}.child.other_partial: org_id,b`, `${FIXTURE}.child.wrong_lead: org_id,c`]);
  });

  it('fails a timestamp without time zone column', async () => {
    const found = await withFixture(`${parent}
      CREATE DOMAIN ${FIXTURE}.local_time AS timestamp;
      CREATE TABLE ${FIXTURE}.times (org_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (org_id, id),
        plain timestamp, several timestamp[], via_domain ${FIXTURE}.local_time, fine timestamptz);
      CREATE VIEW ${FIXTURE}.times_view AS SELECT now()::timestamp AS seen;`);
    expect(named(found, 'timestamp')).toEqual([
      `${FIXTURE}.times.plain: timestamp without time zone`,
      `${FIXTURE}.times.several: timestamp without time zone[]`,
      `${FIXTURE}.times.via_domain: ${FIXTURE}.local_time`,
      `${FIXTURE}.times_view.seen: timestamp without time zone`,
    ]);
  });

  it('fails a money column that is not numeric', async () => {
    const found = await withFixture(`${parent}
      CREATE TABLE ${FIXTURE}.prices (org_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (org_id, id),
        amount bigint, unit_price double precision, vat_amount text, fee money, subtotal crove_finance.amount,
        total numeric(20,4), quantity real);`);
    expect(named(found, 'money')).toEqual([
      `${FIXTURE}.prices.amount: bigint`,
      `${FIXTURE}.prices.fee: money`,
      `${FIXTURE}.prices.unit_price: double precision`,
      `${FIXTURE}.prices.vat_amount: text`,
    ]);
  });

  it('fails a foreign key between module schemas, from the kernel to a module, or out of crove_*', async () => {
    const found = await withFixture(`${parent}
      CREATE TABLE ${FIXTURE}.to_finance (org_id uuid NOT NULL, id uuid NOT NULL, entry_id uuid, PRIMARY KEY (org_id, id),
        CONSTRAINT to_finance FOREIGN KEY (org_id, entry_id) REFERENCES crove_finance.journal_entry (org_id, id),
        CONSTRAINT to_kernel FOREIGN KEY (org_id) REFERENCES crove_kernel.tenant (org_id));
      CREATE TABLE public.g3_fixture_outside (id uuid PRIMARY KEY);
      CREATE TABLE ${FIXTURE}.to_outside (id uuid PRIMARY KEY REFERENCES public.g3_fixture_outside (id));
      CREATE TABLE crove_kernel.g3_fixture_kernel (org_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (org_id, id),
        CONSTRAINT to_module FOREIGN KEY (org_id, id) REFERENCES ${FIXTURE}.parent (org_id, id));`);
    expect(named(found, 'cross-module')).toEqual([
      `crove_kernel.g3_fixture_kernel.to_module: ${FIXTURE}.parent`,
      `${FIXTURE}.to_finance.to_finance: crove_finance.journal_entry`,
      `${FIXTURE}.to_outside.to_outside_id_fkey: g3_fixture_outside`,
    ].sort());
  });

  it('fails a Crove trigger on a table outside the crove_* schemas', async () => {
    const found = await withFixture(`${parent}
      CREATE TABLE public.g3_fixture_outside (id uuid PRIMARY KEY);
      CREATE TRIGGER g3_fixture_guard BEFORE UPDATE ON public.g3_fixture_outside
        FOR EACH ROW EXECUTE FUNCTION crove_kernel.reject_mutation();
      CREATE TRIGGER g3_fixture_inside BEFORE UPDATE ON ${FIXTURE}.parent
        FOR EACH ROW EXECUTE FUNCTION crove_kernel.reject_mutation();`);
    expect(named(found, 'trigger')).toEqual(['g3_fixture_outside.g3_fixture_guard: crove_kernel.reject_mutation()']);
  });

  it('reports a new deviation, a changed one and a stale exception', async () => {
    const found = await withFixture(`${parent} CREATE TABLE ${FIXTURE}.by_id (org_id uuid NOT NULL, id uuid PRIMARY KEY);`);
    const { unexpected, stale } = compare(
      found
        // The org table conforms now: its exception is stale.
        .filter((v) => !(v.rule === 'pk' && v.key === 'crove_kernel.tenant'))
        // A journal line keyed differently from its exception.
        .map((v) => (v.rule === 'pk' && v.key === 'crove_finance.journal_line' ? { ...v, detail: 'org_id,line_no' } : v)),
    );
    expect(unexpected).toEqual([
      'pk crove_finance.journal_line: org_id,line_no (exception records org_id,entry_id,line_no)',
      `pk ${FIXTURE}.by_id: id`,
    ]);
    expect(stale).toEqual(['pk crove_finance.journal_line', 'pk crove_kernel.tenant']);
  });
});
