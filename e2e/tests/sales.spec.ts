// Sales e-invoices (issue #313), end to end: set the org's tax code in Settings -> upload an e-invoice the org issued
// -> a sale proposal in the Inbox (the buyer is the customer) -> approve -> Documents, the journal (Dr 131, Cr 511,
// Cr 3331), the MISA sales export and the output side of the VAT working.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
// The fixture's synthetic tax codes: checksum-invalid on purpose (#157). The org is the fixture's seller here.
const SELLER_TAX_CODE = '0101234564';
const BUYER = 'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU';
const BUYER_TAX_CODE = '0309876546';
const MEMO = `HĐ bán C26TAB-1234 ${BUYER}`;

test('set the tax code, upload a sales e-invoice, approve it, then find it in the lists, the exports and the VAT working', async ({ page }) => {
  await test.step('sign up and create the org', async () => {
    await page.goto('/');
    await signUp(page, newEmail('sales'));
  });
  const slug = await createOrg(page, 'Công ty Bán hàng E2E');
  const nav = page.getByRole('navigation');

  await test.step('set the org tax code in Settings', async () => {
    await nav.getByRole('link', { name: 'Cài đặt' }).click();
    await expect(page.getByText('Chưa nhập', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Nhập', exact: true }).click();
    const form = page.getByRole('form', { name: 'Mã số thuế' });
    await form.getByLabel('Mã số thuế').fill('12345');
    await form.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.getByText('Mã số thuế không hợp lệ', { exact: false })).toBeVisible();
    await form.getByLabel('Mã số thuế').fill(SELLER_TAX_CODE);
    await form.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.getByText(SELLER_TAX_CODE, { exact: true })).toBeVisible();
  });

  await test.step('upload the e-invoice the org issued and open the sale proposal', async () => {
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    const proposal = page.getByRole('row').filter({ has: page.getByRole('link', { name: BUYER }) });
    await expect(proposal).toBeVisible({ timeout: 60_000 });
    await expect(proposal.getByText('Bán ra')).toBeVisible();
    await proposal.getByRole('link', { name: BUYER }).click();
    await expect(page.getByRole('heading', { name: BUYER })).toBeVisible();
    await expect(page.getByText('Hóa đơn bán ra: người bán có mã số thuế của tổ chức.', { exact: false })).toBeVisible();
    await expect(page.getByRole('main').getByText('Khách hàng', { exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'TK doanh thu' })).toBeVisible();
  });

  await test.step('approve it with a second factor', async () => {
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await expect(page.getByText('Việc này cần xác thực hai lớp.')).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await expect(page.getByText('Không có đề xuất nào chờ duyệt')).toBeVisible();
  });

  await test.step('the sale in Documents and the journal', async () => {
    await nav.getByRole('link', { name: 'Chứng từ', exact: true }).click();
    const document = page.getByRole('row').filter({ hasText: 'C26TAB-1234' });
    await expect(document.getByRole('cell')).toHaveText(['15/09/2026', 'C26TAB-1234', 'Bán ra', BUYER, /^1\.800\.000/, /^180\.000/, /^1\.980\.000/, 'Đã ghi sổ']);

    await nav.getByRole('link', { name: 'Bút toán' }).click();
    await expect(page.getByText(MEMO)).toBeVisible();
    const line = (account: string) => page.getByRole('row').filter({ has: page.getByRole('cell', { name: new RegExp(`^${account} `) }) });
    await expect(line('131').getByRole('cell')).toHaveText([/^131 /, /^1\.980\.000/, '']);
    await expect(line('511').getByRole('cell')).toHaveText([/^511 /, '', /^1\.800\.000/]);
    await expect(line('3331').getByRole('cell')).toHaveText([/^3331 /, '', /^180\.000/]);
  });

  await test.step('the MISA sales export', async () => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Xuất chứng từ bán hàng cho MISA' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`crove-misa-ban-hang-${slug}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(await file.path());
    const sheet = workbook.getWorksheet('Chứng từ bán hàng');
    if (!sheet) throw new Error('the MISA export has no sales sheet');
    const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    const cell = (row: number, name: string) => sheet.getRow(row).getCell(header.indexOf(name) + 1).value;
    // One row per invoice line: two services and the discount.
    expect(sheet.rowCount).toBe(4);
    for (const row of [2, 3, 4]) {
      expect(cell(row, 'Tên khách hàng')).toBe(BUYER);
      expect(cell(row, 'Mã số thuế')).toBe(BUYER_TAX_CODE);
      expect(cell(row, 'TK Tiền/Chi phí/Nợ (*)')).toBe('131');
      expect(cell(row, 'TK Doanh thu/Có (*)')).toBe('511');
      expect(cell(row, 'TK thuế GTGT')).toBe('3331');
    }
  });

  await test.step('the output side of the VAT working for September 2026', async () => {
    await nav.getByRole('link', { name: 'Tờ khai GTGT' }).click();
    await page.getByLabel('Kỳ khai', { exact: true }).selectOption('month');
    await page.getByLabel('Năm', { exact: true }).selectOption('2026');
    await page.getByLabel('Tháng', { exact: true }).selectOption('9');
    const indicator = (code: string) => page.getByRole('row').filter({ has: page.getByRole('cell', { name: `[${code}]`, exact: true }) });
    await expect(indicator('32').getByRole('cell').last()).toHaveText(/^1\.800\.000/);
    await expect(indicator('33').getByRole('cell').last()).toHaveText(/^180\.000/);
    await expect(indicator('23').getByRole('cell').last()).toHaveText(/^0/);
    await expect(page.getByRole('heading', { name: 'Hóa đơn bán ra (1)' })).toBeVisible();
    await expect(page.getByText('Không có hóa đơn mua vào trong kỳ này')).toBeVisible();
  });
});
