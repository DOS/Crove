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

// Every violation counts, whatever its impact: the landing page has none to carry. A contrast axe cannot decide does
// not fail the test: today that is text on the org chart's dot grid, the ⌘ glyph, a header cell its neighbour
// overlaps, and at 360px the cells a sideways scroll hides, each checked by hand (#1629). They are listed in the report
// as annotations, so a new one is seen.
async function scan(axe: () => AxeBuilder): Promise<string[]> {
  const wcag = await axe().withTags(WCAG_TAGS).analyze();
  const structure = await axe().withRules(STRUCTURE_RULES).analyze();
  for (const node of wcag.incomplete.filter((result) => result.id === 'color-contrast').flatMap((result) => result.nodes)) {
    const reason = (node.any[0]?.data as { messageKey?: string } | undefined)?.messageKey ?? 'unknown';
    test.info().annotations.push({ type: 'axe: contrast undecided', description: `${reason} on ${node.target.join(' ')}` });
  }
  return [...wcag.violations, ...structure.violations].map(
    (v) => `${v.impact ?? 'unknown'} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`,
  );
}

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
        // axe sees only what is rendered, so the FAQ answers are opened first.
        await page.locator('details').evaluateAll((all) => all.forEach((details) => ((details as HTMLDetailsElement).open = true)));
        problems.push(...(await scan(() => new AxeBuilder({ page }))));
        // The phone header's menu, scanned on its own once open: its panel covers the page below it.
        const menu = page.getByRole('banner').locator('button[aria-controls]');
        if (await menu.isVisible()) {
          await menu.click();
          const panel = `[id="${await menu.getAttribute('aria-controls')}"]`;
          await expect(page.locator(panel)).toBeVisible();
          for (const problem of await scan(() => new AxeBuilder({ page }).include(panel))) problems.push(`menu: ${problem}`);
        }
        expect(problems).toEqual([]);
      });
    }
  }
}

// The rendered English page, so a word typed into a component instead of content/en.ts is caught too: its title, every
// text node (also the closed FAQ answers, the closed menu and what shows at one width only) and the names and hints a
// screen reader or a hover reads out.
test('/en shows no Vietnamese but the allowed example names', async ({ page }) => {
  await page.goto('/en');
  const texts = await page.evaluate(() => {
    const found = [document.title];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest('script, style, noscript, template')) found.push(node.textContent ?? '');
    }
    for (const el of document.querySelectorAll('[aria-label], [alt], [title], [placeholder]')) {
      for (const name of ['aria-label', 'alt', 'title', 'placeholder']) found.push(el.getAttribute(name) ?? '');
    }
    return found;
  });
  expect(vietnameseLeft(texts.join('\n'))).toEqual([]);
});
