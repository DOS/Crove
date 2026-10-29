// The desktop sidebar on a short window (#516): its footer (sign out, the account menu) and the app switcher's foot
// (Settings) stay in view, and the Social home at phone width (#1043). The sidebar sticks to the top at the window's
// height, so a footer below the fold could never be scrolled to. Each app's menu fits a 1366x768 laptop without
// scrolling, and a deep link opens with its app selected (#1528). The same session walks every screen of every app
// under Trusted Types (#681) and expects no CSP violation; it shares this spec's sign-up because every spec draws on
// one sign-up budget (auth-rate-limits.spec.ts).
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { collectCspViolations } from '../lib/csp.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { createOrg, newEmail, signInNewUser, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test.use({ viewport: { width: 1280, height: 600 } });

// The landmark and heading rules of axe (best-practice): one <main>, all content inside a landmark, landmarks told apart,
// one h1, and no heading that skips a level.
const STRUCTURE_RULES = ['landmark-one-main', 'region', 'landmark-unique', 'page-has-heading-one', 'heading-order'];

// The e-invoice the Inbox specs upload, and its parties (synthetic tax codes, checksum-invalid on purpose, #157).
const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER_TAX_CODE = '0101234564';
const BUYER = 'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU';

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

// The paths of every app's menu, gathered at desktop width where the sidebar shows: the app's own screens only, since
// the sidebar also links out (the support address).
async function appScreens(page: Page): Promise<string[]> {
  const sidebar = page.getByRole('complementary');
  const apps = sidebar.getByRole('list', { name: 'Ứng dụng' });
  const links = new Set<string>();
  const appCount = await apps.getByRole('link').count();
  expect(appCount).toBeGreaterThan(1);
  for (let i = 0; i < appCount; i++) {
    await apps.getByRole('link').nth(i).click();
    await page.waitForLoadState('networkidle');
    const paths = await sidebar.getByRole('link').evaluateAll((anchors) => anchors.filter((a) => (a as HTMLAnchorElement).origin === location.origin).map((a) => (a as HTMLAnchorElement).pathname));
    for (const path of paths) links.add(path);
  }
  expect(links.size).toBeGreaterThan(5);
  return [...links];
}

// Opens each path from a fresh document at 360px, in light and dark, and returns what fails (DESIGN.md §7 and §10): a
// page that scrolls sideways, a serious or critical violation of the WCAG 2.2 AA rules, and any landmark or heading
// order violation.
async function phoneWidthProblems(page: Page, paths: readonly string[]): Promise<string[]> {
  await page.setViewportSize({ width: 360, height: 780 });
  const problems: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    // The theme the app reads at load (lib/theme.ts), from this browser only.
    await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
      if (widths.page > widths.view) problems.push(`${theme} ${path}: scrolls sideways (${widths.page}px in ${widths.view}px)`);
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      for (const v of scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')) {
        problems.push(`${theme} ${path}: ${v.impact} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
      }
      // Landmarks and heading order (DESIGN.md §7, #1593): axe files these under best-practice, not WCAG, so they are
      // asked for by id, and any violation counts whatever its impact.
      const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
      for (const v of structure.violations) problems.push(`${theme} ${path}: ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
    }
  }
  return problems;
}

// Every sidebar screen at phone width, in both themes (#1517; DESIGN.md §7 and §10): the page never scrolls sideways,
// and axe finds no serious or critical violation of the WCAG 2.2 AA rules. Each screen is opened from a fresh document.
// Its own user, created confirmed without the sign-up form, so it draws nothing from the sign-up budget.
test('every sidebar screen fits 360px with no horizontal scroll and passes an axe scan, in light and dark (#1517)', async ({ page }) => {
  test.setTimeout(300_000);
  await signInNewUser(page, newEmail('layout-a11y'));
  await createOrg(page, 'Công ty Kiểm tra truy cập');
  expect(await phoneWidthProblems(page, await appScreens(page))).toEqual([]);
});

// The same walk on an org with data (#1572), so what a screen shows only then (table rows, badges, a proposal's detail,
// a post's channels) is scanned too. The data comes through the app, as a user makes it: an approved sale e-invoice,
// whose buyer becomes a customer, and a Social post waiting for review on the sandbox channel. Their detail pages join
// the sidebar's screens.
test('every sidebar screen and the detail pages pass the 360px and axe walk on an org with data (#1572)', async ({ page }) => {
  test.setTimeout(360_000);
  await signInNewUser(page, newEmail('layout-a11y-data'));
  const slug = await createOrg(page, 'Công ty Có dữ liệu');
  const details: string[] = [];
  const problems: string[] = [];

  await test.step('make the org the invoice seller, so the invoice is a sale and its buyer a customer', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
    await page.getByRole('button', { name: 'Nhập', exact: true }).click();
    const taxForm = page.getByRole('form', { name: 'Mã số thuế' });
    await taxForm.getByLabel('Mã số thuế').fill(SELLER_TAX_CODE);
    await taxForm.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.getByRole('definition').getByText(SELLER_TAX_CODE, { exact: true })).toBeVisible();
  });

  await test.step('upload the e-invoice, walk the Inbox and the proposal while it waits, and approve it with a second factor', async () => {
    await page.goto(`/o/${slug}/inbox`);
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    const proposal = page.getByRole('row').filter({ has: page.getByRole('link', { name: BUYER }) });
    await expect(proposal).toBeVisible({ timeout: 60_000 });
    await proposal.getByRole('link', { name: BUYER }).click();
    const detail = new URL(page.url()).pathname;
    details.push(detail);
    // Pending, the list has its row and the detail its checks and approve controls: walked now, before approving.
    problems.push(...(await phoneWidthProblems(page, [`/o/${slug}/inbox`, detail])));
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto(detail);
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await expect(page.getByText('Không có đề xuất nào chờ duyệt')).toBeVisible();
    // Its buyer is now a customer.
    await page.goto(`/o/${slug}/customers`);
    await expect(page.getByRole('row').filter({ hasText: BUYER })).toBeVisible();
  });

  await test.step('connect the sandbox channel and submit a post for review', async () => {
    await page.goto(`/o/${slug}/social`);
    await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
    await page.getByLabel('Tên kênh thử').fill('Fanpage Kiểm tra');
    await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
    await expect(page.getByText('Fanpage Kiểm tra').first()).toBeVisible();
    await page.getByRole('link', { name: 'Quay lại' }).click();
    await page.getByRole('link', { name: 'Soạn bài' }).click();
    await page.getByLabel('Nội dung chung').fill('Khai trương chi nhánh mới, giảm 10% tuần đầu.');
    await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
    await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Chờ duyệt', { exact: true })).toBeVisible();
    details.push(new URL(page.url()).pathname);
  });

  // The approved proposal's tab, and the ledger and VAT screens on the invoice's month (September 2026): they open on
  // the month before today by default, which holds the invoice only while that is September.
  details.push(
    `/o/${slug}/inbox?status=executed`,
    `/o/${slug}/ledger?period=2026-09`,
    `/o/${slug}/ledger?period=2026-09&report=parties`,
    `/o/${slug}/vat?period=2026-09`,
  );
  await page.goto(`/o/${slug}/inbox`);
  problems.push(...(await phoneWidthProblems(page, [...(await appScreens(page)), ...details])));
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
