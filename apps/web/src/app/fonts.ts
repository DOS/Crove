import { Archivo, Be_Vietnam_Pro, JetBrains_Mono } from 'next/font/google';

// Every face ships the Vietnamese subset (DESIGN.md 3.2). next/font self-hosts them at build time.
export const bodyFont = Be_Vietnam_Pro({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});

export const headingFont = Archivo({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  weight: ['500', '600'],
  variable: '--font-heading',
  display: 'swap',
});

export const codeFont = JetBrains_Mono({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  weight: ['400', '500'],
  variable: '--font-code',
  display: 'swap',
});
