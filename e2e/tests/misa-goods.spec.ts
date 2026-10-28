// MISA SME goods purchases (issue #1398), end to end: set the MISA item and warehouse codes of account 156 in Settings,
// upload an e-invoice and put its first line on 156 (goods into stock), approve it, then download both purchase
// exports from the journal: the stock line in the goods template with the codes, the other lines in the services one.
import { fileURLToPath } from 'node:url';
import { expect, test, type Download } from '@playwright/test';
import ExcelJS from 'exceljs';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

async function sheetOf(file: Download, name: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await file.path());
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`sheet ${name} missing`);
  const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  return { sheet, cell: (row: number, column: string) => sheet.getRow(row).getCell(header.indexOf(column) + 1).value };
}

test('set the MISA codes of a stock account, book a stock line, and export it in the goods purchase template', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('misa-goods'));
  const slug = await createOrg(page, 'Công ty Mua hàng E2E');
  const nav = page.getByRole('navigation');

  await test.step('the stock accounts show the default codes in Settings; set the codes of 156', async () => {
    await nav.getByRole('link', { name: 'Cài đặt' }).click();
    const card = page.getByLabel('Mã hàng và mã kho cho MISA');
    await expect(card.getByText('Hóa đơn mua nguyên vật liệu, công cụ dụng cụ và hàng hóa', { exact: false })).toBeVisible();
    const goods = card.getByRole('listitem').filter({ hasText: '156 · Hàng hóa' });
    await expect(goods).toContainText('Mã hàng HH · Kho KHH');
    await expect(goods).toContainText('Mặc định');
    await expect(card.getByRole('listitem').filter({ hasText: '152 · ' })).toContainText('Mã hàng NVL · Kho KNVL');
    await goods.getByRole('button', { name: 'Sửa mã MISA của tài khoản 156' }).click();
    const form = goods.getByRole('form', { name: 'Sửa mã MISA của tài khoản 156' });
    await form.getByLabel('Mã hàng').fill('THEP01');
    await form.getByLabel('Mã kho').fill('KHO-HN');
    await form.getByRole('button', { name: 'Lưu' }).click();
    await expect(goods).toContainText('Mã hàng THEP01 · Kho KHO-HN');
    await expect(goods.getByText('Mặc định', { exact: true })).toHaveCount(0);
    await expect(goods.getByRole('button', { name: 'Bỏ mã đã đặt của tài khoản 156' })).toBeVisible();
  });

  await test.step('upload the e-invoice, put its first line on 156 and approve it', async () => {
    await nav.getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: SELLER }).click();
    await expect(page.getByRole('heading', { name: SELLER })).toBeVisible();
    await page.getByLabel('Tài khoản nợ cho dòng 1').selectOption('156');
    await page.getByRole('button', { name: 'Lưu chỉnh sửa' }).click();
    await expect(page.getByRole('button', { name: 'Lưu chỉnh sửa' })).toHaveCount(0);
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await expect(page.getByText('Việc này cần xác thực hai lớp.')).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  });

  await test.step('the goods file holds the stock line with the codes; the services file the other lines', async () => {
    await nav.getByRole('link', { name: 'Kế toán', exact: true }).click();
    await nav.getByRole('link', { name: 'Bút toán' }).click();
    let download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Xuất chứng từ mua hàng nhập kho cho MISA' }).click();
    let file = await download;
    expect(file.suggestedFilename()).toBe(`ludy-misa-mua-hang-nhap-kho-${slug}.xlsx`);
    const goods = await sheetOf(file, 'Chứng từ mua hàng nhập kho');
    expect(goods.sheet.rowCount).toBe(2);
    expect(goods.cell(2, 'Số phiếu nhập (*)')).toMatch(/^CRMH[0-9A-F]{12}$/);
    expect(goods.cell(2, 'Mã hàng (*)')).toBe('THEP01');
    expect(goods.cell(2, 'Kho')).toBe('KHO-HN');
    expect(goods.cell(2, 'TK kho (*)')).toBe('156');
    expect(goods.cell(2, 'TK công nợ/TK tiền (*)')).toBe('331');
    expect(goods.cell(2, 'Số hóa đơn')).toBe('1234');
    expect(goods.cell(2, 'Thành tiền')).toBe(1000000);
    expect(goods.cell(2, 'Tiền thuế GTGT')).toBe(100000);

    download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Xuất chứng từ mua dịch vụ cho MISA' }).click();
    file = await download;
    expect(file.suggestedFilename()).toBe(`ludy-misa-mua-dich-vu-${slug}.xlsx`);
    const services = await sheetOf(file, 'Chứng từ mua dịch vụ');
    // The second service line and the trade discount; together with the goods line the VAT is the invoice's 180,000.
    expect(services.sheet.rowCount).toBe(3);
    expect([2, 3].map((r) => services.cell(r, 'Tiền thuế GTGT'))).toEqual([100000, -20000]);
    expect(services.cell(2, 'Số chứng từ (*)')).toMatch(/^CRMDV[0-9A-F]{12}$/);
  });
});
