// Module manifests against the catalog (plan §10 G3 "manifest matches catalog", §5.2; #1588, #1599, #1630, #1656) on
// PostgreSQL 17: after every migration, each table of a crove_* schema belongs to exactly one module manifest, under that
// manifest's schema, each table a manifest names exists, every column of those tables has a data class and every
// classified column exists, personal data the PDPL registry (#923) erases or keeps is not classified internal, and every
// permission a crove_kernel.role_permission row grants, a command or the approval policy names, or a database function
// or policy checks is declared, with exactly the seeded rows as its default roles (manifest-permissions.ts), and every
// entity matches its table's legal_entity_id column and append-only trigger and the numbering series its table's
// triggers allocate, and every command's audit target is an entity (manifest-entities.ts). Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@crove/db/migrate';
import { PERSONAL_DATA_COLUMNS, type PersonalDataColumn, type PersonalDataHandling, type PersonalDataKind } from '@crove/kernel';
import { DATA_CLASSES, columns, type DataClass, type ModuleManifest } from '@crove/kernel-contract';
import { commandTargetTypes, entityProblems, numberingCalls, type NumberingCall } from './manifest-entities.ts';
import { MODULE_MANIFESTS, permissionProblems, sqlPermissionUses, staticPermissionUses, type Grant, type Manifests, type PermissionUse } from './manifest-permissions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
// The control plane's tables in crove_kernel (plan §3.6): no app, module or package source may name them (the
// control-plane-reads invariant), so their owner is declared here, beside the module manifests.
const CONTROL_PLANE: ModuleManifest = {
  id: 'control-plane',
  dependsOn: [],
  tables: {
    crove_kernel: {
      auth_email_send: columns(['id', 'client_hash', 'target_hash', 'reserved_at']),
      auth_session: columns(['user_id', 'session_id', 'status', 'first_seen_at', 'last_seen_at', 'revoked_at', 'revoked_by', 'reason', 'evidence_at']),
      global_kill_switch: columns(['id', 'key', 'engaged', 'reason', 'changed_by', 'changed_at']),
      inbound_address: columns(['org_id', 'id', 'created_at', 'retired_at'], { token: 'sensitive' }),
      inbound_pending: columns(['seq', 'blob_id', 'raw_sha256', 'size_bytes', 'received_at'], { recipient: 'sensitive' }),
      stream_ticket: columns(['ticket_hash', 'user_id', 'stream_org_id', 'session_id', 'aal', 'mfa_at', 'token_expires_at', 'expires_at', 'created_at']),
      user_account: columns(['id', 'issuer', 'created_at', 'last_seen_at', 'disabled_at'], { subject: 'pii', email: 'contact', display_name: 'pii', status_reason: 'pii' }),
    },
  },
  permissions: [],
  routes: [],
  nav: [],
  entities: [],
};
// The control plane's owner and every module manifest (manifest-permissions.ts lists them).
const MANIFESTS: Manifests = {
  'control-plane': { manifest: CONTROL_PLANE, file: 'apps/kernel/test/manifest.db.test.ts (CONTROL_PLANE)' },
  ...MODULE_MANIFESTS,
};
const suite = ADMIN ? describe : describe.skip;

// What the PDPL registry's kinds allow as a column's class (#923): personal data the registry erases or keeps is never
// internal. The handlings for data that is not a person's (the org's own identity, a keyed hash, a name that only looks
// personal) leave the class free.
const CLASS_OF_KIND: Record<PersonalDataKind, readonly DataClass[]> = {
  email: ['contact'],
  phone: ['contact'],
  address: ['contact'],
  email_list: ['contact'],
  name: ['pii'],
  tax_code: ['national_id', 'national_id_if_individual'],
  // Free text a person wrote (a note's body, #1678), which may name or describe anyone.
  free_text: ['pii'],
  other: ['pii', 'contact', 'payment', 'national_id', 'national_id_if_individual', 'sensitive'],
};
const PERSONAL_HANDLINGS: readonly PersonalDataHandling[] = ['erase', 'keep_legal', 'keep_record'];

