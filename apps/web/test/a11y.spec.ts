// The landing page in both languages, both themes, at phone width and on a desktop (#1629; DESIGN.md §7, §8, §10): axe
// finds no violation of the WCAG 2.2 AA rules nor of the landmark and heading rules, every contrast it cannot decide is
// of a known kind and measures as passing (#1657), the page never scrolls sideways,
// and the English page shows no Vietnamese but the allowed example names.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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

// The contrasts axe cannot decide, each decided here (#1657). An undecided node must be one of these kinds, keyed on
// axe's reason and on where it sits; anything else fails, so a new one is looked at. For each, the test then measures
// what axe could not: nothing paints over the middle of its text, no background image lies between the text and the
// first opaque background, and the text's color on that background meets 4.5:1 (3:1 for large text, WCAG 1.4.3).
//   - nonBmp: a key glyph such as the ⌘ in a <kbd>, which axe does not read as text. Same colors as the K beside it.
//   - bgOverlap: a header cell that spans two rows (rowspan), whose box the cell beside it overlaps without covering
//     its text.
//   - elmPartiallyObscured: a cell or label partly scrolled out of a block that scrolls sideways at 360px; the part in
//     view is measured.
//   - elmPartiallyObscuring: text of an org chart card ([data-org-node]) whose box crosses a connector line that runs
//     behind the card (the card is opaque and stacked above it).
// Text on the org chart's dot grid is no longer one of them: it sits on the card's own surface (org-chart.tsx), so
// axe decides it.
const UNDECIDED_KINDS = ['nonBmp', 'bgOverlap', 'elmPartiallyObscured', 'elmPartiallyObscuring'] as const;
type UndecidedKind = (typeof UNDECIDED_KINDS)[number];

// What the page reports for one undecided node: whether it is the kind axe gave, and its measured contrast.
interface Measured {
  found: boolean;
  kind: boolean;
  covered: boolean;
  backgroundImage: boolean;
  ratio: number;
  needed: number;
}

async function measure(page: Page, selector: string, kind: UndecidedKind): Promise<Measured> {
  return page.evaluate(
    ({ selector, kind }) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      const none = { found: false, kind: false, covered: false, backgroundImage: false, ratio: 0, needed: 4.5 };
      if (!el) return none;
      // The kind, from where the node sits.
      const scrollsSideways = (node: Element | null): boolean => {
        for (let up = node; up; up = up.parentElement) {
          const overflow = getComputedStyle(up).overflowX;
          if ((overflow === 'auto' || overflow === 'scroll') && up.scrollWidth > up.clientWidth) return true;
        }
        return false;
      };
      const isKind =
        kind === 'nonBmp'
          ? el.tagName === 'KBD' && /^[^\p{L}\p{N}]+$/u.test((el.textContent ?? '').trim())
          : kind === 'bgOverlap'
            ? el.tagName === 'TH' && el.hasAttribute('rowspan')
            : kind === 'elmPartiallyObscuring'
              ? el.closest('[data-org-node]') !== null
              : scrollsSideways(el.parentElement);
      // A color as sRGB with alpha, read back from a canvas so any CSS color (oklch included) converts the way the
      // browser paints it.
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      const rgba = (color: string): [number, number, number, number] => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[];
        return [r as number, g as number, b as number, (a as number) / 255];
      };
      const over = (top: number[], below: number[]) => [0, 1, 2].map((i) => (top[i] as number) * (top[3] as number) + (below[i] as number) * (1 - (top[3] as number)));
      // The layers under the text, from the element down to the first opaque one (the page's own color last).
      let backgroundImage = false;
      const layers: Array<[number, number, number, number]> = [];
      for (let up: Element | null = el; up; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.backgroundImage !== 'none') backgroundImage = true;
        const color = rgba(style.backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] >= 1) break;
      }
      let bg = [255, 255, 255];
      for (const layer of layers.reverse()) bg = over(layer, bg);
      const fg = over(rgba(getComputedStyle(el).color), bg);
      const luminance = (c: number[]) => {
        const [r, g, b] = c.map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
      };
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
      const ratio = ((hi as number) + 0.05) / ((lo as number) + 0.05);
      const style = getComputedStyle(el);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (Number(style.fontWeight) >= 700 && size >= 18.66);
      // Nothing paints over the text: its part in view (inside the window and every clipping ancestor) is hit by the
      // element itself or by its own children at its middle.
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const range = document.createRange();
      range.selectNodeContents(el);
      const box = range.getBoundingClientRect();
      let left = Math.max(box.left, 0);
      let right = Math.min(box.right, window.innerWidth);
      for (let up = el.parentElement; up; up = up.parentElement) {
        if (getComputedStyle(up).overflowX !== 'visible') {
          const clip = up.getBoundingClientRect();
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
        }
      }
      const hit = right > left ? document.elementFromPoint((left + right) / 2, (box.top + box.bottom) / 2) : null;
      const covered = !hit || !(hit === el || el.contains(hit));
      return { found: true, kind: isKind, covered, backgroundImage, ratio, needed: large ? 3 : 4.5 };
    },
    { selector, kind },
  );
}

// Every violation counts, whatever its impact: the landing page has none to carry. A contrast axe cannot decide counts
// unless it is one of the kinds above and measures as passing.
async function scan(page: Page, axe: () => AxeBuilder): Promise<string[]> {
  const wcag = await axe().withTags(WCAG_TAGS).analyze();
  const structure = await axe().withRules(STRUCTURE_RULES).analyze();
  const problems = [...wcag.violations, ...structure.violations].map(
    (v) => `${v.impact ?? 'unknown'} ${v.id} on ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`,
  );
  for (const node of wcag.incomplete.filter((result) => result.id === 'color-contrast').flatMap((result) => result.nodes)) {
    const reason = (node.any[0]?.data as { messageKey?: string } | undefined)?.messageKey ?? 'unknown';
    const where = node.target.join(' ');
    if (!(UNDECIDED_KINDS as readonly string[]).includes(reason) || node.target.length !== 1) {
      problems.push(`undecided contrast ${reason} on ${where}: not a known kind (see UNDECIDED_KINDS)`);
      continue;
    }
    const m = await measure(page, String(node.target[0]), reason as UndecidedKind);
    if (!m.found) problems.push(`undecided contrast ${reason} on ${where}: element not found`);
    else if (!m.kind) problems.push(`undecided contrast ${reason} on ${where}: not where that kind is allowed`);
    else if (m.covered) problems.push(`undecided contrast ${reason} on ${where}: something paints over its text`);
    else if (m.backgroundImage) problems.push(`undecided contrast ${reason} on ${where}: a background image lies behind its text`);
    else if (m.ratio < m.needed) problems.push(`undecided contrast ${reason} on ${where}: ${m.ratio.toFixed(2)}:1, under ${m.needed}:1`);
  }
  return problems;
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
        problems.push(...(await scan(page, () => new AxeBuilder({ page }))));
        // The phone header's menu, scanned on its own once open: its panel covers the page below it.
        const menu = page.getByRole('banner').locator('button[aria-controls]');
        if (await menu.isVisible()) {
          await menu.click();
          const panel = `[id="${await menu.getAttribute('aria-controls')}"]`;
          await expect(page.locator(panel)).toBeVisible();
          for (const problem of await scan(page, () => new AxeBuilder({ page }).include(panel))) problems.push(`menu: ${problem}`);
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
      for (const name of ['aria-label', 'alt', 'title', 'placeholder']) {
        const value = el.getAttribute(name);
        if (value) found.push(value);
      }
    }
    return found;
  });
  expect(vietnameseLeft(texts.join('\n'))).toEqual([]);
});
