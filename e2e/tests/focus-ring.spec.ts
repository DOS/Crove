// Every control the keyboard reaches shows a visible focus ring (#1584; DESIGN.md §7, WCAG 2.4.7), on every sidebar
// screen, in light and dark. axe (layout.spec.ts) cannot see this: it depends on the styles a focused element gets. The
// walk presses Tab through each screen and, for every element that takes the focus, wants an outline that is not `none`
// or a box-shadow ring on the element or on the wrapper that draws its ring (an input group). Its own user, created
// confirmed without the sign-up form, so it draws nothing from the sign-up budget.
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ viewport: { width: 1280, height: 800 } });

// What the focused element lacks, or null when it shows a ring (or nothing visible has the focus).
async function missingRing(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const shows = (node: Element | null) => {
      if (!node) return false;
      const s = getComputedStyle(node);
      const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      return outline || s.boxShadow !== 'none';
    };
    if (shows(el) || shows(el.parentElement)) return null;
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${name}" (${el.className.toString().slice(0, 80)})`;
  });
}

test('every control the keyboard reaches on every sidebar screen shows a focus ring, in light and dark (#1584)', async ({ page }) => {
  test.setTimeout(600_000);
  await signInNewUser(page, newEmail('focus-ring'));
  await createOrg(page, 'Công ty Vòng tiêu điểm');
  const sidebar = page.getByRole('complementary');
  const apps = sidebar.getByRole('list', { name: 'Ứng dụng' });
  const links = new Set<string>();
  const appCount = await apps.getByRole('link').count();
  for (let i = 0; i < appCount; i++) {
    await apps.getByRole('link').nth(i).click();
    await page.waitForLoadState('networkidle');
    const paths = await sidebar.getByRole('link').evaluateAll((anchors) => anchors.filter((a) => (a as HTMLAnchorElement).origin === location.origin).map((a) => (a as HTMLAnchorElement).pathname));
    for (const path of paths) links.add(path);
  }
  expect(links.size).toBeGreaterThan(5);

  const problems = new Set<string>();
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
    for (const path of links) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      // Through the screen from its top, until the focus comes round to where it started.
      const seen = new Set<string>();
      for (let i = 0; i < 120; i++) {
        await page.keyboard.press('Tab');
        const key = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return 'body';
          const path: number[] = [];
          for (let n: Element | null = el; n && n.parentElement; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
          return path.join('.');
        });
        if (seen.has(key)) break;
        seen.add(key);
        const missing = await missingRing(page);
        if (missing) problems.add(`${path} (${theme}): ${missing}`);
      }
    }
  }
  expect([...problems]).toEqual([]);
});
