// Every table of a crove_* schema with an org_id column is deleted by crove_kernel.org_purge or kept on purpose (#1217).
// A migration that adds a table restates org_purge with the table added to its lists; two such migrations written from
// the same base each restate that base, and the one merged second drops the other's table without a conflict, so the
// org's rows there would survive the purge. org-purge.db.test.ts reads the catalog of its migrated database and fails
// on such a table; org-purge-coverage.test.ts checks the reading and the messages on planted catalogs.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

// The tables org_purge leaves in place, with why (docs/runbooks/org-offboarding.md, the deletion map's
// table). A table is here and in that table, or org_purge deletes it.
export const KEPT: Readonly<Record<string, string>> = {
  'crove_kernel.tenant': 'kept with status closed: the kept records reference it',
  'crove_kernel.legal_entity': 'the companies and branches the books are kept for (#1278)',
  'crove_kernel.audit_event': 'proof of who did what to the books; append-only, kept with the ledger',
  'crove_kernel.outbox_event': 'archived, then deleted by the daily retention job 30 days after each event (#997)',
  'crove_kernel.outbox_archive': 'the list of archived outbox days (#997); no personal data',
  'crove_kernel.org_usage': 'usage counts; no personal data',
  'crove_kernel.external_call': 'the ledger of calls to social platforms; no personal data',
  'crove_kernel.inbound_address': 'inbound addresses are permanent tombstones (#37)',
  'crove_kernel.number_series': 'gapless voucher numbering (#1401), kept with the ledger',
  'crove_kernel.number_allocation': 'gapless voucher numbering (#1401), append-only, kept with the ledger',
  'crove_kernel.number_void': 'gapless voucher numbering (#1401), append-only, kept with the ledger',
  'crove_kernel.number_series_policy': 'gapless voucher numbering (#1401), kept with the ledger',
  'crove_finance.journal_entry': 'ledger (Accounting Law 88/2015, Art. 41)',
  'crove_finance.journal_line': 'ledger (Accounting Law 88/2015, Art. 41)',
  'crove_finance.purchase_document': 'ledger (Accounting Law 88/2015, Art. 41)',
  'crove_finance.purchase_line': 'ledger (Accounting Law 88/2015, Art. 41)',
  'crove_finance.purchase_tax_rate': 'ledger (Accounting Law 88/2015, Art. 41)',
  'crove_finance.purchase_document_void': 'the rest of the books',
  'crove_finance.org_account': 'the sub-accounts the ledger lines name by code',
  'crove_finance.misa_goods_code': 'how the kept books map onto the MISA catalog (#1398)',
  'crove_finance.portal_invoice_list': "the tax portal's record of the period's purchases (#465)",
  'crove_finance.portal_invoice_row': "the tax portal's record of the period's purchases (#465)",
  'crove_finance.cash_voucher': 'the rest of the books',
  'crove_finance.bank_line': 'the rest of the books',
  'crove_finance.journal_voucher': 'the rest of the books',
  'crove_finance.fixed_asset': 'the rest of the books',
  'crove_finance.depreciation_line': 'the rest of the books',
  'crove_finance.input_vat_check': 'the rest of the books',
  'crove_finance.period_lock': 'the rest of the books',
  'crove_finance.period_balance_delta': 'the rest of the books',
  'crove_finance.vat_return_filed': 'the rest of the books (#1400)',
  'crove_finance.legal_entity_books': "each entity's accounting regime, which the kept entries were booked under (#1403)",
};

export type PurgeCatalog = {
  // Tables (schema.table) of the crove_* schemas with an org_id column, partitions left out.
  tables: readonly string[];
  // Foreign keys with ON DELETE CASCADE whose columns are all NOT NULL: every child row goes with its parent.
  cascades: ReadonlyArray<{ child: string; parent: string }>;
  // The body of crove_kernel.org_purge(integer) (pg_proc.prosrc).
  purgeSource: string;
};

const TABLE = /crove_[a-z0-9_]+\.[a-z0-9_]+/;

