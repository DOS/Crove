// The legal entity switcher (issue #1486, the books per entity of #1280), end to end: an org adds a second legal entity
// in Settings, the switcher shows in the sidebar on the finance screens, and the screens follow the choice. Locking a
// month is the visible proof: September locked in the second entity stays open in the default one. The choice is kept
// in this browser per org, so it survives a reload.
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const ORG = 'Công ty Hai pháp nhân';
const BRANCH = 'Chi nhánh Đà Nẵng';

test('the finance screens follow the legal entity chosen in the sidebar', async ({ page }) => {
  await signInNewUser(page, newEmail('entity-switch'));
  const slug = await createOrg(page, ORG);
  const nav = page.getByRole('navigation');
  // The desktop sidebar; the mobile drawer holds a copy of the same controls only while it is open.
  const switcher = page.getByRole('complementary').getByLabel('Pháp nhân', { exact: true });

  await test.step('with one legal entity there is nothing to choose', async () => {
    await nav.getByRole('link', { name: 'Sổ sách' }).click();
    await expect(page.getByText('Chưa khóa sổ tháng nào.', { exact: false })).toBeVisible();
    await expect(switcher).toHaveCount(0);
  });

  await test.step('a second entity added in Settings shows the switcher at once', async () => {
    await nav.getByRole('link', { name: 'Cài đặt' }).click();
    const add = page.getByRole('form', { name: 'Thêm pháp nhân' });
    await add.getByLabel('Tên pháp nhân').fill(BRANCH);
    await add.getByRole('button', { name: 'Thêm', exact: true }).click();
    await expect(page.getByText(BRANCH).first()).toBeVisible();
    // Settings works in one entity (its learned account rules), and the list the switcher reads was refreshed.
    await expect(switcher).toBeVisible();
    // The default entity, which is the org itself, comes first and is the one chosen.
    await expect(switcher.locator('option:checked')).toHaveText(ORG);
  });

  await test.step('the Inbox is not kept per entity, so the switcher is not shown there', async () => {
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await expect(switcher).toHaveCount(0);
  });

  await test.step('September locked in the second entity', async () => {
    await nav.getByRole('link', { name: 'Sổ sách' }).click();
    await switcher.selectOption({ label: BRANCH });
    await expect(page.getByText('Chưa khóa sổ tháng nào.', { exact: false })).toBeVisible();
    await page.getByLabel('Tháng khóa sổ').fill('2026-09');
    await page.getByRole('button', { name: 'Khóa sổ tháng 09/2026' }).click();
    await expect(page.getByText('Đã khóa sổ đến hết ngày 30/09/2026', { exact: false })).toBeVisible();
  });

  await test.step('the default entity still has no month locked', async () => {
    await switcher.selectOption({ label: ORG });
    await expect(page.getByText('Chưa khóa sổ tháng nào.', { exact: false })).toBeVisible();
    await expect(page.getByText('Đã khóa sổ đến hết ngày 30/09/2026', { exact: false })).toHaveCount(0);
  });

  await test.step('the choice survives a reload', async () => {
    await switcher.selectOption({ label: BRANCH });
    await expect(page.getByText('Đã khóa sổ đến hết ngày 30/09/2026', { exact: false })).toBeVisible();
    await page.reload();
    await expect(switcher.locator('option:checked')).toHaveText(BRANCH);
    await expect(page.getByText('Đã khóa sổ đến hết ngày 30/09/2026', { exact: false })).toBeVisible();
  });

  await test.step('the lock was recorded for the second entity', async () => {
    const rows = sql<{ month: string; entity: string }>(
      `SELECT a.detail->>'month' AS month, e.name AS entity
       FROM crove_kernel.audit_event a
       JOIN crove_kernel.tenant t ON t.org_id = a.org_id
       JOIN crove_kernel.legal_entity e ON e.org_id = a.org_id AND e.id::text = a.detail->>'legalEntityId'
       WHERE t.slug = :'slug' AND a.command = 'finance.period.lock' AND a.outcome = 'ok'`,
      { slug },
    );
    expect(rows).toEqual([{ month: '2026-09', entity: BRANCH }]);
  });
});
