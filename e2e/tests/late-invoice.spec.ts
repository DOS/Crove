// A late purchase invoice (issue #478), end to end in the Inbox: a month is locked, an invoice of that month arrives,
// the Inbox says its month is locked, the approver chooses to post it in an open month (the first open day by
// default), and the executed proposal shows the posting date. The document keeps its invoice date, the entry is on
// the posting date, and the audit rows record the choice.
// The dates are relative to today in Vietnam (#366): the locked month is the one before last, so it has ended and the
// first day of the month after it (last month) is never after today.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { nextTotp } from '../lib/totp.ts';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url)), 'utf8');
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

// 'YYYY-MM', `by` months from this month in Vietnam (UTC+7, no daylight saving).
function monthFromNow(by: number): string {
  const [year, month] = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7).split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
const LOCKED = monthFromNow(-2);
const OPEN = monthFromNow(-1);
const INVOICE_DATE = `${LOCKED}-15`;
const LAST_LOCKED_DAY = new Date(Date.UTC(Number(LOCKED.slice(0, 4)), Number(LOCKED.slice(5, 7)), 0)).toISOString().slice(0, 10);
const FIRST_OPEN_DAY = `${OPEN}-01`;
// 'DD/MM/YYYY' and 'MM/YYYY', as the screens write them.
const dmy = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
const my = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
// The fixture invoice, dated in the locked month.
const INVOICE = { name: 'hd.xml', mimeType: 'application/xml', buffer: Buffer.from(FIXTURE.replace('<NLap>2026-09-15</NLap>', `<NLap>${INVOICE_DATE}</NLap>`)) };

test('post an invoice of a locked month in the first open month, keeping its invoice date', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('late'));
  const slug = await createOrg(page, 'Công ty Hóa đơn muộn');
  const nav = page.getByRole('navigation');

  await test.step('lock the month before last', async () => {
    await nav.getByRole('link', { name: 'Kế toán', exact: true }).click();
    await nav.getByRole('link', { name: 'Sổ sách' }).click();
    await page.getByLabel('Tháng khóa sổ').fill(LOCKED);
    await page.getByRole('button', { name: `Khóa sổ tháng ${my(LOCKED)}` }).click();
    await expect(page.getByText(`Đã khóa sổ đến hết ngày ${dmy(LAST_LOCKED_DAY)}`, { exact: false })).toBeVisible();
  });

  await test.step('the Inbox says the invoice month is locked and offers the first open day', async () => {
    await nav.getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: SELLER }).click();
    const late = page.getByTestId('late-posting');
    await expect(late.getByText(`Sổ đã khóa đến hết ngày ${dmy(LAST_LOCKED_DAY)}`)).toBeVisible();
    await expect(late.getByText(`Hóa đơn ngày ${dmy(INVOICE_DATE)} thuộc tháng đã khóa sổ`, { exact: false })).toBeVisible();
    // Nothing is chosen until the approver ticks the box.
    await expect(page.getByLabel('Ngày ghi sổ')).toHaveCount(0);
    await late.getByText('Ghi sổ vào tháng đang mở, chứng từ vẫn giữ ngày hóa đơn').click();
    // Date fields read dd/mm/yyyy (#1304).
    await expect(page.getByLabel('Ngày ghi sổ')).toHaveValue(dmy(FIRST_OPEN_DAY));
    // A day inside the locked months is not taken; the first open day is.
    await page.getByLabel('Ngày ghi sổ').fill(LAST_LOCKED_DAY);
    await expect(late.getByText(`Hãy chọn một ngày từ ${dmy(FIRST_OPEN_DAY)} đến hôm nay.`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Duyệt và ghi sổ' })).toBeDisabled();
    await page.getByLabel('Ngày ghi sổ').fill(FIRST_OPEN_DAY);
    await confirmUnverifiedSignature(page);
    await expect(page.getByRole('button', { name: 'Duyệt và ghi sổ' })).toBeEnabled();
  });

  await test.step('approve: the entry is posted on the first open day and the Inbox shows it', async () => {
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await page.getByRole('tab', { name: 'Đã ghi sổ' }).click();
    await page.getByRole('link', { name: SELLER }).click();
    await expect(page.getByTestId('late-posted')).toHaveText(
      `Đã ghi sổ ngày ${dmy(FIRST_OPEN_DAY)}, sau ngày hóa đơn: ngày hóa đơn thuộc tháng đã khóa sổ hoặc không sau ngày số dư đầu kỳ. Chứng từ vẫn giữ ngày hóa đơn ${dmy(INVOICE_DATE)}.`,
    );
  });

  await test.step('the document keeps its invoice date, the entry is on the posting date, the audit rows record it', async () => {
    const posted = sql<{ invoice_date: string; entry_date: string }>(
      `SELECT d.invoice_date::text AS invoice_date, j.entry_date::text AS entry_date
       FROM crove_finance.purchase_document d
       JOIN crove_finance.journal_entry j ON j.org_id = d.org_id AND j.source_type = 'finance.purchase_document' AND j.source_id = d.id
       JOIN crove_kernel.tenant t ON t.org_id = d.org_id
       WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(posted).toEqual([{ invoice_date: INVOICE_DATE, entry_date: FIRST_OPEN_DAY }]);
    const audits = sql<{ command: string; posting_date: string }>(
      `SELECT a.command, a.detail->>'posting_date' AS posting_date
       FROM crove_kernel.audit_event a JOIN crove_kernel.tenant t ON t.org_id = a.org_id
       WHERE t.slug = :'slug' AND a.outcome = 'ok' AND a.command IN ('kernel.proposal.approve', 'finance.purchase.record') ORDER BY a.command`,
      { slug },
    );
    expect(audits).toEqual([
      { command: 'finance.purchase.record', posting_date: FIRST_OPEN_DAY },
      { command: 'kernel.proposal.approve', posting_date: FIRST_OPEN_DAY },
    ]);
  });
});
