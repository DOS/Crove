// How the performance budget (#1655) measures a page: the vitals over a few first visits under a profile's throttling,
// and what the page downloads and declares (fonts, images, scripts). perf.spec.ts runs them on the landing page;
// perf-fixtures.spec.ts plants what the budget forbids and checks that they catch it.
import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';
import { BUDGET, type Profile } from './perf-budget';

type Vitals = { lcp: number; cls: number; inp: number; clicks: number };
type Setup = (context: BrowserContext) => Promise<void>;

// Records the vitals as the page runs, before any of its own script: the largest contentful paint, every layout shift
// that no input caused, and the duration of every interaction (the Event Timing entries that share an interactionId).
function observeVitals(): void {
  const store = { lcp: null as number | null, shifts: [] as Array<{ t: number; v: number }>, events: new Map<number, number>() };
  (window as unknown as { __vitals: typeof store }).__vitals = store;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) store.lcp = entry.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
      if (!entry.hadRecentInput) store.shifts.push({ t: entry.startTime, v: entry.value });
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as Array<PerformanceEntry & { interactionId?: number }>) {
      if (entry.interactionId) store.events.set(entry.interactionId, Math.max(store.events.get(entry.interactionId) ?? 0, entry.duration));
    }
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
}

// CLS as Chrome reports it: the largest session window of shifts, a window closing after a 1 s gap or at 5 s. INP is
// the slowest interaction, as it is for a page with fewer than 50 of them; one under 16 ms is not reported, so a page
// whose every interaction is that fast has an INP of 0. A page that painted nothing has an LCP of Infinity, which fails
// the budget.
async function readVitals(page: Page): Promise<Omit<Vitals, 'clicks'>> {
  return page.evaluate(() => {
    const store = (window as unknown as { __vitals: { lcp: number | null; shifts: Array<{ t: number; v: number }>; events: Map<number, number> } }).__vitals;
    let cls = 0;
    let windowValue = 0;
    let windowStart = -Infinity;
    let last = -Infinity;
    for (const shift of store.shifts) {
      if (shift.t - last > 1000 || shift.t - windowStart > 5000) {
        windowStart = shift.t;
        windowValue = 0;
      }
      windowValue += shift.v;
      last = shift.t;
      cls = Math.max(cls, windowValue);
    }
    const durations = [...store.events.values()];
    return { lcp: store.lcp ?? Infinity, cls, inp: durations.length ? Math.max(...durations) : 0 };
  });
}

async function throttle(cdp: CDPSession, profile: Profile): Promise<void> {
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.network.latencyMs,
    downloadThroughput: (profile.network.downloadKbps * 1024) / 8,
    uploadThroughput: (profile.network.uploadKbps * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown });
}

// Scrolls through the whole page a screen at a time, as a reader would, so a shift further down (a late image, a
// section that grows when it plays) counts too.
async function scrollThrough(page: Page): Promise<void> {
  for (let step = 0; step < 60; step++) {
    const done = await page.evaluate(() => {
      window.scrollBy(0, Math.round(window.innerHeight * 0.8));
      return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    });
    await page.waitForTimeout(150);
    if (done) break;
  }
  await page.waitForTimeout(1200);
}

// Uses each interactive piece once: every visible button and FAQ question, the phone menu opened and closed again.
// Returns the number of clicks.
async function interact(page: Page): Promise<number> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const targets = page.locator('main summary, main button:not([disabled]), header button');
  let clicks = 0;
  for (const target of await targets.all()) {
    if (!(await target.isVisible()) || !(await target.isEnabled())) continue;
    await target.scrollIntoViewIfNeeded();
    await target.click();
    clicks++;
    if (await target.getAttribute('aria-controls')) {
      await target.click();
      clicks++;
    }
  }
  await page.waitForTimeout(500);
  return clicks;
}