// The tables org_purge deletes rows of. Whole: the lists its FOREACH loop deletes, and a DELETE whose only condition is
// the org. Partial: a DELETE with any other condition (the rows pinned rows keep, `id <> ALL (v_keep_...)`). Throws when
// the loop or one of its lists cannot be read, rather than finding fewer tables.
export function purgedTables(source: string): { whole: Set<string>; partial: Set<string> } {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  const whole = new Set<string>();
  const partial = new Set<string>();
  const statement = new RegExp(`DELETE FROM\\s+(${TABLE.source})(?:\\s+(?:AS\\s+)?(?!WHERE\\b)\\w+)?\\s+WHERE\\s+([\\s\\S]*?)(?:;|\\bRETURNING\\b)`, 'gi');
  for (const m of code.matchAll(statement)) {
    const onlyOrg = /^(?:\w+\.)?org_id\s*=\s*\w+$/.test((m[2] as string).trim());
    (onlyOrg ? whole : partial).add(m[1] as string);
  }
  const loop = /FOREACH\s+\w+\s+IN\s+ARRAY\s+([\w\s|]+?)\s+LOOP/.exec(code);
  if (!loop) throw new Error('org_purge: no FOREACH ... IN ARRAY ... LOOP over its table lists; update purgedTables');
  for (const name of (loop[1] as string).split('||').map((s) => s.trim())) {
    const list = new RegExp(`\\b${name}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\];`).exec(code);
    if (!list) throw new Error(`org_purge: the list ${name} is not a text[] := ARRAY[...] it declares; update purgedTables`);
    for (const m of (list[1] as string).matchAll(new RegExp(`'(${TABLE.source})'`, 'g'))) whole.add(m[1] as string);
  }
  for (const table of whole) partial.delete(table);
  return { whole, partial };
}

export type Migrations = { createdIn: (table: string) => string | undefined; newestPurge: string };

export function purgeCoverageProblems(catalog: PurgeCatalog, kept: Readonly<Record<string, string>>, migrations: Migrations): string[] {
  const { whole, partial } = purgedTables(catalog.purgeSource);
  // Children that go with a parent deleted whole, transitively. Not with a parent deleted in part: the children of its
  // kept rows stay, so a child the purge stopped naming would pass unnoticed.
  for (let grown = true; grown; ) {
    grown = false;
    for (const { child, parent } of catalog.cascades) {
      if (whole.has(parent) && !whole.has(child)) {
        whole.add(child);
        grown = true;
      }
    }
  }
  const purged = new Set([...whole, ...partial]);
  const tables = new Set(catalog.tables);
  const problems: string[] = [];
  for (const table of [...tables].sort()) {
    if (purged.has(table) || table in kept) continue;
    const created = migrations.createdIn(table);
    problems.push(
      `${table}${created ? ` (created in supabase/migrations/${created})` : ''} has org_id, but crove_kernel.org_purge does not delete it: ` +
        `add it to org_purge in a new migration that restates the newest definition (supabase/migrations/${migrations.newestPurge}), ` +
        'or, if the org\'s rows must stay, add it to KEPT in apps/kernel/test/org-purge-coverage.ts with the reason and to docs/runbooks/org-offboarding.md',
    );
  }
  for (const table of Object.keys(kept).sort()) {
    if (!tables.has(table)) problems.push(`${table} is on KEPT but is no crove_* table with org_id: remove it from KEPT`);
    else if (purged.has(table)) problems.push(`${table} is on KEPT but crove_kernel.org_purge deletes it: remove it from KEPT`);
  }
  return problems;
}

export async function readPurgeCatalog(client: pg.Client): Promise<PurgeCatalog> {
  const tables = await client.query<{ name: string }>(`
    SELECT n.nspname || '.' || c.relname AS name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname LIKE 'crove\\_%' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)`);
  const cascades = await client.query<{ child: string; parent: string }>(`
    SELECT cn.nspname || '.' || cc.relname AS child, pn.nspname || '.' || pc.relname AS parent
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class cc ON cc.oid = k.conrelid
    JOIN pg_catalog.pg_namespace cn ON cn.oid = cc.relnamespace
    JOIN pg_catalog.pg_class pc ON pc.oid = k.confrelid
    JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE k.contype = 'f' AND k.confdeltype = 'c'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.unnest(k.conkey) col
        JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = col
        WHERE NOT a.attnotnull)`);
  const source = await client.query<{ src: string }>(`SELECT p.prosrc AS src FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_kernel.org_purge(integer)'::regprocedure`);
  return { tables: tables.rows.map((r) => r.name), cascades: cascades.rows, purgeSource: (source.rows[0] as { src: string }).src };
}

// Where each table was created and which migration restates org_purge last, from the migration files.
export function readMigrations(dir: string = MIGRATIONS_DIR): Migrations {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const text = new Map(files.map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]));
  const newestPurge = files.filter((f) => /CREATE OR REPLACE FUNCTION crove_kernel\.org_purge\(/.test(text.get(f) as string)).at(-1);
  if (!newestPurge) throw new Error('no migration defines crove_kernel.org_purge');
  return {
    newestPurge,
    createdIn: (table) => {
      const pattern = new RegExp(`CREATE (?:UNLOGGED )?TABLE(?: IF NOT EXISTS)?\\s+${table.replace('.', '\\.')}\\b`, 'i');
      return files.find((f) => pattern.test(text.get(f) as string));
    },
  };
}
