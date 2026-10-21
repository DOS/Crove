// Crove Social flows past the basic publish (issue #590), on the offline sandbox channel: a channel that needs two
// approvals, retrying a failed channel and settling channels Crove cannot account for, the media library, evergreen
// reposting, the metrics of a published post, and the AI drafting card on a server without a model. Each test signs
// up its own user and org. States the worker reaches only on a real platform (a refusal, an unknown outcome, a metrics
// capture) are written with SQL, as social.spec.ts moves a slot forward.
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

// The schedule form takes local times; the browser runs in the queue's default zone whatever the machine's zone is.
const TIME_ZONE = 'Asia/Ho_Chi_Minh';
test.use({ timezoneId: TIME_ZONE });

// A width x height PNG of one colour (an RGB image, rows unfiltered, deflated).
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([200, 60, 60], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

// From the org's first screen: connects one sandbox channel per name, and stays on the channels screen.
async function connectSandbox(page: Page, ...names: string[]): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: 'Mạng xã hội' }).click();
  await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
  for (const name of names) {
    await page.getByLabel('Tên kênh thử').fill(name);
    await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
    await expect(page.getByText(name).first()).toBeVisible();
  }
}

// From the channels screen: opens the composer with the shared text filled in. With one channel it is chosen for
// you; with several, each named one is picked.
async function compose(page: Page, body: string, channels: string[] = []): Promise<void> {
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('link', { name: 'Soạn bài' }).click();
  await page.getByLabel('Nội dung chung').fill(body);
  for (const name of channels) {
    const pick = page.getByRole('button', { name });
    await pick.click();
    await expect(pick).toHaveAttribute('aria-pressed', 'true');
  }
}

// A channel's card on the post screen: the one with that channel's name and its own-text box (the review panel names
// every channel too, but has no such box).
function channelCard(page: Page, name: string): Locator {
  return page.locator('[data-slot="card"]').filter({ hasText: name }).filter({ hasText: 'Viết riêng cho kênh này' });
}

const postIdOf = (page: Page) => new URL(page.url()).pathname.split('/').pop() ?? '';

// Submits the composed post, approves every channel, schedules them an hour from now and checks each card says so.
async function submitApproveSchedule(page: Page, channels: string[]): Promise<void> {
  await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(page.getByText(`Lên lịch ${channels.length} kênh đã duyệt`)).toBeVisible();
  await page.getByRole('button', { name: 'Lên lịch', exact: true }).click();
  for (const name of channels) await expect(channelCard(page, name).getByText('Đã lên lịch', { exact: true })).toBeVisible();
}

// A post published to the sandbox: scheduled through the screens, then due now, so the worker's sweep publishes it.
// Returns the post's id.
async function publishOnSandbox(page: Page, channel: string, body: string): Promise<string> {
  await connectSandbox(page, channel);
  await compose(page, body);
  await submitApproveSchedule(page, [channel]);
  const postId = postIdOf(page);
  exec(`UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = :'post'`, { post: postId });
  await expect(channelCard(page, channel).getByText('Đã đăng', { exact: true })).toBeVisible({ timeout: 45_000 });
  return postId;
}

