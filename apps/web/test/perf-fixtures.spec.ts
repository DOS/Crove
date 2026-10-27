// The performance budget catches what it forbids (#1655): a page with a large PNG, one with a third font family, one with
// a font that is neither preloaded nor subset, one whose content shifts and one with a slow click each fail the same
// checks perf.spec.ts runs on the landing page, and the same pages without the planted fault pass. The pages are served by Playwright on the site's own origin under /__budget-fixture/; nothing of
// them is in the site.
import { deflateSync, crc32 } from 'node:zlib';
import { expect, test, type BrowserContext } from '@playwright/test';
import { PROFILES } from './perf-budget';
import { auditResources, measureVitals } from './perf-checks';

const DESKTOP = PROFILES.find((profile) => profile.name === 'desktop')!;
const FIXTURE = '/__budget-fixture';

// A 1x1 lossless WebP.
const SMALL_WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

// A 320x320 PNG of noise, which does not compress: about 300 KB.
function largePng(): Buffer {
  const width = 320;
  const height = 320;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let seed = 1655;
  for (let i = 0; i < rows.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    rows[i] = i % (width * 3 + 1) === 0 ? 0 : seed >>> 24;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function html(head: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Budget fixture</title>${head}</head><body style="margin:0;font:20px/1.5 sans-serif"><main>${body}</main></body></html>`;
}

const TEXT = '<p style="margin:0;padding:16px;min-height:560px">' + 'The planted page measures what the budget measures. '.repeat(30) + '</p>';

const FONT_FACES = (families: string[], { preload = true, subset = true } = {}) =>
  families
    .map((family, i) => (preload ? `<link rel="preload" as="font" type="font/woff2" crossorigin href="${FIXTURE}/font-${i}.woff2">` : ''))
    .concat(
      `<style>${families.map((family, i) => `@font-face{font-family:"${family}";src:url(${FIXTURE}/font-${i}.woff2) format("woff2")${subset ? ';unicode-range:U+0000-00FF' : ''}}`).join('')}${families.map((family, i) => `.f${i}{font-family:"${family}",sans-serif}`).join('')}</style>`,
    )
    .join('');

const PAGES: Record<string, string> = {
  'large-png': html('', `<h1>Planted image</h1><img src="${FIXTURE}/planted.png" alt="">`),
  'small-webp': html('', `<h1>Small image</h1><img src="${FIXTURE}/small.webp" width="1" height="1" alt="">`),
  'three-fonts': html(FONT_FACES(['Planted One', 'Planted Two', 'Planted Three']), '<p class="f0">One</p><p class="f1">Two</p><p class="f2">Three</p>'),
  'two-fonts': html(FONT_FACES(['Planted One', 'Planted Two']), '<p class="f0">One</p><p class="f1">Two</p>'),
  'font-not-preloaded': html(FONT_FACES(['Planted One'], { preload: false, subset: false }), '<p class="f0">One</p>'),
  // 400px of space pushed in above the text once the page has painted, as a late banner or an image without its size
  // would.
  'layout-shift': html('', `${TEXT}<script>setTimeout(()=>{const d=document.createElement('div');d.style.height='400px';document.querySelector('main').prepend(d)},300)</script>`),
  'no-shift': html('', TEXT),
  // A click whose handler holds the main thread for 300 ms.
  'slow-click': html('', `${TEXT}<button type="button" onclick="const end=performance.now()+300;while(performance.now()<end);">Slow</button>`),
  'quick-click': html('', `${TEXT}<button type="button" onclick="this.textContent='Done'">Quick</button>`),
};

async function serveFixtures(context: BrowserContext): Promise<void> {
  await context.route(`**${FIXTURE}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(FIXTURE.length + 1);
    if (name === 'planted.png') return route.fulfill({ contentType: 'image/png', body: largePng() });
    if (name === 'small.webp') return route.fulfill({ contentType: 'image/webp', body: SMALL_WEBP });
    // Not a real font: the browser falls back to sans-serif, but it has downloaded the file and read the rule.
    if (name.endsWith('.woff2')) return route.fulfill({ contentType: 'font/woff2', body: Buffer.from('wOF2') });
    const page = PAGES[name];
    return page ? route.fulfill({ contentType: 'text/html', body: page }) : route.fulfill({ status: 404 });
  });
}

test('a large PNG fails the image checks', async ({ browser }) => {
  const { problems } = await auditResources(browser, `${FIXTURE}/large-png`, DESKTOP, serveFixtures);
  expect(problems).toEqual([
    `image ${FIXTURE}/planted.png is image/png, not AVIF or WebP`,
    expect.stringMatching(new RegExp(`^image ${FIXTURE}/planted\\.png is \\d+\\.\\d KB, over 100\\.0 KB$`)),
    `<img> ${FIXTURE}/planted.png is not AVIF or WebP`,
    `<img> ${FIXTURE}/planted.png has no width and height`,
  ]);
});

test('a small WebP with its size passes the image checks', async ({ browser }) => {
  const { problems } = await auditResources(browser, `${FIXTURE}/small-webp`, DESKTOP, serveFixtures);
  expect(problems).toEqual([]);
});

test('a third font family fails the font checks', async ({ browser }) => {
  const { problems } = await auditResources(browser, `${FIXTURE}/three-fonts`, DESKTOP, serveFixtures);
  expect(problems).toEqual(['3 font families (Planted One, Planted Two, Planted Three), at most 2']);
});

test('two preloaded, subset font families pass the font checks', async ({ browser }) => {
  const { problems } = await auditResources(browser, `${FIXTURE}/two-fonts`, DESKTOP, serveFixtures);
  expect(problems).toEqual([]);
});

test('a font that is neither preloaded nor subset fails the font checks', async ({ browser }) => {
  const { problems } = await auditResources(browser, `${FIXTURE}/font-not-preloaded`, DESKTOP, serveFixtures);
  expect(problems).toEqual(['font Planted One is not subset (no unicode-range)', `font ${FIXTURE}/font-0.woff2 is downloaded but not preloaded`]);
});

test('a layout shift fails the CLS budget', async ({ browser }) => {
  const { problems } = await measureVitals(browser, `${FIXTURE}/layout-shift`, DESKTOP, 1, serveFixtures);
  expect(problems).toEqual([expect.stringMatching(/^CLS 0\.\d{3}, at most 0\.1$/)]);
});

test('the same page without the shift passes the vitals budget', async ({ browser }) => {
  const { problems } = await measureVitals(browser, `${FIXTURE}/no-shift`, DESKTOP, 1, serveFixtures);
  expect(problems).toEqual([]);
});

test('a slow click fails the INP budget', async ({ browser }) => {
  const { problems, vitals } = await measureVitals(browser, `${FIXTURE}/slow-click`, DESKTOP, 1, serveFixtures);
  expect(vitals.clicks).toBe(1);
  expect(problems).toEqual([expect.stringMatching(/^INP \d+ ms, at most 200 ms$/)]);
});

test('a quick click passes the INP budget', async ({ browser }) => {
  const { problems, vitals } = await measureVitals(browser, `${FIXTURE}/quick-click`, DESKTOP, 1, serveFixtures);
  expect(vitals.clicks).toBe(1);
  expect(problems).toEqual([]);
});
