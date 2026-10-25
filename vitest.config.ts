import { defineConfig } from 'vitest/config';

// Database test files a CI part leaves to another part (#1041): comma-separated globs from the repository root.
const DB_EXCLUDE = (process.env.CROVE_DB_TEST_EXCLUDE ?? '').split(',').filter(Boolean);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'modules/*/test/**/*.test.ts', 'apps/kernel/test/**/*.test.ts', 'apps/extract/test/**/*.test.ts', 'apps/app/test/**/*.test.{ts,tsx}', 'tools/test/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', 'packages/agent/test/**/*.ai.test.ts', '**/node_modules/**'],
        },
      },
      {
        // Live AI suites (conformance, extraction evals): `pnpm ai:conformance` / `pnpm ai:eval`. They call the
        // endpoint in AI_BASE_URL / AI_MODEL and skip themselves when it is not set.
        test: {
          name: 'ai',
          include: ['packages/agent/test/**/*.ai.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 300_000,
        },
      },
      {
        test: {
          name: 'db',
          include: ['packages/*/test/**/*.db.test.ts', 'modules/*/test/**/*.db.test.ts', 'apps/kernel/test/**/*.db.test.ts'],
          exclude: ['**/node_modules/**', ...DB_EXCLUDE],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