// The vitals of `runs` first visits (each a new context, so an empty cache). LCP is the median of the runs, so one
// stall of a shared runner does not decide it; CLS is the worst run; INP is measured in the last run, which uses every
// interactive piece once.
export async function measureVitals(browser: Browser, path: string, profile: Profile, runs: number, setup?: Setup) {
  const measured: Vitals[] = [];
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext(profile.context);
    await setup?.(context);
    const page = await context.newPage();
    await throttle(await context.newCDPSession(page), profile);
    await page.addInitScript(observeVitals);
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    // LCP stops at the first scroll or input, so it is read before either.
    const { lcp } = await readVitals(page);
    await scrollThrough(page);
    const clicks = run === runs - 1 ? await interact(page) : 0;
    measured.push({ ...(await readVitals(page)), lcp, clicks });
    await context.close();
  }
  const lcps = measured.map((r) => r.lcp).sort((a, b) => a - b);
  const last = measured[measured.length - 1];
  const vitals = { lcp: lcps[Math.floor(lcps.length / 2)], cls: Math.max(...measured.map((r) => r.cls)), inp: last.inp, clicks: last.clicks };
  const problems: string[] = [];
  if (!(vitals.lcp < BUDGET.lcpMs)) problems.push(`LCP ${vitals.lcp} ms (median of ${lcps.join(', ')}), at most ${BUDGET.lcpMs} ms`);
  if (!(vitals.cls < BUDGET.cls)) problems.push(`CLS ${vitals.cls.toFixed(3)}, at most ${BUDGET.cls}`);
  if (profile.checksInp && !(vitals.inp < BUDGET.inpMs)) problems.push(`INP ${vitals.inp} ms, at most ${BUDGET.inpMs} ms`);
  const summary = `LCP ${lcps.join(', ')} ms; CLS ${vitals.cls.toFixed(4)}; INP ${vitals.inp} ms over ${vitals.clicks} clicks${profile.checksInp ? '' : ' (reported only)'}`;
  return { vitals, problems, summary };
}

type Loaded = { url: string; type: string; contentType: string; bytes: number | null; encoded: number | null };

