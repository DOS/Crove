import { Be_Vietnam_Pro, JetBrains_Mono } from 'next/font/google';

// Every face ships the Vietnamese subset (DESIGN.md 3.2). next/font self-hosts them at build time. Be Vietnam Pro
// sets both headings and text (the owner's pick, 2026-10-19); JetBrains Mono only amounts and codes.
export const bodyFont = Be_Vietnam_Pro({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});

export const codeFont = JetBrains_Mono({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  weight: ['400', '500'],
  variable: '--font-code',
  display: 'swap',
  // Only amounts and codes use it; let the text face load first.
  preload: false,
});
