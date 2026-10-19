// A late purchase invoice (issue #478), end to end in the Inbox: September is locked, a September invoice arrives,
// the Inbox says its month is locked, the approver chooses to post it in an open month (the first open day by
// default), and the executed proposal shows the posting date. The document keeps its invoice date, the entry is on
// the posting date, and the audit rows record the choice.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

test('post an invoice of a locked month in the first open month, keeping its invoice date', async ({ page }) => {
  await page.goto('/');
  await signUp(page, newEmail('late'));
  const slug = await createOrg(page, 'Công ty Hóa đơn muộn');
  const nav = page.getByRole('navigation');

  await test.step('lock September 2026', async () => {
    await nav.getByRole('link', { name: 'Sổ sách' }).click();
    await page.getByLabel('Tháng khóa sổ').fill('2026-09');
    await page.getByRole('button', { name: 'Khóa sổ tháng 09/2026' }).click();
    await expect(page.getByText('Đã khóa sổ đến hết ngày 30/09/2026', { exact: false })).toBeVisible();
  });

  await test.step('the Inbox says the invoice month is locked and offers the first open day', async () => {
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: SELLER }).click();
    const late = page.getByTestId('late-posting');
    await expect(late.getByText('Sổ đã khóa đến hết ngày 30/09/2026')).toBeVisible();
    await expect(late.getByText('Hóa đơn ngày 15/09/2026 thuộc tháng đã khóa sổ', { exact: false })).toBeVisible();
    // Nothing is chosen until the approver ticks the box.
    await expect(page.getByLabel('Ngày ghi sổ')).toHaveCount(0);
    await late.getByText('Ghi sổ vào tháng đang mở, chứng từ vẫn giữ ngày hóa đơn').click();
    await expect(page.getByLabel('Ngày ghi sổ')).toHaveValue('2026-10-01');
    // A day inside the locked months is not taken; the first open day is.
    await page.getByLabel('Ngày ghi sổ').fill('2026-09-30');
    await expect(late.getByText('Hãy chọn một ngày từ 01/10/2026 đến hôm nay.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Duyệt và ghi sổ' })).toBeDisabled();
    await page.getByLabel('Ngày ghi sổ').fill('2026-10-01');
    await expect(page.getByRole('button', { name: 'Duyệt và ghi sổ' })).toBeEnabled();
  });

  await test.step('approve: the entry is posted on 1 October and the Inbox shows it', async () => {
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await page.getByRole('tab', { name: 'Đã ghi sổ' }).click();
    await page.getByRole('link', { name: SELLER }).click();
    await expect(page.getByTestId('late-posted')).toHaveText(
      'Đã ghi sổ ngày 01/10/2026: tháng của hóa đơn đã khóa sổ nên người duyệt ghi vào tháng đang mở. Chứng từ vẫn giữ ngày hóa đơn 15/09/2026.',
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
    expect(posted).toEqual([{ invoice_date: '2026-09-15', entry_date: '2026-10-01' }]);
    const audits = sql<{ command: string; posting_date: string }>(
      `SELECT a.command, a.detail->>'posting_date' AS posting_date
       FROM crove_kernel.audit_event a JOIN crove_kernel.tenant t ON t.org_id = a.org_id
       WHERE t.slug = :'slug' AND a.outcome = 'ok' AND a.command IN ('kernel.proposal.approve', 'finance.purchase.record') ORDER BY a.command`,
      { slug },
    );
    expect(audits).toEqual([
      { command: 'finance.purchase.record', posting_date: '2026-10-01' },
      { command: 'kernel.proposal.approve', posting_date: '2026-10-01' },
    ]);
  });
});
