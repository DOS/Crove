// Member roles in Settings (issue #1279): an owner gives a built-in role (R3, so with a fresh second factor) and takes
// it back, and the member role select keeps its own label beside the new control.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('an owner gives the chief accountant role and takes it back', async ({ page }) => {
  const owner = newEmail('roles');
  await signUp(page, owner);
  await createOrg(page, 'Công ty phân quyền');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();

  // Giving a role is R3: turn on the second factor first, so the code is fresh.
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.getByText('Đang bật')).toBeVisible();

  const row = page.getByRole('listitem').filter({ hasText: owner }).first();
  const roles = row.getByRole('group', { name: `Vai trò nghiệp vụ của ${owner}` });
  await roles.getByRole('button', { name: `Giao vai trò cho ${owner}` }).click();
  await roles.getByLabel('Vai trò nghiệp vụ', { exact: true }).selectOption({ label: 'Kế toán trưởng' });
  await expect(roles.getByText('Duyệt các đề xuất ghi sổ và mở khóa tháng đã khóa sổ, như chủ sở hữu.')).toBeVisible();
  await roles.getByRole('button', { name: 'Giao vai trò', exact: true }).click();
  await expect(roles.getByText('Kế toán trưởng', { exact: true })).toBeVisible();

  await roles.getByRole('button', { name: `Thu hồi vai trò Kế toán trưởng của ${owner}` }).click();
  await expect(roles.getByText('Kế toán trưởng', { exact: true })).toHaveCount(0);
});
