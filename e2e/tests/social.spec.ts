// Crove Social in the browser (Social plan S5): connect the offline sandbox channel, give it a queue, compose a post,
// submit it, approve it on what is shown, schedule it in the next free slot, and find it in the agenda. The channel
// rules run as the text is typed.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

// Queue slots are set in the queue's time zone (Asia/Ho_Chi_Minh by default) and the agenda shows the viewer's local
// time, so the browser runs in that zone whatever the machine's zone is.
test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('composes, reviews and schedules a post on the sandbox channel', async ({ page }) => {
  await signUp(page, newEmail('social'));
  await createOrg(page, 'Công ty Social');

  await page.getByRole('navigation').getByRole('link', { name: 'Mạng xã hội' }).click();
  await expect(page.getByText('Chưa kết nối kênh nào')).toBeVisible();
  await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();

  await page.getByLabel('Tên kênh thử').fill('Fanpage E2E');
  await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
  await expect(page.getByText('Fanpage E2E').first()).toBeVisible();
  await page.getByRole('textbox', { name: 'Giờ' }).fill('09:00');
  await page.getByRole('button', { name: 'Thêm cho mọi ngày' }).click();
  await page.getByRole('button', { name: 'Lưu hàng đợi' }).click();
  await expect(page.getByText(/Khung giờ trống kế tiếp:/)).toBeVisible();

  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('link', { name: 'Soạn bài' }).click();
  // The sandbox allows 1,000 characters: one more is flagged as typed and blocks submitting.
  await page.getByLabel('Nội dung chung').fill('x'.repeat(1001));
  await expect(page.getByText('Nội dung dài 1.001 ký tự, kênh này cho tối đa 1.000')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lưu và gửi duyệt' })).toBeDisabled();
  await page.getByLabel('Nội dung chung').fill('Ra mắt Crove Social: soạn một lần, duyệt rồi đăng đúng giờ.');
  await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();

  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Chờ duyệt')).toBeVisible();
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(page.getByText('Lên lịch 1 kênh đã duyệt')).toBeVisible();
  await page.getByRole('button', { name: 'Khung giờ trống kế tiếp' }).click();
  await page.getByRole('button', { name: 'Lên lịch', exact: true }).click();
  await expect(page.getByText(/Đăng lúc .* · theo hàng đợi/)).toBeVisible();
  await expect(page.getByText('Đã lên lịch')).toBeVisible();

  await page.getByRole('link', { name: 'Quay lại' }).click();
  await expect(page.getByRole('tab', { name: 'Lịch đăng' })).toBeVisible();
  await expect(page.getByText('Ra mắt Crove Social: soạn một lần, duyệt rồi đăng đúng giờ.')).toBeVisible();
  await expect(page.getByText('09:00')).toBeVisible();
});

test('keeps unsaved edits when another tab approves the post', async ({ page, context }) => {
  await signUp(page, newEmail('social-edit'));
  await createOrg(page, 'Công ty Hai Tab');
  await page.getByRole('navigation').getByRole('link', { name: 'Mạng xã hội' }).click();
  await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
  await page.getByLabel('Tên kênh thử').fill('Trang Hai Tab');
  await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
  await expect(page.getByText('Trang Hai Tab').first()).toBeVisible();
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('link', { name: 'Soạn bài' }).click();
  await page.getByLabel('Nội dung chung').fill('Bản gốc');
  await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(page.getByText('Chờ duyệt')).toBeVisible();
  const url = page.url();

  // This tab starts editing; the other tab approves the same post.
  await page.getByLabel('Nội dung chung').fill('Bản gốc, đang sửa dở');
  const other = await context.newPage();
  await other.goto(url);
  await other.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(other.getByText('Đã duyệt').first()).toBeVisible();

  // The status reaches this tab without wiping what is being typed.
  await page.bringToFront();
  await expect(page.getByText('Đã duyệt').first()).toBeVisible();
  await expect(page.getByLabel('Nội dung chung')).toHaveValue('Bản gốc, đang sửa dở');
  await expect(page.getByText('Bài vừa được sửa ở nơi khác')).toHaveCount(0);
});
