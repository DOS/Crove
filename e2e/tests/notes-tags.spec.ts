// The notes screen's toolbar and tag filter end to end (#1739, plan docs/plan/notes.md §3.10): the toolbar and its
// shortcuts write Markdown at the cursor, and a member filters their notes by a tag from the list's chips and from a
// note's own chip.
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

async function newNote(page: Page, title: string, tags: string) {
  // The page header's button: an empty list shows a second one.
  await page.getByRole('button', { name: 'Ghi chú mới' }).first().click();
  await expect(page.getByRole('textbox', { name: 'Tiêu đề' })).toHaveValue('Ghi chú mới');
  await page.getByRole('textbox', { name: 'Tiêu đề' }).fill(title);
  await page.getByRole('textbox', { name: 'Thẻ' }).fill(tags);
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible({ timeout: 10_000 });
}

test('the toolbar writes Markdown at the cursor, and tags filter the notes', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('notes-tags'));
  const slug = await createOrg(page, 'Công ty Thẻ Ghi Chú');
  await page.goto(`/o/${slug}/notes`);

  await test.step('the toolbar and a shortcut write Markdown', async () => {
    await newNote(page, 'Sao kê ngân hàng', 'Ngân hàng, thuế');
    const body = page.getByRole('textbox', { name: 'Nội dung' });
    await body.fill('Gọi khách');
    await body.press('ControlOrMeta+a');
    await page.getByRole('group', { name: 'Định dạng nội dung' }).getByRole('button', { name: 'Đậm' }).click();
    await expect(body).toHaveValue('**Gọi khách**');
    // The selection comes back a frame after the text: "Gọi khách", inside the stars.
    await expect.poll(() => body.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([2, 11]);
    await body.press('End');
    await body.press('Enter');
    await body.pressSequentially('Xin sao kê tháng 10');
    await body.press('ControlOrMeta+Shift+9');
    await expect(body).toHaveValue('**Gọi khách**\n- [ ] Xin sao kê tháng 10');
    // Ctrl or Cmd+K is the editor's link here, not the command palette.
    await body.press('End');
    await body.press('ControlOrMeta+k');
    await expect(body).toHaveValue('**Gọi khách**\n- [ ] Xin sao kê tháng 10[](https://)');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible({ timeout: 10_000 });
  });

  await test.step('a second note with another tag', async () => {
    await newNote(page, 'Hợp đồng bảo hiểm', 'Bảo hiểm');
  });

  const rows = page.getByTestId('note-row');
  await test.step("filter from the list's chips, and clear it", async () => {
    await expect(rows).toHaveCount(2);
    const chips = page.getByRole('group', { name: 'Lọc theo thẻ' });
    await chips.getByRole('button', { name: 'ngân hàng' }).click();
    await expect(page).toHaveURL(/tag=/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Sao kê ngân hàng');
    await chips.getByRole('button', { name: 'ngân hàng' }).click();
    await expect(rows).toHaveCount(2);
  });

  await test.step("filter from a note's own chip", async () => {
    await rows.filter({ hasText: 'Hợp đồng bảo hiểm' }).click();
    await page.getByRole('button', { name: 'Xem các ghi chú có thẻ bảo hiểm' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Hợp đồng bảo hiểm');
    await expect(page.getByRole('group', { name: 'Lọc theo thẻ' }).getByRole('button', { name: 'bảo hiểm' })).toHaveAttribute('aria-pressed', 'true');
  });
});
