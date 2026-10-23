// Suggested edits while reviewing (#1236), on the offline sandbox channel: a member writes a post and sends it for
// review; the owner, reviewing it, selects words of its text from the keyboard and suggests others; the member accepts
// the suggestion from the keyboard, the text changes with a new version and the post is in review again. A suggestion
// whose words an edit removed shows as outdated and cannot be accepted, only skipped. Each test has its own users,
// created confirmed without the sign-up form (the suite shares one sign-up budget), and its own org.
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
test.use({ timezoneId: TIME_ZONE });

const postIdOf = (page: Page) => new URL(page.url()).pathname.split('/').pop() ?? '';

// Selects `quote` in the focused text box from the keyboard: to the start, then right to it, then Shift+right over it.
async function selectByKeyboard(page: Page, body: string, quote: string): Promise<void> {
  const at = body.indexOf(quote);
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < at; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < quote.length; i++) await page.keyboard.press('Shift+ArrowRight');
}

test('a reviewer suggests an edit, the author accepts it by keyboard, and the post is reviewed again (#1236)', async ({ page, browser }) => {
  await signInNewUser(page, newEmail('social-suggest-owner'));
  const slug = await createOrg(page, 'Công ty Đề Xuất Sửa');
  await page.getByRole('navigation').getByRole('link', { name: 'Mạng xã hội' }).click();
  await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
  await page.getByLabel('Tên kênh thử').fill('Trang Đề Xuất');
  await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
  await expect(page.getByText('Trang Đề Xuất').first()).toBeVisible();

  // The writer, a member of the org, writes the post and sends it for review.
  const writer = newEmail('social-suggest-writer');
  const writerContext = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'vi-VN', timezoneId: TIME_ZONE });
  const writerPage = await writerContext.newPage();
  await signInNewUser(writerPage, writer);
  await expect.poll(() => sql<{ id: string }>(`SELECT id FROM crove_kernel.user_account WHERE lower(email) = lower(:'email')`, { email: writer }).length).toBe(1);
  exec(
    `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
     SELECT t.org_id, u.id, 'member' FROM crove_kernel.tenant t, crove_kernel.user_account u
      WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { slug, email: writer },
  );
  const body = 'Khai trương cửa hàng mới, giảm 20% cả tuần.';
  await writerPage.goto(`/o/${slug}/social/new`);
  await writerPage.getByLabel('Nội dung chung').fill(body);
  await writerPage.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(writerPage).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  const postId = postIdOf(writerPage);
  const postUrl = writerPage.url();
  await expect.poll(() => sql<{ status: string }>(`SELECT status FROM crove_social.post_variant WHERE post_id = :'post'`, { post: postId })).toEqual([{ status: 'in_review' }]);

  // The owner reviews it: the panel says how to suggest; the words are selected from the keyboard.
  await page.goto(postUrl);
  await expect(page.getByText('Muốn đổi câu chữ? Bôi đen đoạn đó trong nội dung rồi bấm Đề xuất sửa')).toBeVisible();
  const text = page.getByLabel('Nội dung chung');
  await expect(text).toHaveValue(body);
  const open = page.getByRole('button', { name: 'Đề xuất sửa', exact: true }).first();
  await expect(open).toBeDisabled();
  await text.focus();
  await selectByKeyboard(page, body, 'giảm 20%');
  await expect(page.getByText('Đã chọn 8 ký tự')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(open).toBeFocused();
  await page.keyboard.press('Enter');
  const form = page.getByTestId('suggest-form');
  const replacement = form.getByRole('textbox', { name: 'Sửa thành' });
  await expect(replacement).toBeFocused();
  await expect(replacement).toHaveValue('giảm 20%');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('giảm 25%');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Mức giảm đúng là 25%');
  await page.keyboard.press('Tab');
  await expect(form.getByRole('button', { name: 'Gửi đề xuất' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Đã gửi đề xuất sửa.')).toBeVisible();
  // The focus is back in the text, which did not change.
  await expect(text).toBeFocused();
  await expect(text).toHaveValue(body);

  // In the comments: the change, old to new, with the words around it.
  const suggestion = page.getByTestId('suggestion').first();
  await expect(suggestion).toContainText('Đề xuất sửa nội dung chung');
  await expect(suggestion.locator('del')).toHaveText('giảm 20%');
  await expect(suggestion.locator('ins')).toHaveText('giảm 25%');
  await expect(suggestion).toContainText('Khai trương cửa hàng mới,');
  await expect(page.getByText('Mức giảm đúng là 25%')).toBeVisible();
  const row = () => sql<{ suggest_state: string; suggest_quote: string; suggest_text: string }>(`SELECT suggest_state, suggest_quote, suggest_text FROM crove_social.post_comment WHERE post_id = :'post'`, { post: postId });
  expect(row()).toEqual([{ suggest_state: 'open', suggest_quote: 'giảm 20%', suggest_text: 'giảm 25%' }]);
  const versionsBefore = Number(sql<{ n: string }>(`SELECT count(*)::text AS n FROM crove_social.post_version WHERE post_id = :'post'`, { post: postId })[0]?.n);
  const revisionBefore = sql<{ revision: number }>(`SELECT revision FROM crove_social.post_variant WHERE post_id = :'post'`, { post: postId })[0]?.revision ?? 0;

  // The writer accepts it from the keyboard.
  await writerPage.reload();
  const theirs = writerPage.getByTestId('suggestion').first();
  const accept = theirs.getByRole('button', { name: 'Nhận', exact: true });
  await accept.focus();
  await writerPage.keyboard.press('Enter');
  await expect(theirs.getByText('Đã sửa theo đề xuất, bài được gửi duyệt lại.')).toBeVisible();
  await expect(theirs).toContainText('Đã nhận');
  await expect(writerPage.getByLabel('Nội dung chung')).toHaveValue('Khai trương cửa hàng mới, giảm 25% cả tuần.');
  // A new revision and version, and the channel back in review in a new round.
  const after = sql<{ status: string; revision: number }>(`SELECT status, revision FROM crove_social.post_variant WHERE post_id = :'post'`, { post: postId });
  expect(after).toEqual([{ status: 'in_review', revision: revisionBefore + 1 }]);
  expect(Number(sql<{ n: string }>(`SELECT count(*)::text AS n FROM crove_social.post_version WHERE post_id = :'post'`, { post: postId })[0]?.n)).toBeGreaterThan(versionsBefore);
  expect(row()[0]?.suggest_state).toBe('accepted');
  await expect(writerPage.getByText('đã sửa nội dung').first()).toBeVisible();

  // The owner suggests again; the writer then rewrites the end, so the suggestion is outdated: only Bỏ qua is left.
  await page.reload();
  const edited = 'Khai trương cửa hàng mới, giảm 25% cả tuần.';
  await expect(text).toHaveValue(edited);
  await text.focus();
  await selectByKeyboard(page, edited, 'cả tuần');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('cả tháng');
  await form.getByRole('button', { name: 'Gửi đề xuất' }).click();
  await expect(page.getByText('Đã gửi đề xuất sửa.')).toBeVisible();

  await writerPage.reload();
  await writerPage.getByLabel('Nội dung chung').fill('Khai trương cửa hàng mới, giảm 25% đến Chủ nhật.');
  // Unsaved edits on the page hold back accepting a suggestion.
  await expect(writerPage.getByTestId('suggestion').filter({ hasText: 'cả tháng' }).getByRole('button', { name: 'Nhận', exact: true })).toBeDisabled();
  await writerPage.getByRole('button', { name: 'Lưu', exact: true }).first().click();
  await expect.poll(() => sql<{ body: string }>(`SELECT body FROM crove_social.post WHERE id = :'post'`, { post: postId })).toEqual([{ body: 'Khai trương cửa hàng mới, giảm 25% đến Chủ nhật.' }]);
  await writerPage.reload();
  const stale = writerPage.getByTestId('suggestion').filter({ hasText: 'cả tháng' });
  await expect(stale).toHaveAttribute('data-state', 'outdated');
  await expect(stale).toContainText('Đã cũ');
  await expect(stale.getByRole('button', { name: 'Nhận', exact: true })).toBeDisabled();
  await stale.getByRole('button', { name: 'Bỏ qua', exact: true }).click();
  await expect(stale.getByText('Đã bỏ qua đề xuất.')).toBeVisible();
  await expect(writerPage.getByLabel('Nội dung chung')).toHaveValue('Khai trương cửa hàng mới, giảm 25% đến Chủ nhật.');
  expect(sql<{ suggest_state: string }>(`SELECT suggest_state FROM crove_social.post_comment WHERE post_id = :'post' AND suggest_text = 'cả tháng'`, { post: postId })).toEqual([{ suggest_state: 'outdated' }]);
  await writerContext.close();
});