// What one visit downloads and what the page declares, against the budget's rules for fonts, images and scripts.
export async function auditResources(browser: Browser, path: string, profile: Profile, setup?: Setup) {
  const context = await browser.newContext(profile.context);
  await setup?.(context);
  const page = await context.newPage();
  const loaded: Array<Promise<Loaded | null>> = [];
  page.on('requestfinished', (request) => {
    loaded.push(
      (async () => {
        const response = await request.response();
        if (!response || request.url().startsWith('data:')) return null;
        return {
          url: request.url(),
          type: request.resourceType(),
          contentType: (response.headers()['content-type'] ?? '').split(';')[0].trim(),
          bytes: (await response.body().catch(() => null))?.length ?? null,
          // sizes() rejects when the request was torn down before Playwright read them; the size is then unknown,
          // which the checks below report rather than count as 0.
          encoded: (await request.sizes().catch(() => null))?.responseBodySize ?? null,
        };
      })(),
    );
  });
  await page.goto(path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await scrollThrough(page);
  await page.waitForLoadState('networkidle');
  const origin = new URL(page.url()).origin;
  const dom = await page.evaluate(readDocument);
  const resources = (await Promise.all(loaded)).filter((r): r is Loaded => r !== null);
  await context.close();

  const problems: string[] = [];

  // Fonts: the families the stylesheets download (next/font's metric-matched fallbacks use local() and are not
  // counted), each subset with a unicode-range, every downloaded file preloaded and served from this site.
  const families = [...new Set(dom.fontFaces.filter((face) => face.remote).map((face) => face.family))];
  if (families.length > BUDGET.fontFamilies) problems.push(`${families.length} font families (${families.join(', ')}), at most ${BUDGET.fontFamilies}`);
  for (const face of dom.fontFaces.filter((f) => f.remote && !f.unicodeRange)) problems.push(`font ${face.family} is not subset (no unicode-range)`);
  for (const sheet of dom.unreadableSheets) problems.push(`stylesheet ${sheet} from another origin`);
  for (const font of resources.filter((r) => r.type === 'font')) {
    if (new URL(font.url).origin !== origin) problems.push(`font ${font.url} from another origin`);
    else if (!dom.preloadedFonts.includes(font.url)) problems.push(`font ${pathOf(font.url)} is downloaded but not preloaded`);
  }

  // Raster images: AVIF or WebP only, each under the size cap, and an <img> with a raster source has its width and
  // height in the markup so it reserves its box.
  for (const image of resources.filter((r) => r.type === 'image' && r.contentType !== 'image/svg+xml')) {
    if (!['image/avif', 'image/webp'].includes(image.contentType)) problems.push(`image ${pathOf(image.url)} is ${image.contentType || 'of no type'}, not AVIF or WebP`);
    // Chromium keeps no body for an image, so its size is the one sent (images are sent uncompressed).
    if (image.bytes === null && image.encoded === null) {
      problems.push(`image ${pathOf(image.url)} could not be read, so its size is unknown`);
      continue;
    }
    const size = Math.max(image.bytes ?? 0, image.encoded ?? 0);
    if (size > BUDGET.imageBytes) problems.push(`image ${pathOf(image.url)} is ${kb(size)}, over ${kb(BUDGET.imageBytes)}`);
  }
  // An <img> is judged by the type it was served as (next/image negotiates the format behind one URL), or by its
  // data: URL.
  const servedAs = new Map(resources.map((r) => [r.url, r.contentType]));
  for (const img of dom.images.filter((i) => i.src)) {
    const name = img.src.startsWith('data:') ? img.src.slice(0, 30) : pathOf(img.src);
    const type = img.src.startsWith('data:') ? (/^data:([^;,]*)/.exec(img.src)?.[1] ?? '') : (servedAs.get(img.src) ?? '');
    if (type === 'image/svg+xml') continue;
    if (!['image/avif', 'image/webp'].includes(type)) problems.push(`<img> ${name} is not AVIF or WebP`);
    if (!img.width || !img.height) problems.push(`<img> ${name} has no width and height`);
  }

  // Client JavaScript: Next's runtime, React and the interactive islands, from this site, under a cap in files and in
  // bytes (sent and decoded).
  const scripts = resources.filter((r) => r.type === 'script');
  const encoded = scripts.reduce((sum, s) => sum + (s.encoded ?? 0), 0);
  const decoded = scripts.reduce((sum, s) => sum + (s.bytes ?? 0), 0);
  for (const script of scripts.filter((s) => s.bytes === null || s.encoded === null)) problems.push(`script ${pathOf(script.url)} could not be read, so its size is unknown`);
  for (const script of scripts.filter((s) => new URL(s.url).origin !== origin)) problems.push(`script ${script.url} from another origin`);
  if (scripts.length > BUDGET.scriptFiles) problems.push(`${scripts.length} script files, at most ${BUDGET.scriptFiles}`);
  if (encoded > BUDGET.scriptBytesSent) problems.push(`${kb(encoded)} of script sent, at most ${kb(BUDGET.scriptBytesSent)}`);
  if (decoded > BUDGET.scriptBytes) problems.push(`${kb(decoded)} of script decoded, at most ${kb(BUDGET.scriptBytes)}`);

  const summary = `fonts ${families.join(', ')}; ${dom.preloadedFonts.length} font preloads; ${scripts.length} scripts, ${kb(encoded)} sent, ${kb(decoded)} decoded`;
  return { problems, summary };
}

// What the page's markup and stylesheets declare: the @font-face rules (also inside @media, @supports, @layer and
// imported sheets), the preloaded fonts, the images.
function readDocument() {
  const fontFaces: Array<{ family: string; remote: boolean; unicodeRange: string }> = [];
  const unreadableSheets: string[] = [];
  const walk = (sheet: CSSStyleSheet) => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      unreadableSheets.push(sheet.href ?? '(inline)');
      return;
    }
    const visit = (list: CSSRuleList) => {
      for (const rule of list) {
        if (rule instanceof CSSImportRule && rule.styleSheet) walk(rule.styleSheet);
        else if (rule instanceof CSSGroupingRule) visit(rule.cssRules);
        else if (rule instanceof CSSFontFaceRule) {
          const family = rule.style.getPropertyValue('font-family').replace(/^["']|["']$/g, '');
          fontFaces.push({ family, remote: /url\(/.test(rule.style.getPropertyValue('src')), unicodeRange: rule.style.getPropertyValue('unicode-range') });
        }
      }
    };
    visit(rules);
  };
  for (const sheet of document.styleSheets) walk(sheet);
  const preloadedFonts = [...document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="font"]')].map((link) => link.href);
  const images = [...document.querySelectorAll('img')].map((img) => {
    const src = img.currentSrc || img.src;
    return { src, width: img.getAttribute('width'), height: img.getAttribute('height') };
  });
  return { fontFaces, unreadableSheets, preloadedFonts, images };
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
