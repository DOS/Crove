// Social figures on the multi-client home (#1261), end to end: an agency with two client companies sees, on the
// overview, the post waiting for review and the channel to reconnect in the first one and a quiet week in the second,
// each figure opening the filtered Social list of that company; at 360px the page does not scroll sideways.
import { expect, test } from '@playwright/test';
import { exec } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('an agency sees each client’s Social figures on the overview and opens the list behind one', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('clients-social'));
  const first = await createOrg(page, 'Công ty An Bình');

  await test.step('the first company has a post waiting for review on its sandbox channel', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Mạng xã hội' }).click();
    await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
    await page.getByLabel('Tên kênh thử').fill('Fanpage An Bình');
    await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
    await expect(page.getByText('Fanpage An Bình').first()).toBeVisible();
    await page.getByRole('link', { name: 'Quay lại' }).click();
    await page.getByRole('link', { name: 'Soạn bài' }).click();
    await page.getByLabel('Nội dung chung').fill('Khuyến mãi cuối tuần của An Bình');
    await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
    await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Chờ duyệt', { exact: true })).toBeVisible();
  });

  await test.step('a second company', async () => {
    await page.goto('/onboarding');
    await createOrg(page, 'Công ty Bình Minh');
  });

  await test.step('the overview shows each company’s Social figures', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/clients$/);
    await expect(page.getByRole('columnheader', { name: 'Mạng xã hội' })).toBeVisible();
    const anBinh = page.getByRole('row').filter({ hasText: 'Công ty An Bình' });
    const binhMinh = page.getByRole('row').filter({ hasText: 'Công ty Bình Minh' });
    await expect(anBinh.getByRole('link', { name: '1 bài chờ duyệt' })).toBeVisible();
    await expect(anBinh.getByRole('link', { name: 'Chưa đăng bài nào' })).toBeVisible();
    await expect(binhMinh.getByRole('link', { name: 'Chưa có bài nào trong 7 ngày tới' })).toBeVisible();
    await expect(binhMinh.getByRole('link', { name: /bài chờ duyệt/ })).toHaveCount(0);
  });

  await test.step('a figure opens the filtered list of that company', async () => {
    await page.getByRole('row').filter({ hasText: 'Công ty An Bình' }).getByRole('link', { name: '1 bài chờ duyệt' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${first}/social\\?tab=review$`));
    await expect(page.getByText('Khuyến mãi cuối tuần của An Bình').first()).toBeVisible();
  });

  await test.step('a channel whose sign-in expired shows as one to reconnect, leading to the channels page', async () => {
    exec(`UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE org_id = (SELECT org_id FROM crove_kernel.tenant WHERE slug = :'slug')`, { slug: first });
    await page.goto('/clients');
    const anBinh = page.getByRole('row').filter({ hasText: 'Công ty An Bình' });
    await expect(anBinh.getByRole('link', { name: '1 kênh cần kết nối lại' })).toBeVisible();
    await anBinh.getByRole('link', { name: '1 kênh cần kết nối lại' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${first}/social/channels$`));
  });

  await test.step('at 360px the overview does not scroll sideways', async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/clients');
    await expect(page.getByRole('row').filter({ hasText: 'Công ty An Bình' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  });
});
