// A control the keyboard moves to is never hidden behind a sticky or fixed bar (#1575; DESIGN.md §7, WCAG 2.4.11): the
// phone's top bar and a proposal's approval bar at 360px, and a list's pinned header row when Shift+Tab scrolls its table
// up. Each focused control must be the element at its own centre (document.elementFromPoint), so nothing lies over it.
// Its own users, created confirmed without the sign-up form, so it draws nothing from the sign-up budget.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

const FIXTURE = readFileSync(fileURLToPath(new URL('../../apps/extract/test/fixtures/einvoice-basic.xml', import.meta.url)), 'utf8');
const SELLER = 'CÔNG TY TNHH DỊCH VỤ MẪU';
// The fixture with another invoice number, so each upload is its own proposal.
const invoice = (number: number) => ({ name: `hd-${number}.xml`, mimeType: 'application/xml', buffer: Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`)) });

// What covers the focused control, or null when nothing does (or nothing visible has the focus).
async function covered(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const describe = (n: Element | null) => (n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''} "${(n.getAttribute('aria-label') ?? n.textContent ?? '').trim().slice(0, 40)}"` : 'nothing');
    const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
    const y = r.top + r.height / 2;
    if (y < 0 || y >= window.innerHeight) return `${describe(el)} is off screen`;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === el || el.contains(hit)) ? null : `${describe(el)} is under ${describe(hit)}`;
  });
}

// Presses the key up to max times and gathers what covers the focused control after each press.
async function walk(page: Page, key: 'Tab' | 'Shift+Tab', max: number): Promise<string[]> {
  const problems: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    const problem = await covered(page);
    if (problem) problems.push(problem);
  }
  return problems;
}

test.describe('at phone width', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test("a proposal's controls are never under the top bar or the approval bar, in light and dark (#1575)", async ({ page }) => {
    await signInNewUser(page, newEmail('focus-proposal'));
    await createOrg(page, 'Công ty Tiêu điểm');
    await page.locator('input[type=file]').setInputFiles([invoice(4101)]);
    // The worker reads the XML and raises the proposal; the Inbox polls every few seconds.
    await page.getByRole('link', { name: SELLER }).first().click({ timeout: 90_000 });
    await expect(page.getByRole('heading', { name: SELLER })).toBeVisible();
    const proposal = page.url();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => localStorage.setItem('crove-theme', value), theme);
      await page.goto(proposal);
      await expect(page.getByRole('heading', { name: SELLER })).toBeVisible();
      // Down the page and back up: the approval bar is below, the top bar above.
      const problems = [...(await walk(page, 'Tab', 60)), ...(await walk(page, 'Shift+Tab', 60))];
      expect(problems, theme).toEqual([]);
    }
  });
});

test("a list's rows are never under its pinned header when Shift+Tab scrolls the table up (#1575)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await signInNewUser(page, newEmail('focus-list'));
  await createOrg(page, 'Công ty Danh sách dài');
  const numbers = Array.from({ length: 12 }, (_, i) => 4201 + i);
  await page.locator('input[type=file]').setInputFiles(numbers.map(invoice));
  await expect(page.getByRole('link', { name: SELLER })).toHaveCount(numbers.length, { timeout: 120_000 });
  // The table is taller than its box (#1444): Tab to its last row, then Shift+Tab back over every row.
  await page.getByRole('link', { name: SELLER }).first().focus();
  await walk(page, 'Tab', numbers.length * 2);
  const problems = await walk(page, 'Shift+Tab', numbers.length * 3);
  expect(problems).toEqual([]);
});
