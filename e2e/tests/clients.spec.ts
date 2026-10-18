// The multi-client home screen (issue #318), end to end: an accountant with two companies lands on the overview, sees
// each company's waiting invoices and VAT deadline (quarterly for one, not chosen for the other), opens a company with
// one click and comes back from the sidebar.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

test('an accountant sees every company on one screen and opens one with a click', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('clients'));
  const first = await createOrg(page, 'Công ty An Bình');

  await test.step('the first company files quarterly and has an invoice waiting', async () => {
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
    await page.getByLabel('Kỳ khai thuế GTGT').selectOption({ label: 'Theo quý' });
    await expect(page.getByLabel('Kỳ khai thuế GTGT')).toHaveValue('quarter');
    await expect(page.getByLabel('Kỳ khai thuế GTGT')).toBeEnabled();
  });

  const second = await test.step('a second company', async () => {
    await page.goto('/onboarding');
    return createOrg(page, 'Công ty Bình Minh');
  });

  await test.step('signing in again lands on the overview of both companies', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/clients$/);
    await expect(page.getByRole('heading', { name: 'Tổng quan các doanh nghiệp' })).toBeVisible();
    const anBinh = page.getByRole('row').filter({ hasText: 'Công ty An Bình' });
    const binhMinh = page.getByRole('row').filter({ hasText: 'Công ty Bình Minh' });
    await expect(anBinh.getByRole('link', { name: '1', exact: true })).toBeVisible();
    await expect(anBinh.getByText(/^Quý [1-4]\/\d{4} · (còn \d+ ngày|hạn cuối là hôm nay)$/)).toBeVisible();
    await expect(binhMinh.getByText('Chưa chọn kỳ khai thuế')).toBeVisible();
    await expect(binhMinh.getByRole('link', { name: 'Chọn kỳ khai' })).toBeVisible();
    // The company with a deadline comes first.
    await expect(page.getByRole('row').nth(1)).toContainText('Công ty An Bình');
  });

  await test.step('one click opens a company, and the sidebar leads back', async () => {
    await page.getByRole('link', { name: 'Công ty Bình Minh' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${second}/inbox$`));
    await page.getByRole('complementary').getByRole('link', { name: 'Tất cả doanh nghiệp' }).click();
    await expect(page).toHaveURL(/\/clients$/);
    await page.getByRole('row').filter({ hasText: 'Công ty An Bình' }).getByRole('link', { name: '1', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${first}/inbox$`));
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible();
  });
});
