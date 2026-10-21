// Trusted Types (#681): the kernel serves the SPA with `require-trusted-types-for 'script'; trusted-types 'none'`,
// and the policy is really enforced: a string written to an HTML sink throws in the page and is reported as a
// violation. The signed-in screens are walked in layout.spec.ts, which already signs up: every spec shares one
// client address and Supabase Auth's sign-up budget (auth-rate-limits.spec.ts), so this spec adds no sign-up.
import { expect, test } from '@playwright/test';
import { collectCspViolations } from '../lib/csp.ts';

test('the login page renders under Trusted Types with no CSP violation, and a raw HTML sink is refused', async ({ page }) => {
  const violations = await collectCspViolations(page);

  const login = await page.goto('/login');
  const csp = login?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toContain("trusted-types 'none'");
  await page.waitForLoadState('networkidle');
  expect(await violations()).toEqual([]);

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
