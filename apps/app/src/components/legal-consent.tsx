import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { getConfig } from '../lib/auth.ts';
import { consentKey, legalLinks } from '../lib/legal.ts';

// "By continuing you agree to the terms of service and the privacy notice" (#688), with links to the pages the
// deployment set in TERMS_URL and PRIVACY_URL; nothing when it set neither.
export function LegalConsent() {
  const t = useTranslations('legal');
  const links = legalLinks(getConfig());
  const key = consentKey(links);
  if (!key) return null;
  const link = (href: string | null) => (chunks: ReactNode) => (
    <a href={href ?? undefined} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
      {chunks}
    </a>
  );
  return <p className="text-xs text-subtle-foreground">{t.rich(key, { terms: link(links.terms), privacy: link(links.privacy) })}</p>;
}
