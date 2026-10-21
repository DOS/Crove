// The tax portal's purchase list (issue #465), end to end: set the org's tax code -> upload a purchase e-invoice (it
// waits in the Inbox) -> on "Đối chiếu cổng thuế", upload the portal's list for September 2026 -> the list is read in
// the parsing sandbox and compared: one invoice waiting in the Inbox, one the tax authority has that Crove lacks. A
// file that is not the portal's list is kept with the reason it cannot be used, and a list can be removed. The company
// is asked for the missing invoice by email (#669), once the owner has set its contact email.
// The list is written with ExcelJS (shared strings, styled header), another writer than the portal's own (inline
// strings), so the reader is exercised on both.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
// The fixture's synthetic tax codes (checksum-invalid on purpose, #157). The org is the fixture's buyer here.
const SELLER_TAX_CODE = '0101234564';
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
const BUYER_TAX_CODE = '0309876546';
const OTHER_SELLER_TAX_CODE = '0100109107';

const HEADER = [
  'STT',
  'Ký hiệu mẫu số',
  'Ký hiệu hóa đơn',
  'Số hóa đơn',
  'Ngày lập',
  'MST người bán/MST người xuất hàng',
  'Tên người bán/Tên người xuất hàng',
  'MST người mua/MST người nhận hàng',
  'Tên người mua/Tên người nhận hàng',
  'Địa chỉ người mua',
  'Tổng tiền chưa thuế',
  'Tổng tiền thuế',
  'Tổng tiền chiết khấu thương mại',
  'Tổng tiền phí',
  'Tổng tiền thanh toán',
  'Đơn vị tiền tệ',
  'Tỷ giá',
  'Trạng thái hóa đơn',
  'Kết quả kiểm tra hóa đơn',
];

