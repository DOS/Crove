import { Be_Vietnam_Pro, JetBrains_Mono } from 'next/font/google';

// Every face ships the Vietnamese subset (DESIGN.md 3.2). next/font self-hosts them at build time and declares every
// subset a family has; `subsets` names the ones it preloads (DESIGN.md 6.3: two families, preloaded, subset). Be
// Vietnam Pro sets both headings and text (the owner's pick, 2026-10-19); JetBrains Mono only amounts and codes.
export const bodyFont = Be_Vietnam_Pro({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});

// Only amounts and codes use it, so only the two files they need on both pages are preloaded (one variable file per
// subset serves both weights): Latin, and Latin Extended for the đồng sign. Its Vietnamese face is still declared and
// loads if a code ever needs it. The performance budget test fails on a font file that is downloaded but not preloaded.
export const codeFont = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500'],
  variable: '--font-code',
  display: 'swap',
});
