// The desktop sidebar on a short window (#516): its footer (sign out, the account menu) and the app switcher's foot
// (Settings) stay in view, and the Social home at phone width (#1043). The sidebar sticks to the top at the window's
// height, so a footer below the fold could never be scrolled to. Each app's menu fits a 1366x768 laptop without
// scrolling, and a deep link opens with its app selected (#1528). The same session walks every screen of every app
// under Trusted Types (#681) and expects no CSP violation; it shares this spec's sign-up because every spec draws on
// one sign-up budget (auth-rate-limits.spec.ts).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { collectCspViolations } from '../lib/csp.ts';
import { createOrg, newEmail, signInNewUser, signUp } from '../lib/session.ts';

test.use({ viewport: { width: 1280, height: 600 } });

test('the sidebar keeps sign-out and Settings in view on a short window, and each app has its own short menu', async ({ page }) => {
  const violations = await collectCspViolations(page);
  await signUp(page, newEmail('layout'));
  const slug = await createOrg(page, 'Công ty Màn hình nhỏ');
  const sidebar = page.getByRole('complementary');
  const signOut = sidebar.getByRole('button', { name: 'Đăng xuất', exact: true });
  await expect(signOut).toBeInViewport();
  await expect(sidebar.getByRole('link', { name: 'Cài đặt' })).toBeInViewport();

  // A deep link opens with its app selected, and only that app's menu shows.
  const apps = sidebar.getByRole('list', { name: 'Ứng dụng' });
  await page.goto(`/o/${slug}/journal`);
  await expect(apps.getByRole('link', { name: 'Kế toán', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(sidebar.getByRole('link', { name: 'Sổ sách' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Hộp thư chứng từ' })).toHaveCount(0);

  // On a 1366x768 laptop no app's menu scrolls.
  await page.setViewportSize({ width: 1366, height: 768 });
  const menuScrolls = () => sidebar.locator('.overflow-y-auto').evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(await menuScrolls()).toBe(false);

  // Every screen of every app, each opened from a fresh document so the listener sees its first render.
  const links = new Set<string>();
  const appCount = await apps.getByRole('link').count();
  expect(appCount).toBeGreaterThan(1);
  for (let i = 0; i < appCount; i++) {
    await apps.getByRole('link').nth(i).click();
    await page.waitForLoadState('networkidle');
    expect(await menuScrolls(), `app ${i}`).toBe(false);
    for (const path of await sidebar.getByRole('link').evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).pathname))) links.add(path);
  }
  expect(links.size).toBeGreaterThan(5);
  await page.setViewportSize({ width: 1280, height: 600 });
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

// Every sidebar screen at phone width, in both themes (#1517; DESIGN.md §7 and §10): the page never scrolls sideways,
// and axe finds no serious or critical violation of the WCAG 2.2 AA rules. The screens are the links of every app's
// menu, gathered at desktop width where the sidebar shows; each is then opened from a fresh document. Its own user,
// created confirmed without the sign-up form, so it draws nothing from the sign-up budget.
test('every sidebar screen fits 360px with no horizontal scroll and passes an axe scan, in light and dark (#1517)', async ({ page }) => {
  test.setTimeout(300_000);
  await signInNewUser(page, newEmail('layout-a11y'));
  await createOrg(page, 'Công ty Kiểm tra truy cập');
  const sidebar = page.getByRole('complementary');
  const apps = sidebar.getByRole('list', { name: 'Ứng dụng' });
  const links = new Set<string>();
  const appCount = await apps.getByRole('link').count();
  expect(appCount).toBeGreaterThan(1);
  for (let i = 0; i < appCount; i++) {
    await apps.getByRole('link').nth(i).click();
    await page.waitForLoadState('networkidle');
    // The app's own screens only: the sidebar also links out (the support address).
    const paths = await sidebar.getByRole('link').evaluateAll((anchors) => anchors.filter((a) => (a as HTMLAnchorElement).origin === location.origin).map((a) => (a as HTMLAnchorElement).pathname));
    for (const path of paths) links.add(path);
  }
  expect(links.size).toBeGreaterThan(5);

  await page.setViewportSize({ width: 360, height: 780 });
  const problems: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    // The theme the app reads at load (lib/theme.ts), from this browser only.
    await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
    for (const path of links) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
      if (widths.page > widths.view) problems.push(`${theme} ${path}: scrolls sideways (${widths.page}px in ${widths.view}px)`);
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      for (const v of scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')) {
        problems.push(`${theme} ${path}: ${v.impact} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
      }
    }
  }
  expect(problems).toEqual([]);
});

// The Social home's nine tabs at phone width (#1043): they wrap inside the screen, and the page never scrolls sideways.
// Its own user, created confirmed without the sign-up form, so it draws nothing from the sign-up budget.
test.describe('at phone width', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the Social home fits its tab row at 360px with no horizontal scroll (#1043)', async ({ page }) => {
    await signInNewUser(page, newEmail('layout-social'));
    const slug = await createOrg(page, 'Công ty Màn hình hẹp');
    await page.goto(`/o/${slug}/social`);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(10);
    await expect(page.getByRole('tab', { name: 'Thư viện ảnh' })).toBeVisible();
    // Every tab lies inside the screen, without scrolling the page or the tab row.
    for (const box of await tabs.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as { left: number; right: number }))) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(360);
    }
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth, tabs: document.querySelector('[role="tablist"]')?.scrollWidth ?? 0 }));
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    expect(widths.tabs).toBeLessThanOrEqual(widths.view);
  });

  // The phone's menu (#1245): a drawer with the app switcher (#1528) and the current app's menu, which stays open when
  // the app changes and closes after a screen's link, on Esc, and on its backdrop.
  test('the menu button opens a drawer with the app switcher, and it closes after navigating or on Esc (#1245)', async ({ page }) => {
    await signInNewUser(page, newEmail('layout-drawer'));
    await createOrg(page, 'Công ty Menu điện thoại');
    const open = page.getByRole('button', { name: 'Mở menu' });
    await open.click();
    const drawer = page.getByRole('dialog', { name: 'Menu chính' });
    await expect(drawer.getByRole('region', { name: 'Trang chủ' }).getByRole('link', { name: 'Hộp thư chứng từ' })).toBeVisible();
    await drawer.getByRole('link', { name: 'Kế toán', exact: true }).click();
    await expect(page).toHaveURL(/\/documents$/);
    await expect(drawer.getByRole('region', { name: 'Kế toán' }).getByRole('link', { name: 'Sổ sách' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Đăng xuất', exact: true })).toBeVisible();
    await drawer.getByRole('link', { name: 'Sổ sách' }).click();
    await expect(page).toHaveURL(/\/ledger$/);
    await expect(drawer).toBeHidden();

    await open.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(open).toBeFocused();

    // A tap beside the drawer, on the backdrop, closes it too.
    await open.click();
    await page.mouse.click(350, 400);
    await expect(drawer).toBeHidden();
  });
});
