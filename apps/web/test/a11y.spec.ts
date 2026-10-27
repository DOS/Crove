// The landing page in both languages, both themes, at phone width and on a desktop (#1629; DESIGN.md §7, §8, §10): axe
// finds no violation of the WCAG 2.2 AA rules nor of the landmark and heading rules, the page never scrolls sideways,
// and the English page shows no Vietnamese but the allowed example names.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { vietnameseLeft } from './vietnamese';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// The landmark and heading rules of axe (best-practice), asked for by id as in e2e/tests/layout.spec.ts.
const STRUCTURE_RULES = ['landmark-one-main', 'region', 'landmark-unique', 'page-has-heading-one', 'heading-order'];

const PAGES = [
  { path: '/', lang: 'vi' },
  { path: '/en', lang: 'en' },
] as const;
const VIEWPORTS = [
  { name: '360px', width: 360, height: 780 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
const THEMES = ['light', 'dark'] as const;

for (const { path, lang } of PAGES) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`${path} in ${theme} at ${viewport.name} passes axe and fits the screen`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        // The theme the page applies before its first paint (root-document.tsx), as if the visitor had picked it.
        await page.addInitScript((value) => localStorage.setItem('crove-theme', value), theme);
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);

        const problems: string[] = [];
        const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
        if (widths.page > widths.view) problems.push(`scrolls sideways (${widths.page}px in ${widths.view}px)`);
        // Every impact counts: the landing page has no known violation to carry.
        const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
        for (const v of [...scan.violations, ...structure.violations]) {
          problems.push(`${v.impact ?? 'unknown'} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
        }
        expect(problems).toEqual([]);
      });
    }
  }
}

// The rendered English page, so a word typed into a component instead of content/en.ts is caught too: its title, its
// visible text and the names and hints a screen reader or a hover reads out.
test('/en shows no Vietnamese but the allowed example names', async ({ page }) => {
  await page.goto('/en');
  const attributes = await page
    .locator('[aria-label], [alt], [title], [placeholder]')
    .evaluateAll((elements) => elements.flatMap((el) => ['aria-label', 'alt', 'title', 'placeholder'].map((name) => el.getAttribute(name) ?? '')));
  const text = [await page.title(), await page.locator('body').innerText(), ...attributes].join('\n');
  expect(vietnameseLeft(text)).toEqual([]);
});
