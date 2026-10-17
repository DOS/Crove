// Sign-up and sign-in through the SPA, as a user does it.
import { expect, type Page } from '@playwright/test';
import { authLink } from './mail.ts';

export const PASSWORD = 'e2e-password-0123';

export function newEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

// Signs up, opens the confirmation link from the email in the same browser (PKCE) and lands on onboarding.
export async function signUp(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mật khẩu').fill(password);
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(page.getByText('Đã gửi email xác nhận')).toBeVisible();
  await page.goto(await authLink(email, /confirm/i));
  await expect(page).toHaveURL(/\/onboarding$/);
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mật khẩu').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
}

// The app's own sign-out control: the sidebar's inside an org, the only one elsewhere (onboarding, /mfa). The
// sessions card in Settings has a "Đăng xuất" button per device as well.
export async function signOut(page: Page): Promise<void> {
  const sidebar = page.getByRole('complementary').getByRole('button', { name: 'Đăng xuất', exact: true });
  await ((await sidebar.count()) > 0 ? sidebar : page.getByRole('button', { name: 'Đăng xuất', exact: true })).click();
}

export async function createOrg(page: Page, name: string): Promise<string> {
  await page.getByLabel('Tên công ty hoặc hộ kinh doanh').fill(name);
  await page.getByRole('button', { name: 'Tạo tổ chức' }).click();
  await expect(page).toHaveURL(/\/o\/[^/]+\/inbox$/);
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// The session auth-js keeps in localStorage (storage key `crove-auth`).
export async function storedSession(page: Page): Promise<StoredSession | null> {
  const raw = await page.evaluate(() => window.localStorage.getItem('crove-auth'));
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}

export function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}
