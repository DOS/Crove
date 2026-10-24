// Customers (issue #670), end to end: a sale proposal links its customer to the customers screen -> once approved the
// customer is listed with its tax code, receivable on 131 and last invoice date -> search by tax code and name -> the
// owner adds its contact details with the vendors' editor -> the receivables report links back to it.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
// The fixture's synthetic tax codes: checksum-invalid on purpose (#157). The org is the fixture's seller here.
const SELLER_TAX_CODE = '0101234564';
const BUYER = 'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU';
const BUYER_TAX_CODE = '0309876546';

test('lists the customer of an approved sale with its receivable, edits it, and links to it from the proposal and the receivables report', async ({ page }) => {
  await test.step('sign up, create the org and set its tax code', async () => {
    await page.goto('/');
    await signUp(page, newEmail('customers'));
  });
  const slug = await createOrg(page, 'Công ty Khách hàng E2E');
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Nhập', exact: true }).click();
  const taxForm = page.getByRole('form', { name: 'Mã số thuế' });
  await taxForm.getByLabel('Mã số thuế').fill(SELLER_TAX_CODE);
  await taxForm.getByRole('button', { name: 'Lưu' }).click();
  // The org's own field (a <dd>): the legal entities card shows the default entity's code too (#1278).
  await expect(page.getByRole('definition').getByText(SELLER_TAX_CODE, { exact: true })).toBeVisible();

  await test.step('no customers yet', async () => {
    await nav.getByRole('link', { name: 'Khách hàng' }).click();
    await expect(page.getByRole('heading', { name: 'Khách hàng' })).toBeVisible();
    await expect(page.getByText('Chưa có khách hàng')).toBeVisible();
  });

  await test.step('the sale proposal links its customer to the customers screen', async () => {
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    const proposal = page.getByRole('row').filter({ has: page.getByRole('link', { name: BUYER }) });
    await expect(proposal).toBeVisible({ timeout: 60_000 });
    await proposal.getByRole('link', { name: BUYER }).click();
    const toCustomer = page.getByRole('link', { name: 'Xem trong danh sách khách hàng' });
    await expect(toCustomer).toHaveAttribute('href', `/o/${slug}/customers?q=${BUYER_TAX_CODE}`);
  });

  await test.step('approve it with a second factor', async () => {
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await expect(page.getByText('Không có đề xuất nào chờ duyệt')).toBeVisible();
  });

  const row = page.getByRole('row').filter({ hasText: BUYER });

  await test.step('the customer with its tax code, invoices, last invoice date and receivable', async () => {
    await nav.getByRole('link', { name: 'Khách hàng' }).click();
    for (const header of ['Tên', 'Mã số thuế', 'Hóa đơn', 'Hóa đơn gần nhất', 'Công nợ phải thu']) {
      await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
    }
    await expect(row.getByRole('cell').nth(1)).toHaveText(BUYER_TAX_CODE);
    await expect(row.getByRole('cell').nth(2)).toHaveText('1');
    await expect(row.getByRole('cell').nth(3)).toHaveText('15/09/2026');
    await expect(row.getByRole('cell').nth(4)).toHaveText(/^1\.980\.000/);
  });

  await test.step('search by tax code and by name', async () => {
    const search = page.getByRole('searchbox', { name: 'Tìm theo tên hoặc MST' });
    await search.fill('030987');
    await expect(row).toBeVisible();
    await search.fill('không có ai');
    await expect(page.getByText('Không có khách hàng nào khớp')).toBeVisible();
    await search.fill('người mua');
    await expect(row).toBeVisible();
    await search.fill('');
  });

  await test.step('the owner adds the contact email and phone with the editor shared with vendors', async () => {
    await row.getByRole('button', { name: `Sửa thông tin của ${BUYER}` }).click();
    const form = page.getByRole('form', { name: `Sửa thông tin của ${BUYER}` });
    // The tax code is how invoices find the customer: it cannot be changed once set.
    await expect(form.getByLabel('Mã số thuế')).toBeDisabled();
    await form.getByLabel('Email').fill('ketoan@nguoimua.test');
    await form.getByLabel('Điện thoại').fill('028 3822 0000');
    await form.getByRole('button', { name: 'Lưu' }).click();
    await expect(form).toBeHidden();
    await expect(row.getByRole('cell').first()).toContainText('028 3822 0000 · ketoan@nguoimua.test');
  });

  await test.step('the receivables report links the customer back to the customers screen', async () => {
    await nav.getByRole('link', { name: 'Sổ sách' }).click();
    await page.getByLabel('Kỳ báo cáo', { exact: true }).selectOption('month');
    await page.getByLabel('Năm', { exact: true }).selectOption('2026');
    await page.getByLabel('Tháng', { exact: true }).selectOption('9');
    await page.getByRole('tab', { name: 'Công nợ' }).click();
    await page.getByRole('link', { name: BUYER }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/customers\\?q=${BUYER_TAX_CODE}$`));
    await expect(page.getByRole('searchbox', { name: 'Tìm theo tên hoặc MST' })).toHaveValue(BUYER_TAX_CODE);
    await expect(row.getByRole('cell').nth(4)).toHaveText(/^1\.980\.000/);
  });
});
