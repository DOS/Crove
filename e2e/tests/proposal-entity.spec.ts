// A proposal's legal entity in the Inbox (issue #1542, the books per entity of #1280), end to end: with two entities,
// an e-invoice's proposal shows the entity whose books it goes to (the default one until a revision names another),
// offers the entity chosen in the sidebar, moves there in one click, and once approved its entry is in that entity's
// journal only. The Inbox list names the entity beside the proposal (#1543).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
const ORG = 'Công ty Đề xuất hai pháp nhân';
const BRANCH = 'Chi nhánh Cần Thơ';

test('an invoice proposal moves to the entity chosen in the sidebar and posts in its books', async ({ page }) => {
  await signInNewUser(page, newEmail('proposal-entity'));
  const slug = await createOrg(page, ORG);
  const nav = page.getByRole('navigation');
  const switcher = page.getByRole('complementary').getByLabel('Pháp nhân', { exact: true });
  // The proposal's row in the Inbox list.
  const row = page.getByRole('main').getByRole('row').filter({ has: page.getByRole('link', { name: SELLER }) });

  await test.step('add a second entity and work in it', async () => {
    await nav.getByRole('link', { name: 'Cài đặt' }).click();
    const add = page.getByRole('form', { name: 'Thêm pháp nhân' });
    await add.getByLabel('Tên pháp nhân').fill(BRANCH);
    await add.getByRole('button', { name: 'Thêm', exact: true }).click();
    await expect(switcher).toBeVisible();
    await switcher.selectOption({ label: BRANCH });
  });

  await test.step('the proposal goes to the default entity until it is moved', async () => {
    await nav.getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await expect(row.getByRole('cell', { name: ORG, exact: true })).toBeVisible();
    await page.getByRole('link', { name: SELLER }).click();
    const field = page.getByLabel('Ghi vào sổ của pháp nhân');
    await expect(field.locator('option:checked')).toHaveText(ORG);
    // The sidebar's choice is offered, not applied: nothing changes without a click.
    await expect(page.getByText(`Bạn đang làm việc với ${BRANCH}.`)).toBeVisible();
    await page.getByRole('button', { name: `Chuyển hóa đơn sang ${BRANCH}` }).click();
    await expect(field.locator('option:checked')).toHaveText(BRANCH);
    await expect(page.getByText(`Bạn đang làm việc với ${BRANCH}.`)).toHaveCount(0);
  });

  await test.step('the Inbox list names the entity it moved to', async () => {
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await expect(row.getByRole('cell', { name: BRANCH, exact: true })).toBeVisible();
    await page.getByRole('link', { name: SELLER }).click();
  });

  await test.step('approve it', async () => {
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    // Approving is R3: the page asks for a second factor, then approves by itself.
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  });

  await test.step('the entry is in the branch books only', async () => {
    const rows = sql<{ entity: string }>(
      `SELECT e.name AS entity
       FROM crove_finance.journal_entry j
       JOIN crove_kernel.tenant t ON t.org_id = j.org_id
       JOIN crove_kernel.legal_entity e ON e.org_id = j.org_id AND e.id = j.legal_entity_id
       WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(rows).toEqual([{ entity: BRANCH }]);
    await nav.getByRole('link', { name: 'Kế toán', exact: true }).click();
    await nav.getByRole('link', { name: 'Bút toán' }).click();
    await expect(switcher.locator('option:checked')).toHaveText(BRANCH);
    await expect(page.getByText(SELLER).first()).toBeVisible();
    await switcher.selectOption({ label: ORG });
    await expect(page.getByText(SELLER)).toHaveCount(0);
  });
});
