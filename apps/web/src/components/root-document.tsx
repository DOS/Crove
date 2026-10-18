import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../app/globals.css';
import { bodyFont, codeFont, headingFont } from '../app/fonts';
import type { Dictionary } from '../content/vi';
import { SITE_URL } from '../content/site';

// Applies a theme the visitor picked earlier before the first paint; without one the CSS follows the system.
const THEME_SCRIPT = `try{var t=localStorage.getItem('crove-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export function landingMetadata(dict: Dictionary, path: string): Metadata {
  return {
    metadataBase: new URL(SITE_URL),
    title: dict.meta.title,
    description: dict.meta.description,
    alternates: { canonical: path, languages: { vi: '/', en: '/en' } },
    icons: { icon: '/favicon.svg' },
    openGraph: { title: dict.meta.title, description: dict.meta.description, type: 'website', url: path, locale: dict.lang === 'vi' ? 'vi_VN' : 'en_US' },
  };
}

export const landingViewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
    { media: '(prefers-color-scheme: dark)', color: '#121216' },
  ],
};

export function RootDocument({ lang, children }: { lang: string; children: ReactNode }) {
  return (
    <html lang={lang} suppressHydrationWarning className={`${bodyFont.variable} ${headingFont.variable} ${codeFont.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
