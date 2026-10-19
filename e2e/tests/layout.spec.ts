// The desktop sidebar on a short window (#516): the menu scrolls inside the sidebar and its footer (sign out, language)
// stays in view. The sidebar sticks to the top at the window's height, so a footer below the fold could never be
// scrolled to.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

test.use({ viewport: { width: 1280, height: 600 } });

test('the sidebar keeps sign-out in view on a short window, and its menu scrolls', async ({ page }) => {
  await signUp(page, newEmail('layout'));
  await createOrg(page, 'Công ty Màn hình nhỏ');
  const sidebar = page.getByRole('complementary');
  const signOut = sidebar.getByRole('button', { name: 'Đăng xuất', exact: true });
  await expect(signOut).toBeInViewport();

  // The last menu item is reached by scrolling the menu; the footer stays where it is.
  const settings = sidebar.getByRole('link', { name: 'Cài đặt' });
  await settings.scrollIntoViewIfNeeded();
  await expect(settings).toBeInViewport();
  await expect(signOut).toBeInViewport();

  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
});
