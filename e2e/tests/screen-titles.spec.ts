// SPDX-License-Identifier: AGPL-3.0-only
// Each screen has its own tab title, a skip link and a focus move on navigation (WCAG 2.4.1, 2.4.2, 2.4.3, 4.1.3;
// DESIGN.md §7, #2115): six screens of different apps give six distinct titles, in Vietnamese and in English; the first
// Tab on a signed-in screen reaches the skip link, which puts the focus in <main>; a keyboard press on a sidebar link
// moves the focus to the new screen's heading and names the screen in the live region, while a search-param change
// (the inbox tabs) and the back button leave the focus alone; and at 360px the skip link is not under the sticky header.
// Its own user, created confirmed without the sign-up form, so it draws nothing from the sign-up budget.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
const BRAND = 'Ludy';

const SKIP = { vi: 'Bỏ qua tới nội dung', en: 'Skip to content' } as const;

// Where the focus is: the heading or <main> of the screen, a sidebar link, or somewhere else (body, a control).
function where(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'body';
    if (el.tagName === 'MAIN') return 'main';
    if (el.tagName === 'H1' && el.closest('main')) return 'heading';
    if (el.closest('aside')) return `sidebar:${(el.textContent ?? '').trim()}`;
    return `${el.tagName.toLowerCase()}:${(el.getAttribute('role') ?? '')}`;
  });
}

async function titleAndHeading(page: Page): Promise<{ title: string; heading: string }> {
  const heading = (await page.locator('main h1').first().innerText()).trim();
  return { title: await page.title(), heading };
}

test.describe('screen titles, skip link and focus on navigation (#2115)', () => {
  test.setTimeout(240_000);
  let slug = '';
  let proposal = '';

  test.beforeEach(async ({ page }) => {
    await signInNewUser(page, newEmail('screen-titles'));
    slug = await createOrg(page, 'Công ty Tiêu đề');
    await page.locator('input[type=file]').setInputFiles(INVOICE);
    await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 90_000 });
    proposal = new URL((await page.getByRole('link', { name: SELLER }).getAttribute('href')) ?? '', page.url()).pathname;
  });

  for (const locale of ['vi', 'en'] as const) {
    test(`six screens of different apps have distinct titles in ${locale}`, async ({ page }) => {
      await page.evaluate((value) => localStorage.setItem('crove-locale', value), locale);
      const screens = [`/o/${slug}/overview`, `/o/${slug}/inbox`, proposal, `/o/${slug}/journal`, `/o/${slug}/settings`, `/o/${slug}/social`];
      const titles: string[] = [];
      for (const path of screens) {
        await page.goto(path);
        await expect(page.locator('main h1').first()).toBeVisible();
        const { title, heading } = await titleAndHeading(page);
        expect(heading, path).not.toBe('');
        // "<screen name> · <brand>", the screen name being the page's own heading.
        expect(title, path).toBe(`${heading} · ${BRAND}`);
        titles.push(title);
      }
      expect(new Set(titles).size).toBe(screens.length);
      // The proposal's title is its record's name, not the name of the screen.
      expect(titles[2]).toContain(SELLER);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
    });
  }

  test('the tab title follows a change of language', async ({ page }) => {
    await page.goto(`/o/${slug}/settings`);
    await expect(page.locator('main h1').first()).toBeVisible();
    const vi = (await page.title()).split(' · ')[0];
    await page.evaluate(() => localStorage.setItem('crove-locale', 'en'));
    await page.reload();
    await expect(page.locator('main h1').first()).toBeVisible();
    const en = (await page.title()).split(' · ')[0];
    expect(en).not.toBe(vi);
  });

  test('Tab once reaches the skip link, which puts the focus in <main>', async ({ page }) => {
    await page.goto(`/o/${slug}/settings`);
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: SKIP.vi });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Enter');
    expect(await where(page)).toBe('main');
    // The address stays as it was: the link is not a navigation.
    expect(new URL(page.url()).pathname).toBe(`/o/${slug}/settings`);
  });

  test('a keyboard press on a sidebar link lands on the new screen and names it; ?search changes and back do not move focus', async ({ page }) => {
    await page.goto(`/o/${slug}/inbox`);
    await expect(page.locator('main h1').first()).toBeVisible();
    const sidebar = page.getByRole('complementary');
    const settings = sidebar.getByRole('link', { name: 'Cài đặt', exact: true });
    await settings.focus();
    expect(await where(page)).toMatch(/^sidebar:/);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/settings$`));
    await expect(page.locator('main h1').first()).toBeVisible();
    const heading = (await page.locator('main h1').first().innerText()).trim();
    // The new screen's own heading has the focus (not the old screen's, which is gone), and it stays there.
    await expect(page.locator('main h1').first()).toBeFocused();
    await expect(page.locator('[data-route-announcer]')).toHaveText(heading);
    await page.waitForTimeout(500);
    await expect(page.locator('main h1').first()).toBeFocused();

    // Back keeps the focus where the browser puts it: not on the screen's heading.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/inbox$`));
    await expect(page.locator('main h1').first()).toBeVisible();
    expect(await where(page)).not.toMatch(/^(heading|main)$/);

    // A search-param change (the inbox tabs, ?status=) keeps the focus on the tab.
    const tab = page.getByRole('tab', { name: 'Đã ghi sổ' });
    await tab.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/status=/);
    await page.waitForTimeout(500);
    expect(await where(page)).toMatch(/:tab$/);
  });

  test.describe('at 360px', () => {
    test.use({ viewport: { width: 360, height: 780 } });

    test('the skip link is the first stop and clear of the sticky header', async ({ page }) => {
      await page.goto(`/o/${slug}/inbox`);
      await expect(page.locator('main h1').first()).toBeVisible();
      // Scrolled down, so the sticky header is stuck to the top when the focus arrives.
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: SKIP.vi });
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport({ ratio: 1 });
      const covered = await skip.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit !== el && !el.contains(hit);
      });
      expect(covered).toBe(false);
      await page.keyboard.press('Enter');
      expect(await where(page)).toBe('main');
    });
  });
});
