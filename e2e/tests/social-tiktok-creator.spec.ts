// The TikTok composer shows the account's own options (#1497), at phone width. The worker reads TikTok's creator_info
// only on a real account, so the list it would record is written with SQL, on a sandbox channel turned into a TikTok
// one, as social-flows.spec.ts writes the states a real platform gives.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

// Its own name each run: the e2e database keeps the channels of earlier runs.
const CHANNEL = `Tiệm Bánh TikTok ${randomUUID().slice(0, 8)}`;
// What the worker records for an account that may post only as "Only me", with Duet turned off.
const ITEMS = [
  { id: 'nickname', name: 'Tiệm Bánh B' },
  { id: 'privacy_SELF_ONLY', name: 'SELF_ONLY' },
  { id: 'off_duet', name: 'off' },
  { id: 'max_video_seconds', name: '600' },
];

test.use({ viewport: { width: 360, height: 780 } });

test("the TikTok block lists only the account's options and fits 360px", async ({ page }) => {
  await signInNewUser(page, newEmail('social-tiktok-creator'));
  const slug = await createOrg(page, 'Công ty Tiệm Bánh TikTok');
  await page.goto(`/o/${slug}/social/channels`);
  await page.getByLabel('Tên kênh thử').fill(CHANNEL);
  await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
  await expect(page.getByText(CHANNEL).first()).toBeVisible();
  const [channel] = sql<{ org: string; id: string }>(`SELECT org_id AS org, id FROM crove_kernel.channel_connection WHERE display_name = :'name'`, { name: CHANNEL });
  exec(`UPDATE crove_kernel.channel_connection SET provider = 'tiktok' WHERE org_id = :'org' AND id = :'id'`, { org: channel?.org ?? '', id: channel?.id ?? '' });
  exec(
    `INSERT INTO crove_social.channel_option (org_id, channel_connection_id, kind, status, items, requested_at, fetched_at)
     VALUES (:'org', :'id', 'tiktok_creator', 'ready', :'items'::jsonb, now(), now())`,
    { org: channel?.org ?? '', id: channel?.id ?? '', items: JSON.stringify(ITEMS) },
  );

  await page.goto(`/o/${slug}/social/channels`);
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('link', { name: 'Soạn bài' }).click();
  await page.getByLabel('Nội dung chung').fill('Bánh mới ra lò');
  await expect(page.getByText('Đăng lên TikTok của Tiệm Bánh B')).toBeVisible();
  const privacy = page.locator('select', { has: page.locator('option', { hasText: 'Chọn quyền xem' }) });
  await expect(privacy.locator('option')).toHaveText(['Chọn quyền xem', 'Chỉ mình tôi']);
  await expect(privacy).toHaveValue('');
  const duet = page.getByRole('checkbox', { name: 'Cho phép Duet' });
  await expect(duet).toBeDisabled();
  await expect(duet).not.toBeChecked();
  await expect(page.getByText('Bạn đã tắt mục này trong TikTok')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Cho phép bình luận' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const block = page.getByText('Đăng lên TikTok của Tiệm Bánh B').locator('xpath=..');
  const box = await block.boundingBox();
  expect(box !== null && box.x >= 0 && box.x + box.width <= 360).toBe(true);
});
