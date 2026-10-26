// Nothing slides, zooms, fades or pulses for a user whose system asks for reduced motion (#1605; DESIGN.md §7). A
// recorder in every page looks at the running animations and transitions every few milliseconds and notes the ones
// that last longer than a frame, the spinner aside (it is the only sign that work is running) and so are scroll-linked
// fades, which follow the user's own scroll. The walk loads every sidebar screen and hovers its controls, and opens the
// command palette and the account menu once. A probe, an element given a one-second transition, shows the recorder
// works: with the setting the stylesheet cuts it short and nothing is noted, without it the recorder notes it. Its own
// user, created confirmed without the sign-up form.
import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ viewport: { width: 1280, height: 800 } });

// A frame and a bit: what ends sooner is not seen as motion.
const FRAME_MS = 20;

function recordMotion(frameMs: number): void {
  const seen = new Set<string>();
  (window as unknown as { __motion: Set<string> }).__motion = seen;
  const look = () => {
    for (const animation of document.getAnimations()) {
      if (animation.playState !== 'running' || !(animation.timeline instanceof DocumentTimeline)) continue;
      const timing = animation.effect?.getComputedTiming();
      const duration = typeof timing?.duration === 'number' ? timing.duration : 0;
      if (duration <= frameMs && timing?.iterations !== Infinity) continue;
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (target?.closest('[data-slot="spinner"]')) continue;
      const what = animation instanceof CSSAnimation ? animation.animationName : animation instanceof CSSTransition ? animation.transitionProperty : 'script';
      seen.add(`${what} (${Math.round(duration)} ms) on ${target?.tagName.toLowerCase()} "${(target?.getAttribute('class') ?? '').slice(0, 60)}"`);
    }
  };
  // A timer rather than animation frames, which a headless browser may produce sparingly.
  setInterval(look, 5);
}

const PROBE = 'motion-probe';

// Adds an element with a one-second opacity transition and starts it; whether the recorder then noted it.
async function probeSeen(page: Page): Promise<boolean> {
  await page.evaluate((name) => {
    const el = document.createElement('div');
    el.className = name;
    el.style.transition = 'opacity 1s linear';
    document.body.append(el);
    // Laid out at full opacity first, so the change below transitions.
    el.getBoundingClientRect();
    el.style.opacity = '0';
  }, PROBE);
  await page.waitForTimeout(300);
  return (await motion(page)).some((m) => m.includes(PROBE));
}

const motion = (page: Page) => page.evaluate(() => [...(window as unknown as { __motion: Set<string> }).__motion]);

// Moves the pointer over the screen's buttons and links, one after another, so their hover transitions run.
async function hoverControls(page: Page, max = 12): Promise<void> {
  const controls = page.locator('main button:visible, main a[href]:visible, aside a[href]:visible');
  const count = Math.min(await controls.count(), max);
  for (let i = 0; i < count; i++) await controls.nth(i).hover({ timeout: 2_000 }).catch(() => undefined);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
}

async function openPaletteAndClose(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: 'Bảng lệnh' })).toBeFocused();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: 'Bảng lệnh' })).toBeHidden();
}

test('nothing on the sidebar screens slides, zooms, fades or pulses when the system asks for reduced motion (#1605)', async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(recordMotion, FRAME_MS);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInNewUser(page, newEmail('reduced-motion'));
  await createOrg(page, 'Công ty Giảm chuyển động');
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
  const note = async (where: string) => {
    for (const m of await motion(page)) problems.add(`${where}: ${m}`);
  };
  let first = true;
  for (const path of links) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await hoverControls(page);
    if (first) {
      first = false;
      await openPaletteAndClose(page);
      await sidebar.locator('summary').click();
      await page.waitForTimeout(300);
      expect(await probeSeen(page), 'the stylesheet cuts the probe short').toBe(false);
    }
    await note(path);
  }
  expect([...problems]).toEqual([]);

  await test.step('without the setting, the recorder notes the probe moving', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto([...links][0]!);
    await page.waitForLoadState('networkidle');
    expect(await probeSeen(page)).toBe(true);
  });
});
