// The shell's "Góp ý / Hỗ trợ" link (issue #310), from SUPPORT_URL in /api/config. The kernel refuses to start with
// anything but an https: or mailto: URL; the app checks again, so an unexpected value hides the link rather than
// rendering it.
export interface SupportLink {
  href: string;
  // An https: page opens in a new tab; a mailto: link hands over to the mail app.
  external: boolean;
}

export function supportLink(url: string | null | undefined): SupportLink | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'https:' && parsed.hostname !== '') return { href: parsed.href, external: true };
  if (parsed.protocol === 'mailto:' && parsed.pathname.trim() !== '') return { href: parsed.href, external: false };
  return null;
}
