// The landing page's accessibility and language checks (#1629, project a11y) and its performance budget (#1655, project
// perf): test/*.spec.ts. CI starts the apps/web image and sets WEB_BASE_URL; without it Playwright builds the site and
// starts it on port 3000 (or reuses a server already there).
import { defineConfig, devices } from '@playwright/test';

const external = process.env.WEB_BASE_URL;
const baseURL = external ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './test',
  testMatch: '*.spec.ts',
  forbidOnly: Boolean(process.env.CI),
  // A flaky check is a bug to fix, not to retry.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'a11y',
      testIgnore: 'perf*.spec.ts',
      // The scroll-driven reveal and the hero's replay settle at once, so axe sees each section in its final colors
      // instead of halfway through a fade (globals.css, prefers-reduced-motion).
      use: { ...devices['Desktop Chrome'], reducedMotion: 'reduce' },
    },
    {
      // Measured as a visitor sees the page, motion included. Each test sets its own viewport and throttling; run it
      // with one worker (test:perf), so no other test competes for the CPU it measures.
      name: 'perf',
      testMatch: 'perf*.spec.ts',
      // No trace or screenshots: recording them runs in the throttled renderer and would add to what is measured.
      use: { ...devices['Desktop Chrome'], trace: 'off', screenshot: 'off' },
      timeout: 120_000,
    },
  ],
  webServer: external ? undefined : { command: 'pnpm build && pnpm start', url: baseURL, reuseExistingServer: true, timeout: 300_000 },
});
