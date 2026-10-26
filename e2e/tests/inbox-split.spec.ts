// The Inbox list and the open proposal side by side on a wide screen (DESIGN.md §3.4, issue #1514): the proposals
// waiting for review stay beside the open one, the open one is marked, and approving opens the next one in its place
// instead of going back to the list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url)), 'utf8');
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

// The fixture with another invoice number, so each upload is its own proposal and none is a duplicate.
const invoice = (number: number) => ({
  name: `hd-${number}.xml`,
  mimeType: 'application/xml',
  buffer: Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`)),
});

test.use({ viewport: { width: 1440, height: 900 } });

test('on a wide screen the pending list stays beside the proposal, and approving opens the next one', async ({ page }) => {
  await signInNewUser(page, newEmail('inbox-split'));
  const slug = await createOrg(page, 'Công ty Màn hình rộng');
  await page.locator('input[type=file]').setInputFiles([invoice(4101), invoice(4102)]);
  await expect(page.getByRole('main').getByRole('link', { name: SELLER })).toHaveCount(2, { timeout: 90_000 });

  const queue = page.getByRole('region', { name: 'Đề xuất chờ duyệt' });
  const queued = queue.getByRole('link', { name: SELLER });

  await test.step('the open proposal is marked in the list beside it', async () => {
    await page.getByRole('main').getByRole('link', { name: SELLER }).first().click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox/[^/]+$`));
    await expect(queued).toHaveCount(2);
    const open = page.url().split('/').at(-1) ?? '';
    await expect(queue.locator(`a[href$="/inbox/${open}"]`)).toHaveAttribute('aria-current', 'page');
  });

  await test.step('approving opens the other proposal in place', async () => {
    const open = page.url().split('/').at(-1) ?? '';
    const other = (await queued.evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).pathname.split('/').at(-1)))).find((id) => id !== open) ?? '';
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    // Approving is R3: the page asks for a second factor, then approves by itself.
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox/${other}$`));
    await expect(queued).toHaveCount(1);
    await expect(queue.locator(`a[href$="/inbox/${other}"]`)).toHaveAttribute('aria-current', 'page');
  });
});
