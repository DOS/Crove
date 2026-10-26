// Every control the keyboard reaches shows a visible focus ring (#1584; DESIGN.md §7, WCAG 2.4.7), on every sidebar
// screen, in light and dark. axe (layout.spec.ts) cannot see this: it depends on the styles a focused element gets. The
// walk records, before any key is pressed, how each focusable element and its parent look (outline, shadow, border,
// background); then presses Tab through the screen and wants each focused element, or the wrapper that draws its ring,
// to look different from that, with an outline or a shadow when it had none of its own. Its own user, created
// confirmed without the sign-up form, so it draws nothing from the sign-up budget.
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ viewport: { width: 1280, height: 800 } });

const MAX_STOPS = 120;

// Each focusable element's look, and its parent's, while nothing has the focus.
async function recordUnfocused(page: Page): Promise<void> {
  await page.evaluate(() => {
    const look = (node: Element | null) => {
      if (!node) return '';
      const s = getComputedStyle(node);
      return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor].join('|');
    };
    const base = new WeakMap<Element, { self: string; parent: string }>();
    for (const el of document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]')) base.set(el, { self: look(el), parent: look(el.parentElement) });
    (window as unknown as { __ringBase: typeof base }).__ringBase = base;
  });
}

// What the focused element lacks, or null when it shows an indicator (or nothing visible has the focus).
async function missingRing(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const look = (node: Element | null) => {
      if (!node) return '';
      const s = getComputedStyle(node);
      return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor].join('|');
    };
    const ring = (node: Element | null) => {
      if (!node) return false;
      const s = getComputedStyle(node);
      return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
    };
    const base = (window as unknown as { __ringBase?: WeakMap<Element, { self: string; parent: string }> }).__ringBase?.get(el);
    // Rendered after the screen loaded: no record to compare with, so an outline or a shadow has to show.
    const shows = base ? look(el) !== base.self || look(el.parentElement) !== base.parent : ring(el) || ring(el.parentElement);
    if (shows) return null;
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${name}" (${(el.getAttribute('class') ?? '').slice(0, 80)})`;
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
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      await recordUnfocused(page);
      // Through the screen from its top, until the focus comes round to where it started.
      const seen = new Set<string>();
      let round = false;
      for (let i = 0; i < MAX_STOPS; i++) {
        await page.keyboard.press('Tab');
        const key = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return 'body';
          const path: number[] = [];
          for (let n: Element | null = el; n && n.parentElement; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
          return path.join('.');
        });
        if (seen.has(key)) {
          round = true;
          break;
        }
        seen.add(key);
        const missing = await missingRing(page);
        if (missing) problems.add(`${path} (${theme}): ${missing}`);
      }
      // A screen with more stops than the walk takes is said, so no control goes unchecked unnoticed.
      if (!round) problems.add(`${path} (${theme}): more than ${MAX_STOPS} tab stops, the rest not checked`);
    }
  }
  expect([...problems]).toEqual([]);
});
