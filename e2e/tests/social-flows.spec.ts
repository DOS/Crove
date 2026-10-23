// Crove Social flows past the basic publish (issue #590), on the offline sandbox channel: a channel that needs two
// approvals, retrying a failed channel and settling channels Crove cannot account for, the media library, evergreen
// reposting, the metrics of a published post, and the AI drafting card on a server without a model. Each test has
// its own users, created confirmed without the sign-up form (signInNewUser: the suite shares one sign-up budget), and
// its own org. States the worker reaches only on a real platform (a refusal, an unknown outcome, a metrics
// capture) are written with SQL, as social.spec.ts moves a slot forward.
import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

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
  await signInNewUser(page, newEmail('social-steps'));
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

  // A second person signs in with a browser of their own and is made an admin of the org.
  const reviewer = newEmail('social-reviewer');
  const reviewerContext = await browser.newContext({ baseURL: new URL(postUrl).origin, locale: 'vi-VN', timezoneId: TIME_ZONE });
  const reviewerPage = await reviewerContext.newPage();
  await signInNewUser(reviewerPage, reviewer);
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
  await signInNewUser(page, newEmail('social-retry'));
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
  await signInNewUser(page, newEmail('social-library'));
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

test('imports a sheet with images, alt texts, labels and a first comment as drafts with their media (#1258)', async ({ page }) => {
  await signInNewUser(page, newEmail('social-csv-media'));
  await createOrg(page, 'Công ty Nhập Ảnh');
  await connectSandbox(page, 'Trang Nhập Ảnh');

  // Two images in the library, uploaded with a draft.
  await compose(page, 'Bài tải ảnh lên thư viện');
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'mat-tien.png', mimeType: 'image/png', buffer: solidPng(40, 30) },
    { name: 'quay-pha-che.png', mimeType: 'image/png', buffer: solidPng(30, 40) },
  ]);
  await expect(page.getByText('2/20')).toBeVisible();
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);

  // The sheet: images by library name (any case), their alt texts one per line, labels, a first comment; a row whose
  // image URL is on a private address (the API's egress guard refuses it before any connection) and one with a file
  // the library does not have show their problems and are not created. The texts carry this run's mark, so the
  // database reads find this test's posts only.
  const run = randomUUID().slice(0, 8);
  const sheet =
    'text,channels,media,alt,first_comment,labels\r\n' +
    `"Khai trương chi nhánh mới, giảm 20% ${run}",Trang Nhập Ảnh,"MAT-TIEN.png\nquay-pha-che.png","Mặt tiền chi nhánh\nQuầy pha chế",Xem thực đơn ở trang của quán,"Khai trương, Tháng 11"\r\n` +
    `Bài có ảnh nội bộ ${run},Trang Nhập Ảnh,https://127.0.0.1/anh.jpg,,,Tháng 11\r\n` +
    `Bài thiếu ảnh ${run},Trang Nhập Ảnh,khong-co.jpg,,,\r\n`;
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('link', { name: 'Nhập từ tệp' }).click();
  await page.getByLabel('Chọn tệp CSV hoặc Excel').setInputFiles([{ name: 'ke-hoach.csv', mimeType: 'text/csv', buffer: Buffer.from(sheet) }]);
  await expect(page.getByText('1 trên 3 dòng sẵn sàng.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Không tải ảnh từ "https://127.0.0.1/anh.jpg" vì đây là địa chỉ trong mạng nội bộ')).toBeVisible();
  await expect(page.getByText('Không thấy tệp "khong-co.jpg" trong thư viện ảnh')).toBeVisible();
  await expect(page.getByText('Sẽ tạo 2 nhãn mới: Khai trương, Tháng 11')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Ảnh của dòng 2' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText('2/2 ảnh')).toBeVisible();

  await page.getByRole('button', { name: 'Tạo 1 bản nháp' }).click();
  await expect(page).toHaveURL(/\/social$/);
  const [post] = sql<{ id: string; media: { name: string; alt: string | null }[]; labels: string[]; comments: string[] }>(
    `SELECT p.id,
            (SELECT json_agg(json_build_object('name', f.filename, 'alt', m.alt_text) ORDER BY m.position) FROM crove_social.post_media m JOIN crove_kernel.file f ON f.org_id = m.org_id AND f.id = m.file_id WHERE m.org_id = p.org_id AND m.post_id = p.id) AS media,
            (SELECT json_agg(l.name ORDER BY l.name) FROM crove_social.post_label pl JOIN crove_social.label l ON l.org_id = pl.org_id AND l.id = pl.label_id WHERE pl.org_id = p.org_id AND pl.post_id = p.id) AS labels,
            (SELECT json_agg(v.settings->>'firstComment') FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'draft') AS comments
       FROM crove_social.post p WHERE p.body = :'body'`,
    { body: `Khai trương chi nhánh mới, giảm 20% ${run}` },
  );
  expect(post?.media).toEqual([
    { name: 'mat-tien.png', alt: 'Mặt tiền chi nhánh' },
    { name: 'quay-pha-che.png', alt: 'Quầy pha chế' },
  ]);
  expect(post?.labels).toEqual(['Khai trương', 'Tháng 11']);
  expect(post?.comments).toEqual(['Xem thực đơn ở trang của quán']);
  expect(sql<{ n: number }>(`SELECT count(*)::int AS n FROM crove_social.post WHERE body IN (:'a', :'b')`, { a: `Bài có ảnh nội bộ ${run}`, b: `Bài thiếu ảnh ${run}` })).toEqual([{ n: 0 }]);
  // The draft shows its two images on its page.
  await page.goto(`${new URL(page.url()).pathname}/${post?.id}`);
  await expect(page.getByText('2/20')).toBeVisible();
});

