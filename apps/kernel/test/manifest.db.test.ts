// Module manifests against the catalog (plan §10 G3 "manifest matches catalog", §5.2; #1588, #1599) on PostgreSQL 17:
// after every migration, each table of a crove_* schema belongs to exactly one module manifest, under that manifest's
// schema, each table a manifest names exists, every column of those tables has a data class and every classified column
// exists, and personal data the PDPL registry (#923) erases or keeps is not classified internal. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@crove/db/migrate';
import { PERSONAL_DATA_COLUMNS, kernelManifest, type PersonalDataColumn, type PersonalDataHandling, type PersonalDataKind } from '@crove/kernel';
import { DATA_CLASSES, columns, type DataClass, type ModuleManifest } from '@crove/kernel-contract';
import { crmManifest } from '@crove/mod-crm';
import { financeManifest } from '@crove/mod-finance';
import { socialManifest } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
// The control plane's tables in crove_kernel (plan §3.6): no app, module or package source may name them (the
// control-plane-reads invariant), so their owner is declared here, beside the module manifests.
const CONTROL_PLANE: ModuleManifest = {
  id: 'control-plane',
  tables: {
    crove_kernel: {
      auth_email_send: columns(['id', 'client_hash', 'target_hash', 'reserved_at']),
      auth_session: columns(['user_id', 'session_id', 'status', 'first_seen_at', 'last_seen_at', 'revoked_at', 'revoked_by', 'reason', 'evidence_at']),
      global_kill_switch: columns(['id', 'key', 'engaged', 'reason', 'changed_by', 'changed_at']),
      inbound_address: columns(['org_id', 'id', 'created_at', 'retired_at'], { token: 'sensitive' }),
      inbound_pending: columns(['seq', 'blob_id', 'raw_sha256', 'size_bytes', 'received_at'], { recipient: 'sensitive' }),
      stream_ticket: columns(['ticket_hash', 'user_id', 'stream_org_id', 'session_id', 'aal', 'mfa_at', 'token_expires_at', 'expires_at', 'created_at']),
      user_account: columns(['id', 'issuer', 'created_at', 'last_seen_at', 'disabled_at'], { subject: 'pii', email: 'contact', display_name: 'pii' }),
    },
  },
};
const MANIFESTS: Record<string, { manifest: ModuleManifest; file: string }> = {
  'control-plane': { manifest: CONTROL_PLANE, file: 'apps/kernel/test/manifest.db.test.ts (CONTROL_PLANE)' },
  kernel: { manifest: kernelManifest, file: 'packages/kernel/src/manifest.ts' },
  finance: { manifest: financeManifest, file: 'modules/finance/src/manifest.ts' },
  social: { manifest: socialManifest, file: 'modules/social/src/manifest.ts' },
  crm: { manifest: crmManifest, file: 'modules/crm/src/manifest.ts' },
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

  it('keeps each manifest sorted, one schema per module except the kernel infrastructure', () => {
    for (const { manifest, file } of Object.values(MANIFESTS)) {
      for (const tables of Object.values(manifest.tables)) expect(Object.keys(tables), file).toEqual(Object.keys(tables).sort());
    }
    for (const id of ['finance', 'social', 'crm']) expect(Object.keys(MANIFESTS[id]!.manifest.tables), id).toEqual([`crove_${id}`]);
  });
});

describe('columns()', () => {
  it('makes the listed columns internal and refuses a column given two classes', () => {
    expect(columns(['id', 'org_id'], { email: 'contact' })).toEqual({ id: 'internal', org_id: 'internal', email: 'contact' });
    expect(() => columns(['email'], { email: 'contact' })).toThrow(/email/);
    expect(columns(['id'], { constructor: 'pii' })).toEqual({ id: 'internal', constructor: 'pii' });
    expect(DATA_CLASSES).toContain('national_id_if_individual');
  });
});
