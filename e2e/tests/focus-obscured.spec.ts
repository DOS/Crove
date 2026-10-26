// Focus not obscured (WCAG 2.4.11, DESIGN.md §7, #1575): at phone width, in both themes, Tab through a proposal (under
// the phone's sticky header, above the fixed approval bar) and a long list (a table under its pinned header row), and
// every control the keyboard focuses lies clear of all three bars: the element at the centre of the focused control is
// the control or inside it. Its own user, created confirmed without the sign-up form, so it draws nothing from the
// sign-up budget.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { exec } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const INVOICE = fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
const VENDORS = 30;
// More than the controls of either screen, so the walk reaches the end of the page.
const MAX_TABS = 160;

test.use({ viewport: { width: 360, height: 780 } });

// The focused control, and what lies over its centre when that is not the control itself (null: nothing does).
function focused(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const describe = (n: Element) => `${n.tagName.toLowerCase()} "${(n.getAttribute('aria-label') ?? n.textContent ?? '').trim().slice(0, 40)}"`;
    const box = el.getBoundingClientRect();
    const key = `${describe(el)}@${Math.round(box.top + window.scrollY)}`;
    if (box.width === 0 || box.height === 0) return { key, problem: null };
    // The part of the control its scroll boxes and the window show (a table wider than a phone shows part of a row's
    // last button, which is fine); a bar must not lie over the middle of that part.
    let [left, top, right, bottom] = [box.left, box.top, box.right, box.bottom];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = p.getBoundingClientRect();
      [left, top, right, bottom] = [Math.max(left, clip.left), Math.max(top, clip.top), Math.min(right, clip.right), Math.min(bottom, clip.bottom)];
    }
    [left, top, right, bottom] = [Math.max(left, 0), Math.max(top, 0), Math.min(right, window.innerWidth), Math.min(bottom, window.innerHeight)];
    if (right - left < 1 || bottom - top < 1) return { key, problem: `${describe(el)} is out of view` };
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    if (!hit || hit === el || el.contains(hit)) return { key, problem: null };
    return { key, problem: `${describe(el)} is under ${describe(hit.closest('header, thead, .fixed') ?? hit)}` };
  });
}

// Down the page with Tab until the focus leaves it or comes back to where it started, then back up with Shift+Tab
// (a bar above covers what scrolls in from the top: the header, the table's header row). Returns every focused control
// something lay over.
async function coveredControls(page: Page): Promise<string[]> {
  const covered: string[] = [];
  let first: string | null = null;
  let steps = 0;
  for (; steps < MAX_TABS; steps++) {
    await page.keyboard.press('Tab');
    const seen = await focused(page);
    if (!seen || seen.key === first) break;
    first ??= seen.key;
    if (seen.problem) covered.push(`down: ${seen.problem}`);
  }
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Shift+Tab');
    const seen = await focused(page);
    if (!seen) break;
    if (seen.problem) covered.push(`up: ${seen.problem}`);
  }
  return covered;
}

test('a focused control is never hidden behind a sticky bar, at 360px in light and dark (#1575)', async ({ page }) => {
  test.setTimeout(240_000);
  await signInNewUser(page, newEmail('focus-obscured'));
  const slug = await createOrg(page, 'Công ty Tiêu điểm');
  // A long list: vendors enough for the table to scroll inside its card.
  exec(
    `INSERT INTO crove_kernel.party (org_id, name, kind)
     SELECT t.org_id, 'Nhà cung cấp ' || chr(64 + (n / 26) + 1) || chr(65 + n % 26), 'organization'
     FROM crove_kernel.tenant t, generate_series(0, ${VENDORS - 1}) n WHERE t.slug = :'slug'`,
    { slug },
  );
  // A pending proposal: its approval bar is fixed to the foot of the screen.
  await page.locator('input[type=file]').setInputFiles(INVOICE);
  await expect(page.getByRole('link', { name: SELLER })).toBeVisible({ timeout: 90_000 });
  const proposal = new URL((await page.getByRole('link', { name: SELLER }).getAttribute('href')) ?? '', page.url()).pathname;

  const problems: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
    for (const path of [proposal, `/o/${slug}/vendors`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      for (const problem of await coveredControls(page)) problems.push(`${theme} ${path}: ${problem}`);
    }
  }
  expect(problems).toEqual([]);
});
