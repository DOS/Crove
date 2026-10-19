// An invited address cannot be pre-claimed (issue #563), in the browser against the real Supabase Auth. Under a
// restricted sign-up policy the kernel's /auth/v1 proxy forwards a sign-up for an invited address only with the token
// of its invite, which the SPA sends when the invitee signs up after opening the accept link. Someone who only knows
// the address is refused, so the account the invitee confirms and joins the org with carries the invitee's password.
//
// Needs a stack started with AUTH_SIGNUP_POLICY=allowlist and AUTH_SIGNUP_ALLOWED_DOMAINS=example.com (the domain of
// newEmail(), so the owner signs up as usual and the invitee's address is at an allowed domain); skipped otherwise.
import { expect, test } from '@playwright/test';
import { authLink } from '../lib/mail.ts';
import { createOrg, newEmail, signIn, signUp } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('an invited address signs up only from its accept link, and the invitee joins with their own password', async ({ page, browser, request }) => {
  const config = (await (await request.get('/api/config')).json()) as { signupPolicy?: string };
  test.skip(config.signupPolicy !== 'allowlist', 'needs AUTH_SIGNUP_POLICY=allowlist with AUTH_SIGNUP_ALLOWED_DOMAINS=example.com');

  const owner = newEmail('preclaim-owner');
  await signUp(page, owner);
  const slug = await createOrg(page, 'Công ty lời mời');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.getByText('Đang bật')).toBeVisible();

  const member = newEmail('preclaim-member');
  await page.getByPlaceholder('email@congty.vn').fill(member);
  await page.getByRole('button', { name: 'Mời', exact: true }).click();
  const created = page.getByRole('status').filter({ hasText: `Đã tạo lời mời cho ${member}` });
  const link = (await created.getByText(/\/-\/invite#/).textContent())?.trim() ?? '';
  expect(link).toMatch(/\/-\/invite#/);
  const origin = new URL(page.url()).origin;

  // Someone who knows the invited address signs up first, with their own password, from the plain sign-up page.
  const attackerContext = await browser.newContext({ baseURL: origin });
  const attacker = await attackerContext.newPage();
  await attacker.goto('/login');
  await attacker.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await attacker.getByLabel('Email').fill(member);
  await attacker.getByLabel('Mật khẩu').fill('attacker-password-0123');
  await attacker.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(attacker.getByRole('alert')).toContainText('Email này chưa được phép đăng ký');
  await expect(attacker.getByText('Đã gửi email xác nhận')).toHaveCount(0);

  // The invitee opens the link in their own browser, signs up there, confirms and accepts.
  const memberContext = await browser.newContext({ baseURL: origin });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(link);
  await expect(memberPage).toHaveURL(/\/login$/);
  await memberPage.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await memberPage.getByLabel('Email').fill(member);
  await memberPage.getByLabel('Mật khẩu').fill('member-password-0123');
  await memberPage.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(memberPage.getByText('Đã gửi email xác nhận')).toBeVisible();
  await memberPage.goto(await authLink(member, /confirm/i));
  await expect(memberPage).toHaveURL(/\/-\/invite$/);
  await memberPage.getByRole('button', { name: 'Chấp nhận lời mời' }).click();
  await expect(memberPage).toHaveURL(new RegExp(`/o/${slug}/inbox$`));

  // The account is the invitee's: the attacker's password does not open it, the invitee's does.
  await signIn(attacker, member, 'attacker-password-0123');
  await expect(attacker.getByRole('alert')).toHaveText('Email hoặc mật khẩu không đúng');
  const again = await browser.newContext({ baseURL: origin });
  const againPage = await again.newPage();
  await signIn(againPage, member, 'member-password-0123');
  await expect(againPage).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  await Promise.all([attackerContext.close(), memberContext.close(), again.close()]);
});
