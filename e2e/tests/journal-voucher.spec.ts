// General journal vouchers, NVK (issue #888), end to end: enter an accrual of salaries on the journal screen, approve it
// in the Inbox (R3: the page asks for a second factor and approves again by itself), then find it numbered NVK00001
// in the journal and in the database.
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('enter a general journal voucher, approve it and find it numbered in the journal', async ({ page }) => {
  const email = newEmail('nvk');
  await page.goto('/');
  await signUp(page, email);
  const slug = await createOrg(page, 'Công ty Bút Toán');

  await test.step('enter the voucher on the journal screen', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Bút toán' }).click();
    await page.getByRole('button', { name: 'Lập phiếu kế toán' }).click();
    const form = page.getByRole('form', { name: 'Phiếu kế toán khác' });
    await form.getByLabel('Ngày chứng từ').fill('2026-10-31');
    await form.getByLabel('Diễn giải', { exact: true }).fill('Trích trước lương tháng 10');
    await form.getByLabel('Tài khoản dòng 1').selectOption('6422');
    await form.getByLabel('Số tiền Nợ dòng 1').fill('15.000.000');
    await form.getByLabel('Tài khoản dòng 2').selectOption('334');
    await form.getByLabel('Số tiền Có dòng 2').fill('15.000.000');
    await expect(form.getByText(/Tổng Nợ: 15\.000\.000.* · Tổng Có: 15\.000\.000/)).toBeVisible();
    await form.getByRole('button', { name: 'Gửi đề xuất' }).click();
    await expect(page.getByText('Đã tạo đề xuất phiếu kế toán.')).toBeVisible();
    await page.getByRole('link', { name: 'Xem đề xuất' }).click();
  });

  await test.step('approve it in the Inbox after a fresh second factor', async () => {
    await expect(page.getByText(/Phiếu kế toán ngày .*Crove cấp số NVK và ghi bút toán/)).toBeVisible();
    await expect(page.getByText('Số chứng từ được cấp khi duyệt.')).toBeVisible();
    await page.getByRole('button', { name: 'Duyệt và ghi sổ phiếu kế toán' }).click();
    await expect(page.getByText('Đang chờ: duyệt và ghi sổ phiếu kế toán này.')).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  });

  await test.step('the entry is in the journal as NVK00001', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Bút toán' }).click();
    await expect(page.getByText('NVK00001 Trích trước lương tháng 10')).toBeVisible();
  });

  await test.step('one voucher and its entry in the database', async () => {
    const rows = sql<{ number: number; lines: string }>(
      `SELECT v.number,
              (SELECT string_agg(l.account_code || ':' || l.debit::text || ':' || l.credit::text, ',' ORDER BY l.line_no)
                 FROM crove_finance.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id) AS lines
         FROM crove_finance.journal_voucher v
         JOIN crove_kernel.tenant t ON t.org_id = v.org_id
         JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
        WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(rows).toEqual([{ number: 1, lines: '6422:15000000.0000:0.0000,334:0.0000:15000000.0000' }]);
  });
});