test('turns on evergreen reposting for a published post', async ({ page }) => {
  await signInNewUser(page, newEmail('social-evergreen'));
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
  await signInNewUser(page, newEmail('social-metrics'));
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
  await panel.getByLabel('Từ ngày', { exact: true }).fill(today);
  await panel.getByLabel('Đến ngày', { exact: true }).fill(today);
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

  await signInNewUser(page, newEmail('social-ai'));
  await createOrg(page, 'Công ty Không AI');
  await connectSandbox(page, 'Trang Không AI');
  await compose(page, 'Bài viết tay, không nhờ AI');

  await expect(page.getByText('Soạn bằng AI', { exact: true })).toBeVisible();
  await expect(page.getByText('Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Soạn nháp bằng AI' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nhờ AI viết lại' })).toHaveCount(0);
});

test('approves several posts at once from the review list (#635)', async ({ page }) => {
  await signInNewUser(page, newEmail('social-bulk'));
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
  await signInNewUser(page, newEmail('social-autosave'));
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
  await signInNewUser(page, newEmail('social-one-step'));
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
  await signInNewUser(page, newEmail('social-story'));
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
  await signInNewUser(page, newEmail('social-crop'));
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
  await signInNewUser(page, newEmail('social-idea'));
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

test('moves a draft to review on the board and approves it with four-eyes; an illegal drop sends nothing (#1022)', async ({ page, browser }) => {
  await signInNewUser(page, newEmail('social-board'));
  const slug = await createOrg(page, 'Công ty Bảng Bài');
  await connectSandbox(page, 'Trang Bảng Bài');
  // Four-eyes on the channel (#740): the author approves nothing of their own post there.
  const fourEyes = () => page.getByRole('checkbox', { name: /Người viết bài không tự duyệt bài của mình/ });
  await fourEyes().click();
  await expect(fourEyes()).toBeChecked();
  await page.reload();
  await expect(fourEyes()).toBeChecked();

  await compose(page, 'Bài chuyển trên bảng');
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  const postId = postIdOf(page);
  const statuses = () => sql<{ status: string }>(`SELECT status FROM crove_social.post_variant WHERE post_id = :'post'`, { post: postId }).map((r) => r.status);
  const approvals = () => sql<{ n: number }>(`SELECT count(*)::int AS n FROM crove_social.post_approval WHERE post_id = :'post'`, { post: postId })[0]?.n;

  // The board's moves that reach the server, so a refused drop can be shown to send nothing.
  const moves: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/rpc\/social\/(posts\/submit|variants\/(decide|schedule|unschedule))/.test(r.url())) moves.push(r.url());
  });
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('tab', { name: 'Bảng' }).click();
  await expect(page).toHaveURL(/tab=board/);
  const column = (name: string) => page.getByRole('region', { name, exact: true });
  const card = page.getByTestId('board-card').filter({ hasText: 'Bài chuyển trên bảng' });
  await expect(column('Nháp').getByTestId('board-card')).toHaveCount(1);

  // Dragged from Drafts to In review: sent for review.
  await card.dragTo(column('Chờ duyệt'));
  await expect(page.getByText('Đã gửi duyệt bài.')).toBeVisible();
  await expect(column('Chờ duyệt').getByTestId('board-card')).toHaveCount(1);
  expect(statuses()).toEqual(['in_review']);
  expect(moves).toHaveLength(1);

  // Dropped on Published: refused with the reason, nothing sent, nothing changed.
  await card.dragTo(column('Đã đăng'));
  await expect(page.getByText('Crove tự đăng bài vào giờ đã hẹn, không chuyển tay sang Đã đăng được.')).toBeVisible();
  await expect(column('Chờ duyệt').getByTestId('board-card')).toHaveCount(1);
  expect(moves).toHaveLength(1);
  expect(statuses()).toEqual(['in_review']);
  expect(approvals()).toBe(0);

  // The author moves it on by keyboard, to Approved: the server refuses under four-eyes and the card stays.
  await card.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Kênh này cần người khác duyệt bài của bạn')).toBeVisible();
  expect(moves).toHaveLength(2);
  await expect(column('Chờ duyệt').getByTestId('board-card')).toHaveCount(1);
  expect(statuses()).toEqual(['in_review']);
  expect(approvals()).toBe(0);

  // A second person, made an admin of the org, approves it from the same board.
  const reviewer = newEmail('social-board-reviewer');
  const reviewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'vi-VN', timezoneId: TIME_ZONE });
  const reviewerPage = await reviewerContext.newPage();
  await signInNewUser(reviewerPage, reviewer);
  await expect
    .poll(() => sql<{ id: string }>(`SELECT id FROM crove_kernel.user_account WHERE lower(email) = lower(:'email')`, { email: reviewer }).length)
    .toBe(1);
  exec(
    `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
     SELECT t.org_id, u.id, 'admin' FROM crove_kernel.tenant t, crove_kernel.user_account u
      WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { slug, email: reviewer },
  );
  await reviewerPage.goto(`/o/${slug}/social?tab=board`);
  const reviewerColumn = (name: string) => reviewerPage.getByRole('region', { name, exact: true });
  const reviewerCard = reviewerPage.getByTestId('board-card').filter({ hasText: 'Bài chuyển trên bảng' });
  await expect(reviewerColumn('Chờ duyệt').getByTestId('board-card')).toHaveCount(1);
  await reviewerCard.dragTo(reviewerColumn('Đã duyệt'));
  await expect(reviewerPage.getByText('Đã duyệt bài.')).toBeVisible();
  await expect(reviewerColumn('Đã duyệt').getByTestId('board-card')).toHaveCount(1);
  expect(statuses()).toEqual(['approved']);
  const decided = sql<{ email: string; decision: string }>(
    `SELECT u.email, a.decision FROM crove_social.post_approval a JOIN crove_kernel.user_account u ON u.id = a.decided_by WHERE a.post_id = :'post'`,
    { post: postId },
  );
  expect(decided).toEqual([{ email: reviewer.toLowerCase(), decision: 'approved' }]);
  await reviewerContext.close();
});

test('plans an undated draft by dropping it on a day, then moves its time from the chip menu (#1145)', async ({ page }) => {
  await signInNewUser(page, newEmail('social-undated'));
  const slug = await createOrg(page, 'Công ty Lịch Nháp');
  await connectSandbox(page, 'Trang Lịch Nháp');
  await compose(page, 'Bài chưa có ngày');
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  const postId = postIdOf(page);
  const planned = () =>
    sql<{ at: string | null }>(`SELECT to_char(scheduled_at AT TIME ZONE :'zone', 'YYYY-MM-DD HH24:MI') AS at FROM crove_social.post WHERE id = :'post'`, { post: postId, zone: TIME_ZONE })[0]?.at;
  expect(planned()).toBeNull();
  const updates: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/rpc/social/posts/update')) updates.push(r.url());
  });

  await page.goto(`/o/${slug}/social?tab=calendar`);
  const draft = page.getByTestId('undated-draft').filter({ hasText: 'Bài chưa có ngày' });
  await expect(page.getByRole('heading', { name: /Chưa có ngày/ })).toBeVisible();
  await expect(draft).toHaveCount(1);
  // Two days ahead is always in the month view (it runs at least four days into the next month): 09:00 that day.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(Date.now() + 2 * 86_400_000));
  // The list stays beside the calendar, so neither has to scroll while dragging.
  const cell = page.locator(`[data-day="${day}"]`);
  await cell.scrollIntoViewIfNeeded();
  await expect(draft).toBeInViewport();
  await draft.dragTo(cell);
  await expect(page.getByText('Đã đặt ngày dự kiến:')).toBeVisible();
  await expect(draft).toHaveCount(0);
  expect(planned()).toBe(`${day} 09:00`);
  expect(updates).toHaveLength(1);
  const chip = cell.getByTestId('calendar-chip').filter({ hasText: 'Bài chưa có ngày' });
  await expect(chip).toContainText('09:00');

  // Without dragging: the chip's menu, by keyboard, to 15:30 the same day.
  await page.getByRole('button', { name: 'Đổi ngày dự kiến của bài: Bài chưa có ngày' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Ngày', { exact: true })).toBeFocused();
  await page.getByLabel('Giờ', { exact: true }).fill('15:30');
  await page.keyboard.press('Enter');
  await expect(chip).toContainText('15:30');
  expect(planned()).toBe(`${day} 15:30`);
  expect(updates).toHaveLength(2);
});

test('puts an approved post in an open queue slot by dropping it there, then moves it from the chip menu (#1158)', async ({ page }) => {
  await signInNewUser(page, newEmail('social-slots'));
  const slug = await createOrg(page, 'Công ty Khung Giờ');
  await connectSandbox(page, 'Trang Khung Giờ');
  // A queue posting every day at 19:00, set on the channels screen.
  await page.getByRole('textbox', { name: 'Giờ' }).fill('19:00');
  await page.getByRole('button', { name: 'Thêm cho mọi ngày' }).click();
  await page.getByRole('button', { name: 'Lưu hàng đợi' }).click();
  await expect(page.getByText(/Khung giờ trống kế tiếp:/)).toBeVisible();
  await compose(page, 'Bài vào khung giờ');
  await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(page.getByText('Lên lịch 1 kênh đã duyệt')).toBeVisible();
  const postId = postIdOf(page);
  const [channel] = sql<{ id: string }>(`SELECT channel_connection_id AS id FROM crove_social.post_variant WHERE post_id = :'post'`, { post: postId });
  const slotOf = () =>
    sql<{ status: string; at: string | null }>(
      `SELECT status, to_char(queue_slot_at AT TIME ZONE :'zone', 'YYYY-MM-DD HH24:MI') AS at FROM crove_social.post_variant WHERE post_id = :'post'`,
      { post: postId, zone: TIME_ZONE },
    )[0];

  // Under the channel filter the calendar draws the queue's open slots; two days ahead is always in the month view.
  await page.goto(`/o/${slug}/social?tab=calendar&channel=${channel?.id ?? ''}`);
  const dayOf = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(Date.now() + n * 86_400_000));
  const slotAt = (day: string) => new Date(`${day}T19:00:00+07:00`).toISOString();
  const [day, next] = [dayOf(2), dayOf(3)];
  const slot = page.locator(`[data-slot="${slotAt(day)}"]`);
  await expect(slot).toContainText('19:00 Trống');
  const draft = page.getByTestId('undated-draft').filter({ hasText: 'Bài vào khung giờ' });
  await slot.scrollIntoViewIfNeeded();
  await draft.dragTo(slot);
  await expect(page.getByText('Đã xếp bài vào khung giờ')).toBeVisible();
  expect(slotOf()).toEqual({ status: 'scheduled', at: `${day} 19:00` });
  await expect(slot).toHaveCount(0);
  await expect(draft).toHaveCount(0);

  // Without dragging: the chip's menu offers the open slots, by keyboard, and moves the post to the next day's.
  await page.getByRole('button', { name: 'Xếp vào khung giờ trống: Bài vào khung giờ' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Khung giờ trống của hàng đợi').selectOption(slotAt(next));
  await page.getByRole('button', { name: 'Lên lịch vào giờ này' }).click();
  await expect(page.getByText('Đã xếp bài vào khung giờ')).toBeVisible();
  expect(slotOf()).toEqual({ status: 'scheduled', at: `${next} 19:00` });
  await expect(page.locator(`[data-slot="${slotAt(day)}"]`)).toContainText('Trống');
});

test('corrects a published post on its channel: a blocked word is refused, the text changes and the timeline and versions show before and after, a member is refused (#1223)', async ({ page, browser }) => {
  await signInNewUser(page, newEmail('social-live-edit'));
  const slug = await createOrg(page, 'Quán Phở Sửa Bài');
  const channel = 'Trang Sửa Bài';
  await connectSandbox(page, channel);
  // A blocked word of the org, on the channels screen.
  await page.getByLabel('Từ hoặc cụm từ').fill('rẻ nhất');
  await page.getByLabel('Mức', { exact: true }).selectOption('block');
  await page.getByRole('button', { name: 'Thêm từ' }).click();
  await expect(page.getByText('rẻ nhất', { exact: true })).toBeVisible();
  await compose(page, 'Phở bò giá 54.000đ');
  await submitApproveSchedule(page, [channel]);
  const postId = postIdOf(page);
  const postUrl = page.url();
  exec(`UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = :'post'`, { post: postId });
  const card = channelCard(page, channel);
  await expect(card.getByText('Đã đăng', { exact: true })).toBeVisible({ timeout: 45_000 });
  const variantId = sql<{ id: string }>(`SELECT id FROM crove_social.post_variant WHERE post_id = :'post'`, { post: postId })[0]?.id as string;

  // A blocked word in the new text is refused, with nothing sent.
  await card.getByRole('button', { name: 'Sửa nội dung đã đăng' }).click();
  const text = card.getByLabel('Nội dung mới');
  await expect(text).toHaveValue('Phở bò giá 54.000đ');
  await text.fill('Phở bò rẻ nhất phố: 45.000đ');
  await card.getByRole('button', { name: 'Cập nhật lên kênh' }).click();
  await expect(card.getByText('Bài có từ bị cấm: «rẻ nhất»')).toBeVisible();
  expect(sql<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.external_call WHERE key LIKE :'key'`, { key: `social.publish:${variantId}:%:edit%` })).toEqual([{ n: '0' }]);
  expect(sql<{ edit_state: string | null }>(`SELECT edit_state FROM crove_social.post_variant WHERE id = :'id'`, { id: variantId })).toEqual([{ edit_state: null }]);

  // The corrected text goes to the channel; the page follows until the platform confirms it.
  await text.fill('Phở bò giá 45.000đ');
  await card.getByRole('button', { name: 'Cập nhật lên kênh' }).click();
  await expect(card.getByLabel('Nội dung mới')).toHaveCount(0);
  await expect
    .poll(() => sql<{ revision: number; body: string | null; edit_state: string | null }>(`SELECT revision, body, edit_state FROM crove_social.post_variant WHERE id = :'id'`, { id: variantId }), { timeout: 45_000 })
    .toEqual([{ revision: 2, body: 'Phở bò giá 45.000đ', edit_state: null }]);
  expect(sql<{ state: string }>(`SELECT state FROM crove_kernel.external_call WHERE key = :'key'`, { key: `social.publish:${variantId}:1:1:edit` })).toEqual([{ state: 'succeeded' }]);
  await expect(card.getByText('Đang cập nhật nội dung đã sửa lên kênh')).toHaveCount(0, { timeout: 15_000 });
  await expect(card.getByText('Phở bò giá 45.000đ').first()).toBeVisible();

  // The timeline: the owner corrected it, and the channel shows the corrected text.
  await page.reload();
  await expect(page.getByText('đã sửa nội dung bài đã đăng').first()).toBeVisible();
  await expect(page.getByText('đã hiển thị nội dung đã sửa').first()).toBeVisible();
  // The versions: the new one is the owner's; the one before shows the text the channel had, without a restore.
  const versions = page.getByRole('region', { name: 'Lịch sử phiên bản' }).or(page.locator('[aria-label="Lịch sử phiên bản"]'));
  await expect(versions.getByText('Phiên bản 2', { exact: true })).toBeVisible();
  const first = versions.locator('li').filter({ hasText: 'Phiên bản 1' });
  await first.getByRole('button', { name: 'Xem khác biệt' }).click();
  await expect(first.getByText('Kênh đã đăng giữ nguyên nội dung hiện tại; lúc đó kênh hiện nội dung khác như sau:')).toBeVisible();
  await expect(first.getByText('54', { exact: false }).first()).toBeVisible();
  await expect(first.getByRole('button', { name: 'Khôi phục' })).toHaveCount(0);

  // A member sees no such action, and the server refuses them with 403.
  const writer = newEmail('social-live-edit-member');
  const memberContext = await browser.newContext({ baseURL: new URL(postUrl).origin, locale: 'vi-VN', timezoneId: TIME_ZONE });
  const memberPage = await memberContext.newPage();
  await signInNewUser(memberPage, writer);
  await expect.poll(() => sql<{ id: string }>(`SELECT id FROM crove_kernel.user_account WHERE lower(email) = lower(:'email')`, { email: writer }).length).toBe(1);
  exec(
    `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
     SELECT t.org_id, u.id, 'member' FROM crove_kernel.tenant t, crove_kernel.user_account u
      WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { slug, email: writer },
  );
  const read = memberPage.waitForRequest((r) => r.url().includes('/api/rpc/social/posts/get'));
  await memberPage.goto(postUrl);
  const headers = (await read).headers();
  const memberCard = channelCard(memberPage, channel);
  await expect(memberCard.getByText('Đã đăng', { exact: true })).toBeVisible();
  await expect(memberCard.getByRole('button', { name: /Sửa (lại )?nội dung đã đăng/ })).toHaveCount(0);
  const refused = await memberPage.request.post('/api/rpc/social/variants/editPublished', {
    headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k === 'authorization' || k.startsWith('x-crove'))),
    data: { json: { variantId, revision: 2, body: 'Thành viên sửa bài' } },
  });
  expect(refused.status()).toBe(403);
  expect(sql<{ revision: number }>(`SELECT revision FROM crove_social.post_variant WHERE id = :'id'`, { id: variantId })).toEqual([{ revision: 2 }]);
  await memberContext.close();
});

test('draws a post on six channels as one chip, and "+9" opens every post of the day, by keyboard too (#1220)', async ({ page }) => {
  await signInNewUser(page, newEmail('social-day-list'));
  const slug = await createOrg(page, 'Công ty Lịch Kín');
  const channels = ['Kênh 1', 'Kênh 2', 'Kênh 3', 'Kênh 4', 'Kênh 5', 'Kênh 6'];
  await connectSandbox(page, ...channels);
  await compose(page, 'Bài sáu kênh', channels);
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  const six = postIdOf(page);
  await page.goto(`/o/${slug}/social/new`);
  await page.getByLabel('Nội dung chung').fill('Bài số 2');
  const pick = page.getByRole('button', { name: 'Kênh 1' });
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  const second = postIdOf(page);

  // Two days ahead is always in the month view. The six-channel draft is planned at 08:00 and the other at 09:00; ten
  // copies of the other, written with SQL, fill the day to twelve posts, hourly from 10:00.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(Date.now() + 2 * 86_400_000));
  exec(`UPDATE crove_social.post SET scheduled_at = (:'day' || ' 08:00+07')::timestamptz WHERE id = :'six'`, { day, six });
  exec(`UPDATE crove_social.post SET scheduled_at = (:'day' || ' 09:00+07')::timestamptz WHERE id = :'second'`, { day, second });
  exec(
    `WITH n AS (SELECT g, gen_random_uuid() AS id FROM generate_series(3, 12) g),
          copies AS (
            INSERT INTO crove_social.post
            SELECT (jsonb_populate_record(p, jsonb_build_object('id', n.id, 'body', 'Bài số ' || n.g, 'scheduled_at', (:'day' || ' ' || lpad((n.g + 7)::text, 2, '0') || ':00+07')::timestamptz))).*
              FROM crove_social.post p, n WHERE p.id = :'second' RETURNING id)
     INSERT INTO crove_social.post_variant
     SELECT (jsonb_populate_record(v, jsonb_build_object('id', gen_random_uuid(), 'post_id', n.id))).* FROM crove_social.post_variant v, n WHERE v.post_id = :'second'`,
    { day, second },
  );
  const planned = (body: string) =>
    sql<{ at: string }>(
      `SELECT to_char(scheduled_at AT TIME ZONE :'zone', 'YYYY-MM-DD HH24:MI') AS at FROM crove_social.post WHERE body = :'body' AND org_id = (SELECT org_id FROM crove_social.post WHERE id = :'six')`,
      { body, six, zone: TIME_ZONE },
    )[0]?.at;
  expect(planned('Bài số 12')).toBe(`${day} 19:00`);

  await page.goto(`/o/${slug}/social?tab=calendar`);
  const cell = page.locator(`[data-day="${day}"]`);
  await cell.scrollIntoViewIfNeeded();
  // Three chips and "+9": the six channels are one chip that names them and their status in words.
  await expect(cell.getByTestId('calendar-chip')).toHaveCount(3);
  const sixChip = cell.getByTestId('calendar-chip').filter({ hasText: 'Bài sáu kênh' });
  await expect(sixChip).toHaveAttribute('data-channels', '6');
  await expect(sixChip).toContainText('6 kênh · Nháp');
  const more = cell.getByRole('button', { name: /^\+9 bài nữa, xem cả ngày/ });
  await expect(more).toHaveText(/^\+9/);

  // By keyboard: the dialog opens on its heading and lists every post of the day with each channel's status.
  const [y, m, d] = day.split('-');
  const title = `Các bài ngày ${d}/${m}/${y}`;
  const dialog = page.getByRole('dialog', { name: title });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: title })).toBeFocused();
  await expect(dialog.getByTestId('day-post')).toHaveCount(12);
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) await expect(dialog.getByRole('link', { name: `Bài số ${n}`, exact: true })).toBeVisible();
  const sixRow = dialog.getByTestId('day-post').filter({ hasText: 'Bài sáu kênh' });
  for (const name of channels) await expect(sixRow.getByText(`Sandbox (${name}) · Nháp`)).toBeVisible();
  // Tab walks the rows inside the dialog down to the last post's link, never leaving it.
  const focused = () => page.evaluate(() => ({ inDialog: document.activeElement?.closest('dialog') !== null, text: document.activeElement?.textContent ?? '' }));
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press('Tab');
    const now = await focused();
    expect(now.inDialog).toBe(true);
    reached = now.text === 'Bài số 12';
  }
  expect(reached).toBe(true);
  // Esc closes it and gives the focus back to "+9".
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();

  // A hidden post gets its date from its row, without leaving the dialog.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Đặt ngày cho bài: Bài số 12' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Ngày', { exact: true })).toBeFocused();
  await dialog.getByLabel('Giờ', { exact: true }).fill('20:30');
  await page.keyboard.press('Enter');
  await expect(dialog.getByText('Đã đặt ngày dự kiến:')).toBeVisible();
  await expect.poll(() => planned('Bài số 12')).toBe(`${day} 20:30`);
  await expect(dialog.getByTestId('day-post').last()).toContainText('20:30');

  // And opens from its link.
  await dialog.getByRole('link', { name: 'Bài số 7', exact: true }).focus();
  await page.keyboard.press('Enter');
  const [seventh] = sql<{ id: string }>(`SELECT id FROM crove_social.post WHERE body = 'Bài số 7' AND org_id = (SELECT org_id FROM crove_social.post WHERE id = :'six')`, { six });
  await expect(page).toHaveURL(new RegExp(`/social/${seventh?.id ?? 'missing'}$`));

  // At phone width the month and the day's list fit the screen, and "+9" still opens it.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/o/${slug}/social?tab=calendar`);
  await cell.scrollIntoViewIfNeeded();
  const inside = (box: { x: number; width: number } | null) => box !== null && box.x >= 0 && box.x + box.width <= 360;
  expect(inside(await cell.locator('xpath=..').boundingBox())).toBe(true);
  const narrowMore = cell.getByRole('button', { name: /^\+9 bài nữa/ });
  expect(inside(await narrowMore.boundingBox())).toBe(true);
  await narrowMore.click();
  await expect(dialog).toBeVisible();
  expect(inside(await dialog.boundingBox())).toBe(true);
  await dialog.getByRole('button', { name: 'Đóng' }).click();
  await expect(dialog).toBeHidden();

  // A drag moves every channel of the chip at once; a drop while that move still runs is said, not lost (#1044).
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/o/${slug}/social?tab=calendar`);
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(Date.now() + 86_400_000));
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/rpc/social/posts/update', async (route) => {
    await held;
    await route.continue();
  });
  await cell.scrollIntoViewIfNeeded();
  await sixChip.dragTo(page.locator(`[data-day="${tomorrow}"]`));
  await cell.getByTestId('calendar-chip').filter({ hasText: 'Bài số 2' }).dragTo(page.locator(`[data-day="${tomorrow}"]`));
  await expect(page.getByText('Đang dời một bài, hãy chờ xong rồi kéo tiếp.')).toBeVisible();
  release();
  await expect(page.getByText(/^Đã dời 6 kênh sang/)).toBeVisible();
  await page.unroute('**/api/rpc/social/posts/update');
  expect(planned('Bài sáu kênh')).toBe(`${tomorrow} 08:00`);
  expect(planned('Bài số 2')).toBe(`${day} 09:00`);
  await expect(page.locator(`[data-day="${tomorrow}"]`).getByTestId('calendar-chip').filter({ hasText: 'Bài sáu kênh' })).toHaveAttribute('data-channels', '6');
});
