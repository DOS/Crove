// The DRAFT financial statements (issue #154) on the ledger screen: the tab shows B01-DNN and B02-DNN for the
// period under the notice that nobody has verified the mapping, and downloads them as Excel. The figures themselves
// are checked against posted entries in apps/kernel/test/finance-ledger.db.test.ts.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('shows the draft B01 and B02 of a period and exports them', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('statements'));
  const slug = await createOrg(page, 'Công ty Báo cáo tài chính');
  await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Sổ sách' }).click();
  await page.getByRole('tab', { name: 'Báo cáo tài chính' }).click();
  await expect(page.getByText('Bản nháp: mã chỉ tiêu và cách lấy số liệu từ tài khoản chưa được kế toán kiểm tra', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Báo cáo tình hình tài chính \(B01-DNN\)/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Báo cáo kết quả hoạt động kinh doanh \(B02-DNN\)/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'TỔNG CỘNG TÀI SẢN' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất Excel báo cáo tài chính' }).click();
  expect((await download).suggestedFilename()).toMatch(new RegExp(`^ludy-bao-cao-tai-chinh-\\d{4}-\\d{2}-${slug}\\.xlsx$`));

  // The period and the tab live in the address (#1513): a reload keeps them, and Back returns to the previous period.
  await page.getByLabel('Kỳ báo cáo').selectOption('quarter');
  await expect(page).toHaveURL(/[?&]period=\d{4}-Q[1-4]/);
  await expect(page).toHaveURL(/[?&]report=statements/);
  await page.reload();
  await expect(page.getByLabel('Kỳ báo cáo')).toHaveValue('quarter');
  await expect(page.getByRole('tab', { name: 'Báo cáo tài chính' })).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page.getByLabel('Kỳ báo cáo')).toHaveValue('month');
});

// The comparison columns (#2090): B01 beside its start of year, B02 against the same month last year or, picked, the month
// before. The figures are checked in apps/kernel/test/finance-ledger.db.test.ts; a new org has none, so every cell reads 0.
test('shows the start-of-year and previous-period columns, on a desktop and on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await signInNewUser(page, newEmail('statements-compare'));
  await createOrg(page, 'Công ty cột so sánh');
  await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Sổ sách' }).click();
  await page.getByRole('tab', { name: 'Báo cáo tài chính' }).click();
  const total = page.getByRole('row', { name: /TỔNG CỘNG TÀI SẢN/ });
  const startOfYear = page.getByRole('columnheader', { name: /^Số đầu năm \(/ });
  const lastYear = page.getByRole('columnheader', { name: /^Cùng kỳ năm trước \(\d{4}-\d{2}\)$/ });
  const before = page.getByRole('columnheader', { name: /^Kỳ liền trước \(\d{4}-\d{2}\)$/ });

  await test.step('on a desktop B01 has a start of year and B02 the same month last year', async () => {
    await expect(page.getByRole('columnheader', { name: 'Số cuối kỳ' })).toBeVisible();
    await expect(startOfYear).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Kỳ này' })).toBeVisible();
    await expect(lastYear).toBeVisible();
    await expect(before).toHaveCount(0);
    // No entries in a new org: the start of year reads 0, not an error or a blank.
    await expect(total.getByRole('cell').last()).toHaveText(/^0/);
  });

  await test.step('the period before replaces the column when picked, and a year has only its previous year', async () => {
    await page.getByLabel('So sánh với').selectOption('previous');
    await expect(before).toBeVisible();
    await expect(lastYear).toHaveCount(0);
    await page.getByLabel('Kỳ báo cáo').selectOption('year');
    await expect(page.getByLabel('So sánh với')).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Năm nay' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /^Năm trước \(\d{4}\)$/ })).toBeVisible();
    await page.getByLabel('Kỳ báo cáo').selectOption('month');
    await expect(page.getByLabel('So sánh với')).toBeVisible();
  });

  await test.step('on a phone the tables scroll inside their box and the page does not scroll sideways', async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    await startOfYear.scrollIntoViewIfNeeded();
    await expect(startOfYear).toBeInViewport();
    await expect(total.getByRole('cell').last()).toHaveText(/^0/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  });
});
