// The personal-data registry against the database (issue #923, PDPL), on a real PostgreSQL 17. Every column of the
// tenant schemas whose name looks like personal data (an email, a phone, an address, a tax code, a person's name, a
// recipient) is classified in PERSONAL_DATA_COLUMNS (packages/kernel/src/personal-data.ts), so a new one cannot escape
// an erasure request unclassified; and every classified column exists, so the list does not rot. Part of the invariant
// suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a
// superuser URL; the run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@crove/db/migrate';
import { PERSONAL_DATA_COLUMNS, PERSONAL_DATA_NAME_PATTERN, PERSONAL_DATA_SCHEMAS } from '@crove/kernel';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

// Control-plane tables: not tenant data, never read by tenant code (control-plane-reads.test.ts keeps the list).
const CONTROL_PLANE = ['user_account', 'auth_session', 'inbound_address', 'inbound_pending', 'auth_email_send', 'stream_ticket', 'global_kill_switch'];

const suite = ADMIN ? describe : describe.skip;

suite('personal-data registry (#923)', () => {
  const dbName = `crove_test_pdpl_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
  });

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  async function columns(where: string, params: unknown[]): Promise<string[]> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ key: string }>(
        `SELECT n.nspname || '.' || c.relname || '.' || a.attname AS key
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND ${where}
          ORDER BY 1`,
        params,
      );
      return rows.map((r) => r.key);
    } finally {
      await admin.end();
    }
  }

  it('classifies every column of the tenant schemas whose name looks like personal data', async () => {
    const found = await columns(`n.nspname = ANY($1::text[]) AND a.attname ~ $2 AND NOT (n.nspname = 'crove_kernel' AND c.relname = ANY($3::text[]))`, [
      [...PERSONAL_DATA_SCHEMAS],
      PERSONAL_DATA_NAME_PATTERN,
      CONTROL_PLANE,
    ]);
    expect(found.length).toBeGreaterThan(15);
    const unclassified = found.filter((key) => !(key in PERSONAL_DATA_COLUMNS));
    expect(unclassified, 'classify these in packages/kernel/src/personal-data.ts').toEqual([]);
  });

  it('lists only columns that exist', async () => {
    const keys = Object.keys(PERSONAL_DATA_COLUMNS);
    const existing = new Set(await columns(`n.nspname || '.' || c.relname || '.' || a.attname = ANY($1::text[])`, [keys]));
    expect(keys.filter((key) => !existing.has(key))).toEqual([]);
  });
});
