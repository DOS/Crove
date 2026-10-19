import type { MetadataRoute } from 'next';
import { SITE_URL } from '../content/site';

// Both language versions, each pointing at the other (hreflang), so search engines show the right one.
export default function sitemap(): MetadataRoute.Sitemap {
  const languages = { vi: `${SITE_URL}/`, en: `${SITE_URL}/en` };
  return [
    { url: `${SITE_URL}/`, changeFrequency: 'weekly', priority: 1, alternates: { languages } },
    { url: `${SITE_URL}/en`, changeFrequency: 'weekly', priority: 0.8, alternates: { languages } },
  ];
}
