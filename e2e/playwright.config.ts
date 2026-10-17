// Runs against a stack started with `pnpm --filter @crove/e2e stack:up` (docker compose, project crove-e2e).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // One stack, one flow: tests share the database, so they run one at a time.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // A flaky end-to-end test is a bug to fix, not to retry.
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    // The SPA takes its language from the browser (#47); the tests read the Vietnamese screens.
    locale: 'vi-VN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
