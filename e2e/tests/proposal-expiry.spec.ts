// Proposal expiry (issue #876), end to end: an owner sets an expiry in Settings (it needs the owners' escalation first),
// asks for a general journal voucher, and once it has expired finds it under "Hết hạn" in the Inbox with its reason,
// cannot approve it, and asks for it again: a new pending proposal from the same request. The worker's sweep runs every
// 30 minutes, so the test moves the proposal to the state the expiry command leaves (the database tests cover the
// command itself).
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

test('set an expiry, find an expired proposal with its reason and ask for it again', async ({ page }) => {
  const email = newEmail('expiry');
  await page.goto('/');
  await signUp(page, email);
  const slug = await createOrg(page, 'Công ty Hết Hạn');

  await test.step('expiry is offered only after the owners are told, and only for longer', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
    const expire = page.getByLabel('Hết hạn sau');
    await expect(expire).toBeDisabled();
    await page.getByLabel('Báo chủ sở hữu sau').selectOption('7');
    await expect(expire).toBeEnabled();
    await expect(expire.getByRole('option')).toHaveText(['Không đặt hạn', '14 ngày', '30 ngày', '60 ngày', '90 ngày']);
    await expire.selectOption('14');
    await expect(expire).toHaveValue('14');
    await page.reload();
    await expect(page.getByLabel('Hết hạn sau')).toHaveValue('14');
    const policy = sql<{ escalate: number; expire: number }>(
      `SELECT p.escalate_after_days AS escalate, p.expire_after_days AS expire
         FROM crove_kernel.proposal_policy p JOIN crove_kernel.tenant t ON t.org_id = p.org_id WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(policy).toEqual([{ escalate: 7, expire: 14 }]);
  });

  await test.step('ask for a general journal voucher', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Kế toán', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Bút toán' }).click();
    await page.getByRole('button', { name: 'Lập phiếu kế toán' }).click();
    const form = page.getByRole('form', { name: 'Phiếu kế toán khác' });
    await form.getByLabel('Ngày chứng từ').fill('2026-10-31');
    await form.getByLabel('Diễn giải', { exact: true }).fill('Trích trước tiền điện tháng 10');
    await form.getByLabel('Tài khoản dòng 1').selectOption('6422');
    await form.getByLabel('Số tiền Nợ dòng 1').fill('1.500.000');
    await form.getByLabel('Tài khoản dòng 2').selectOption('334');
    await form.getByLabel('Số tiền Có dòng 2').fill('1.500.000');
    await form.getByRole('button', { name: 'Gửi đề xuất' }).click();
    await expect(page.getByText('Đã tạo đề xuất phiếu kế toán.')).toBeVisible();
  });

  await test.step('the proposal expires after 15 days of waiting', async () => {
    exec(
      `UPDATE crove_kernel.proposal p SET created_at = now() - interval '15 days', status = 'expired', decided_at = now()
         FROM crove_kernel.tenant t WHERE t.org_id = p.org_id AND t.slug = :'slug' AND p.status = 'pending'`,
      { slug },
    );
  });

  await test.step('the Inbox lists it under "Hết hạn" with its reason, and it cannot be approved', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Hộp thư' }).click();
    await expect(page.getByText('Trích trước tiền điện tháng 10')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Hết hạn' }).click();
    await expect(page.getByText('Hết hạn sau 15 ngày chờ duyệt')).toBeVisible();
    await page.getByRole('link', { name: /Trích trước tiền điện tháng 10/ }).first().click();
    await expect(page.getByText('Đã hết hạn', { exact: true })).toBeVisible();
    await expect(page.getByText(/Đề xuất đã hết hạn lúc .*: chờ duyệt 15 ngày mà chưa ai duyệt/)).toBeVisible();
    await expect(page.getByText('Nếu vẫn cần, bạn có thể gửi lại để tạo một đề xuất mới từ cùng nguồn.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Duyệt/ })).toHaveCount(0);
  });

  await test.step('ask for it again: a new pending proposal opens', async () => {
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Gửi lại' }).click();
    await expect(page.getByText('Đề xuất này được gửi lại từ một đề xuất đã hết hạn.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Duyệt và ghi sổ phiếu kế toán' })).toBeVisible();
    await page.getByRole('link', { name: 'Xem đề xuất cũ' }).click();
    await expect(page.getByText('Đề xuất này đã được gửi lại.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gửi lại' })).toHaveCount(0);
  });

  await test.step('two proposals in the database: the expired one and the one asked for again', async () => {
    const rows = sql<{ status: string; again: boolean }>(
      `SELECT p.status, p.resubmitted_from IS NOT NULL AS again
         FROM crove_kernel.proposal p JOIN crove_kernel.tenant t ON t.org_id = p.org_id
        WHERE t.slug = :'slug' ORDER BY p.created_at`,
      { slug },
    );
    expect(rows).toEqual([
      { status: 'expired', again: false },
      { status: 'pending', again: true },
    ]);
  });
});
