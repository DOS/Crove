// The approval rule in Settings (issue #1425): an owner switches to "only the chief accountant approves" (R3, so with a
// fresh second factor). Without a chief accountant the server refuses, and the refusal leads to the role assignments;
// once the owner holds the role, the switch goes through.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('an owner switches the approval rule once a chief accountant is named', async ({ page }) => {
  const owner = newEmail('preset');
  await signUp(page, owner);
  await createOrg(page, 'Công ty quy tắc duyệt');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();

  const card = page.getByRole('region', { name: 'Quy tắc duyệt bút toán' });
  await expect(card.getByRole('radio', { name: 'Chủ doanh nghiệp duyệt' })).toBeChecked();
  await expect(card.getByRole('button', { name: 'Lưu quy tắc' })).toBeDisabled();

  // Switching is R3: turn on the second factor first, so the code is fresh.
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.getByText('Đang bật')).toBeVisible();

  // Nobody holds the chief accountant role yet: refused, with the way to the role assignments.
  await card.getByRole('radio', { name: 'Chỉ kế toán trưởng duyệt' }).check();
  await card.getByRole('button', { name: 'Lưu quy tắc' }).click();
  await expect(card.getByText('Hãy giao vai trò kế toán trưởng cho một thành viên')).toBeVisible();
  await card.getByRole('button', { name: 'Giao vai trò kế toán trưởng' }).click();
  await expect(page.locator('#settings-members')).toBeFocused();

  const row = page.getByRole('listitem').filter({ hasText: owner }).first();
  const roles = row.getByRole('group', { name: `Vai trò nghiệp vụ của ${owner}` });
  await roles.getByRole('button', { name: `Giao vai trò cho ${owner}` }).click();
  await roles.getByLabel('Vai trò nghiệp vụ', { exact: true }).selectOption({ label: 'Kế toán trưởng' });
  await roles.getByRole('button', { name: 'Giao vai trò', exact: true }).click();
  await expect(roles.getByText('Kế toán trưởng', { exact: true })).toBeVisible();

  await card.getByRole('radio', { name: 'Chỉ kế toán trưởng duyệt' }).check();
  await card.getByRole('button', { name: 'Lưu quy tắc' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã đổi quy tắc duyệt: Chỉ kế toán trưởng duyệt' })).toBeVisible();
  await expect(card.getByRole('radio', { name: 'Chỉ kế toán trưởng duyệt' })).toBeChecked();
  await expect(card.getByRole('radio', { name: 'Chỉ kế toán trưởng duyệt' })).toHaveAccessibleName(/Đang áp dụng/);
});
