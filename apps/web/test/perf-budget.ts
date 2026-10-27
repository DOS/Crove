// The fixed numbers of the landing page's performance budget (#1655). The vitals are DESIGN.md §6.3's; the caps on
// images and scripts are set from what the page loads today with some headroom, so growth past them is a decision
// made in review, not a drift.
import type { BrowserContextOptions } from '@playwright/test';

export const BUDGET = {
  // DESIGN.md §6.3, Core Web Vitals.
  lcpMs: 2500,
  cls: 0.1,
  inpMs: 200,
  // Page loads per page and profile; LCP is their median.
  runs: 3,
  // DESIGN.md §6.3: "Two font families at most".
  fontFamilies: 2,
  // DESIGN.md §6.3: product visuals are HTML and SVG, so a raster image is the exception and stays small.
  imageBytes: 100 * 1024,
  // Next's runtime, React and the interactive islands (theme toggle, phone menu, copy button, org chart, the hero's
  // product picture; client-islands.test.ts lists them). Today: 6 files, 141 KB sent, 478 KB decoded, on both pages.
  scriptFiles: 8,
  scriptBytesSent: 170 * 1024,
  scriptBytes: 575 * 1024,
} as const;

export type Profile = {
  name: string;
  context: BrowserContextOptions;
  network: { latencyMs: number; downloadKbps: number; uploadKbps: number };
  cpuSlowdown: number;
  // Whether INP is held to the budget here, or only reported (see PROFILES).
  checksInp: boolean;
};

// Lighthouse's two profiles as DevTools throttling applies them: a mid-range phone on slow 4G with a 4x slower CPU,
// and a desktop on a fast line. INP is held to the budget on the desktop, where the CPU runs at the runner's own speed;
// on the phone it is only reported: a 4x slowdown of a CI runner is not a calibrated phone, and the theme toggle
// restyles the whole page, which there lands near the 200 ms line from one run to the next.
export const PROFILES: Profile[] = [
  {
    name: 'mobile',
    context: { viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true },
    network: { latencyMs: 562.5, downloadKbps: 1474.56, uploadKbps: 675 },
    cpuSlowdown: 4,
    checksInp: false,
  },
  {
    name: 'desktop',
    context: { viewport: { width: 1350, height: 940 }, deviceScaleFactor: 1 },
    network: { latencyMs: 40, downloadKbps: 10240, uploadKbps: 10240 },
    cpuSlowdown: 1,
    checksInp: true,
  },
];
