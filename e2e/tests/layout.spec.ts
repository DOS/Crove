// The desktop sidebar on a short window (#516): the menu scrolls inside the sidebar and its footer (sign out, language)
// stays in view. The sidebar sticks to the top at the window's height, so a footer below the fold could never be
// scrolled to. The same session walks every screen the sidebar links to under Trusted Types (#681) and expects no CSP
// violation; it shares this spec's sign-up because every spec draws on one sign-up budget (auth-rate-limits.spec.ts).
import { expect, test } from '@playwright/test';
import { collectCspViolations } from '../lib/csp.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

test.use({ viewport: { width: 1280, height: 600 } });

test('the sidebar keeps sign-out in view on a short window, and its menu scrolls', async ({ page }) => {
  const violations = await collectCspViolations(page);
  await signUp(page, newEmail('layout'));
  await createOrg(page, 'Công ty Màn hình nhỏ');
  const sidebar = page.getByRole('complementary');
  const signOut = sidebar.getByRole('button', { name: 'Đăng xuất', exact: true });
  await expect(signOut).toBeInViewport();

  // The last menu item is reached by scrolling the menu; the footer stays where it is.
  const settings = sidebar.getByRole('link', { name: 'Cài đặt' });
  await settings.scrollIntoViewIfNeeded();
  await expect(settings).toBeInViewport();
  await expect(signOut).toBeInViewport();

  // Every screen the sidebar links to, each opened from a fresh document so the listener sees its first render.
  const links = await sidebar
    .getByRole('link')
    .evaluateAll((anchors) => [...new Set(anchors.map((a) => (a as HTMLAnchorElement).pathname))]);
  expect(links.length).toBeGreaterThan(5);
  for (const path of links) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await violations(), path).toEqual([]);
  }

  // Back to the home screen: some linked screens have their own layout without this sidebar.
  await page.goto('/');
  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
});
