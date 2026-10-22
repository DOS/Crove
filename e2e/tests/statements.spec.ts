// The DRAFT financial statements (issue #154) on the ledger screen: the tab shows B01-DNN and B02-DNN for the
// period under the notice that nobody has verified the mapping, and downloads them as Excel. The figures themselves
// are checked against posted entries in apps/kernel/test/finance-ledger.db.test.ts.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('shows the draft B01 and B02 of a period and exports them', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('statements'));
  const slug = await createOrg(page, 'Công ty Báo cáo tài chính');
  await page.getByRole('navigation').getByRole('link', { name: 'Sổ sách' }).click();
  await page.getByRole('tab', { name: 'Báo cáo tài chính' }).click();
  await expect(page.getByText('Bản nháp: mã chỉ tiêu và cách lấy số liệu từ tài khoản chưa được kế toán kiểm tra', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Báo cáo tình hình tài chính \(B01-DNN\)/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Báo cáo kết quả hoạt động kinh doanh \(B02-DNN\)/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'TỔNG CỘNG TÀI SẢN' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất Excel báo cáo tài chính' }).click();
  expect((await download).suggestedFilename()).toMatch(new RegExp(`^crove-bao-cao-tai-chinh-\\d{4}-\\d{2}-${slug}\\.xlsx$`));
});
