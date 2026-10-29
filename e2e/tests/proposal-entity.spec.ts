// A proposal's legal entity in the Inbox (issue #1542, the books per entity of #1280), end to end: with two entities,
// an e-invoice uploaded with the branch chosen beside the upload button is read into the branch (#1764), its proposal
// shows that entity with no way to move it, and once approved its entry is in that entity's journal only. The Inbox
// list names the entity beside the proposal (#1543).
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

test('an invoice uploaded in an entity stays there and posts in its books', async ({ page }) => {
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

  await test.step('upload it in the branch, chosen beside the upload button', async () => {
    await nav.getByRole('link', { name: 'Trang chủ', exact: true }).click();
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    // The sidebar's choice carries over; the Inbox shows it where documents are uploaded.
    await expect(page.getByRole('main').getByLabel('Ghi sổ vào').locator('option:checked')).toHaveText(BRANCH);
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
    await expect(row.getByRole('cell', { name: BRANCH, exact: true })).toBeVisible();
  });

  await test.step('the proposal shows its entity, with no way to move it', async () => {
    await page.getByRole('link', { name: SELLER }).click();
    const shown = page.locator('p', { hasText: 'Ghi vào sổ của pháp nhân' });
    await expect(shown.locator('xpath=following-sibling::p[1]')).toHaveText(BRANCH);
    await expect(page.getByLabel('Ghi vào sổ của pháp nhân')).toHaveCount(0);
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
