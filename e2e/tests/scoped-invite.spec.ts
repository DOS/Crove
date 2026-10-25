// An invite for some legal entities only (issue #1447, the server's #1281): an owner of an org with a second legal
// entity limits an outside accountant to it. The invite is for a member or a viewer, the list shows its entities, and
// the invitee who accepts holds the outside accountant role for that entity. Hiding the other entities' data comes
// with #1280; nothing here claims it.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('an owner invites an outside accountant for one legal entity', async ({ page, browser }) => {
  const owner = newEmail('scoped-owner');
  await signUp(page, owner);
  const slug = await createOrg(page, 'Công ty nhiều pháp nhân');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();

  // Inviting is R3: turn on the second factor first, so the code is fresh.
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.getByText('Đang bật')).toBeVisible();

  // With one legal entity there is nothing to limit to.
  await expect(page.getByRole('checkbox', { name: 'Giới hạn theo pháp nhân' })).toHaveCount(0);
  const add = page.getByRole('form', { name: 'Thêm pháp nhân' });
  await add.getByLabel('Tên pháp nhân').fill('Chi nhánh Hà Nội');
  await add.getByRole('button', { name: 'Thêm', exact: true }).click();
  // In the page, not the sidebar switcher, whose options carry the same name.
  await expect(page.getByRole('main').getByText('Chi nhánh Hà Nội').first()).toBeVisible();

  const member = newEmail('scoped-member');
  await page.getByPlaceholder('email@congty.vn').fill(member);
  const role = page.getByLabel('Vai trò', { exact: true });
  await role.selectOption('admin');
  await page.getByRole('checkbox', { name: 'Giới hạn theo pháp nhân' }).check();
  // A scoped invite is never for an admin.
  await expect(role).toHaveValue('member');
  await expect(role.getByRole('option', { name: 'Quản trị' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mời', exact: true }).click();
  await expect(page.getByText('Hãy chọn ít nhất một pháp nhân')).toBeVisible();

  await page.getByRole('group', { name: 'Pháp nhân được làm việc' }).getByRole('checkbox', { name: 'Chi nhánh Hà Nội' }).check();
  await page.getByRole('button', { name: 'Mời', exact: true }).click();
  const created = page.getByRole('status').filter({ hasText: `Đã tạo lời mời cho ${member}` });
  const link = (await created.getByText(/\/-\/invite#/).textContent())?.trim() ?? '';
  expect(link).toMatch(/\/-\/invite#/);
  await expect(page.getByRole('listitem').filter({ hasText: member }).getByText('Kế toán thuê ngoài cho: Chi nhánh Hà Nội', { exact: true })).toBeVisible();

  // The invitee accepts in a browser of their own.
  const memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const memberPage = await memberContext.newPage();
  await signUp(memberPage, member);
  await memberPage.goto(link);
  await memberPage.getByRole('button', { name: 'Chấp nhận lời mời' }).click();
  await expect(memberPage).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  await memberContext.close();

  // The owner sees the new member holding the outside accountant role for that entity.
  await page.reload();
  const roles = page.getByRole('listitem').filter({ hasText: member }).getByRole('group', { name: `Vai trò nghiệp vụ của ${member}` });
  await expect(roles.getByText('Kế toán thuê ngoài')).toBeVisible();
  await expect(roles.getByText('Chi nhánh Hà Nội')).toBeVisible();
});