// The portal's layout: title on row 3, the date range on row 4, the header on row 6.
async function portalList(rows: Array<Array<string | number>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('sheet 1');
  sheet.getCell('A3').value = 'DANH SÁCH HÓA ĐƠN';
  sheet.getCell('A4').value = 'Từ ngày 01/09/2026 đến ngày 30/09/2026';
  sheet.getRow(6).values = HEADER;
  sheet.getRow(6).font = { bold: true };
  rows.forEach((row, i) => {
    sheet.getRow(7 + i).values = row;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const row = (n: number, number: string, sellerTaxCode: string, sellerName: string, total: number): Array<string | number> => [
  n,
  '1',
  'C26TAB',
  number,
  '15/09/2026',
  sellerTaxCode,
  sellerName,
  BUYER_TAX_CODE,
  'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU',
  '2 Đường Thử, TP Hồ Chí Minh',
  total - total / 11,
  total / 11,
  0,
  0,
  total,
  'VND',
  '1.0',
  'Hóa đơn mới',
  'Đã cấp mã hóa đơn',
];

async function choosePeriod(page: Page) {
  await page.getByRole('combobox', { name: 'Tháng', exact: true }).selectOption('9');
  await page.getByRole('combobox', { name: 'Năm', exact: true }).selectOption('2026');
}

test('import the tax portal purchase list and see which invoices Crove lacks', async ({ page }) => {
  await test.step('sign up, create the org and set its tax code', async () => {
    await page.goto('/');
    await signUp(page, newEmail('portal'));
  });
  await createOrg(page, 'Công ty Đối chiếu E2E');
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Nhập', exact: true }).click();
  const form = page.getByRole('form', { name: 'Mã số thuế' });
  await form.getByLabel('Mã số thuế').fill(BUYER_TAX_CODE);
  await form.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText(BUYER_TAX_CODE, { exact: true })).toBeVisible();

  await test.step('upload a purchase e-invoice; it waits in the Inbox', async () => {
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('row').filter({ has: page.getByRole('link', { name: SELLER }) })).toBeVisible({ timeout: 60_000 });
  });

  await test.step('open the reconciliation screen: no list yet', async () => {
    await nav.getByRole('link', { name: 'Đối chiếu cổng thuế' }).click();
    await expect(page.getByRole('heading', { name: 'Đối chiếu hóa đơn mua vào với cổng thuế' })).toBeVisible();
    await choosePeriod(page);
    await expect(page.getByText('Kỳ này chưa có danh sách nào')).toBeVisible();
  });

  await test.step('upload the portal list; it is read and compared', async () => {
    // The third row names another buyer: it is left out, and the screen says so (#506).
    const otherBuyer = row(3, '7777', SELLER_TAX_CODE, SELLER, 550_000);
    otherBuyer[7] = OTHER_SELLER_TAX_CODE;
    const buffer = await portalList([row(1, '1234', SELLER_TAX_CODE, SELLER, 1_980_000), row(2, '5555', OTHER_SELLER_TAX_CODE, 'CÔNG TY TNHH BÊN BÁN KHÁC', 1_100_000), otherBuyer]);
    await page.getByLabel('Tải danh sách lên').setInputFiles({ name: 'DANH SÁCH HÓA ĐƠN.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await expect(page.getByText('Đã đọc 2 hóa đơn')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('1 dòng của người mua khác, đã bỏ qua')).toBeVisible();
    await expect(page.getByText('Đã bỏ qua 1 dòng không phải hóa đơn mua vào của công ty')).toBeVisible();
    await expect(page.getByText('DANH SÁCH HÓA ĐƠN.xlsx: 1 dòng ghi người mua là doanh nghiệp khác')).toBeVisible();
    await expect(page.getByRole('cell', { name: '01/09/2026 đến 30/09/2026', exact: true })).toBeVisible();

    const missing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Cơ quan thuế có, Crove chưa có (1)' }) });
    await expect(missing.getByRole('row').filter({ hasText: '1C26TAB-5555' })).toContainText('CÔNG TY TNHH BÊN BÁN KHÁC');
    await expect(missing.getByText('Hãy xin người bán tệp XML', { exact: false })).toBeVisible();

    const inbox = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Đang chờ duyệt trong Hộp thư (1)' }) });
    const waiting = inbox.getByRole('row').filter({ hasText: '1C26TAB-1234' });
    await expect(waiting).toContainText(SELLER_TAX_CODE);
    await expect(waiting.getByRole('link', { name: 'Mở đề xuất' })).toBeVisible();
  });

  await test.step('ask the company for the missing invoice by email, with a monthly reminder (#669)', async () => {
    const card = page.getByRole('region', { name: 'Đề nghị công ty bổ sung hóa đơn' });
    await expect(card.getByText('Công ty chưa có email liên hệ.')).toBeVisible();
    await card.getByRole('link', { name: 'Nhập email liên hệ trong Cài đặt' }).click();
    await page.getByRole('button', { name: 'Nhập email', exact: true }).click();
    const form = page.getByRole('form', { name: 'Email liên hệ của công ty' });
    await form.getByLabel('Email liên hệ của công ty').fill('ketoan@nguoimua.example');
    await form.getByRole('button', { name: 'Lưu email' }).click();
    await expect(page.getByText('ketoan@nguoimua.example', { exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Đối chiếu cổng thuế' }).click();
    await choosePeriod(page);
    await expect(card.getByText('Gửi email tới ketoan@nguoimua.example liệt kê 1 hóa đơn', { exact: false })).toBeVisible();
    await card.getByRole('button', { name: 'Gửi email đề nghị' }).click();
    await expect(card.getByText('Đã xếp email vào hàng gửi.')).toBeVisible();
    await expect(card.getByRole('listitem').filter({ hasText: 'Đề nghị' })).toContainText('09/2026');
    await card.getByRole('combobox', { name: 'Nhắc hằng tháng' }).selectOption('5');
    await expect(card.getByText('Đang nhắc vào ngày 5 hằng tháng.')).toBeVisible();
    // A second request for the period within the hour is refused.
    await card.getByRole('button', { name: 'Gửi email đề nghị' }).click();
    // In Vietnamese the SPA shows the kernel's own message (KERNEL_LOCALE), which names the period.
    await expect(card.getByRole('alert')).toContainText('Đã gửi đề nghị cho tháng 9/2026 trong vòng một giờ qua');
  });

  await test.step('a file that is not the portal list is kept with the reason', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Số dư').addRows([
      ['Mã tài khoản', 'Tên tài khoản', 'Dư Nợ'],
      ['111', 'Tiền mặt', 1000],
    ]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await page.getByLabel('Tải danh sách lên').setInputFiles({ name: 'so-du.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    const failed = page.getByRole('row').filter({ hasText: 'so-du.xlsx' });
    await expect(failed.getByText('Không dùng được')).toBeVisible({ timeout: 60_000 });
    await expect(failed.getByText('Không nhận ra bảng danh sách hóa đơn', { exact: false })).toBeVisible();
    await failed.getByRole('button', { name: 'Gỡ' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'so-du.xlsx' })).toHaveCount(0);
  });

  await test.step('another period has its own lists', async () => {
    await page.getByRole('combobox', { name: 'Tháng', exact: true }).selectOption('10');
    await expect(page.getByText('Kỳ này chưa có danh sách nào')).toBeVisible();
  });
});
