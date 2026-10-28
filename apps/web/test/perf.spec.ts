// The landing page's performance budget (#1655; DESIGN.md §6.3), measured on the built site in Chromium: LCP under
// 2.5 s, CLS under 0.1 and INP under 200 ms on / and /en, on a throttled phone and on a desktop; at most two font
// families, each self-hosted, subset and preloaded; raster images only as AVIF or WebP, small, with their dimensions in
// the markup; and a cap on the client JavaScript the page loads. The numbers are in perf-budget.ts.
import { expect, test } from '@playwright/test';
import { BUDGET, PROFILES } from './perf-budget';
import { auditResources, measureVitals } from './perf-checks';

for (const path of ['/', '/en']) {
  for (const profile of PROFILES) {
    test(`${path} on ${profile.name} keeps LCP, CLS and INP in budget`, async ({ browser }) => {
      const { vitals, problems, summary } = await measureVitals(browser, path, profile, BUDGET.runs);
      // In the CI log too, so the margin left under the budget is seen on every run.
      console.log(`${path} ${profile.name}: ${summary}`);
      test.info().annotations.push({ type: 'vitals', description: `${path} ${profile.name}: ${summary}` });
      expect(problems).toEqual([]);
      expect(vitals.clicks, 'no interactive piece was clicked').toBeGreaterThan(0);
    });

    test(`${path} on ${profile.name} keeps its fonts, images and scripts in budget`, async ({ browser }) => {
      const { problems, summary } = await auditResources(browser, path, profile);
      console.log(`${path} ${profile.name}: ${summary}`);
      test.info().annotations.push({ type: 'resources', description: `${path} ${profile.name}: ${summary}` });
      expect(problems).toEqual([]);
    });
  }
}
