// MVP exit criterion 1, end to end: sign up -> create org -> upload an e-invoice -> proposal in the Inbox ->
// approve -> vendor, document and a balanced entry exist, with audit rows -> lists and the Excel export.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { Decimal } from 'decimal.js';
import ExcelJS from 'exceljs';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
// The fixture's synthetic tax code: checksum-invalid on purpose (#157).
const SELLER_TAX_CODE = '0101234564';
const MEMO = `HĐ C26TAB-1234 ${SELLER}`;

const eq = (value: unknown, expected: string) => new Decimal(String(value)).equals(expected);

test('sign up, upload an e-invoice, approve it, then find it in the lists, the export and the database', async ({ page }) => {
  const email = newEmail('inbox');

  await test.step('sign up and confirm the email', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await signUp(page, email);
  });

  const slug = await test.step('create the first org', async () => {
    const created = await createOrg(page, 'Công ty E2E');
    await expect(page.getByRole('heading', { name: 'Hộp thư chứng từ' })).toBeVisible();
    return created;
  });

  await test.step('the empty Inbox links the quick guide, and the shell the support channel (#310)', async () => {
    const support = page.getByRole('complementary').getByRole('link', { name: 'Góp ý / Hỗ trợ' });
    await expect(support).toHaveAttribute('href', 'mailto:support@e2e.test');
    await page.getByRole('link', { name: 'Xem hướng dẫn nhanh: tải lên, duyệt, xuất Excel' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/guide$`));
    await expect(page.getByRole('heading', { name: 'Hướng dẫn nhanh' })).toBeVisible();
    for (const step of ['Bước 1. Tải hóa đơn lên', 'Bước 2. Kiểm tra và duyệt', 'Bước 3. Xuất Excel cho kế toán']) {
      await expect(page.getByRole('heading', { name: step })).toBeVisible();
    }
    await page.getByRole('link', { name: '← Hộp thư chứng từ' }).click();
    await expect(page.getByRole('heading', { name: 'Hộp thư chứng từ' })).toBeVisible();
  });

  await test.step('upload the e-invoice and wait for the proposal', async () => {
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByText('einvoice-basic.xml')).toBeVisible();
    // The worker reads the XML and raises the proposal; the Inbox polls every few seconds.
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Đã có đề xuất')).toBeVisible();
  });

  await test.step('open the proposal and approve it', async () => {
    await page.getByRole('link', { name: SELLER }).click();
    await expect(page.getByRole('heading', { name: SELLER })).toBeVisible();
    await expect(page.getByText('Hóa đơn C26TAB · số 1234 · ngày 15/09/2026')).toBeVisible();
    const approve = page.getByRole('button', { name: 'Duyệt và ghi sổ' });
    await expect(approve).toBeEnabled();
    await approve.click();
    // Approving is R3: without a second factor the kernel answers STEP_UP_REQUIRED and the page offers to enable one,
    // then approves again by itself.
    await expect(page.getByText('Việc này cần xác thực hai lớp.')).toBeVisible();
    await expect(page.getByText('Đang chờ: duyệt và ghi sổ chứng từ này.')).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await expect(page.getByText('Không có đề xuất nào chờ duyệt')).toBeVisible();
    await page.getByRole('tab', { name: 'Đã ghi sổ' }).click();
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible();
  });

  await test.step('vendor, document and entry lists', async () => {
    const nav = page.getByRole('navigation');

    await nav.getByRole('link', { name: 'Nhà cung cấp' }).click();
    const vendor = page.getByRole('row').filter({ hasText: SELLER });
    await expect(vendor).toHaveCount(1);
    await expect(vendor.getByRole('cell')).toHaveText([SELLER, SELLER_TAX_CODE, /Hà Nội/, '1']);

    await nav.getByRole('link', { name: 'Chứng từ mua' }).click();
    const document = page.getByRole('row').filter({ hasText: 'C26TAB-1234' });
    await expect(document).toHaveCount(1);
    await expect(document.getByRole('cell')).toHaveText(['15/09/2026', 'C26TAB-1234', SELLER, /^1\.800\.000/, /^180\.000/, /^1\.980\.000/, 'Đã ghi sổ']);

    await nav.getByRole('link', { name: 'Bút toán' }).click();
    await expect(page.getByText(MEMO)).toBeVisible();
    const line = (account: string) => page.getByRole('row').filter({ has: page.getByRole('cell', { name: new RegExp(`^${account} `) }) });
    await expect(line('1331').getByRole('cell')).toHaveText([/^1331 /, /^180\.000/, '']);
    await expect(line('331').getByRole('cell')).toHaveText([/^331 /, '', /^1\.980\.000/]);
  });

  await test.step('Excel export', async () => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Xuất Excel' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`crove-but-toan-${slug}.xlsx`);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(await file.path());
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('the export has no worksheet');
    const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    const col = (name: string) => header.indexOf(name) + 1;
    expect(header).toEqual(expect.arrayContaining(['Số HĐ', 'MST nhà cung cấp', 'TK Nợ', 'TK Có', 'Số tiền']));

    const rows = sheet.getRows(2, sheet.rowCount - 1) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    let total = new Decimal(0);
    for (const row of rows) {
      expect(String(row.getCell(col('Số HĐ')).value)).toBe('1234');
      expect(String(row.getCell(col('MST nhà cung cấp')).value)).toBe(SELLER_TAX_CODE);
      expect(String(row.getCell(col('TK Có')).value)).toBe('331');
      total = total.plus(String(row.getCell(col('Số tiền')).value));
    }
    expect(total.toFixed(0)).toBe('1980000');
  });

  await test.step('VAT working for September 2026 and its Excel export (#316)', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Tờ khai GTGT' }).click();
    await expect(page.getByRole('heading', { name: 'Tờ khai thuế GTGT' })).toBeVisible();
    await page.getByLabel('Kỳ khai', { exact: true }).selectOption('month');
    await page.getByLabel('Năm', { exact: true }).selectOption('2026');
    await page.getByLabel('Tháng', { exact: true }).selectOption('9');
    await expect(page.getByText('Từ 01/09/2026 đến 30/09/2026, theo ngày lập hóa đơn')).toBeVisible();
    const indicator = (code: string) => page.getByRole('row').filter({ has: page.getByRole('cell', { name: `[${code}]`, exact: true }) });
    await expect(indicator('23').getByRole('cell').last()).toHaveText(/^1\.800\.000/);
    await expect(indicator('24').getByRole('cell').last()).toHaveText(/^180\.000/);
    await expect(page.getByText('Crove chưa ghi nhận hóa đơn bán ra')).toBeVisible();
    const purchase = page.getByRole('row').filter({ hasText: 'C26TAB-1234' });
    await expect(purchase).toHaveCount(1);
    await expect(purchase.getByRole('cell')).toHaveText(['15/09/2026', 'C26TAB-1234', new RegExp(SELLER), '10%', /^1\.800\.000/, /^180\.000/, '']);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Xuất Excel' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`crove-gtgt-2026-09-${slug}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(await file.path());
    const sheet = workbook.getWorksheet('Mua vao');
    if (!sheet) throw new Error('the VAT export has no purchase sheet');
    const values = (row: number) => (sheet.getRow(row).values as unknown[]).slice(1);
    expect(values(2)).toEqual([1, '2026-09-15', 'C26TAB', '1234', SELLER_TAX_CODE, SELLER, '10%', 1800000, 180000, '']);
    expect(values(3).slice(5)).toEqual(['Tổng cộng', undefined, 1800000, 180000]);
  });

  await test.step('ledger reports for September 2026 and their Excel export (#321)', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Sổ sách' }).click();
    await expect(page.getByRole('heading', { name: 'Sổ sách kế toán' })).toBeVisible();
    await page.getByLabel('Kỳ báo cáo', { exact: true }).selectOption('month');
    await page.getByLabel('Năm', { exact: true }).selectOption('2026');
    await page.getByLabel('Tháng', { exact: true }).selectOption('9');
    await expect(page.getByText('Từ 01/09/2026 đến 30/09/2026, theo ngày hạch toán')).toBeVisible();

    // Trial balance: 331 owes the invoice total, 1331 holds its VAT and rolls up into 133.
    const account = (code: string) => page.getByRole('row').filter({ has: page.getByRole('cell', { name: code, exact: true }) });
    await expect(account('331').getByRole('cell')).toHaveText(['331', 'Phải trả cho người bán', /^0/, /^0/, /^0/, /^1\.980\.000/, /^0/, /^1\.980\.000/]);
    await expect(account('1331').getByRole('cell')).toHaveText(['1331', /^Thuế GTGT được khấu trừ của hàng hóa/, /^0/, /^0/, /^180\.000/, /^0/, /^180\.000/, /^0/]);
    await expect(account('133').getByRole('cell')).toHaveText(['133', 'Thuế GTGT được khấu trừ', /^0/, /^0/, /^180\.000/, /^0/, /^180\.000/, /^0/]);
    const total = page.getByRole('row').filter({ hasText: 'Tổng cộng' });
    await expect(total.getByRole('cell')).toHaveText(['', 'Tổng cộng', /^0/, /^0/, /^1\.980\.000/, /^1\.980\.000/, /^1\.980\.000/, /^1\.980\.000/]);

    // General ledger of 331: the invoice line and the running balance.
    await page.getByRole('tab', { name: 'Sổ cái' }).click();
    await page.getByLabel('Tài khoản', { exact: true }).selectOption('331');
    const posted = page.getByRole('row').filter({ hasText: 'C26TAB-1234' });
    await expect(posted.getByRole('cell')).toHaveText(['15/09/2026', 'C26TAB-1234', MEMO, '331', /1331/, SELLER, '', /^1\.980\.000/, /^Có 1\.980\.000/]);

    // Payables per vendor.
    await page.getByRole('tab', { name: 'Công nợ' }).click();
    const vendor = page.getByRole('row').filter({ hasText: SELLER });
    await expect(vendor.getByRole('cell')).toHaveText([SELLER_TAX_CODE, SELLER, /^0/, /^1\.980\.000/, /^0/, /^1\.980\.000/]);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Xuất Excel' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`crove-so-sach-2026-09-${slug}.xlsx`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(await file.path());
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Can doi phat sinh', 'So cai', 'Phai thu', 'Phai tra']);
    const rows = (name: string) => (workbook.getWorksheet(name)?.getRows(1, workbook.getWorksheet(name)?.rowCount ?? 0) ?? []).map((r) => (r.values as unknown[]).slice(1));
    expect(rows('Can doi phat sinh').find((r) => r[0] === '331')).toEqual(['331', 'Phải trả cho người bán', 0, 0, 0, 1980000, 0, 1980000]);
    expect(rows('Phai tra')[2]).toEqual([SELLER_TAX_CODE, SELLER, 0, 1980000, 0, 1980000]);
  });

  await test.step('rows in the database', async () => {
    const [org] = sql<{ org_id: string; user_id: string }>(
      `SELECT t.org_id, u.id AS user_id
         FROM crove_kernel.tenant t JOIN crove_kernel.user_account u ON u.id = t.created_by
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );
    if (!org) throw new Error(`org ${slug} created by ${email} not found`);
    const vars = { org: org.org_id, user: org.user_id };

    const vendors = sql<{ id: string; name: string; tax_code: string }>(
      `SELECT id, name, tax_code FROM crove_kernel.party WHERE org_id = :'org'`,
      vars,
    );
    expect(vendors).toEqual([{ id: expect.any(String), name: SELLER, tax_code: SELLER_TAX_CODE }]);

    const documents = sql<{ id: string; party_id: string; invoice_series: string; invoice_number: string; subtotal: string; vat_amount: string; total: string; created_by: string }>(
      `SELECT id, party_id, invoice_series, invoice_number, subtotal::text, vat_amount::text, total::text, created_by
         FROM crove_finance.purchase_document WHERE org_id = :'org'`,
      vars,
    );
    expect(documents).toHaveLength(1);
    const doc = documents[0];
    if (!doc) throw new Error('no purchase document');
    expect(doc).toMatchObject({ party_id: vendors[0]?.id, invoice_series: 'C26TAB', invoice_number: '1234', created_by: org.user_id });
    expect(eq(doc.subtotal, '1800000') && eq(doc.vat_amount, '180000') && eq(doc.total, '1980000')).toBe(true);

    const entries = sql<{ source_type: string; source_id: string; debit: string; credit: string; lines: number }>(
      `SELECT e.source_type, e.source_id, sum(l.debit)::text AS debit, sum(l.credit)::text AS credit, count(*)::int AS lines
         FROM crove_finance.journal_entry e
         JOIN crove_finance.journal_line l ON l.org_id = e.org_id AND l.entry_id = e.id
        WHERE e.org_id = :'org'
        GROUP BY e.org_id, e.id`,
      vars,
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error('no journal entry');
    expect(entry).toMatchObject({ source_type: 'finance.purchase_document', source_id: doc.id });
    expect(entry.lines).toBeGreaterThanOrEqual(2);
    expect(eq(entry.debit, '1980000') && eq(entry.credit, '1980000')).toBe(true);

    const audit = sql<{ command: string; outcome: string; actor_type: string; by_user: boolean }>(
      `SELECT command, outcome, actor_type, coalesce(actor_id = :'user'::uuid, false) AS by_user
         FROM crove_kernel.audit_event WHERE org_id = :'org' ORDER BY occurred_at, id`,
      vars,
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        { command: 'kernel.file.ingest', outcome: 'ok', actor_type: 'user', by_user: true },
        { command: 'kernel.extraction.record', outcome: 'ok', actor_type: 'system', by_user: false },
        { command: 'kernel.proposal.approve', outcome: 'denied', actor_type: 'user', by_user: true },
        { command: 'kernel.proposal.approve', outcome: 'ok', actor_type: 'user', by_user: true },
        { command: 'finance.purchase.record', outcome: 'ok', actor_type: 'user', by_user: true },
      ]),
    );

    // The denied attempt was aal1; the approval ran with the fresh second factor (policy P11).
    const approvals = sql<{ outcome: string; code: string | null; aal: string; mfa: boolean }>(
      `SELECT outcome, detail->>'code' AS code, detail->>'aal' AS aal, detail->>'mfaAt' IS NOT NULL AS mfa
         FROM crove_kernel.audit_event WHERE org_id = :'org' AND command = 'kernel.proposal.approve' ORDER BY occurred_at, id`,
      vars,
    );
    expect(approvals).toEqual([
      { outcome: 'denied', code: 'STEP_UP_REQUIRED', aal: 'aal1', mfa: false },
      { outcome: 'ok', code: null, aal: 'aal2', mfa: true },
    ]);
  });
});
