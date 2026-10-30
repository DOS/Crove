// Notes end to end (#1671, plan docs/plan/notes.md step N2): on the client's overview a member writes a note (shared by
// default there), pins it, and finds it again on the notes screen by words typed without Vietnamese marks; a private
// note keeps its lock and word, and the database holds it as the member wrote it.
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('a member writes a note on the overview, pins it, and finds it on the notes screen', async ({ page }) => {
  const email = newEmail('notes');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Khách Ghi Chú');

  const panel = page.getByRole('region', { name: 'Ghi chú' });
  await test.step('write a note on the overview: shared by default', async () => {
    await page.goto(`/o/${slug}/overview`);
    await expect(panel.getByText('Ghi lại điều cần nhớ về khách hàng này')).toBeVisible();
    await panel.getByRole('button', { name: 'Thêm ghi chú' }).click();
    await panel.getByPlaceholder('Tiêu đề ghi chú').fill('Giám đốc chỉ nghe máy sau 15h');
    await panel.getByPlaceholder('Nội dung (không bắt buộc)').fill('Hỏi **kế toán trưởng** trước ngày 5');
    await panel.getByRole('button', { name: 'Lưu ghi chú' }).click();
    const item = panel.getByTestId('note-item').filter({ hasText: 'Giám đốc chỉ nghe máy sau 15h' });
    await expect(item).toBeVisible();
    await expect(item.getByText('Dùng chung')).toBeVisible();
  });

  await test.step('pin it', async () => {
    await panel.getByRole('button', { name: 'Ghim ghi chú Giám đốc chỉ nghe máy sau 15h' }).click();
    await expect(panel.getByTestId('note-item').filter({ hasText: 'Giám đốc' }).getByText('Đã ghim')).toBeVisible();
    const rows = sql<{ visibility: string; pinned: boolean }>(
      `SELECT n.visibility, n.pinned FROM crove_notes.note n JOIN crove_kernel.tenant t ON t.org_id = n.org_id WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(rows).toEqual([{ visibility: 'org', pinned: true }]);
  });

  await test.step('find it on the notes screen by words typed without marks', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Ghi chú', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ghi chú', level: 1 })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Tìm ghi chú' }).fill('giam doc');
    await page.getByRole('searchbox', { name: 'Tìm ghi chú' }).press('Enter');
    const row = page.getByTestId('note-row').filter({ hasText: 'Giám đốc chỉ nghe máy sau 15h' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('textbox', { name: 'Tiêu đề' })).toHaveValue('Giám đốc chỉ nghe máy sau 15h');
  });

  await test.step('a new note is private, and says so beside its title', async () => {
    await page.getByRole('button', { name: 'Ghi chú mới' }).click();
    await expect(page.getByRole('textbox', { name: 'Tiêu đề' })).toHaveValue('Ghi chú mới');
    await expect(page.getByRole('article').getByText('Riêng tư')).toBeVisible();
    await page.getByRole('textbox', { name: 'Tiêu đề' }).fill('Mật khẩu cổng ngân hàng');
    await page.getByRole('textbox', { name: 'Nội dung' }).fill('mật khẩu: không ghi ở đây');
    await expect(page.getByText('Ghi chú không phải nơi giữ mật khẩu')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible({ timeout: 10_000 });
    const rows = sql<{ title: string; visibility: string }>(
      `SELECT n.title, n.visibility FROM crove_notes.note n JOIN crove_kernel.tenant t ON t.org_id = n.org_id WHERE t.slug = :'slug' AND n.visibility = 'private'`,
      { slug },
    );
    expect(rows).toEqual([{ title: 'Mật khẩu cổng ngân hàng', visibility: 'private' }]);
  });

  await test.step('moving a note to the trash says so, and its undo brings it back (#2003)', async () => {
    await page.getByRole('button', { name: 'Chuyển vào thùng rác' }).click();
    const done = page.getByRole('status').filter({ hasText: 'Đã chuyển ghi chú vào thùng rác' });
    await expect(done).toBeVisible();
    await done.getByRole('button', { name: 'Hoàn tác' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã đưa ghi chú trở lại' })).toBeVisible();
    const trashed = sql<{ trashed: boolean }>(
      `SELECT n.deleted_at IS NOT NULL AS trashed FROM crove_notes.note n JOIN crove_kernel.tenant t ON t.org_id = n.org_id
        WHERE t.slug = :'slug' AND n.title = 'Mật khẩu cổng ngân hàng'`,
      { slug },
    );
    expect(trashed).toEqual([{ trashed: false }]);
  });
});
