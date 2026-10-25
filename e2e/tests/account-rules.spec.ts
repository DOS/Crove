// Learned account rules (issue #1399) end to end: the approver changes a line's account and approves, Settings lists the
// rule with its provenance, an owner adds and removes a keyword rule, and the vendor's next invoice is proposed by the
// learned rule, with the line saying so.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { nextTotp } from '../lib/totp.ts';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url)), 'utf8');
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';

// The fixture under another number, with its internet line dated in another month.
const invoice = (number: number, month: string) => ({
  name: `hd-${number}.xml`,
  mimeType: 'application/xml',
  buffer: Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('tháng 9/2026', `tháng ${month}`)),
});

const internetRow = (page: Page) => page.getByRole('row').filter({ hasText: 'Cước dịch vụ internet' });

async function openProposal(page: Page, file: ReturnType<typeof invoice>) {
  await page.getByRole('navigation').getByRole('link', { name: 'Trang chủ', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Hộp thư chứng từ' }).click();
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: SELLER }).click();
  await expect(page.getByRole('heading', { name: SELLER })).toBeVisible();
}

test('an approver teaches a line rule, Settings lists and removes rules, and the next invoice uses it', async ({ page }) => {
  const email = newEmail('rules');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Quy tắc định khoản');

  await test.step('change the account of the internet line and approve', async () => {
    await openProposal(page, invoice(4101, '9/2026'));
    await expect(internetRow(page).getByText('Từ khóa có sẵn')).toBeVisible();
    await page.getByRole('combobox', { name: 'Tài khoản nợ cho dòng 1' }).selectOption('242');
    await page.getByRole('button', { name: 'Lưu chỉnh sửa' }).click();
    await expect(internetRow(page).getByText('Người dùng chọn')).toBeVisible();
    await confirmUnverifiedSignature(page);
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    // Approving is R3: the page asks for a second factor, then approves by itself.
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await expect(page.getByRole('status').filter({ hasText: `Đã duyệt và ghi sổ ${SELLER}` })).toBeVisible();
  });

  const card = page.locator('[aria-label="Quy tắc định khoản đã học"]');

  await test.step('Settings lists the learned rule with its provenance', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
    const rule = card.getByRole('listitem').filter({ hasText: 'Cước dịch vụ internet tháng 9/2026' });
    await expect(rule).toBeVisible();
    await expect(rule.getByText('Cùng mặt hàng')).toBeVisible();
    await expect(rule.getByText(SELLER)).toBeVisible();
    await expect(rule.getByText('Ghi vào TK 242')).toBeVisible();
    const provenance = rule.getByText(`Do ${email} xác nhận ngày`, { exact: false });
    await expect(provenance).toBeVisible();
    await expect(provenance).toContainText('khi duyệt hóa đơn C26TAB/4101');
  });

  await test.step('an owner adds a keyword rule for every vendor, then removes it', async () => {
    const add = card.getByRole('form', { name: 'Thêm quy tắc theo từ khóa' });
    await add.getByLabel('Từ khóa').fill('Chiết khấu');
    await add.getByLabel('Tài khoản').selectOption('6422');
    await add.getByRole('button', { name: 'Thêm' }).click();
    const rule = card.getByRole('listitem').filter({ hasText: 'Chiết khấu' });
    await expect(rule.getByText('Từ khóa', { exact: true })).toBeVisible();
    await expect(rule.getByText('Mọi nhà cung cấp')).toBeVisible();
    await expect(rule.getByText('Ghi vào TK 6422')).toBeVisible();

    // The same words without marks are the same rule.
    await add.getByLabel('Từ khóa').fill('chiet khau');
    await add.getByLabel('Tài khoản').selectOption('6422');
    await add.getByRole('button', { name: 'Thêm' }).click();
    await expect(card.getByRole('alert').filter({ hasText: 'Đã có quy tắc cho từ khóa' })).toBeVisible();

    await rule.getByRole('button', { name: 'Xóa quy tắc Chiết khấu' }).click();
    await rule.getByRole('button', { name: 'Xóa quy tắc', exact: true }).click();
    await expect(card.getByRole('listitem').filter({ hasText: 'Chiết khấu' })).toHaveCount(0);
    await expect(card.getByRole('listitem')).toHaveCount(1);
  });

  await test.step('the next invoice of the vendor is proposed by the learned rule, whatever its month', async () => {
    await openProposal(page, invoice(4102, '10/2026'));
    await expect(page.getByRole('combobox', { name: 'Tài khoản nợ cho dòng 1' })).toHaveValue('242');
    await expect(internetRow(page).getByText('Quy tắc đã học')).toBeVisible();
    await expect(internetRow(page).getByText('Theo quy tắc đã học: cùng mặt hàng của nhà cung cấp này')).toBeVisible();
  });

  await test.step('the rule row keeps its provenance in the database', async () => {
    const rows = sql<{ match_kind: string; match_text: string; debit_account: string; confirmed_by: string; invoice_number: string }>(
      `SELECT r.match_kind, r.match_text, r.debit_account, u.email AS confirmed_by, d.invoice_number
         FROM crove_finance.categorization_rule r
         JOIN crove_kernel.tenant t ON t.org_id = r.org_id
         JOIN crove_kernel.user_account u ON u.id = r.confirmed_by
         JOIN crove_finance.purchase_document d ON d.org_id = r.org_id AND d.id = r.source_document_id
        WHERE t.slug = :'slug'`,
      { slug },
    );
    expect(rows).toEqual([{ match_kind: 'description', match_text: 'cuoc dich vu internet thang', debit_account: '242', confirmed_by: email, invoice_number: '4101' }]);
  });
});
