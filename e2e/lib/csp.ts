import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

// Collects every CSP violation of each document from its first script, before the app runs (#681).
export async function collectCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations?.push(`${e.effectiveDirective}: ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  return () => page.evaluate(() => window.__cspViolations ?? []);
}
