import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'modules/*/test/**/*.test.ts', 'apps/kernel/test/**/*.test.ts', 'apps/extract/test/**/*.test.ts', 'apps/app/test/**/*.test.ts', 'tools/test/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'db',
          include: ['packages/*/test/**/*.db.test.ts', 'modules/*/test/**/*.db.test.ts', 'apps/kernel/test/**/*.db.test.ts'],
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
