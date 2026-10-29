import { defineConfig } from 'vitest/config';

// The context token key of the test suites (#1822): public, refused by the kernel's config on a public URL. The
// migration runner installs it in every test database and runtimes sign their user contexts with it.
const env = { CROVE_CONTEXT_TOKEN_KEY: Buffer.from('test-only-context-token-key-0123456789').toString('base64') };

// Database test files a CI part leaves to another part (#1041): comma-separated globs from the repository root.
const DB_EXCLUDE = (process.env.CROVE_DB_TEST_EXCLUDE ?? '').split(',').filter(Boolean);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          env,
          include: ['packages/*/test/**/*.test.ts', 'modules/*/test/**/*.test.ts', 'apps/kernel/test/**/*.test.ts', 'apps/extract/test/**/*.test.ts', 'apps/app/test/**/*.test.{ts,tsx}', 'apps/web/test/**/*.test.ts', 'tools/test/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', 'packages/agent/test/**/*.ai.test.ts', '**/node_modules/**'],
        },
      },
      {
        // Live AI suites (conformance, extraction evals): `pnpm ai:conformance` / `pnpm ai:eval`. They call the
        // endpoint in AI_BASE_URL / AI_MODEL and skip themselves when it is not set.
        test: {
          name: 'ai',
          env,
          include: ['packages/agent/test/**/*.ai.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 300_000,
        },
      },
      {
        test: {
          name: 'db',
          env,
          include: ['packages/*/test/**/*.db.test.ts', 'modules/*/test/**/*.db.test.ts', 'apps/kernel/test/**/*.db.test.ts'],
          exclude: ['**/node_modules/**', ...DB_EXCLUDE],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
