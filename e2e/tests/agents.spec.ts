// R3 work on the agents screen asks for a second factor in place (#345): installing an agent template without one
// shows the step-up prompt, which enables TOTP right there and then installs the template as asked, with no second
// click.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('the agents screen asks for a second factor in place, then does what was asked', async ({ page }) => {
  await signUp(page, newEmail('agents'));
  await createOrg(page, 'Công ty Tác tử');
  await page.getByRole('navigation').getByRole('link', { name: 'Sơ đồ và AI' }).click();
  await expect(page.getByRole('heading', { name: 'Sơ đồ tổ chức và tác tử AI' })).toBeVisible();

  await page.getByTestId('template').first().getByRole('button', { name: 'Cài', exact: true }).click();
  await expect(page.getByText('Việc này cần xác thực hai lớp. Bật xác thực hai lớp cho tài khoản, Crove sẽ thực hiện lại ngay sau đó.')).toBeVisible();
  await expect(page.getByText(/^Đang chờ: cài mẫu .+\.$/)).toBeVisible();

  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  const enrolled = await nextTotp(secret);
  await page.getByLabel('Mã xác thực').fill(enrolled.code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();

  // The refused request ran again once the factor was on.
  await expect(page.getByText('Đã cài tác tử AI và vị trí của nó.')).toBeVisible();
  await expect(page.getByTestId('agent-row')).toHaveCount(1);
  await expect(page.getByText(/^Đang chờ: cài mẫu/)).toHaveCount(0);
});
