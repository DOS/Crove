// The terms of service and privacy notice linked at sign-up and invite acceptance (#688), from TERMS_URL and
// PRIVACY_URL in /api/config. The kernel accepts only https: pages; the app checks again, so an unexpected value hides
// the link rather than rendering it.
export interface LegalLinks {
  terms: string | null;
  privacy: string | null;
}

function httpsPage(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname !== '' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function legalLinks(config: { termsUrl?: string | null; privacyUrl?: string | null }): LegalLinks {
  return { terms: httpsPage(config.termsUrl), privacy: httpsPage(config.privacyUrl) };
}

// Which consent sentence fits the links the deployment set; null shows none.
export function consentKey(links: LegalLinks): 'consentBoth' | 'consentTerms' | 'consentPrivacy' | null {
  if (links.terms && links.privacy) return 'consentBoth';
  if (links.terms) return 'consentTerms';
  if (links.privacy) return 'consentPrivacy';
  return null;
}
