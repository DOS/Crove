// The fixed numbers of the landing page's performance budget (#1655). The vitals are DESIGN.md §6.3's; the caps on
// images and scripts are set from what the page loads today with some headroom, so growth past them is a decision
// made in review, not a drift.
import { devices, type BrowserContextOptions } from '@playwright/test';

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
// and a desktop on a fast line. INP is held to the budget on both. The theme toggle restyles the whole page, which on
// the phone landed near the 200 ms line from one run to the next; since #1668 the click answers with the button's own
// icon and the page restyles in the task after that paint (theme-toggle.tsx). The restyle costs the same main-thread
// time as before; INP no longer counts it, since it is not part of the click's answer.
export const PROFILES: Profile[] = [
  {
    name: 'mobile',
    context: { viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true, userAgent: devices['Moto G4'].userAgent },
    network: { latencyMs: 562.5, downloadKbps: 1474.56, uploadKbps: 675 },
    cpuSlowdown: 4,
    checksInp: true,
  },
  {
    name: 'desktop',
    context: { viewport: { width: 1350, height: 940 }, deviceScaleFactor: 1 },
    network: { latencyMs: 40, downloadKbps: 10240, uploadKbps: 10240 },
    cpuSlowdown: 1,
    checksInp: true,
  },
];
