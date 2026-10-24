// Whose posts and saved views on the Social home (#1300): an owner filters the drafts by one writer, the filter stays
// in the address through a reload, and the owner saves it as a view shared with the team; the writer opens it in one
// click, and never sees the owner's private view. Each test has its own users and org (signInNewUser).
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const userIdOf = (email: string) => sql<{ id: string }>(`SELECT id FROM crove_kernel.user_account WHERE lower(email) = lower(:'email')`, { email })[0]?.id ?? '';

// A draft on the org's only channel, written from the composer.
async function draft(page: Page, slug: string, body: string): Promise<void> {
  await page.goto(`/o/${slug}/social/new`);
  await page.getByLabel('Nội dung chung').fill(body);
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
}

test('filters the drafts by a writer, keeps it in the link, and shares it as a saved view (#1300)', async ({ page, browser }) => {
  await signInNewUser(page, newEmail('social-views-owner'));
  const slug = await createOrg(page, 'Công ty Bộ Lọc');
  await page.getByRole('navigation').getByRole('link', { name: 'Mạng xã hội' }).click();
  await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
  await page.getByLabel('Tên kênh thử').fill('Kênh Chung');
  await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
  await expect(page.getByText('Kênh Chung').first()).toBeVisible();
  await draft(page, slug, 'Bài nháp của chủ');

  // Lan, a member, writes a draft from a browser of her own.
  const lanEmail = newEmail('social-views-lan');
  const lanContext = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'vi-VN' });
  const lanPage = await lanContext.newPage();
  await signInNewUser(lanPage, lanEmail);
  await expect.poll(() => userIdOf(lanEmail)).not.toBe('');
  const lan = userIdOf(lanEmail);
  exec(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) SELECT org_id, :'lan', 'member' FROM crove_kernel.tenant WHERE slug = :'slug'`, { lan, slug });
  await draft(lanPage, slug, 'Bài nháp của Lan');

  // The owner checks Lan's drafts: the filter is in the address and survives a reload.
  await page.goto(`/o/${slug}/social?tab=drafts`);
  await expect(page.getByText('Bài nháp của chủ')).toBeVisible();
  await page.getByLabel('Người viết').selectOption(lan);
  await expect(page).toHaveURL(new RegExp(`author=${lan}`));
  await expect(page.getByText('Bài nháp của Lan')).toBeVisible();
  await expect(page.getByText('Bài nháp của chủ')).toBeHidden();
  await page.reload();
  await expect(page.getByLabel('Người viết')).toHaveValue(lan);
  await expect(page.getByText('Bài nháp của Lan')).toBeVisible();
  await expect(page.getByText('Bài nháp của chủ')).toBeHidden();

  // Saved for the team.
  await page.getByRole('button', { name: 'Lưu chế độ xem' }).click();
  await page.getByLabel('Tên chế độ xem').fill('Nháp của Lan');
  await page.getByRole('checkbox', { name: 'Dùng chung với cả nhóm' }).click();
  await page.getByRole('form', { name: 'Lưu chế độ xem' }).getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByText('Đã lưu chế độ xem “Nháp của Lan”.')).toBeVisible();
  // And one for the owner alone, on their own drafts.
  await page.getByLabel('Người viết').selectOption('me');
  await expect(page.getByText('Bài nháp của chủ')).toBeVisible();
  await page.getByRole('button', { name: 'Lưu chế độ xem' }).click();
  await page.getByLabel('Tên chế độ xem').fill('Nháp riêng của chủ');
  await page.getByRole('form', { name: 'Lưu chế độ xem' }).getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByText('Đã lưu chế độ xem “Nháp riêng của chủ”.')).toBeVisible();

  // Lan opens the shared view in one click; the owner's private one is not offered to her.
  await lanPage.goto(`/o/${slug}/social`);
  const views = lanPage.getByLabel('Chế độ xem đã lưu');
  await expect(views.locator('option', { hasText: 'Nháp của Lan' })).toHaveCount(1);
  await expect(views.locator('option', { hasText: 'Nháp riêng của chủ' })).toHaveCount(0);
  const value = await views.locator('option', { hasText: 'Nháp của Lan' }).getAttribute('value');
  await views.selectOption(value ?? '');
  await expect(lanPage).toHaveURL(new RegExp(`tab=drafts.*author=${lan}|author=${lan}.*tab=drafts`));
  await expect(lanPage.getByText('Bài nháp của Lan')).toBeVisible();
  await expect(lanPage.getByText('Bài nháp của chủ')).toBeHidden();
  await lanContext.close();

  const rows = sql<{ name: string; shared: boolean }>(
    `SELECT name, shared FROM crove_social.saved_view WHERE org_id = (SELECT org_id FROM crove_kernel.tenant WHERE slug = :'slug') ORDER BY name`,
    { slug },
  );
  expect(rows.map((r) => `${r.name}:${String(r.shared)}`)).toEqual(['Nháp của Lan:true', 'Nháp riêng của chủ:false']);
});
