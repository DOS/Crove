// The HTKK XML of form 01/GTGT (issue #332), end to end: the button waits for the org's tax code -> set it in Settings
// -> upload an e-invoice the org issued and approve the sale -> Tờ khai GTGT for September 2026 -> download the XML
// and read the taxpayer, the period and the sales indicators back from it.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
// The fixture's synthetic seller tax code (checksum-invalid on purpose, #157). The org is the fixture's seller here.
const SELLER_TAX_CODE = '0101234564';
const BUYER = 'CÔNG TY CỔ PHẦN NGƯỜI MUA MẪU';
const ORG_NAME = 'Công ty Tờ khai XML E2E';

const valueOf = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];

test('export the VAT return of a month as the HTKK XML of form 01/GTGT', async ({ page }) => {
  await test.step('sign up and create the org', async () => {
    await page.goto('/');
    await signUp(page, newEmail('vatxml'));
  });
  const slug = await createOrg(page, ORG_NAME);
  const nav = page.getByRole('navigation');

  await test.step('the XML export waits for the org tax code', async () => {
    await nav.getByRole('link', { name: 'Tờ khai GTGT' }).click();
    await expect(page.getByRole('button', { name: 'Xuất XML cho HTKK' })).toBeDisabled();
    await expect(page.getByText('Muốn xuất tờ khai XML cho HTKK, hãy nhập mã số thuế của tổ chức trong Cài đặt.')).toBeVisible();
  });

  await test.step('set the org tax code in Settings', async () => {
    await nav.getByRole('link', { name: 'Cài đặt' }).click();
    await page.getByRole('button', { name: 'Nhập', exact: true }).click();
    const form = page.getByRole('form', { name: 'Mã số thuế' });
    await form.getByLabel('Mã số thuế').fill(SELLER_TAX_CODE);
    await form.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.getByText(SELLER_TAX_CODE, { exact: true })).toBeVisible();
  });

  await test.step('upload the e-invoice the org issued and approve the sale with a second factor', async () => {
    await nav.getByRole('link', { name: 'Hộp thư chứng từ' }).click();
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    const proposal = page.getByRole('row').filter({ has: page.getByRole('link', { name: BUYER }) });
    await expect(proposal).toBeVisible({ timeout: 60_000 });
    await proposal.getByRole('link', { name: BUYER }).click();
    await page.getByRole('button', { name: 'Duyệt và ghi sổ' }).click();
    await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
    const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
    await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await expect(page.getByText('Không có đề xuất nào chờ duyệt')).toBeVisible();
  });

  await test.step('download the XML of September 2026 and read it back', async () => {
    await nav.getByRole('link', { name: 'Tờ khai GTGT' }).click();
    await page.getByLabel('Kỳ khai', { exact: true }).selectOption('month');
    await page.getByLabel('Năm', { exact: true }).selectOption('2026');
    await page.getByLabel('Tháng', { exact: true }).selectOption('9');
    await expect(page.getByRole('heading', { name: 'Hóa đơn bán ra (1)' })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Xuất XML cho HTKK' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`crove-01gtgt-2026-09-${slug}.xml`);
    const xml = await readFile(await file.path(), 'utf8');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(valueOf(xml, 'mst')).toBe(SELLER_TAX_CODE);
    expect(valueOf(xml, 'tenNNT')).toBe(ORG_NAME);
    expect(valueOf(xml, 'kieuKy')).toBe('M');
    expect(valueOf(xml, 'kyKKhai')).toBe('09/2026');
    // The fixture: 1,800,000 at 10%, VAT 180,000, sold by the org.
    expect(valueOf(xml, 'ct32')).toBe('1800000');
    expect(valueOf(xml, 'ct33')).toBe('180000');
    expect(valueOf(xml, 'ct34')).toBe('1800000');
    expect(valueOf(xml, 'ct23')).toBe('0');
  });
});
