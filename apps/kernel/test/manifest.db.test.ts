// Module manifests against the catalog (plan §10 G3 "manifest matches catalog", §5.2; #1588) on PostgreSQL 17: after
// every migration, each table of a crove_* schema belongs to exactly one module manifest, under that manifest's schema,
// and each table a manifest names exists. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@crove/db/migrate';
import { kernelManifest } from '@crove/kernel';
import type { ModuleManifest } from '@crove/kernel-contract';
import { crmManifest } from '@crove/mod-crm';
import { financeManifest } from '@crove/mod-finance';
import { socialManifest } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
// The control plane's tables in crove_kernel (plan §3.6): no app, module or package source may name them (the
// control-plane-reads invariant), so their owner is declared here, beside the module manifests.
const CONTROL_PLANE: ModuleManifest = {
  id: 'control-plane',
  tables: { crove_kernel: ['auth_email_send', 'auth_session', 'global_kill_switch', 'inbound_address', 'inbound_pending', 'stream_ticket', 'user_account'] },
};
const MANIFESTS: Record<string, { manifest: ModuleManifest; file: string }> = {
  'control-plane': { manifest: CONTROL_PLANE, file: 'apps/kernel/test/manifest.db.test.ts (CONTROL_PLANE)' },
  kernel: { manifest: kernelManifest, file: 'packages/kernel/src/manifest.ts' },
  finance: { manifest: financeManifest, file: 'modules/finance/src/manifest.ts' },
  social: { manifest: socialManifest, file: 'modules/social/src/manifest.ts' },
  crm: { manifest: crmManifest, file: 'modules/crm/src/manifest.ts' },
};
const suite = ADMIN ? describe : describe.skip;

suite('module manifests against the catalog (#1588)', () => {
  const dbName = `crove_test_manifest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let catalog: Array<{ schema: string; table: string }> = [];

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
      for (const [schema, tables] of Object.entries(manifest.tables)) for (const t of tables) owners.set(`${schema}.${t}`, [...(owners.get(`${schema}.${t}`) ?? []), id]);
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
      for (const [schema, tables] of Object.entries(manifest.tables)) for (const t of tables) if (!existing.has(`${schema}.${t}`)) missing.push(`${schema}.${t} (${file})`);
    }
    expect(missing, 'manifest entries for tables the migrations do not create: remove them').toEqual([]);
  });

  it('keeps each manifest sorted, one schema per module except the kernel infrastructure', () => {
    for (const { manifest, file } of Object.values(MANIFESTS)) {
      for (const tables of Object.values(manifest.tables)) expect([...tables], file).toEqual([...tables].sort());
    }
    for (const id of ['finance', 'social', 'crm']) expect(Object.keys(MANIFESTS[id]!.manifest.tables), id).toEqual([`crove_${id}`]);
  });
});
