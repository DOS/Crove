// The org's overview (issue #1249), end to end: a new org says nothing waits and offers the upload; once an invoice is
// in, the overview counts its proposal and one click on the count opens the Inbox that holds it.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

test('the overview counts what waits and opens the screen that clears it', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('overview'));
  await createOrg(page, 'Công ty Tổng Quan');
  const overview = page.getByRole('navigation').getByRole('link', { name: 'Tổng quan' });

  await test.step('a new org has nothing waiting, and the tax calendar says why it is empty', async () => {
    await overview.click();
    await expect(page.getByRole('heading', { name: 'Tổng quan', exact: true })).toBeVisible();
    await expect(page.getByText('Không có việc gì đang chờ bạn')).toBeVisible();
    await expect(page.getByText('Chưa chọn kỳ khai thuế')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Chọn kỳ khai' })).toBeVisible();
  });

  await test.step('an invoice in the Inbox shows as one proposal to approve', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await overview.click();
    const proposals = page.getByRole('link', { name: /^1 đề xuất bút toán chờ duyệt/ });
    await expect(proposals).toBeVisible();
    await proposals.click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible();
  });
});
