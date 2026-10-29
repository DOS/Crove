// Every table of a crove_* schema with an org_id column is deleted by crove_kernel.org_purge or on KEPT with a reason
// (#1217), on a freshly migrated database: a table a migration adds without restating org_purge, or whose restatement
// another migration's restatement overwrote, fails here with its name and the migration to restate. The reading and
// the messages are in org-purge-coverage.ts and org-purge-coverage.test.ts; what the purge does is org-purge.db.test.ts.
//
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the test creates and drops its own database.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@crove/db/migrate';
import { KEPT, MIGRATIONS_DIR, purgeCoverageProblems, readMigrations, readPurgeCatalog, type PurgeCatalog } from './org-purge-coverage.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const suite = ADMIN ? describe : describe.skip;

suite('org purge covers every org table (#1217)', () => {
  const dbName = `crove_test_purgecover_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let admin: pg.Client;
  let created = false;
  let catalog: PurgeCatalog;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    await migrate({ adminUrl: url.toString(), dir: MIGRATIONS_DIR });
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      catalog = await readPurgeCatalog(client);
    } finally {
      await client.end();
    }
  }, 300_000);

  afterAll(async () => {
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('reads the org tables and the purge', () => {
    expect(catalog.tables).toContain('crove_kernel.tenant_member');
    expect(catalog.cascades).toContainEqual({ child: 'crove_kernel.role_assignment', parent: 'crove_kernel.tenant_member' });
  });

  it('deletes or keeps, with a reason, every crove_* table with org_id', () => {
    expect(purgeCoverageProblems(catalog, KEPT, readMigrations())).toEqual([]);
  });
});
