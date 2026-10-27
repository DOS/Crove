// The modules' pgTAP tests (plan §10 G3, §5.3 naming table, issue #1627): every supabase/tests/database/<token>/*.test.sql
// runs on a real PostgreSQL 17 after every migration, in the `db` test project. The runner, its TAP check, the vendored
// pgTAP, the layout test and the gate files (supabase/tests/database/_*.test.sql) are in the invariant suite
// (test/invariant/pgtap-gate.db.test.ts and test/invariant/pgtap/), so on protected-path PRs the base branch's copy
// judges the gate files (#1643); this file only runs the modules' tests with that runner.
//
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODULE_FILE, listTests, pgtapDatabase, runTestFile, type PgtapDatabase } from './invariant/pgtap/runner.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const suite = ADMIN ? describe : describe.skip;

suite('pgTAP tests of the modules in supabase/tests/database', () => {
  let db: PgtapDatabase | undefined;

  beforeAll(async () => {
    const created = pgtapDatabase(ADMIN as string);
    db = created;
    await created.ready;
  }, 300_000);

  afterAll(async () => {
    await db?.drop();
  });

  it.each(listTests().filter((f) => MODULE_FILE.test(f)))('%s', async (file) => {
    expect(await runTestFile((db as PgtapDatabase).url, file), file).toEqual([]);
  });
});
