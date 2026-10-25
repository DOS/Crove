// Bank statements (issue #326), end to end: import a bank's CSV export into the 1121 account (the columns are found by
// their headers), see the check before anything is stored, then import an overlapping export and see only its new line
// stored; the lines and their totals show per month, and the database has each line once. Then enter the báo Nợ of a
// bank fee from its line (stage 2a): the form follows the line, and the line waits for approval; the Inbox lists the
// lines still open and links to their account and month (stage 2b).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const HEADER = 'SAO KÊ TÀI KHOẢN\nSố tài khoản: 0011000000000\n\nNgày giao dịch;Số tham chiếu;Nội dung;Số tiền ghi nợ;Số tiền ghi có;Số dư';
const LINES = [
  '01/09/2026;FT001;Góp vốn;;50.000.000;50.000.000',
  '03/09/2026;FT002;Phí SMS;11.000;;49.989.000',
  '05/09/2026;FT003;"Trả tiền hàng; HĐ 1234";19.800.000;;30.189.000',
];

test('import a bank statement, then an overlapping one, and find each line once', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('bank'));
  const slug = await createOrg(page, 'Công ty Ngân hàng');
  const dir = mkdtempSync(join(tmpdir(), 'crove-bank-'));
  const write = (name: string, lines: string[]) => {
    const path = join(dir, name);
    writeFileSync(path, `﻿${HEADER}\n${lines.join('\n')}\nTổng cộng;;;19.811.000;50.000.000;\n`);
    return path;
  };

  await test.step('the first export: checked line by line, then imported', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Ngân hàng' }).click();
    await expect(page.getByRole('heading', { name: 'Sao kê ngân hàng' })).toBeVisible();
    await expect(page.getByLabel('Tài khoản ngân hàng')).toHaveValue('1121');
    await page.getByLabel('Tháng').fill('2026-09');
    await expect(page.getByText('Chưa có dòng sao kê nào trong tháng này.')).toBeVisible();
    await page.getByLabel('File sao kê (.xlsx, .csv)').setInputFiles(write('thang-9.csv', LINES));
    // The columns found by their headers.
    await expect(page.getByLabel('Số tham chiếu', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('Ghi nợ (tiền ra)')).toHaveValue('3');
    await expect(page.getByText('3 dòng mới, 0 dòng đã có, 0 dòng cần xem, 0 dòng lỗi; từ 01/09/2026 đến 05/09/2026.')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FT003' }).getByRole('cell')).toHaveText(['7', '05/09/2026', 'FT003', 'Trả tiền hàng; HĐ 1234', '', /^19\.800\.000/, /^30\.189\.000/, 'Mới']);
    await page.getByRole('button', { name: 'Nhập 3 dòng' }).click();
    await expect(page.getByText('Đã nhập 3 dòng (0 dòng đã có được bỏ qua).')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Tổng phát sinh trong kỳ' }).getByRole('cell')).toHaveText(['Tổng phát sinh trong kỳ', /^50\.000\.000/, /^19\.811\.000/, '', '']);
  });

  await test.step('an overlapping export stores only its new line', async () => {
    await page.getByLabel('File sao kê (.xlsx, .csv)').setInputFiles(write('thang-9-lan-2.csv', [...LINES.slice(1), '07/09/2026;FT004;Khách trả tiền;;2.000.000;32.189.000']));
    await expect(page.getByText('1 dòng mới, 2 dòng đã có, 0 dòng cần xem, 0 dòng lỗi', { exact: false })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FT002' }).getByText('Đã có')).toBeVisible();
    await page.getByRole('button', { name: 'Nhập 1 dòng' }).click();
    await expect(page.getByText('Đã nhập 1 dòng (2 dòng đã có được bỏ qua).')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Khách trả tiền' })).toHaveCount(1);
  });

  await test.step('enter the báo Nợ of the SMS fee from its line; the line then waits for approval', async () => {
    await page.getByRole('button', { name: /^Lập chứng từ cho dòng ngày 03\/09\/2026/ }).click();
    await expect(page.getByText(/Lập từ dòng sao kê ngày 03\/09\/2026: 11\.000/)).toBeVisible();
    // The type, date, bank account and amount follow the line.
    await expect(page.getByLabel('Loại chứng từ').first()).toHaveValue('bank_debit');
    await expect(page.getByLabel('Loại chứng từ').first()).toBeDisabled();
    await expect(page.getByLabel('Ngày chứng từ')).toHaveValue('03/09/2026');
    // Amount fields show Vietnamese digit grouping when not being typed in (#1391).
    await expect(page.getByLabel('Số tiền dòng 1')).toHaveValue('11.000');
    await expect(page.getByLabel('Lý do chi')).toHaveValue('Phí SMS');
    // A bank fee settles no vendor: as an expense line it needs no party.
    await page.getByLabel('Tài khoản đối ứng dòng 1').selectOption('6422');
    await page.getByRole('button', { name: 'Gửi đề xuất' }).click();
    await expect(page.getByText('Đã tạo đề xuất Giấy báo Nợ.')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'FT002' }).getByRole('link', { name: 'Chờ duyệt' })).toBeVisible();
    // Other lines can still get theirs.
    await expect(page.getByRole('button', { name: /^Lập chứng từ cho dòng ngày 05\/09\/2026/ })).toBeVisible();
  });

  await test.step('the Inbox lists the lines still without a voucher and opens their account and month', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Hộp thư' }).click();
    await expect(page.getByText('Dòng sao kê ngân hàng chưa lập chứng từ')).toBeVisible();
    // FT002 waits for approval; the three others are open.
    await page.getByRole('link', { name: '1121: 3 dòng; cũ nhất ngày 01/09/2026' }).click();
    // The link sets the account and the month (the router writes 1121 quoted in the URL, as JSON, so the page is checked
    // rather than the URL).
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/bank\\?`));
    await expect(page.getByLabel('Tài khoản ngân hàng')).toHaveValue('1121');
    await expect(page.getByLabel('Tháng')).toHaveValue('09/2026');
    await expect(page.getByRole('row').filter({ hasText: 'FT002' }).getByRole('link', { name: 'Chờ duyệt' })).toBeVisible();
  });

  await test.step('each line once in the database', async () => {
    const rows = sql<{ ref: string; amount: string }>(
      `SELECT l.bank_ref AS ref, l.amount::text AS amount FROM crove_finance.bank_line l JOIN crove_kernel.tenant t ON t.org_id = l.org_id
       WHERE t.slug = :'slug' ORDER BY l.value_date`,
      { slug },
    );
    expect(rows).toEqual([
      { ref: 'FT001', amount: '50000000.0000' },
      { ref: 'FT002', amount: '-11000.0000' },
      { ref: 'FT003', amount: '-19800000.0000' },
      { ref: 'FT004', amount: '2000000.0000' },
    ]);
  });
});
