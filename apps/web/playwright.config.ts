// The landing page's accessibility and language checks (#1629): test/*.spec.ts. CI starts the apps/web image and sets
// WEB_BASE_URL; without it Playwright builds the site and starts it on port 3000 (or reuses a server already there).
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
    // The scroll-driven reveal and the hero's replay settle at once, so axe sees each section in its final colors
    // instead of halfway through a fade (globals.css, prefers-reduced-motion).
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external ? undefined : { command: 'pnpm build && pnpm start', url: baseURL, reuseExistingServer: true, timeout: 300_000 },
});
