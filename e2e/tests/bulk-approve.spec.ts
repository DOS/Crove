// Issue #315 end to end: the review shortcuts on a proposal, then selecting several pending proposals and approving
// them in one action under one MFA step-up, with an approval audit row for each proposal.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { confirmUnverifiedSignature } from '../lib/inbox.ts';
import { nextTotp } from '../lib/totp.ts';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url)), 'utf8');
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
const NUMBERS = [3151, 3152, 3153];

// The fixture with another invoice number, so each upload is its own proposal and none is a duplicate.
const invoice = (number: number) => ({
  name: `hd-${number}.xml`,
  mimeType: 'application/xml',
  buffer: Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`)),
});

test('review shortcuts, then approve several proposals under one step-up', async ({ page }) => {
  const email = newEmail('bulk');

  await test.step('sign up, create an org and upload three e-invoices', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await signUp(page, email);
    await createOrg(page, 'Công ty Duyệt hàng loạt');
    await expect(page.getByRole('heading', { name: 'Hộp thư chứng từ' })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles(NUMBERS.map(invoice));
    // The worker reads each XML and raises its proposal; the Inbox polls every few seconds.
    await expect(page.getByRole('link', { name: SELLER })).toHaveCount(NUMBERS.length, { timeout: 90_000 });
  });

  const slug = new URL(page.url()).pathname.split('/')[2] ?? '';

  await test.step('J and K move between pending proposals, A approves, E focuses the first account', async () => {
    await page.getByRole('link', { name: SELLER }).first().click();
    await expect(
      page.getByText('Phím tắt: J hoặc N sang đề xuất chờ duyệt tiếp theo · K hoặc P về đề xuất trước · A duyệt · E sửa tài khoản · Ctrl K mở bảng lệnh'),
    ).toBeVisible();
    const first = page.url();
    await page.keyboard.press('j');
    await expect(page).not.toHaveURL(first);
    const next = page.url();
    // K goes back to the previous pending proposal, J forward again (#439).
    await page.keyboard.press('k');
    await expect(page).toHaveURL(first);
    await page.keyboard.press('j');
    await expect(page).toHaveURL(next);
    await expect(page.getByRole('heading', { name: SELLER })).toBeVisible();
    await confirmUnverifiedSignature(page);
    await expect(page.getByRole('button', { name: 'Duyệt và ghi sổ' })).toBeEnabled();
    // A asks for the same approval as the button: without a second factor, the step-up prompt.
    await page.keyboard.press('a');
    await expect(page.getByText('Đang chờ: duyệt và ghi sổ chứng từ này.')).toBeVisible();
    await page.getByRole('button', { name: 'Hủy thao tác' }).click();
    await expect(page.getByText('Đang chờ: duyệt và ghi sổ chứng từ này.')).toBeHidden();
    await page.keyboard.press('e');
    await expect(page.getByRole('combobox', { name: 'Tài khoản nợ cho dòng 1' })).toBeFocused();
    // Typing in a field is never a shortcut.
    const second = page.url();
    await page.keyboard.press('j');
    await expect(page.getByRole('combobox', { name: 'Tài khoản nợ cho dòng 1' })).toBeFocused();
    expect(page.url()).toBe(second);
    await page.getByRole('link', { name: '← Hộp thư chứng từ' }).click();
  });

  await test.step('the command palette opens with Ctrl K and goes where the user types (#439)', async () => {
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('combobox', { name: 'Bảng lệnh' });
    await expect(palette).toBeFocused();
    // Matching ignores Vietnamese marks.
    await palette.fill('so sach');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/ledger$`));
    await page.keyboard.press('Control+k');
    await palette.fill('hop thu');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  });

  await test.step('select all and approve them under one step-up', async () => {
    await page.getByText(`Chọn tất cả mục duyệt chung được (${NUMBERS.length})`).click();
    await expect(page.getByText(`Đã chọn ${NUMBERS.length}`)).toBeVisible();
    // The fixtures' signatures are placeholders (#674): the whole selection is confirmed once before it is approved.
    await expect(page.getByRole('button', { name: `Duyệt ${NUMBERS.length} đề xuất` })).toBeDisabled();
    await page.getByText(`Có ${NUMBERS.length} hóa đơn đã chọn chưa xác minh được chữ ký số`, { exact: false }).click();
    await page.getByRole('button', { name: `Duyệt ${NUMBERS.length} đề xuất` }).click();
    // Bulk approval is R3: one step-up for the whole selection, then the page sends it again by itself.
    await expect(page.getByText(`Đang chờ: duyệt và ghi sổ ${NUMBERS.length} đề xuất.`)).toBeVisible();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByText(`Đã duyệt và ghi sổ ${NUMBERS.length} đề xuất.`)).toBeVisible();
    await expect(page.getByText('Không có đề xuất nào chờ duyệt')).toBeVisible();
    await page.getByRole('tab', { name: 'Đã ghi sổ' }).click();
    await expect(page.getByRole('link', { name: SELLER })).toHaveCount(NUMBERS.length);
  });

  await test.step('each proposal has its own approval row, all under the one step-up', async () => {
    const [org] = sql<{ org_id: string }>(`SELECT org_id FROM crove_kernel.tenant WHERE slug = :'slug'`, { slug });
    if (!org) throw new Error(`org ${slug} not found`);
    const vars = { org: org.org_id };
    const approvals = sql<{ outcome: string; aal: string; mfa_at: string | null; target_id: string | null }>(
      `SELECT outcome, detail->>'aal' AS aal, detail->>'mfaAt' AS mfa_at, target_id
         FROM crove_kernel.audit_event WHERE org_id = :'org' AND command = 'kernel.proposal.approve' AND outcome = 'ok'`,
      vars,
    );
    expect(approvals).toHaveLength(NUMBERS.length);
    expect(new Set(approvals.map((a) => a.target_id)).size).toBe(NUMBERS.length);
    expect(approvals.every((a) => a.aal === 'aal2')).toBe(true);
    expect(new Set(approvals.map((a) => a.mfa_at)).size).toBe(1);
    const batches = sql<{ outcome: string; code: string | null; approved: number | null }>(
      `SELECT outcome, detail->>'code' AS code, (detail->>'approved')::int AS approved
         FROM crove_kernel.audit_event WHERE org_id = :'org' AND command = 'kernel.proposal.approve_many' ORDER BY occurred_at, id`,
      vars,
    );
    expect(batches).toEqual([
      { outcome: 'denied', code: 'STEP_UP_REQUIRED', approved: null },
      { outcome: 'ok', code: null, approved: NUMBERS.length },
    ]);
    const documents = sql<{ invoice_number: string }>(`SELECT invoice_number FROM crove_finance.purchase_document WHERE org_id = :'org' ORDER BY invoice_number`, vars);
    expect(documents.map((d) => d.invoice_number)).toEqual(NUMBERS.map(String));
  });
});