// schema.table.column -> class, from every manifest.
function classified(): Map<string, { cls: DataClass; file: string }> {
  const out = new Map<string, { cls: DataClass; file: string }>();
  for (const { manifest, file } of Object.values(MANIFESTS)) {
    for (const [schema, tables] of Object.entries(manifest.tables)) {
      for (const [table, cols] of Object.entries(tables)) for (const [col, cls] of Object.entries(cols)) out.set(`${schema}.${table}.${col}`, { cls, file });
    }
  }
  return out;
}

suite('module manifests against the catalog (#1588, #1599)', () => {
  const dbName = `crove_test_manifest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let catalog: Array<{ schema: string; table: string }> = [];
  let columnRows: Array<{ schema: string; table: string; column: string }> = [];
  let grants: Grant[] = [];
  let sqlUses: PermissionUse[] = [];
  let sqlProblems: string[] = [];
  let appendOnly = new Set<string>();
  let numbering: NumberingCall[] = [];
  let numberingProblems: string[] = [];
  let allocators: string[] = [];

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    await migrate({ adminUrl: base.toString(), dir: MIGRATIONS });
    const c = new pg.Client({ connectionString: base.toString() });
    await c.connect();
    try {
      // Tables and partitioned tables of every crove_* schema; partitions belong to their parent (pg-boss makes one per
      // queue at runtime).
      catalog = (
        await c.query<{ schema: string; table: string }>(
          `SELECT n.nspname AS schema, c.relname AS table FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname LIKE 'crove\\_%' ORDER BY 1, 2`,
        )
      ).rows;
      columnRows = (
        await c.query<{ schema: string; table: string; column: string }>(
          `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
             FROM pg_catalog.pg_attribute a
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname LIKE 'crove\\_%' AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY 1, 2, a.attnum`,
        )
      ).rows;
      grants = (await c.query<Grant>('SELECT role_key, permission FROM crove_kernel.role_permission ORDER BY 1, 2')).rows;
      // The bodies of every function of a crove_* schema and the expressions of every row-level security policy on its
      // tables, for the permissions they check.
      const texts = (
        await c.query<{ source: string; text: string }>(
          `SELECT 'function ' || n.nspname || '.' || p.proname AS source, p.prosrc AS text
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname LIKE 'crove\\_%' AND p.prosrc IS NOT NULL
           UNION ALL
           SELECT 'policy ' || schemaname || '.' || tablename || '.' || policyname, COALESCE(qual, '') || ' ' || COALESCE(with_check, '')
             FROM pg_catalog.pg_policies WHERE schemaname LIKE 'crove\\_%'
           ORDER BY 1`,
        )
      ).rows;
      const read = texts.map((t) => sqlPermissionUses(t.source, t.text));
      sqlUses = read.flatMap((r) => r.uses);
      sqlProblems = read.flatMap((r) => r.problems);
      // The tables crove_kernel.make_append_only() guards: its row trigger refuses every UPDATE and DELETE.
      appendOnly = new Set(
        (
          await c.query<{ table: string }>(
            `SELECT n.nspname || '.' || c.relname AS table
               FROM pg_catalog.pg_trigger t
               JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
               JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
              WHERE t.tgname = 'append_only_row' AND pn.nspname = 'crove_kernel' AND p.proname = 'reject_mutation' AND n.nspname LIKE 'crove\\_%'`,
          )
        ).rows.map((r) => r.table),
      );
      // The numbering series (#1401) the triggers on crove_* tables allocate their rows' numbers in.
      const triggers = (
        await c.query<{ table: string; by: string; body: string }>(
          `SELECT n.nspname || '.' || c.relname AS table, 'trigger ' || t.tgname || ' (' || pn.nspname || '.' || p.proname || ')' AS by, p.prosrc AS body
             FROM pg_catalog.pg_trigger t
             JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
             JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
            WHERE NOT t.tgisinternal AND n.nspname LIKE 'crove\\_%' AND p.prosrc LIKE '%crove\\_kernel.number\\_allocate(%'
            ORDER BY 1, 2`,
        )
      ).rows;
      for (const t of triggers) {
        const found = numberingCalls(t.table, t.by, t.body);
        numbering.push(...found.calls);
        numberingProblems.push(...found.problems);
      }
      // Every other function that allocates numbers: the commands' definer only (ctx.numbering.allocate).
      allocators = (
        await c.query<{ fn: string }>(
          `SELECT n.nspname || '.' || p.proname AS fn FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE p.prosrc LIKE '%crove\\_kernel.number\\_allocate(%' AND p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype ORDER BY 1`,
        )
      ).rows.map((r) => r.fn);
    } finally {
      await c.end();
    }
  }, 300_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives every crove_* table exactly one owning module', () => {
    const owners = new Map<string, string[]>();
    for (const [id, { manifest }] of Object.entries(MANIFESTS)) {
      for (const [schema, tables] of Object.entries(manifest.tables)) for (const t of Object.keys(tables)) owners.set(`${schema}.${t}`, [...(owners.get(`${schema}.${t}`) ?? []), id]);
    }
    const unowned = catalog.filter((r) => !owners.has(`${r.schema}.${r.table}`)).map((r) => `${r.schema}.${r.table}`);
    const schemaOwner = (schema: string) => Object.entries(MANIFESTS).find(([, m]) => schema in m.manifest.tables)?.[1]?.file ?? 'the manifest of the module that owns the schema';
    expect(
      unowned.map((t) => `${t}: add it to ${schemaOwner(t.split('.')[0] as string)}`),
      'tables no module manifest names (plan §5.2): add each to its module manifest',
    ).toEqual([]);
    const shared = [...owners.entries()].filter(([, ids]) => ids.length > 1).map(([t, ids]) => `${t}: ${ids.join(', ')}`);
    expect(shared, 'tables named by more than one manifest').toEqual([]);
  });

  it('names no table that does not exist', () => {
    const existing = new Set(catalog.map((r) => `${r.schema}.${r.table}`));
    const missing: string[] = [];
    for (const { manifest, file } of Object.values(MANIFESTS)) {
      for (const [schema, tables] of Object.entries(manifest.tables)) for (const t of Object.keys(tables)) if (!existing.has(`${schema}.${t}`)) missing.push(`${schema}.${t} (${file})`);
    }
    expect(missing, 'manifest entries for tables the migrations do not create: remove them').toEqual([]);
  });

  it('classifies every column of every crove_* table, and no column that does not exist (plan §5.2)', () => {
    expect(columnRows.length).toBeGreaterThan(1000);
    const known = classified();
    const tableFile = new Map<string, string>();
    for (const { manifest, file } of Object.values(MANIFESTS)) for (const [schema, tables] of Object.entries(manifest.tables)) for (const t of Object.keys(tables)) tableFile.set(`${schema}.${t}`, file);
    const unclassified = columnRows
      .filter((r) => tableFile.has(`${r.schema}.${r.table}`) && !known.has(`${r.schema}.${r.table}.${r.column}`))
      .map((r) => `${r.schema}.${r.table}.${r.column}: classify it in ${tableFile.get(`${r.schema}.${r.table}`)}`);
    expect(unclassified, 'columns with no data class: list each under its table, internal or with its class').toEqual([]);
    const existing = new Set(columnRows.map((r) => `${r.schema}.${r.table}.${r.column}`));
    const stale = [...known.entries()].filter(([key]) => !existing.has(key)).map(([key, { file }]) => `${key} (${file})`);
    expect(stale, 'classified columns the migrations do not create: remove them').toEqual([]);
  });

  it('agrees with the personal-data registry (#923)', () => {
    const known = classified();
    const wrong: string[] = [];
    for (const [key, entry] of Object.entries(PERSONAL_DATA_COLUMNS) as Array<[string, PersonalDataColumn]>) {
      const cls = known.get(key)?.cls;
      if (!cls) continue; // A missing column fails the registry's own invariant test.
      const handlings = [entry.handling, ...(entry.override ? [entry.override.handling] : [])];
      if (!handlings.some((h) => PERSONAL_HANDLINGS.includes(h))) continue;
      if (!CLASS_OF_KIND[entry.kind].includes(cls)) wrong.push(`${key}: ${cls}, but the registry holds it as ${entry.kind} (${entry.handling}); expected ${CLASS_OF_KIND[entry.kind].join(' or ')}`);
    }
    expect(wrong, 'personal data classified as something else').toEqual([]);
  });

  it('declares every permission a role grants or something checks, with the seeded rows as its default roles (#1630)', () => {
    const { uses, problems } = staticPermissionUses();
    expect(problems).toEqual([]);
    // Every function and policy names its permissions in a form the scan attributes (#1641).
    expect(sqlProblems, 'database functions or policies that name a permission the manifest check cannot read').toEqual([]);
    // The database names three permissions on main: unlock_period(), the accountant preset's chief accountant guard and
    // vat_return_filed_guard (#1508).
    expect([...new Set(sqlUses.map((u) => u.permission))].sort()).toEqual(['finance.period.unlock', 'finance.proposal.approve', 'finance.vat.file']);
    expect(grants.length).toBeGreaterThan(0);
    expect(
      permissionProblems(MANIFESTS, { uses: [...uses, ...sqlUses], grants }),
      'permissions the manifests do not declare as the migrations grant and the code checks them',
    ).toEqual([]);
  });

  it('declares every entity as its table, its numbering series and the commands name it (#1656)', () => {
    expect(numberingProblems).toEqual([]);
    // The voucher triggers number on main (#1401); a series numbered through ctx.numbering.allocate has no trigger, and
    // its first command extends this check.
    expect(numbering.map((n) => `${n.table} ${n.docType} ${n.targetType}`)).toEqual([
      'crove_finance.cash_voucher finance.cash_voucher.<voucher_type> finance.cash_voucher',
      'crove_finance.journal_voucher finance.journal_voucher finance.journal_voucher',
    ]);
    expect(allocators).toEqual(['crove_kernel.allocate_number']);
    expect(appendOnly.has('crove_finance.journal_entry')).toBe(true);
    const cols = new Map<string, Set<string>>();
    for (const r of columnRows) cols.set(`${r.schema}.${r.table}`, (cols.get(`${r.schema}.${r.table}`) ?? new Set()).add(r.column));
    const targets = commandTargetTypes();
    expect(targets.problems).toEqual([]);
    expect(
      entityProblems(MANIFESTS, { columns: cols, appendOnly, numbering }, targets.uses),
      'entities that do not match the catalog or the commands (plan §5.2): change the manifest',
    ).toEqual([]);
  });

  it('keeps each manifest sorted, one schema per module except the kernel infrastructure', () => {
    for (const { manifest, file } of Object.values(MANIFESTS)) {
      for (const tables of Object.values(manifest.tables)) expect(Object.keys(tables), file).toEqual(Object.keys(tables).sort());
      const types = manifest.entities.map((e) => e.type);
      expect(types, file).toEqual([...types].sort());
    }
    for (const id of ['finance', 'social', 'crm', 'notes']) expect(Object.keys(MANIFESTS[id]!.manifest.tables), id).toEqual([`crove_${id}`]);
  });
});

describe('columns()', () => {
  it('makes the listed columns internal and refuses a column given two classes', () => {
    expect(columns(['id', 'org_id'], { email: 'contact' })).toEqual({ id: 'internal', org_id: 'internal', email: 'contact' });
    expect(() => columns(['email'], { email: 'contact' })).toThrow(/email/);
    expect(columns(['id'], Object.fromEntries([['constructor', 'pii' as const]]))).toEqual(Object.fromEntries([['id', 'internal'], ['constructor', 'pii']]));
    expect(DATA_CLASSES).toContain('national_id_if_individual');
  });
});
