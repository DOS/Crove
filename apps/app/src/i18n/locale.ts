// Which language the SPA shows (issue #47). No browser or React imports, so it is unit tested.
export const LOCALES = ['vi', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'vi';

// Language names are shown in their own language, so they are not translated.
export const LOCALE_NAMES: Record<Locale, string> = { vi: 'Tiếng Việt', en: 'English' };

// The BCP 47 tag numbers and dates are formatted with. English uses day-first dates (en-GB), like the Vietnamese
// documents the app shows next to them.
export const FORMAT_LOCALE: Record<Locale, string> = { vi: 'vi-VN', en: 'en-GB' };

export const LOCALE_STORAGE_KEY = 'crove-locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

// The user's saved choice first, then the first supported browser language ("en-US" counts as "en"), then Vietnamese.
export function resolveLocale(stored: string | null | undefined, browserLanguages: readonly string[] = []): Locale {
  if (isLocale(stored)) return stored;
  for (const tag of browserLanguages) {
    const language = tag.toLowerCase().split('-')[0];
    if (isLocale(language)) return language;
  }
  return DEFAULT_LOCALE;
}
