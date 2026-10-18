// Bulk intake (issue #314), end to end: a ZIP of e-invoices and loose XML files dropped in the Inbox at once. The ZIP
// is opened in the parsing sandbox, every document is read on its own, and the Inbox shows each file's result.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { buildZip } from '../../apps/extract/test/zip-fixture.ts';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

const FIXTURE = readFileSync(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const invoice = (number: number) => Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`));

test('upload a ZIP of e-invoices with loose files and follow each file to its proposal', async ({ page }) => {
  const slug = await test.step('sign up and create an org', async () => {
    await page.goto('/');
    await signUp(page, newEmail('bulk'));
    const created = await createOrg(page, 'Công ty nhận hàng loạt');
    await expect(page.getByRole('heading', { name: 'Hộp thư chứng từ' })).toBeVisible();
    return created;
  });

  await test.step('upload a ZIP and two XML files in one go', async () => {
    const zip = buildZip([
      { name: 'thang-10/hd-5001.xml', data: invoice(5001) },
      { name: 'thang-10/hd-5002.xml', data: invoice(5002) },
      { name: 'thang-10/kem-theo.zip', data: buildZip([{ name: 'a.xml', data: invoice(5009) }]) },
      { name: 'thang-10/ghi-chu.txt', data: 'Hoa don thang 10' },
    ]);
    await page.locator('input[type=file]').setInputFiles([
      { name: 'thang-10.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) },
      { name: 'hd-5003.xml', mimeType: 'application/xml', buffer: invoice(5003) },
      { name: 'hd-5004.xml', mimeType: 'application/xml', buffer: invoice(5004) },
    ]);
    const panel = page.getByTestId('intake-panel');
    await expect(panel).toBeVisible();
    // Two loose files and four entries of the archive.
    await expect(panel.getByTestId('intake-summary')).toHaveText('Đã nhận 6 tệp', { timeout: 120_000 });
    await expect(panel.getByText('4 đề xuất · 0 trùng · 2 lỗi')).toBeVisible();
    await expect(panel.getByText('ZIP: 4 tệp')).toBeVisible();
    await expect(panel.getByText('Không mở ZIP nằm trong ZIP; hãy tải riêng tệp đó')).toBeVisible();
    await expect(panel.getByText('Không phải tệp XML, PDF, JPG, PNG hoặc WEBP')).toBeVisible();
    await expect(panel.locator('[data-testid=intake-item][data-state=proposed]')).toHaveCount(4);
  });

  await test.step('the four invoices wait for approval, each read from its own file', async () => {
    for (const number of ['5001', '5002', '5003', '5004']) {
      await expect(page.getByText(`HĐ C26TAB-${number}`, { exact: false }).first()).toBeVisible();
    }
    const rows = sql<{ filename: string; created_by: string | null }>(
      `SELECT f.filename, f.created_by FROM crove_kernel.file f
       JOIN crove_kernel.tenant t ON t.org_id = f.org_id
       JOIN crove_kernel.proposal p ON p.org_id = f.org_id AND p.source_file_id = f.id
       WHERE t.slug = :'slug' ORDER BY f.filename`,
      { slug },
    );
    expect(rows.map((r) => r.filename)).toEqual(['hd-5001.xml', 'hd-5002.xml', 'hd-5003.xml', 'hd-5004.xml']);
    // The archive's entries count as uploaded by the member who uploaded the archive (four-eyes, P10).
    expect(rows.every((r) => r.created_by !== null && r.created_by === rows[0]?.created_by)).toBe(true);
  });
});
