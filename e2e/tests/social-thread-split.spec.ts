// A long text split into a thread (#1222), on the offline sandbox channel: a 1,200-character text is over the
// sandbox's 1,000, so the channel's card offers *Tách thành chuỗi bài* with a preview; the split fills the channel's own
// text and a thread part as an unsaved edit, *Gộp lại* puts the text back, and the split post goes through review and
// out as a thread of two posts.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
test.use({ timezoneId: TIME_ZONE });

// Paragraphs of three sentences, then a closing line, exactly 1,200 characters.
function longText(): string {
  const sentence = (i: number) => `Ngày ${i}: tiệm bánh mở cửa từ sáng sớm, bánh mì nóng giòn ra lò mỗi giờ, mời cả nhà ghé thử.`;
  const paragraphs: string[] = [];
  for (let i = 1; i <= 10; i += 3) paragraphs.push([sentence(i), sentence(i + 1), sentence(i + 2)].join(' '));
  const body = `${paragraphs.join('\n\n')}\n\n${'Cảm ơn cả nhà đã ủng hộ tiệm bánh. '.repeat(4)}`;
  return body.slice(0, 1199).trimEnd().padEnd(1200, '!');
}

function channelCard(page: Page, name: string): Locator {
  return page.locator('[data-slot="card"]').filter({ hasText: name }).filter({ hasText: 'Viết riêng cho kênh này' });
}

test('splits a 1,200-character text into a thread and posts it on the sandbox (#1222)', async ({ page }) => {
  const text = longText();
  expect(text.length).toBe(1200);
  await signInNewUser(page, newEmail('social-thread-split'));
  await createOrg(page, 'Công ty Chuỗi Bài');
  const channel = 'Trang Chuỗi Bài';

  await page.getByRole('navigation').getByRole('link', { name: 'Mạng xã hội' }).click();
  await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
  await page.getByLabel('Tên kênh thử').fill(channel);
  await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
  await expect(page.getByText(channel).first()).toBeVisible();
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('link', { name: 'Soạn bài' }).click();
  await page.getByLabel('Nội dung chung').fill(text);

  // Too long for one post: the card says so and previews the thread, each post with its count.
  const card = channelCard(page, channel);
  await expect(card.getByText('Nội dung dài 1.200 ký tự, kênh này cho tối đa 1.000')).toBeVisible();
  await expect(card.getByText(/^Nội dung dài quá một bài của kênh này\. Có thể tách thành 2 phần/)).toBeVisible();
  await expect(card.getByText('Xem trước chuỗi bài')).toBeVisible();
  await expect(card.getByText(/^Phần 1 · \d+\/1\.000$/)).toBeVisible();
  await expect(card.getByText(/^Phần 2 · \d+\/1\.000$/)).toBeVisible();

  // The split, as an unsaved edit: the channel's own text and its second part; Gộp lại undoes it.
  await card.getByRole('button', { name: 'Tách thành chuỗi bài' }).click();
  await expect(card.getByText('Đã tách thành 2 phần, thay đổi chưa được lưu.')).toBeVisible();
  await expect(card.getByLabel('Phần 2')).toBeVisible();
  await expect(card.getByText('Nội dung dài 1.200 ký tự, kênh này cho tối đa 1.000')).toHaveCount(0);
  await card.getByRole('button', { name: 'Gộp lại' }).click();
  await expect(card.getByLabel('Phần 2')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Tách thành chuỗi bài' })).toBeVisible();
  await card.getByRole('button', { name: 'Tách thành chuỗi bài' }).click();
  const own = await card.getByLabel('Nội dung riêng cho kênh này').inputValue();
  const part2 = await card.getByLabel('Phần 2').inputValue();
  expect(`${own} ${part2}`.replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));

  // Saved and sent through review, approved, scheduled, then due now: the sandbox posts it and its reply.
  await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(page.getByText('Lên lịch 1 kênh đã duyệt')).toBeVisible();
  await page.getByRole('button', { name: 'Lên lịch', exact: true }).click();
  const posted = channelCard(page, channel);
  await expect(posted.getByText('Đã lên lịch', { exact: true })).toBeVisible();
  const postId = new URL(page.url()).pathname.split('/').pop() ?? '';
  exec(`UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = :'post'`, { post: postId });
  await expect(posted.getByText('Đã đăng', { exact: true })).toBeVisible({ timeout: 45_000 });

  // What was stored and sent: the first post as the channel's text, the rest as its one thread part, together the
  // whole text, and the part's call succeeded.
  const [variant] = sql<{ body: string; parts: string[]; id: string }>(
    `SELECT id, body, settings->'threadParts' AS parts FROM crove_social.post_variant WHERE post_id = :'post'`,
    { post: postId },
  );
  expect(variant?.parts).toHaveLength(1);
  expect(`${variant?.body} ${variant?.parts[0]}`.replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  expect([...(variant?.body ?? '')].length).toBeLessThanOrEqual(1000);
  await expect
    .poll(() => sql<{ step: string; state: string }>(`SELECT step, state FROM crove_kernel.external_call WHERE key LIKE :'prefix' ORDER BY started_at`, { prefix: `%${variant?.id}%:part_%` }), { timeout: 45_000 })
    .toEqual([{ step: 'part_2', state: 'succeeded' }]);
  await page.reload();
  await expect(page.getByText('Chuỗi bài: đã đăng đủ 2 phần')).toBeVisible();
});
