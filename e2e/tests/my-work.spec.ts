// My work end to end (#1673, notes plan docs/plan/notes.md step N4): a member adds to-dos with quick add, completes
// one with the keyboard, reorders the others, and the order and the done one are still there after a reload. Another
// member of the org sees none of them.
import { expect, test } from '@playwright/test';
import { exec } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('a member adds, completes and reorders their own to-dos, which nobody else sees', async ({ page, browser }) => {
  const email = newEmail('my-work');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Việc Riêng');

  await page.getByRole('navigation').getByRole('link', { name: 'Việc của tôi' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/my-work$`));
  await expect(page.getByText('Không có việc nào đến hạn')).toBeVisible();

  const rows = page.getByTestId('todo-row');
  const titles = () => page.getByTestId('todo-title').allTextContents();

  await test.step('quick add saves on Enter, newest first', async () => {
    const add = page.getByRole('textbox', { name: 'Thêm việc, Enter để lưu' });
    for (const title of ['Nộp tờ khai thuế', 'Kiểm tra hóa đơn nhà cung cấp', 'Gọi khách xin sao kê']) {
      await add.fill(title);
      await add.press('Enter');
      await expect(rows.filter({ hasText: title })).toBeVisible();
    }
    await expect(page.getByTestId('todo-group-none')).toContainText('Không hạn');
    expect(await titles()).toEqual(['Gọi khách xin sao kê', 'Kiểm tra hóa đơn nhà cung cấp', 'Nộp tờ khai thuế']);
  });

  await test.step('J selects the first to-do and X marks it done', async () => {
    // Out of the quick add field, so the keys work the list.
    await page.getByRole('textbox', { name: 'Thêm việc, Enter để lưu' }).press('Escape');
    await page.keyboard.press('j');
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('x');
    await expect(rows.filter({ hasText: 'Gọi khách xin sao kê' })).toHaveCount(0);
    expect(await titles()).toEqual(['Kiểm tra hóa đơn nhà cung cấp', 'Nộp tờ khai thuế']);
    await page.getByRole('tab', { name: 'Đã xong' }).click();
    await expect(rows.filter({ hasText: 'Gọi khách xin sao kê' })).toBeVisible();
    await page.getByRole('tab', { name: 'Cần làm' }).click();
  });

  await test.step('moving a to-do up keeps the new order after a reload', async () => {
    await page.getByRole('button', { name: 'Chuyển lên: Nộp tờ khai thuế' }).click();
    await expect.poll(titles).toEqual(['Nộp tờ khai thuế', 'Kiểm tra hóa đơn nhà cung cấp']);
    await page.reload();
    await expect.poll(titles).toEqual(['Nộp tờ khai thuế', 'Kiểm tra hóa đơn nhà cung cấp']);
  });

  await test.step('completing a to-do says so, and its undo, reached with F8, opens it again (#2003, #2026)', async () => {
    await page.getByRole('checkbox', { name: 'Đánh dấu xong: Kiểm tra hóa đơn nhà cung cấp' }).click();
    await expect.poll(titles).toEqual(['Nộp tờ khai thuế']);
    const done = page.getByRole('status').filter({ hasText: 'Đã đánh dấu xong: Kiểm tra hóa đơn nhà cung cấp' });
    const undo = done.getByRole('button', { name: 'Hoàn tác' });
    await expect(undo).toBeVisible();
    // From the quick add field, F8 reaches the undo; once the toast is gone the focus is back in the field.
    const add = page.getByRole('textbox', { name: 'Thêm việc, Enter để lưu' });
    await add.focus();
    await page.keyboard.press('F8');
    await expect(undo).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(add).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Đã đưa việc trở lại: Kiểm tra hóa đơn nhà cung cấp' })).toBeVisible();
    await expect(rows.filter({ hasText: 'Kiểm tra hóa đơn nhà cung cấp' })).toBeVisible();
  });

  await test.step('another member of the org sees none of them', async () => {
    const otherEmail = newEmail('my-work-other');
    const other = await browser.newPage({ timezoneId: 'Asia/Ho_Chi_Minh' });
    await other.goto('/');
    await signInNewUser(other, otherEmail);
    exec(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       SELECT t.org_id, u.id, 'member' FROM crove_kernel.tenant t, crove_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email: otherEmail },
    );
    await other.goto(`/o/${slug}/my-work`);
    await expect(other.getByText('Không có việc nào đến hạn')).toBeVisible();
    await expect(other.getByTestId('todo-row')).toHaveCount(0);
    await other.close();
  });
});
