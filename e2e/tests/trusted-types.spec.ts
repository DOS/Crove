// Trusted Types (#681): the kernel serves the SPA with `require-trusted-types-for 'script'; trusted-types 'none'`.
// Every screen of the sidebar renders without a single CSP violation, and the policy is really enforced: a string
// written to an HTML sink throws in the page and is reported as a violation.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

test('every screen renders under Trusted Types with no CSP violation, and a raw HTML sink is refused', async ({ page }) => {
  // Collected from the first script on every document, before the app runs.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations?.push(`${e.effectiveDirective}: ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  const violations = () => page.evaluate(() => window.__cspViolations ?? []);

  const login = await page.goto('/login');
  const csp = login?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toContain("trusted-types 'none'");

  await signUp(page, newEmail('trusted-types'));
  await createOrg(page, 'Công ty Trusted Types');

  // Every screen the sidebar links to, each opened from a fresh document so the listener sees its first render.
  const links = await page
    .getByRole('complementary')
    .getByRole('link')
    .evaluateAll((anchors) => [...new Set(anchors.map((a) => (a as HTMLAnchorElement).pathname))]);
  expect(links.length).toBeGreaterThan(5);
  for (const path of links) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await violations(), path).toEqual([]);
  }

  // Enforced, not only declared: a string written to innerHTML throws and is reported.
  const refused = await page.evaluate(() => {
    try {
      document.createElement('div').innerHTML = '<img src=x onerror=alert(1)>';
      return null;
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(refused).toBe('TypeError');
  await expect.poll(violations).toEqual([expect.stringMatching(/^require-trusted-types-for: trusted-types-sink/)]);
});
