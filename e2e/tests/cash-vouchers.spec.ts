// Cash and bank vouchers (issue #327), end to end: enter a giấy báo Nợ for a bank fee on the "Thu chi" screen, approve
// it in the Inbox (R3: the page asks for a second factor and approves again by itself), then find it numbered BN00001
// on the vouchers screen, in the journal and in the database. The MISA exports of cash receipts and payments (#657)
// download from the same screen, and leave the bank note out (bank vouchers have their own MISA templates).
import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('enter a bank debit note, approve it and find it numbered in the books', async ({ page }) => {
  const email = newEmail('vouchers');
  await page.goto('/');
  await signUp(page, email);
  const slug = await createOrg(page, 'Công ty Thu Chi');

  await test.step('enter the voucher on the cash and bank screen', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Thu chi' }).click();
    await expect(page.getByRole('heading', { name: 'Thu chi' })).toBeVisible();
    await expect(page.getByText('Chưa có chứng từ thu chi nào được ghi sổ.')).toBeVisible();
    await page.getByRole('button', { name: 'Lập chứng từ' }).click();
    await page.getByLabel('Loại chứng từ').first().selectOption('bank_debit');
    await page.getByLabel('Ngày chứng từ').fill('2026-10-15');
    await page.getByLabel('Tài khoản ngân hàng').selectOption('1121');
    await page.getByLabel('Lý do chi').fill('Phí chuyển khoản tháng 10');
    // A bank fee settles no vendor, so no party is needed once the line is an expense.
    await page.getByLabel('Tài khoản đối ứng dòng 1').selectOption('6422');
    await page.getByLabel('Số tiền dòng 1').fill('22.000');
    await expect(page.getByText(/Tổng tiền: 22\.000/)).toBeVisible();
    await page.getByRole('button', { name: 'Gửi đề xuất' }).click();
    await expect(page.getByText('Đã tạo đề xuất Giấy báo Nợ.')).toBeVisible();
    await page.getByRole('link', { name: 'Xem đề xuất' }).click();
  });

  let proposalUrl = '';
  await test.step('approve it in the Inbox after a fresh second factor', async () => {
    await expect(page.getByText(/Giấy báo Nợ ngày .*Ludy cấp số chứng từ và ghi bút toán/)).toBeVisible();
    proposalUrl = page.url();
    await expect(page.getByText('Số chứng từ được cấp khi duyệt.')).toBeVisible();
    await page.getByRole('button', { name: 'Duyệt và ghi sổ chứng từ' }).click();
    await expect(page.getByText('Đang chờ: duyệt và ghi sổ chứng từ thu chi này.')).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  });

  await test.step('the voucher is numbered BN00001, posted, and in the journal', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Thu chi' }).click();
    const row = page.getByRole('row').filter({ hasText: 'BN00001' });
    await expect(row).toContainText('Giấy báo Nợ');
    await expect(row).toContainText('Phí chuyển khoản tháng 10');
    await expect(row).toContainText('22.000');
    await expect(row).toContainText('Đã ghi sổ');
    await row.getByRole('link', { name: 'Xem bút toán' }).click();
    await expect(page.getByText('BN00001 Phí chuyển khoản tháng 10')).toBeVisible();
  });

  await test.step('the MISA exports download from the cash and bank screen, without the bank note', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Thu chi' }).click();
    for (const [button, file, sheet] of [
      ['Xuất phiếu thu cho MISA', `ludy-misa-phieu-thu-${slug}.xlsx`, 'Phiếu thu'],
      ['Xuất phiếu chi cho MISA', `ludy-misa-phieu-chi-${slug}.xlsx`, 'Phiếu chi'],
    ] as const) {
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: button }).click();
      const saved = await download;
      expect(saved.suggestedFilename()).toBe(file);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(await saved.path());
      const worksheet = workbook.getWorksheet(sheet);
      if (!worksheet) throw new Error(`sheet ${sheet} missing`);
      expect((worksheet.getRow(1).values as unknown[]).slice(1, 5)).toEqual(['Hiển thị trên sổ', 'Ngày hạch toán (*)', 'Ngày chứng từ (*)', 'Số chứng từ (*)']);
      expect(worksheet.rowCount).toBe(1);
    }
  });

  await test.step('the approved proposal shows the number the voucher was given', async () => {
    await page.goto(proposalUrl);
    await expect(page.getByText(/Giấy báo Nợ số BN00001 ngày .*đã ghi sổ/)).toBeVisible();
    await expect(page.getByText('Số chứng từ: BN00001')).toBeVisible();
    await expect(page.getByText('Số chứng từ được cấp khi duyệt.')).toHaveCount(0);
  });

  await test.step('one voucher and its entry in the database, approved with the second factor', async () => {
    const rows = sql<{ code: string; amount: string; lines: string; aal: string }>(
      `SELECT v.voucher_type || '-' || v.number AS code, v.amount::text AS amount,
              (SELECT string_agg(l.account_code || ':' || l.debit::text || ':' || l.credit::text, ',' ORDER BY l.line_no)
                 FROM crove_finance.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id) AS lines,
              (SELECT a.detail->>'aal' FROM crove_kernel.audit_event a
                WHERE a.org_id = v.org_id AND a.command = 'kernel.proposal.approve' AND a.outcome = 'ok' AND a.target_id = v.proposal_id) AS aal
         FROM crove_finance.cash_voucher v
         JOIN crove_kernel.tenant t ON t.org_id = v.org_id
         JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id
        WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(rows).toEqual([{ code: 'bank_debit-1', amount: '22000.0000', lines: '6422:22000.0000:0.0000,1121:0.0000:22000.0000', aal: 'aal2' }]);
  });
});
