// Period lock (issue #329), end to end: lock September on the ledger screen, see the approval of a September invoice
// refused with the reason, unlock September with a reason (R3: the page asks for a fresh second factor), then approve
// the invoice. The audit rows record who locked and unlocked, and why.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

test('lock a month, see a posting into it refused, then unlock it with a reason', async ({ page }) => {
  const email = newEmail('lock');
  await page.goto('/');
  await signUp(page, email);
  const slug = await createOrg(page, 'Công ty Khóa sổ');
  const nav = page.getByRole('navigation');

  await test.step('lock September 2026 on the ledger screen', async () => {
    await nav.getByRole('link', { name: 'Kế toán', exact: true }).click();
    await nav.getByRole('link', { name: 'Sổ sách' }).click();
    await expect(page.getByText('Chưa khóa sổ tháng nào.', { exact: false })).toBeVisible();
    await page.getByLabel('Tháng khóa sổ').fill('2026-09');
    await page.getByRole('button', { name: 'Khóa sổ tháng 09/2026' }).click();
    await expect(page.getByText('Đã khóa sổ đến hết ngày 30/09/2026', { exact: false })).toBeVisible();
    await expect(page.getByText(`Thay đổi gần nhất: ${email}`, { exact: false })).toBeVisible();
    // The next lock can only name October.
    await expect(page.getByRole('button', { name: 'Khóa sổ tháng 10/2026' })).toBeVisible();
  });

  await test.step('the approval of a September invoice is refused and says why', async () => {
    await nav.getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: SELLER }).click();
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByText('Sổ đã khóa đến hết ngày 30/09/2026, nên không ghi được bút toán ngày 15/09/2026', { exact: false })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox/`));
  });

  await test.step('the owner unlocks September with a reason, then the approval goes through', async () => {
    await nav.getByRole('link', { name: 'Kế toán', exact: true }).click();
    await nav.getByRole('link', { name: 'Sổ sách' }).click();
    await page.getByRole('button', { name: 'Mở khóa tháng 09/2026' }).click();
    const confirm = page.getByRole('button', { name: 'Mở khóa tháng 09/2026' });
    await expect(confirm).toBeDisabled();
    await page.getByLabel('Lý do mở khóa').fill('Bổ sung hóa đơn mua vào tháng 9');
    // The second factor verified for the approval is still fresh (5 minutes), so no new code is asked.
    await confirm.click();
    await expect(page.getByText('Chưa khóa sổ tháng nào.', { exact: false })).toBeVisible();

    await nav.getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.getByRole('link', { name: SELLER }).click();
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await page.getByRole('tab', { name: 'Đã ghi sổ' }).click();
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible();
  });

  await test.step('the audit rows record the lock and the unlock with its reason and second factor', async () => {
    const rows = sql<{ command: string; month: string; reason: string | null; aal: string | null }>(
      `SELECT a.command, a.detail->>'month' AS month, a.detail->>'reason' AS reason, a.detail->>'aal' AS aal
       FROM crove_kernel.audit_event a JOIN crove_kernel.tenant t ON t.org_id = a.org_id
       WHERE t.slug = :'slug' AND a.command LIKE 'finance.period.%' AND a.outcome = 'ok' ORDER BY a.occurred_at`,
      { slug },
    );
    expect(rows).toEqual([
      { command: 'finance.period.lock', month: '2026-09', reason: null, aal: null },
      { command: 'finance.period.unlock', month: '2026-09', reason: 'Bổ sung hóa đơn mua vào tháng 9', aal: 'aal2' },
    ]);
  });
});
