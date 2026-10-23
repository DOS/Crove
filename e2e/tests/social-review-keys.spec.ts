// Reviewing Social posts by keyboard (#1221): with a review checklist (#1105), a reviewer approves three posts in a
// row from the keyboard alone and lands on "Hết bài chờ duyệt". A leaves the approval unsent until every item is
// ticked and takes the focus to the first one left; the shortcuts do nothing while typing in a field; R takes the
// focus to the reason of a request for changes. A comment pin is placed and moved with the arrow keys before it is
// saved (#1186). Each test has its own user, created confirmed without the sign-up form (the suite shares one sign-up
// budget), and its own org, on the offline sandbox channel.
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

const postIdOf = (page: Page) => new URL(page.url()).pathname.split('/').pop() ?? '';

// From the org's first screen: connects a sandbox channel and stays on the channels screen.
async function connectSandbox(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'Mạng xã hội' }).click();
  await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
  await page.getByLabel('Tên kênh thử').fill(name);
  await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

// From the Social home: writes a post and sends it for review; stays on its page.
async function submitForReview(page: Page, body: string): Promise<string> {
  await page.getByRole('link', { name: 'Soạn bài' }).click();
  await page.getByLabel('Nội dung chung').fill(body);
  await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  return postIdOf(page);
}

test('approves three posts with a checklist in a row from the keyboard and lands on none left (#1221)', async ({ page }) => {
  await signInNewUser(page, newEmail('social-keys'));
  await createOrg(page, 'Công ty Duyệt Bằng Phím');
  await connectSandbox(page, 'Trang Duyệt Phím');

  // The org's review checklist: two items every channel's approval needs.
  await page.getByRole('button', { name: 'Thêm mục' }).click();
  await page.getByLabel('Mục 1', { exact: true }).fill('Đã soát chính tả');
  await page.getByRole('button', { name: 'Thêm mục' }).click();
  await page.getByLabel('Mục 2', { exact: true }).fill('Liên kết mở được');
  await page.getByRole('button', { name: 'Lưu danh sách' }).click();
  await expect(page.getByText('Đã lưu danh sách kiểm tra.')).toBeVisible();

  await page.getByRole('link', { name: 'Quay lại' }).click();
  const ids: string[] = [];
  for (const body of ['Bài phím một', 'Bài phím hai', 'Bài phím ba']) {
    ids.push(await submitForReview(page, body));
    await page.getByRole('link', { name: 'Quay lại' }).click();
  }
  // The review list is newest change first: the third post, then the second, then the first.
  const order = [...ids].reverse();

  // Every approval this page sends, to check none goes out without its ticks.
  const decisions: Array<Record<string, unknown>> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/rpc/social/variants/decide')) decisions.push((request.postDataJSON() as { json: Record<string, unknown> }).json);
  });

  // The first post of the review list is opened; from here on only the keyboard is used.
  await page.getByRole('tab', { name: /Cần duyệt/ }).click();
  await page.getByRole('link', { name: /Bài phím ba/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/social/${order[0]}$`));
  const panel = page.locator('[data-slot="card"]').filter({ hasText: 'Duyệt bài' }).filter({ hasText: 'Danh sách kiểm tra' });
  await expect(panel.getByTestId('review-shortcuts')).toContainText('J hoặc N sang bài tiếp');
  await expect(panel.getByRole('button', { name: 'Duyệt và sang bài tiếp' })).toBeDisabled();

  // J and K move along the list, in its order, and back.
  await page.locator('body').press('j');
  await expect(page).toHaveURL(new RegExp(`/social/${order[1]}$`));
  await page.locator('body').press('k');
  await expect(page).toHaveURL(new RegExp(`/social/${order[0]}$`));

  // Typed in a field, the shortcuts are text: R puts the focus in the reason, where "a", "j" and "r" are typed.
  await expect(panel.getByRole('checkbox').first()).toBeVisible();
  await page.keyboard.press('r');
  const reason = panel.getByRole('textbox', { name: 'Nhận xét cho người viết' });
  await expect(reason).toBeFocused();
  await page.keyboard.type('ajr');
  await expect(reason).toHaveValue('ajr');
  await expect(page).toHaveURL(new RegExp(`/social/${order[0]}$`));
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await expect(reason).toHaveValue('');
  await page.keyboard.press('Shift+Tab');

  for (const [n, id] of order.entries()) {
    await expect(page).toHaveURL(new RegExp(`/social/${id}$`));
    const items = page.getByRole('group', { name: 'Danh sách kiểm tra' }).getByRole('checkbox');
    await expect(items).toHaveCount(2);
    // A with items left takes the focus to the first one and sends nothing; Space ticks it.
    await page.keyboard.press('a');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(items.nth(0)).toBeChecked();
    await page.keyboard.press('a');
    await expect(items.nth(1)).toBeFocused();
    expect(decisions).toHaveLength(n);
    await page.keyboard.press('Space');
    await expect(items.nth(1)).toBeChecked();
    // Everything ticked: A approves, as Duyệt would, and opens the next post.
    await page.keyboard.press('a');
    await expect.poll(() => decisions.length).toBe(n + 1);
    if (n < order.length - 1) await expect(page).toHaveURL(new RegExp(`/social/${order[n + 1]}$`));
  }
  await expect(page.getByTestId('review-none-left')).toContainText('Hết bài chờ duyệt');
  await expect(page.getByTestId('review-none-left')).toBeFocused();

  // Each approval named its post's channel at the revision and content shown, with both items ticked.
  expect(decisions.map((d) => d.postId)).toEqual(order);
  for (const d of decisions) {
    expect(d.decision).toBe('approved');
    const variants = d.variants as Array<{ revision: number; contentHash: string; checks: string[] }>;
    expect(variants).toHaveLength(1);
    expect(variants[0]?.checks).toHaveLength(2);
    expect(typeof variants[0]?.contentHash).toBe('string');
  }

  // The list is empty now.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Về mục Cần duyệt' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Không có bài nào chờ duyệt')).toBeVisible();
});

test('places a comment pin from the keyboard and moves it with the arrow keys before saving it (#1186)', async ({ page }) => {
  await signInNewUser(page, newEmail('social-pin-keys'));
  await createOrg(page, 'Công ty Ghim Phím');
  await connectSandbox(page, 'Trang Ghim Phím');
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('link', { name: 'Soạn bài' }).click();
  await page.getByLabel('Nội dung chung').fill('Bài có ảnh để ghim');
  await page.locator('input[type="file"]').setInputFiles([{ name: 'logo.png', mimeType: 'image/png', buffer: PNG }]);
  await page.getByRole('textbox', { name: 'Mô tả ảnh 1' }).fill('Logo cửa hàng');
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);

  const image = page.getByRole('button', { name: 'Ghim bình luận vào một chỗ trên Ảnh 1' });
  await expect(image).toBeEnabled();
  await image.focus();
  // Enter pins the middle; three steps right and one long step down move it before it is saved.
  await page.keyboard.press('Enter');
  const draft = page.getByTestId('pin-draft');
  await expect(draft).toHaveAttribute('style', /left: 50%; top: 50%/);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(draft).toHaveAttribute('style', /left: 53%; top: 60%/);
  await expect(page.getByTestId('pin-draft-at')).toHaveText('Chỗ sẽ ghim: 53% từ trái sang, 60% từ trên xuống');
  // The arrows moved the pin, not the page.
  await expect(image).toBeFocused();

  await page.keyboard.press('Tab');
  await page.keyboard.type('Logo lệch sang phải');
  // Past the note of the pin (its Bỏ ghim) to the send button.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Bình luận', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const marker = page.getByTestId('pin-marker');
  await expect(marker).toHaveAttribute('aria-label', 'Ghim 1: Logo lệch sang phải');
  await expect(marker).toHaveAttribute('style', /left: 53%; top: 60%/);
});