test('a channel that needs two approvals waits for a second admin, then is approved', async ({ page, browser }) => {
  await signUp(page, newEmail('social-steps'));
  const slug = await createOrg(page, 'Công ty Hai Người Duyệt');
  const channel = 'Trang Duyệt Kép';
  await connectSandbox(page, channel);

  // The channel's review policy, set on the channels screen and kept after a reload.
  const policy = page.getByLabel('Duyệt trước khi đăng');
  await expect(policy).toBeEnabled();
  await policy.selectOption('2');
  await expect(policy).toHaveValue('2');
  await page.reload();
  await expect(page.getByLabel('Duyệt trước khi đăng')).toHaveValue('2');

  await compose(page, 'Bài cần hai người duyệt');
  await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  const postUrl = page.url();
  const card = channelCard(page, channel);
  await expect(card.getByText('Chờ duyệt', { exact: true })).toBeVisible();
  await expect(card.getByText('Đã duyệt 0/2', { exact: true })).toBeVisible();

  // The author's approval is one of two: the channel stays in review and this reviewer cannot approve it again.
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(card.getByText('Đã duyệt 1/2', { exact: true })).toBeVisible();
  await expect(page.getByText(`Bạn đã duyệt ${channel}; cần thêm người khác duyệt.`)).toBeVisible();
  await expect(card.getByText('Chờ duyệt', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Duyệt', exact: true })).toBeDisabled();

  // A second person signs up in a browser of their own and is made an admin of the org.
  const reviewer = newEmail('social-reviewer');
  const reviewerContext = await browser.newContext({ baseURL: new URL(postUrl).origin, locale: 'vi-VN', timezoneId: TIME_ZONE });
  const reviewerPage = await reviewerContext.newPage();
  await signUp(reviewerPage, reviewer);
  await expect
    .poll(() => sql<{ id: string }>(`SELECT id FROM crove_kernel.user_account WHERE lower(email) = lower(:'email')`, { email: reviewer }).length)
    .toBe(1);
  exec(
    `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
     SELECT t.org_id, u.id, 'admin' FROM crove_kernel.tenant t, crove_kernel.user_account u
      WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { slug, email: reviewer },
  );

  // Their approval is the second: the channel is approved and ready to schedule, on both screens.
  await reviewerPage.goto(postUrl);
  const reviewerCard = channelCard(reviewerPage, channel);
  await expect(reviewerCard.getByText('Đã duyệt 1/2', { exact: true })).toBeVisible();
  await reviewerPage.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(reviewerCard.getByText('Đã duyệt', { exact: true })).toBeVisible();
  await expect(reviewerPage.getByText('Lên lịch 1 kênh đã duyệt')).toBeVisible();
  await page.bringToFront();
  await expect(card.getByText('Đã duyệt', { exact: true })).toBeVisible();

  const approvers = sql<{ n: number }>(
    `SELECT count(DISTINCT decided_by)::int AS n FROM crove_social.post_approval WHERE post_id = :'post' AND decision = 'approved'`,
    { post: postIdOf(page) },
  );
  expect(approvers).toEqual([{ n: 2 }]);
  await reviewerContext.close();
});

test('retries a failed channel and settles the channels Crove could not account for', async ({ page }) => {
  await signUp(page, newEmail('social-retry'));
  await createOrg(page, 'Công ty Đăng Lại');
  const failed = 'Kênh Bị Từ Chối';
  const seen = 'Kênh Đã Thấy Bài';
  const dropped = 'Kênh Bỏ Bài';
  await connectSandbox(page, failed, seen, dropped);
  await compose(page, 'Bài thử đăng lại và xử lý kết quả', [failed, seen, dropped]);
  await submitApproveSchedule(page, [failed, seen, dropped]);
  const postId = postIdOf(page);

  // What a platform's refusal and a lost answer leave behind, which the sandbox never produces on its own.
  const setVariant = (channel: string, values: string) =>
    exec(
      `UPDATE crove_social.post_variant v SET ${values}, updated_at = now()
         FROM crove_kernel.channel_connection c
        WHERE v.post_id = :'post' AND c.org_id = v.org_id AND c.id = v.channel_connection_id AND c.display_name = :'channel'`,
      { post: postId, channel },
    );
  setVariant(failed, `status = 'failed', error_kind = 'bad_request', error_code = 'E2E_REFUSED', error_message = 'Ảnh bìa không hợp lệ'`);
  setVariant(seen, `status = 'needs_attention', error_kind = 'unknown', error_code = 'NOT_FOUND_ON_PLATFORM'`);
  setVariant(dropped, `status = 'needs_attention', error_kind = 'unknown', error_code = 'NOT_FOUND_ON_PLATFORM'`);
  await page.reload();

  const failedCard = channelCard(page, failed);
  await expect(failedCard.getByText('Đăng lỗi', { exact: true })).toBeVisible();
  await expect(failedCard.getByText('Nền tảng từ chối bài này.')).toBeVisible();
  await expect(failedCard.getByText('Nền tảng báo: Ảnh bìa không hợp lệ')).toBeVisible();

  const seenCard = channelCard(page, seen);
  const droppedCard = channelCard(page, dropped);
  for (const card of [seenCard, droppedCard]) {
    await expect(card.getByText('Cần bạn xem', { exact: true })).toBeVisible();
    await expect(card.getByText(/^Crove không xác định được bài đã lên kênh hay chưa\./)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Chưa thấy bài, đăng lại' })).toBeVisible();
  }

  // The person found the post on the platform: the channel counts as published.
  await seenCard.getByRole('button', { name: 'Đã thấy bài trên trang' }).click();
  await expect(seenCard.getByText('Đã đăng', { exact: true })).toBeVisible();
  await expect(seenCard.getByText(/^Đã đăng lúc/)).toBeVisible();

  // The person drops the channel instead: it is cancelled, with nothing left to do on it.
  await droppedCard.getByRole('button', { name: 'Bỏ bài trên kênh này' }).click();
  await expect(droppedCard.getByText('Đã hủy', { exact: true })).toBeVisible();
  await expect(droppedCard.getByRole('button', { name: 'Chưa thấy bài, đăng lại' })).toHaveCount(0);

  // A retry is a new attempt due now: the worker's sweep publishes it to the sandbox, and the page follows.
  await failedCard.getByRole('button', { name: 'Đăng lại', exact: true }).click();
  await expect(failedCard.getByText('Đã đăng', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(failedCard.getByText('Nền tảng từ chối bài này.')).toHaveCount(0);

  const rows = sql<{ display_name: string; status: string }>(
    `SELECT c.display_name, v.status FROM crove_social.post_variant v
       JOIN crove_kernel.channel_connection c ON c.org_id = v.org_id AND c.id = v.channel_connection_id
      WHERE v.post_id = :'post'`,
    { post: postId },
  );
  expect(Object.fromEntries(rows.map((r) => [r.display_name, r.status]))).toEqual({ [failed]: 'published', [seen]: 'published', [dropped]: 'cancelled' });
});

test('keeps uploaded images in the library with the posts that use them', async ({ page }) => {
  await signUp(page, newEmail('social-library'));
  await createOrg(page, 'Công ty Thư Viện');
  await connectSandbox(page, 'Trang Thư Viện');

  // The first post uploads the image.
  await compose(page, 'Bài đầu tiên có ảnh');
  await page.locator('input[type="file"]').setInputFiles([{ name: 'thu-vien.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(page.getByText('1/20')).toBeVisible();
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);

  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('tab', { name: 'Thư viện ảnh' }).click();
  const item = page.getByRole('tabpanel').getByRole('button', { name: /thu-vien\.png/ });
  await expect(item).toContainText('Dùng trong 1 bài');

  // The second post takes the same image from the library instead of uploading it again.
  await page.getByRole('link', { name: 'Soạn bài' }).click();
  await page.getByLabel('Nội dung chung').fill('Bài thứ hai dùng lại ảnh');
  await page.getByRole('button', { name: 'Chọn từ thư viện' }).click();
  await page.getByRole('button', { name: 'Chọn ảnh thu-vien.png' }).click();
  await expect(page.getByText('1/20')).toBeVisible();
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);

  // One file in the library, used by both posts, which its panel lists.
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('tab', { name: 'Thư viện ảnh' }).click();
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Dùng trong 2 bài');
  await item.click();
  await expect(page.getByText('Bài đang dùng ảnh này')).toBeVisible();
  await expect(page.getByRole('link', { name: /Bài đầu tiên có ảnh/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Bài thứ hai dùng lại ảnh/ })).toBeVisible();
});

test('turns on evergreen reposting for a published post', async ({ page }) => {
  await signUp(page, newEmail('social-evergreen'));
  await createOrg(page, 'Công ty Đăng Lại Định Kỳ');
  const postId = await publishOnSandbox(page, 'Trang Định Kỳ', 'Bài đăng lại mỗi tháng');

  // The panel shows once the post is out; reposting is off until someone turns it on.
  const evergreen = page.getByLabel('Tự đăng lại');
  await expect(evergreen).toHaveValue('');
  await evergreen.selectOption('30');
  await expect(evergreen).toHaveValue('30');
  await page.reload();
  await expect(page.getByLabel('Tự đăng lại')).toHaveValue('30');
  await expect(page.getByLabel('Tự đăng lại').locator('option:checked')).toHaveText('Mỗi 30 ngày');
  expect(sql<{ evergreen_days: number | null }>(`SELECT evergreen_days FROM crove_social.post WHERE id = :'post'`, { post: postId })).toEqual([{ evergreen_days: 30 }]);

  // And off again.
  await page.getByLabel('Tự đăng lại').selectOption('');
  await expect(page.getByLabel('Tự đăng lại')).toHaveValue('');
  await expect
    .poll(() => sql<{ evergreen_days: number | null }>(`SELECT evergreen_days FROM crove_social.post WHERE id = :'post'`, { post: postId }))
    .toEqual([{ evergreen_days: null }]);
});

test('shows the latest metrics of a published channel on the post and in the Metrics tab, and in a client report', async ({ page, browser }) => {
  await signUp(page, newEmail('social-metrics'));
  await createOrg(page, 'Công ty Số Liệu');
  const channel = 'Trang Số Liệu';
  const body = 'Bài có số liệu tương tác';
  const postId = await publishOnSandbox(page, channel, body);
  const card = channelCard(page, channel);

  // A capture as the worker records it. Taken now, it is newer than any capture the worker's own sweep may have made
  // since the post went out, and the sweep asks again only after 6 hours.
  exec(
    `INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics)
     SELECT v.org_id, v.id, 'e2e-capture', '{"reach": 1234, "impressions": 2345, "reactions": 56, "comments": 7, "shares": 3}'::jsonb
       FROM crove_social.post_variant v WHERE v.post_id = :'post'`,
    { post: postId },
  );
  await page.reload();
  const count = (label: string) => card.locator('dl > div').filter({ has: page.getByRole('term').filter({ hasText: label }) }).getByRole('definition');
  await expect(count('Người tiếp cận')).toHaveText('1.234');
  await expect(count('Lượt hiển thị')).toHaveText('2.345');
  await expect(count('Cảm xúc')).toHaveText('56');
  await expect(count('Bình luận')).toHaveText('7');
  await expect(count('Chia sẻ')).toHaveText('3');
  // A count the platform did not report is left out.
  await expect(card.getByRole('term').filter({ hasText: 'Lượt lưu' })).toHaveCount(0);
  await expect(card.getByText(/^Số liệu lúc/)).toBeVisible();

  // The Metrics tab: the window's totals and the channel's row.
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('tab', { name: 'Số liệu' }).click();
  const panel = page.getByRole('tabpanel');
  const row = panel.getByRole('row').filter({ has: page.getByRole('link', { name: body }) });
  await expect(row.getByRole('cell')).toHaveText([new RegExp(`^${body}`), '1.234', '56', '7', '3']);
  await expect(row).toContainText(channel);
  await expect(panel.locator('[data-slot="card"]').filter({ hasText: 'Người tiếp cận', hasNot: page.locator('table') })).toContainText('1.234');
  // The best post of the window (#645), and the channel's followers over it from the daily snapshots.
  await expect(panel.locator('[data-slot="card"]').filter({ hasText: 'Bài nổi bật trong khoảng này' })).toContainText(body);
  exec(
    `INSERT INTO crove_social.account_snapshot (org_id, channel_connection_id, captured_on, followers)
     SELECT c.org_id, c.id, d.day, d.n FROM crove_kernel.channel_connection c,
       (VALUES ((now() AT TIME ZONE 'UTC')::date - 3, 1000), ((now() AT TIME ZONE 'UTC')::date, 1080)) AS d(day, n)
     WHERE c.display_name = :'channel'`,
    { channel },
  );
  await page.reload();
  await page.getByRole('tab', { name: 'Số liệu' }).click();
  const growth = page.getByRole('tabpanel').locator('[data-slot="card"]').filter({ hasText: 'Tăng trưởng kênh trong 30 ngày' });
  await expect(growth).toContainText('1.080 người theo dõi');
  await expect(growth).toContainText('+80');

  // A client report link of today (#643), opened without an account: the totals, the channel and the post.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
  await panel.getByLabel('Từ ngày').fill(today);
  await panel.getByLabel('Đến ngày').fill(today);
  await panel.getByLabel('Tên báo cáo').fill('Báo cáo hôm nay');
  await panel.getByRole('button', { name: 'Tạo liên kết báo cáo' }).click();
  const link = await panel.getByLabel('Liên kết báo cáo').inputValue();
  expect(link).toMatch(/\/-\/report#[A-Za-z0-9_-]{43}$/);
  await expect(panel.getByText('Báo cáo hôm nay')).toBeVisible();
  const guest = await browser.newContext({ timezoneId: TIME_ZONE });
  try {
    const client = await guest.newPage();
    await client.goto(link);
    await expect(client.getByRole('heading', { name: 'Báo cáo hôm nay' })).toBeVisible();
    await expect(client.getByText('Công ty Số Liệu')).toBeVisible();
    await expect(client.locator('[data-slot="card"]').filter({ hasText: 'Người tiếp cận', hasNot: client.locator('table') })).toContainText('1.234');
    await expect(client.getByRole('row').filter({ hasText: channel })).toContainText('1.234');
    await expect(client.getByRole('listitem').filter({ hasText: body })).toContainText('Cảm xúc: 56');
    await expect(client.getByRole('button', { name: 'In hoặc lưu PDF' })).toBeVisible();
  } finally {
    await guest.close();
  }
  // Revoked, the same link opens nothing.
  await panel.getByRole('button', { name: 'Thu hồi' }).click();
  await expect(panel.getByText('Đã thu hồi')).toBeVisible();
  const after = await browser.newContext();
  try {
    const client = await after.newPage();
    await client.goto(link);
    await expect(client.getByRole('heading', { name: 'Không mở được báo cáo' })).toBeVisible();
  } finally {
    await after.close();
  }
});

test('says AI drafting is off on a server without a model', async ({ page, request }) => {
  // The e2e stack sets no AI_BASE_URL (docker-compose.yml defaults it to empty), so the composer can only say that
  // AI is off. A stack started with a model has nothing to show here, and its drafts would depend on a live model's
  // answer, so the test stands down there.
  const config = (await (await request.get('/api/config')).json()) as { aiEnabled?: boolean };
  test.skip(config.aiEnabled === true, 'this stack has an AI model configured; AI drafts are not tested end to end');

  await signUp(page, newEmail('social-ai'));
  await createOrg(page, 'Công ty Không AI');
  await connectSandbox(page, 'Trang Không AI');
  await compose(page, 'Bài viết tay, không nhờ AI');

  await expect(page.getByText('Soạn bằng AI', { exact: true })).toBeVisible();
  await expect(page.getByText('Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Soạn nháp bằng AI' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nhờ AI viết lại' })).toHaveCount(0);
});

test('approves several posts at once from the review list (#635)', async ({ page }) => {
  await signUp(page, newEmail('social-bulk'));
  await createOrg(page, 'Công ty Duyệt Nhiều');
  await connectSandbox(page, 'Trang Duyệt Nhiều');
  await page.getByRole('link', { name: 'Quay lại' }).click();
  for (const body of ['Bài thứ nhất', 'Bài thứ hai']) {
    await page.getByRole('link', { name: 'Soạn bài' }).click();
    await page.getByLabel('Nội dung chung').fill(body);
    await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
    await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
    await page.getByRole('link', { name: 'Quay lại' }).click();
  }
  await page.getByRole('tab', { name: /Cần duyệt/ }).click();
  await page.getByText('Chọn mọi bài đang hiện').click();
  await expect(page.getByText('Đã chọn 2 bài')).toBeVisible();
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(page.getByText('Duyệt: xong 2, 0 bài không có gì để làm, 0 bài bị từ chối.')).toBeVisible();
});

test('keeps a post being written through a reload, and offers it back (#634)', async ({ page }) => {
  await signUp(page, newEmail('social-autosave'));
  await createOrg(page, 'Công ty Lưu Nháp');
  await connectSandbox(page, 'Trang Lưu Nháp');
  await compose(page, 'Bài đang viết dở 🎉');
  // The shared text gets an emoji at the cursor from the picker.
  await page.getByRole('button', { name: 'Chèn biểu tượng cảm xúc' }).first().click();
  await page.getByRole('option', { name: '🔥' }).click();
  await expect(page.getByLabel('Nội dung chung')).toHaveValue('Bài đang viết dở 🎉🔥');
  // Saved as typed: a reload offers it back.
  await page.waitForTimeout(600);
  page.once('dialog', (d) => void d.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Khôi phục' }).click();
  await expect(page.getByLabel('Nội dung chung')).toHaveValue('Bài đang viết dở 🎉🔥');
  // Saving the post clears what the browser kept.
  await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  await page.goto(page.url().replace(/\/social\/[0-9a-f-]{36}$/, '/social/new'));
  await expect(page.getByRole('button', { name: 'Khôi phục' })).toHaveCount(0);
});

test('lets an owner approve and schedule their own post in one step (#638)', async ({ page }) => {
  await signUp(page, newEmail('social-one-step'));
  await createOrg(page, 'Công ty Một Bước');
  await connectSandbox(page, 'Trang Một Bước');
  // The channel's queue gives the post its slot.
  await page.getByRole('textbox', { name: 'Giờ' }).fill('09:00');
  await page.getByRole('button', { name: 'Thêm cho mọi ngày' }).click();
  await page.getByRole('button', { name: 'Lưu hàng đợi' }).click();
  await expect(page.getByText(/Khung giờ trống kế tiếp:/)).toBeVisible();
  await compose(page, 'Khai trương chi nhánh mới');
  await page.getByRole('button', { name: 'Duyệt và lên lịch' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  await expect(channelCard(page, 'Trang Một Bước').getByText('Đã lên lịch', { exact: true })).toBeVisible();
  const decided = sql<{ n: number }>(`SELECT count(*)::int AS n FROM crove_social.post_approval WHERE post_id = :'post' AND decision = 'approved'`, { post: postIdOf(page) });
  expect(decided).toEqual([{ n: 1 }]);
});

test('posts a Story of one image, with no text, in a phone frame (#644)', async ({ page }) => {
  await signUp(page, newEmail('social-story'));
  await createOrg(page, 'Công ty Tin');
  await connectSandbox(page, 'Trang Tin');
  await compose(page, 'Chữ này không lên Tin');
  await page.locator('input[type="file"]').first().setInputFiles([{ name: 'tin.png', mimeType: 'image/png', buffer: solidPng(1080, 1920) }]);
  await expect(page.getByText('1/20').first()).toBeVisible();
  await page.getByLabel('Kiểu bài').selectOption('story');
  await expect(page.getByText('Tin (Story) - chỉ hiện ảnh hoặc video')).toBeVisible();
  await expect(page.getByText('Bình luận đầu tiên (không bắt buộc)')).toHaveCount(0);
  // A second image is one too many for a Story.
  await page.locator('input[type="file"]').first().setInputFiles([{ name: 'tin-2.png', mimeType: 'image/png', buffer: solidPng(1080, 1910) }]);
  await expect(page.getByText('2/20').first()).toBeVisible();
  await expect(page.getByText('Tin (Story) cần đúng một ảnh hoặc một video')).toBeVisible();
  await page.getByRole('button', { name: 'Bỏ', exact: true }).last().click();
  await expect(page.getByText('Tin (Story) cần đúng một ảnh hoặc một video')).toHaveCount(0);
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  const saved = sql<{ post_type: string }>(`SELECT settings->>'postType' AS post_type FROM crove_social.post_variant WHERE post_id = :'post'`, { post: postIdOf(page) });
  expect(saved).toEqual([{ post_type: 'story' }]);
  // The saved post keeps the type in its channel's editor.
  await expect(page.getByLabel('Kiểu bài')).toHaveValue('story');
});

test('crops a post image to a frame, and the server reads the new size (#636)', async ({ page }) => {
  await signUp(page, newEmail('social-crop'));
  await createOrg(page, 'Công ty Cắt Ảnh');
  await connectSandbox(page, 'Trang Cắt Ảnh');
  await compose(page, 'Bài có ảnh dọc');
  await page.locator('input[type="file"]').first().setInputFiles([{ name: 'doc.png', mimeType: 'image/png', buffer: solidPng(1080, 1920) }]);
  await expect(page.getByText('1/20').first()).toBeVisible();
  await page.getByRole('button', { name: 'Cắt', exact: true }).first().click();
  await page.getByRole('radio', { name: '1:1 · vuông' }).click();
  await expect(page.getByText('Ảnh gốc 1080 × 1920, sau khi cắt 1080 × 1080')).toBeVisible();
  await page.getByRole('button', { name: 'Lưu ảnh đã cắt' }).click();
  await expect(page.getByRole('button', { name: 'Lưu ảnh đã cắt' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  const media = sql<{ image_width: number; image_height: number; content_type: string }>(
    `SELECT f.image_width, f.image_height, f.content_type FROM crove_social.post_media m JOIN crove_kernel.file f ON f.org_id = m.org_id AND f.id = m.file_id WHERE m.post_id = :'post'`,
    { post: postIdOf(page) },
  );
  expect(media).toEqual([{ image_width: 1080, image_height: 1080, content_type: 'image/png' }]);
});
test('turns an idea on the board into a draft, which moves it to Drafted (#701)', async ({ page }) => {
  await signUp(page, newEmail('social-idea'));
  await createOrg(page, 'Công ty Ý Tưởng');
  await connectSandbox(page, 'Trang Ý Tưởng');
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('link', { name: 'Ý tưởng', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm ý tưởng' }).click();
  await page.getByLabel('Ý tưởng', { exact: true }).fill('Món mới mùa thu');
  await page.getByLabel('Ghi chú (không bắt buộc)').fill('Chụp ở quầy, ánh sáng buổi sáng');
  await page.getByLabel('Liên kết (không bắt buộc)').fill('https://cuahang.vn/thu');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  const fresh = page.getByRole('region', { name: 'Mới' });
  await expect(fresh.getByText('Món mới mùa thu')).toBeVisible();
  await fresh.getByRole('button', { name: 'Lên kế hoạch' }).click();
  const planned = page.getByRole('region', { name: 'Đã lên kế hoạch' });
  await expect(planned.getByText('Món mới mùa thu')).toBeVisible();

  await planned.getByRole('button', { name: 'Viết thành bài nháp' }).click();
  await expect(page.getByText('Đang soạn từ ý tưởng "Món mới mùa thu"')).toBeVisible();
  await expect(page.getByLabel('Nội dung chung')).toHaveValue('Món mới mùa thu\n\nChụp ở quầy, ánh sáng buổi sáng');
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Bài này được viết từ ý tưởng')).toBeVisible();
  const saved = sql<{ stage: string; linked: boolean; link_url: string | null }>(
    `SELECT i.stage, i.post_id = p.id AS linked, p.link_url FROM crove_social.idea i JOIN crove_social.post p ON p.org_id = i.org_id AND p.id = :'post'`,
    { post: postIdOf(page) },
  );
  expect(saved).toEqual([{ stage: 'drafted', linked: true, link_url: 'https://cuahang.vn/thu' }]);

  await page.getByRole('link', { name: 'Món mới mùa thu' }).click();
  await expect(page.getByRole('region', { name: 'Đã có bài nháp' }).getByRole('link', { name: 'Mở bài nháp' })).toBeVisible();
});
