import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import type { Dictionary } from '../content/vi';

export const OG_SIZE = { width: 1200, height: 630 };

// Satori draws only with the fonts it is given, and next/font keeps its files out of reach here, so the image asks
// Google Fonts for Be Vietnam Pro cut down to exactly the characters it draws (the `text` parameter returns one file,
// Vietnamese marks included). This runs at build time, like next/font itself.
async function font(weight: 400 | 600, text: string): Promise<ArrayBuffer> {
  const url = `https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@${weight}&text=${encodeURIComponent(text)}`;
  const css = await (await fetch(url)).text();
  const src = css.match(/src: url\((.+?)\) format\('(?:truetype|opentype)'\)/)?.[1];
  if (!src) throw new Error('Be Vietnam Pro: no TrueType or OpenType source in the Google Fonts answer');
  return (await fetch(src)).arrayBuffer();
}

// The social preview for one language: the brand, the hero line and the product promise, in the site's dark palette.
// Colors are literal here because the image is drawn outside the page's CSS.
export async function renderOgImage(dict: Dictionary): Promise<ImageResponse> {
  const text = [...new Set(`Crove crove.com ${dict.hero.line1} ${dict.hero.line2} ${dict.footer.tagline}`)].join('');
  const [regular, semibold] = await Promise.all([font(400, text), font(600, text)]);
  const mark = await readFile(join(process.cwd(), 'public', 'favicon.svg'), 'utf8');
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: '#141418', color: '#f6f6f8', fontFamily: 'Be Vietnam Pro' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <img src={`data:image/svg+xml;base64,${Buffer.from(mark).toString('base64')}`} width={56} height={56} alt="" />
          <span style={{ fontSize: 40, fontWeight: 600 }}>Crove</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 68, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.12 }}>{dict.hero.line1}</span>
          <span style={{ fontSize: 68, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.12, color: '#a9a9b6' }}>{dict.hero.line2}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 26, color: '#a9a9b6' }}>
          <span style={{ maxWidth: 820 }}>{dict.footer.tagline}</span>
          <span style={{ color: '#b9a6ff' }}>crove.com</span>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: 'Be Vietnam Pro', data: regular, weight: 400, style: 'normal' },
        { name: 'Be Vietnam Pro', data: semibold, weight: 600, style: 'normal' },
      ],
    },
  );
}
