// Supabase Auth flows in the SPA (Decision 6, issue #32): email confirmation and recovery callbacks (PKCE),
// TOTP enrollment and the sign-in challenge, token refresh and sign-out.
import { expect, test } from '@playwright/test';
import { authLink } from '../lib/mail.ts';
import { PASSWORD, claims, createOrg, newEmail, signIn, signOut, signUp, storedSession } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test('the confirmation link signs the new user in, and a used link shows why it failed', async ({ page }) => {
  const email = newEmail('confirm');
  await signUp(page, email);
  const session = await storedSession(page);
  expect(session && claims(session.access_token).email).toBe(email);

  await signOut(page);
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(await authLink(email, /confirm/i));
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('alert')).toContainText('Liên kết đã hết hạn hoặc đã được dùng');

  // Anyone can write a link's error text, so only known error codes are explained; the parameters leave the URL.
  await page.goto('/login?error=access_denied&error_code=made_up&error_description=Call+0900+000+000+to+unlock');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('alert')).toHaveText('Liên kết không hợp lệ hoặc đã hết hạn. Hãy yêu cầu liên kết mới.');
});

test('password recovery sets a new password through the emailed link', async ({ page }) => {
  const email = newEmail('recover');
  const newPassword = 'e2e-new-password-4567';
  await signUp(page, email);
  await signOut(page);

  await page.getByRole('button', { name: 'Quên mật khẩu?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Quên mật khẩu' }).click();
  await expect(page.getByText('thư đặt lại mật khẩu đã được gửi')).toBeVisible();

  await page.goto(await authLink(email, /reset/i));
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel('Mật khẩu mới', { exact: true }).fill(newPassword);
  await page.getByLabel('Nhập lại mật khẩu mới').fill(newPassword);
  await page.getByRole('button', { name: 'Lưu mật khẩu' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await signOut(page);

  await signIn(page, email, PASSWORD);
  await expect(page.getByRole('alert')).toHaveText('Email hoặc mật khẩu không đúng');
  await signIn(page, email, newPassword);
  await expect(page).toHaveURL(/\/onboarding$/);
});

test('a user enrolls TOTP; sign-in and password recovery then ask for the code (aal2)', async ({ page }) => {
  const email = newEmail('mfa');
  await signUp(page, email);
  const slug = await createOrg(page, 'Công ty MFA');

  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);

  await page.getByLabel('Mã xác thực').fill('000000');
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.getByRole('alert')).toHaveText('Mã xác thực không đúng hoặc đã hết hạn');

  const enrolled = await nextTotp(secret);
  await page.getByLabel('Mã xác thực').fill(enrolled.code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.getByText('Đã bật xác thực hai lớp.')).toBeVisible();
  await expect(page.getByText('Đang bật')).toBeVisible();
  const upgraded = await storedSession(page);
  expect(upgraded && claims(upgraded.access_token).aal).toBe('aal2');

  await signOut(page);
  await signIn(page, email);
  await expect(page).toHaveURL(/\/mfa$/);
  // Data routes stay behind the challenge.
  await page.goto(`/o/${slug}/inbox`);
  await expect(page).toHaveURL(/\/mfa$/);
  const signIn2 = await storedSession(page);
  expect(signIn2 && claims(signIn2.access_token).aal).toBe('aal1');

  const login = await nextTotp(secret, enrolled.step);
  await page.getByLabel('Mã xác thực').fill(login.code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
  const verified = await storedSession(page);
  expect(verified && claims(verified.access_token).aal).toBe('aal2');

  // A recovery link alone does not get past the second factor.
  await signOut(page);
  await page.getByRole('button', { name: 'Quên mật khẩu?' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Quên mật khẩu' }).click();
  await expect(page.getByText('thư đặt lại mật khẩu đã được gửi')).toBeVisible();
  await page.goto(await authLink(email, /reset/i));
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.getByText('Nhập mã trước khi đặt mật khẩu mới')).toBeVisible();
  await expect(page.getByLabel('Mật khẩu mới', { exact: true })).toHaveCount(0);
  const recovery = await nextTotp(secret, login.step);
  await page.getByLabel('Mã xác thực').fill(recovery.code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await page.getByLabel('Mật khẩu mới', { exact: true }).fill('e2e-mfa-new-password-89');
  await page.getByLabel('Nhập lại mật khẩu mới').fill('e2e-mfa-new-password-89');
  await page.getByRole('button', { name: 'Lưu mật khẩu' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
});

test('an expired access token is refreshed, and sign-out revokes the refresh token', async ({ page, request }) => {
  const email = newEmail('refresh');
  await signUp(page, email);
  const before = await storedSession(page);
  if (!before) throw new Error('no session after sign-up');

  // Pretend the access token expired a minute ago; on reload auth-js must refresh before the app calls the API.
  await page.evaluate(() => {
    const stored = JSON.parse(window.localStorage.getItem('crove-auth') ?? '{}') as { expires_at?: number };
    stored.expires_at = Math.floor(Date.now() / 1000) - 60;
    window.localStorage.setItem('crove-auth', JSON.stringify(stored));
  });
  const refreshed = page.waitForResponse((r) => r.url().includes('/auth/v1/token?grant_type=refresh_token'));
  await page.goto('/');
  expect((await refreshed).status()).toBe(200);
  // The index route asked the kernel for /me with the refreshed token before sending the user on.
  await expect(page).toHaveURL(/\/onboarding$/);
  const after = await storedSession(page);
  expect(after?.refresh_token).not.toBe(before.refresh_token);
  expect(after && after.expires_at > Date.now() / 1000).toBe(true);

  await signOut(page);
  await expect(page).toHaveURL(/\/login$/);
  expect(await storedSession(page)).toBeNull();
  const reuse = await request.post('/auth/v1/token?grant_type=refresh_token', { data: { refresh_token: after?.refresh_token } });
  expect(reuse.status()).toBe(400);
});

test('managing members asks for two-factor first, then works once it is on', async ({ page, browser }) => {
  const owner = newEmail('owner');
  await signUp(page, owner);
  const slug = await createOrg(page, 'Công ty thành viên');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();

  // Inviting is R3, and the owner has no second factor yet.
  const member = newEmail('member');
  await page.getByPlaceholder('email@congty.vn').fill(member);
  await page.getByRole('button', { name: 'Mời', exact: true }).click();
  await expect(page.getByText(`Đang chờ: mời ${member} với vai trò Thành viên.`)).toBeVisible();
  await expect(page.getByText('Bật xác thực hai lớp ở ô bên cạnh rồi thử lại.')).toBeVisible();

  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.getByText('Đang bật')).toBeVisible();

  await page.getByRole('button', { name: 'Mời', exact: true }).click();
  const created = page.getByRole('status').filter({ hasText: `Đã tạo lời mời cho ${member}` });
  const link = (await created.getByText(/\/-\/invite#/).textContent())?.trim() ?? '';
  expect(link).toMatch(/\/-\/invite#/);

  // The member accepts in a browser of their own.
  const memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const memberPage = await memberContext.newPage();
  await signUp(memberPage, member);
  await memberPage.goto(link);
  await memberPage.getByRole('button', { name: 'Chấp nhận lời mời' }).click();
  await expect(memberPage).toHaveURL(new RegExp(`/o/${slug}/inbox$`));

  // Changing a role is R3 as well; the owner's code is still fresh. Promotion to owner is confirmed inline (#119).
  await page.reload();
  const role = page.getByRole('listitem').filter({ hasText: member }).getByLabel(`Vai trò của ${member}`, { exact: true });
  await expect(role).toHaveValue('member');
  await role.selectOption('owner');
  await page.getByRole('button', { name: 'Xác nhận đặt làm chủ sở hữu' }).click();
  await expect(role).toHaveValue('owner');

  // The new co-owner has no second factor: changing the first owner's role asks for one first.
  await memberPage.goto(`/o/${slug}/settings`);
  const first = memberPage.getByRole('listitem').filter({ hasText: owner });
  const firstRole = first.getByLabel(`Vai trò của ${owner}`, { exact: true });
  await firstRole.selectOption('admin');
  await first.getByRole('button', { name: 'Xác nhận đổi vai trò' }).click();
  await expect(first.getByText(`Đang chờ: đổi vai trò của ${owner} thành Quản trị.`)).toBeVisible();
  await memberPage.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const memberSecret = (await memberPage.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  await memberPage.getByLabel('Mã xác thực').fill((await nextTotp(memberSecret)).code);
  await memberPage.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(memberPage.getByText('Đang bật')).toBeVisible();

  // With the second factor fresh, the confirmed change goes through, then the removal.
  await first.getByRole('button', { name: 'Xác nhận đổi vai trò' }).click();
  await expect(firstRole).toHaveValue('admin');
  await first.getByRole('button', { name: 'Xóa', exact: true }).click();
  await first.getByRole('button', { name: 'Xác nhận xóa' }).click();
  await expect(first).toHaveCount(0);
  await memberContext.close();
});

test('rotating the inbound address asks for two-factor first', async ({ page }) => {
  await signUp(page, newEmail('rotate'));
  await createOrg(page, 'Công ty đổi địa chỉ');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();
  const before = (await page.getByText(/@in\.e2e\.test$/).first().textContent())?.trim() ?? '';
  expect(before).toMatch(/@in\.e2e\.test$/);

  // Rotation is R3 (#142): without a second factor the confirmation turns into the step-up prompt.
  await page.getByRole('button', { name: 'Đổi địa chỉ email nhận hóa đơn' }).click();
  await page.getByRole('button', { name: 'Xác nhận đổi địa chỉ' }).click();
  await expect(page.getByText('Đang chờ: đổi địa chỉ email nhận hóa đơn.')).toBeVisible();
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
  await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(page.getByText('Đang bật')).toBeVisible();

  await page.getByRole('button', { name: 'Xác nhận đổi địa chỉ' }).click();
  const rotated = page.getByRole('status').filter({ hasText: 'Đã đổi địa chỉ' });
  await expect(rotated).toContainText(/@in\.e2e\.test/);
  await expect(rotated).not.toContainText(before);
});

test('closing the organization asks for two-factor first', async ({ page }) => {
  await signUp(page, newEmail('offboard'));
  const slug = await createOrg(page, 'Công ty đóng cửa');
  await page.getByRole('navigation').getByRole('link', { name: 'Cài đặt' }).click();

  // Offboarding is R3 (#212): without a second factor the confirmation turns into the step-up prompt.
  await page.getByRole('button', { name: 'Bắt đầu đóng tổ chức' }).click();
  await page.getByPlaceholder('Nhập mã rút gọn').fill(slug);
  await page.getByRole('button', { name: 'Xác nhận đóng tổ chức' }).click();
  await expect(page.getByText('Đang chờ: đóng tổ chức Công ty đóng cửa và xuất dữ liệu.')).toBeVisible();
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  await page.getByLabel('Mã xác thực').fill((await nextTotp(secret)).code);
  await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(page.getByText('Đang bật')).toBeVisible();

  await page.getByRole('button', { name: 'Xác nhận đóng tổ chức' }).click();
  await expect(page.getByText('Tổ chức đang được đóng. Chỉ chủ sở hữu còn truy cập được.')).toBeVisible();
});
