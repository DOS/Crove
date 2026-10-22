// Sign-up and sign-in through the SPA, as a user does it, and confirmed users made without the sign-up form.
import { expect, type Page } from '@playwright/test';
import { compose } from './compose.ts';
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

// Supabase Auth's admin API, called by Node inside the kernel container: the /auth/v1 proxy never forwards /admin
// (http.ts), while the container reaches Supabase Auth on the compose network and holds the stack's JWT secret, so the
// secret never leaves it. It signs a service_role token that lives a minute. argv: email, password.
const CREATE_CONFIRMED_USER = `
import { createHmac } from 'node:crypto';
const [email, password] = process.argv.slice(1);
const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = part({ alg: 'HS256', typ: 'JWT' }) + '.' + part({ role: 'service_role', aud: 'authenticated', iss: process.env.AUTH_ISSUER, iat: now, exp: now + 60 });
const token = unsigned + '.' + createHmac('sha256', process.env.AUTH_JWT_SECRET).update(unsigned).digest('base64url');
const response = await fetch(process.env.AUTH_UPSTREAM_URL + '/admin/users', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, email_confirm: true }),
});
if (!response.ok) {
  console.error('Supabase Auth admin: ' + response.status + ' ' + (await response.text()));
  process.exit(1);
}
`;

// Creates a user whose email is already confirmed, without the sign-up form. Supabase Auth allows each client address
// a burst of 30 sign-ups, then one per 10 s (auth-rate-limits.spec.ts), and this runner is one address for the whole
// suite, so a test whose subject is not sign-up starts its users here and keeps the UI sign-ups for the specs about
// sign-up and onboarding (auth.spec.ts, onboarding.spec.ts, invite-preclaim.spec.ts and the others that call signUp).
// Acts on the same compose project as the database helpers, so it throws on a non-default E2E_BASE_URL without
// E2E_COMPOSE_PROJECT.
export function createConfirmedUser(email: string, password = PASSWORD): void {
  compose(['exec', '-T', 'crove', 'node', '--input-type=module', '-e', CREATE_CONFIRMED_USER, email, password]);
}

// A confirmed user created with createConfirmedUser, signed in through the login form, on onboarding (no org yet).
export async function signInNewUser(page: Page, email: string, password = PASSWORD): Promise<void> {
  createConfirmedUser(email, password);
  await signIn(page, email, password);
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
