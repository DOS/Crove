// Onboarding a client company (issue #324), end to end: the new-organization form takes the client's tax code, name,
// address and contact email; the org is created with its tax code and address, and its invite form opens with the
// contact filled in (inviting is R3, so it asks for a second factor). The e2e stack has no tax registry lookup
// (TAX_CODE_LOOKUP_URL unset), so the form offers no "Tra cứu" button and the firm types the name. A second org is
// added from the sidebar.
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { newEmail, signUp } from '../lib/session.ts';

// A fake tax code (see the MST fixture guard).
const TAX_CODE = '0101234564';

test('a firm adds a client company by tax code, then opens the form again for the next one', async ({ page }) => {
  const email = newEmail('onboard');
  const contact = newEmail('client-contact');
  await page.goto('/');
  await signUp(page, email);

  await test.step('fill in the client and create it', async () => {
    await expect(page.getByRole('heading', { name: 'Tạo tổ chức đầu tiên' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tra cứu' })).toHaveCount(0);
    // A value that is not a tax code is refused before anything is created.
    await page.getByLabel('Mã số thuế (không bắt buộc)').fill('12345');
    await page.getByLabel('Tên công ty hoặc hộ kinh doanh').fill('Công ty TNHH Khách hàng Một');
    await page.getByRole('button', { name: 'Tạo tổ chức' }).click();
    await expect(page.getByText('Mã số thuế không hợp lệ')).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding$/);

    await page.getByLabel('Mã số thuế (không bắt buộc)').fill('0101.234.564');
    await page.getByLabel('Địa chỉ (không bắt buộc)').fill('Số 1 Phố Huế, Hà Nội');
    await page.getByLabel('Email người liên hệ (không bắt buộc)').fill(contact);
    await page.getByRole('button', { name: 'Tạo tổ chức' }).click();
    await expect(page).toHaveURL(/\/o\/[^/]+\/settings\?invite=/);
  });

  const slug = new URL(page.url()).pathname.split('/')[2] ?? '';

  await test.step('the new org has its tax code and address, and the invite form holds the contact', async () => {
    // The org's own field (a <dd>): the legal entities card shows the default entity's code too (#1278).
    await expect(page.getByRole('definition').getByText(TAX_CODE, { exact: true })).toBeVisible();
    await expect(page.getByText('Số 1 Phố Huế, Hà Nội', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('email@congty.vn')).toHaveValue(contact);
    // Inviting is R3: a user without a second factor is asked to enable one first.
    await page.getByRole('button', { name: 'Mời', exact: true }).click();
    await expect(page.getByText(`mời ${contact}`, { exact: false })).toBeVisible();
    const [org] = sql<{ name: string; tax_code: string; address: string }>(
      "SELECT name, tax_code, address FROM crove_kernel.tenant WHERE slug = :'slug'",
      { slug },
    );
    expect(org).toEqual({ name: 'Công ty TNHH Khách hàng Một', tax_code: TAX_CODE, address: 'Số 1 Phố Huế, Hà Nội' });
  });

  await test.step('the sidebar opens the form again for the next client, with a way back', async () => {
    await page.getByRole('complementary').getByRole('link', { name: '+ Thêm tổ chức' }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole('heading', { name: 'Thêm tổ chức' })).toBeVisible();
    await page.getByRole('link', { name: 'Quay lại' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  });
});
