// Opening balances from Excel (issue #320), end to end: download the template from the journal, fill it in Excel's
// format, see the check refuse an unbalanced sheet, then post a balanced one as the opening entry (R3: the page asks
// for a second factor and posts again by itself) and find it in the journal and the database.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('import opening balances from the Excel template', async ({ page }) => {
  const email = newEmail('opening');
  await page.goto('/');
  await signUp(page, email);
  const slug = await createOrg(page, 'Công ty Số dư đầu kỳ');
  const dir = mkdtempSync(join(tmpdir(), 'crove-opening-'));

  const template = await test.step('open the screen from the journal and download the template', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Bút toán' }).click();
    await page.getByRole('link', { name: 'Nhập số dư đầu kỳ' }).click();
    await expect(page.getByRole('heading', { name: 'Số dư đầu kỳ' })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Tải file mẫu' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`crove-mau-so-du-dau-ky-${slug}.xlsx`);
    return file.path();
  });

  // The template filled in by ExcelJS, which writes shared strings and deflated parts as Excel does.
  const fill = async (name: string, amounts: Record<string, [number | null, number | null]>) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(template);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('the template has no worksheet');
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(['Mã tài khoản', 'Tên tài khoản', 'Dư Nợ', 'Dư Có']);
    sheet.eachRow((row) => {
      const amount = amounts[String(row.getCell(1).value)];
      if (!amount) return;
      row.getCell(3).value = amount[0];
      row.getCell(4).value = amount[1];
    });
    const path = join(dir, name);
    await workbook.xlsx.writeFile(path);
    return path;
  };

  await test.step('an unbalanced sheet is refused before posting', async () => {
    await page.getByLabel('Số dư tại cuối ngày').fill('2025-12-31');
    await page.getByLabel('File Excel (.xlsx)').setInputFiles(await fill('unbalanced.xlsx', { '111': [50_000_000, null], '411': [null, 40_000_000] }));
    await expect(page.getByText('Tổng dư Nợ phải bằng tổng dư Có.')).toBeVisible();
    await expect(page.getByText(/Chênh lệch 10\.000\.000/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ghi sổ số dư đầu kỳ' })).toHaveCount(0);
  });

  await test.step('a balanced sheet posts as the opening entry after a fresh second factor', async () => {
    await page
      .getByLabel('File Excel (.xlsx)')
      .setInputFiles(await fill('balanced.xlsx', { '111': [30_000_000, null], '112': [20_000_000, null], '411': [null, 50_000_000] }));
    await expect(page.getByText('Bảng số dư hợp lệ: ghi sổ thành một bút toán 3 dòng.')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Tiền gửi ngân hàng' }).getByRole('cell')).toHaveText(['3', /^112 /, /^20\.000\.000/, '', 'Hợp lệ']);
    await page.getByRole('button', { name: 'Ghi sổ số dư đầu kỳ' }).click();
    await expect(page.getByText('Đang chờ: ghi sổ số dư đầu kỳ.')).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByText('Đã ghi sổ số dư đầu kỳ.')).toBeVisible();
    await page.getByRole('link', { name: 'Xem bút toán' }).click();
    await expect(page.getByText('Số dư đầu kỳ tại ngày 2025-12-31')).toBeVisible();
    await expect(page.getByText('Số dư đầu kỳ', { exact: true })).toBeVisible();
  });

  await test.step('one opening entry in the database, posted with the second factor', async () => {
    const rows = sql<{ lines: number; debit: string; command_aal: string }>(
      `SELECT count(l.*)::int AS lines, sum(l.debit)::text AS debit,
              (SELECT a.detail->>'aal' FROM crove_kernel.audit_event a
                WHERE a.org_id = e.org_id AND a.command = 'finance.opening_balance.post' AND a.outcome = 'ok') AS command_aal
         FROM crove_finance.journal_entry e
         JOIN crove_kernel.tenant t ON t.org_id = e.org_id
         JOIN crove_finance.journal_line l ON l.org_id = e.org_id AND l.entry_id = e.id
        WHERE t.slug = :'slug' AND e.source_type = 'finance.opening_balance'
        GROUP BY e.org_id, e.id`,
      { slug },
    );
    expect(rows).toEqual([{ lines: 3, debit: '50000000.0000', command_aal: 'aal2' }]);
  });
});
