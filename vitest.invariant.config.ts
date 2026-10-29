// Runner config for the invariant suite (Decision 7, External-tenant gate T15). On protected-path PRs,
// .github/workflows/protected.yml takes this file, every test/invariant/ directory and the pgTAP gate files
// (supabase/tests/database/_*.test.sql, #1643) from the base branch and runs them against the PR's code, so the
// PR's own vitest.config.ts cannot exclude or weaken them.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The context token key of the test suites (#1822), as in vitest.config.ts.
const env = { CROVE_CONTEXT_TOKEN_KEY: 'dGVzdC1vbmx5LWNvbnRleHQtdG9rZW4ta2V5LTAxMjM0NTY3ODk=' };

export default defineConfig({
  test: {
    env,
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['apps/*/test/invariant/**/*.test.ts', 'packages/*/test/invariant/**/*.test.ts', 'modules/*/test/invariant/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    fileParallelism: false,
    testTimeout: 30_000,
    // An empty suite must fail the gate; the workflow also fails when any invariant test is skipped.
    passWithNoTests: false,
  },
});
