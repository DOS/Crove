// The free-text matcher's database functions (#1948) against the shared case table, as the tenant login calls them:
// crove_kernel.pii_text_pattern answers the same expression as piiTextPattern, and pii_text_matches and pii_text_redact
// the same as their TypeScript twins (pii-text.test.ts).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { piiTextPattern } from '@crove/kernel';
import { PII_TEXT_CASES } from './pii-text-cases.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the free-text matcher in the database (#1948)', () => {
  const dbName = `crove_test_pii_text_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let app: pg.Client;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    await migrate({ adminUrl: base.toString(), dir: MIGRATIONS });
    await setRolePasswords(base.toString(), { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    base.username = 'crove_app';
    base.password = 'test-app-pw';
    app = new pg.Client({ connectionString: base.toString() });
    await app.connect();
  }, 300_000);

  afterAll(async () => {
    await app?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it.each(PII_TEXT_CASES)('$name', async ({ text, value, redacted }) => {
    const { rows } = await app.query<{ pattern: string | null; matches: boolean; redacted: string }>(
      `SELECT crove_kernel.pii_text_pattern($2) AS pattern, crove_kernel.pii_text_matches($1, $2) AS matches,
              crove_kernel.pii_text_redact($1, $2) AS redacted`,
      [text, value],
    );
    expect(rows[0]).toEqual({ pattern: piiTextPattern(value), matches: redacted !== text, redacted });
  });

  it('answers false and the text itself for a NULL text or a value that is none', async () => {
    const { rows } = await app.query(
      `SELECT crove_kernel.pii_text_matches(NULL, 'ab@x.com') AS a, crove_kernel.pii_text_redact(NULL, 'ab@x.com') AS b,
              crove_kernel.pii_text_pattern(NULL) AS c, crove_kernel.pii_text_matches('ab@x.com', NULL) AS d`,
    );
    expect(rows[0]).toEqual({ a: false, b: null, c: null, d: false });
  });
});
