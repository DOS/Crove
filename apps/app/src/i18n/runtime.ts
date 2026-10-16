// The active locale and its messages, kept outside React so non-component code (API errors, the startup screen)
// translates too. The preference is stored in this browser only; it is a display setting, not account data.
import { createTranslator } from 'use-intl/core';
import { LOCALE_STORAGE_KEY, resolveLocale, type Locale } from './locale.ts';
import { en } from './messages/en.ts';
import { vi, type Messages } from './messages/vi.ts';

export const CATALOGS: Record<Locale, Messages> = { vi, en };

function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts until the page is reloaded.
  }
}

// Resolved on first use, so importing this module (in tests, for example) touches no browser storage.
let active: Locale | null = null;

export function activeLocale(): Locale {
  active ??= resolveLocale(readStoredLocale(), typeof navigator === 'undefined' ? [] : navigator.languages);
  return active;
}

// Saves the user's choice and makes it the active locale. The React tree re-renders through I18nProvider.
export function setActiveLocale(locale: Locale): void {
  active = locale;
  storeLocale(locale);
}

export function translatorFor(locale: Locale) {
  return createTranslator({ locale, messages: CATALOGS[locale] });
}

// A translator over the whole catalog, as useTranslations() returns it; pure helpers take one as an argument.
export type Translate = ReturnType<typeof translatorFor>;

const translators = new Map<Locale, Translate>();

// A translator for the active locale, for code outside React components.
export function translator(): Translate {
  const locale = activeLocale();
  let t = translators.get(locale);
  if (!t) {
    t = translatorFor(locale);
    translators.set(locale, t);
  }
  return t;
}
