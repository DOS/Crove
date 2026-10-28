// The assisted sync from the tax portal (issue #325), end to end against the fake portal of the e2e stack
// (e2e/fake-tax-portal, compose service tax-portal), never the real one: set the org's tax code -> on "Đối chiếu cổng
// thuế", open "Lấy danh sách từ cổng thuế" -> a wrong password is refused in words and a new CAPTCHA is shown -> with the
// right password, the September 2026 list is fetched and recorded, and the XML of the invoices the portal has a code for
// is downloaded into the Inbox. The password never reaches the browser's storage.
import { expect, test, type Page } from '@playwright/test';
import { FAKE_CAPTCHA_ANSWER, FAKE_PORTAL_PASSWORD } from '../fake-tax-portal/server.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

// The fixture's synthetic buyer (checksum-invalid on purpose, #157); the fake portal names the logged-in tax code as the
// buyer of every invoice.
const BUYER_TAX_CODE = '0309876546';
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

async function choosePeriod(page: Page) {
  await page.getByRole('combobox', { name: 'Tháng', exact: true }).selectOption('9');
  await page.getByRole('combobox', { name: 'Năm', exact: true }).selectOption('2026');
}

async function fillLogin(page: Page, password: string) {
  const panel = page.getByRole('region', { name: 'Lấy danh sách từ cổng thuế' });
  await expect(panel.getByRole('img', { name: 'Ảnh mã xác nhận của cổng thuế' })).toBeVisible({ timeout: 30_000 });
  await panel.getByLabel('Mật khẩu cổng thuế').fill(password);
  await panel.getByLabel('Mã xác nhận', { exact: true }).fill(FAKE_CAPTCHA_ANSWER);
  const consent = panel.getByRole('checkbox', { name: 'Khách hàng đã đồng ý', exact: false });
  if ((await consent.getAttribute('aria-checked')) !== 'true') await consent.click();
  await panel.getByRole('button', { name: 'Đăng nhập và lấy danh sách' }).click();
  return panel;
}

test('fetch the period purchase list and invoice XML from the tax portal', async ({ page }) => {
  await test.step('sign up, create the org and set its tax code', async () => {
    await page.goto('/');
    await signUp(page, newEmail('portalsync'));
  });
  await createOrg(page, 'Công ty Lấy hóa đơn E2E');
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Nhập', exact: true }).click();
  const form = page.getByRole('form', { name: 'Mã số thuế' });
  await form.getByLabel('Mã số thuế').fill(BUYER_TAX_CODE);
  await form.getByRole('button', { name: 'Lưu' }).click();
  // The org's own field (a <dd>): the legal entities card shows the default entity's code too (#1278).
  await expect(page.getByRole('definition').getByText(BUYER_TAX_CODE, { exact: true })).toBeVisible();

  await nav.getByRole('link', { name: 'Kế toán', exact: true }).click();
  await nav.getByRole('link', { name: 'Đối chiếu cổng thuế' }).click();
  await choosePeriod(page);
  await page.getByRole('button', { name: 'Lấy danh sách từ cổng thuế' }).click();
  const panel = page.getByRole('region', { name: 'Lấy danh sách từ cổng thuế' });

  await test.step('the user name is the tax code; the password field is not remembered', async () => {
    await expect(panel.getByLabel('Tên đăng nhập (mã số thuế)')).toHaveValue(BUYER_TAX_CODE);
    const password = panel.getByLabel('Mật khẩu cổng thuế');
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveAttribute('autocomplete', 'off');
  });

  await test.step('a wrong password is refused in words, with a new CAPTCHA', async () => {
    await fillLogin(page, 'not-the-portal-password');
    await expect(panel.getByText('Cổng thuế không chấp nhận mật khẩu này', { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByLabel('Mật khẩu cổng thuế')).toHaveValue('');
    // The fake portal takes each CAPTCHA key once, like the real one: the login below works only because the screen
    // fetched a new CAPTCHA after the refusal.
  });

  await test.step('the right password fetches the list and the XML', async () => {
    await fillLogin(page, FAKE_PORTAL_PASSWORD);
    await expect(panel.getByText('Đã lấy 5 hóa đơn từ cổng thuế.')).toBeVisible({ timeout: 120_000 });
    await expect(panel.getByText('Đã tải 3 tệp XML về Hộp thư chứng từ', { exact: false })).toBeVisible();
    const list = page.getByRole('row').filter({ hasText: 'Cổng thuế 2026-09.json' });
    await expect(list.getByText('Đã đọc 5 hóa đơn')).toBeVisible({ timeout: 60_000 });
  });

  await test.step('the password is in no browser storage', async () => {
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain(FAKE_PORTAL_PASSWORD);
  });

  await test.step('the downloaded invoices wait in the Inbox', async () => {
    await nav.getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await expect(page.getByRole('row').filter({ has: page.getByRole('link', { name: SELLER }) })).toHaveCount(2, { timeout: 120_000 });
    await expect(page.getByRole('row').filter({ hasText: 'CÔNG TY CỔ PHẦN VẬT TƯ MẪU' })).toHaveCount(1, { timeout: 60_000 });
  });

  await test.step('the reconciliation counts them as waiting in the Inbox', async () => {
    await nav.getByRole('link', { name: 'Kế toán', exact: true }).click();
    await nav.getByRole('link', { name: 'Đối chiếu cổng thuế' }).click();
    // A fresh read: the screen's cached comparison is from before the proposals existed.
    await page.reload();
    await choosePeriod(page);
    await expect(page.getByRole('heading', { name: 'Đang chờ duyệt trong Hộp thư (3)' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Cơ quan thuế có, Ludy chưa có (2)' })).toBeVisible();
  });
});
