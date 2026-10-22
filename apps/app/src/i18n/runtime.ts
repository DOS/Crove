// The active locale and its messages, kept outside React so non-component code (API errors, the startup screen)
// translates too, and React follows it through useSyncExternalStore (provider.tsx). The preference is stored in this
// browser only; it is a display setting, not account data.
import { createTranslator } from 'use-intl/core';
import { brandCatalog, brandName, subscribeBrand, type Branded } from './brand.ts';
import type { CatalogShape } from './catalog.ts';
import { LOCALE_STORAGE_KEY, isLocale, resolveLocale, type Locale } from './locale.ts';
import { en } from './messages/en.ts';
import { vi, type Messages as SourceMessages } from './messages/vi.ts';

// en.ts is checked against vi.ts key by key and argument by argument (catalog.ts), so it stands in for the Vietnamese
// message types use-intl is configured with. These are the catalogs as written, with `{brand}` where they name the
// product (issue #1040); catalog() gives them with the name filled in.
export const SOURCE_CATALOGS: Record<Locale, SourceMessages> = { vi, en: en satisfies CatalogShape<SourceMessages> as unknown as SourceMessages };

// The messages use-intl is given: the source catalog with the product name filled in (brand.ts).
export type Messages = Branded<SourceMessages>;

const filled = new Map<Locale, { brand: string; messages: Messages }>();

// The catalog of a locale with the current product name, made once per locale and name.
export function catalog(locale: Locale): Messages {
  const brand = brandName();
  let entry = filled.get(locale);
  if (entry?.brand !== brand) {
    entry = { brand, messages: brandCatalog(SOURCE_CATALOGS[locale], brand) };
    filled.set(locale, entry);
  }
  return entry.messages;
}

function localStorageOrNull(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

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

function browserLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : navigator.languages;
}

// Resolved on first use, so importing this module (in tests, for example) touches no browser storage.
let active: Locale | null = null;
const listeners = new Set<() => void>();

export function activeLocale(): Locale {
  active ??= resolveLocale(readStoredLocale(), browserLanguages());
  return active;
}

// <html lang> follows the active locale, so screen readers and the browser's own UI use it.
function applyLocale(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  if (locale === active) return;
  active = locale;
  for (const listener of listeners) listener();
}

// Saves the user's choice and makes it the active locale; every subscriber (the React tree) re-renders.
export function setActiveLocale(locale: Locale): void {
  storeLocale(locale);
  applyLocale(locale);
}

// Calls `listener` after every change of the active locale. Returns the unsubscribe function.
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Sets <html lang> and follows the choice made in other tabs of this browser: localStorage fires `storage` in every
// other tab when one tab saves `crove-locale`. A removed or unknown value falls back to the browser languages.
// Returns the function that stops listening.
export function startLocaleSync(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  applyLocale(activeLocale());
  const onStorage = (event: StorageEvent) => {
    // key null: the whole storage was cleared. sessionStorage fires the same event; only localStorage holds the choice.
    if (event.key !== LOCALE_STORAGE_KEY && event.key !== null) return;
    if (event.storageArea && event.storageArea !== localStorageOrNull()) return;
    applyLocale(isLocale(event.newValue) ? event.newValue : resolveLocale(null, browserLanguages()));
  };
  target.addEventListener('storage', onStorage);
  return () => target.removeEventListener('storage', onStorage);
}

export function translatorFor(locale: Locale) {
  return createTranslator({ locale, messages: catalog(locale) });
}

// A translator over the whole catalog, as useTranslations() returns it; pure helpers take one as an argument.
export type Translate = ReturnType<typeof translatorFor>;

const translators = new Map<Locale, Translate>();
// A new product name makes new translators.
subscribeBrand(() => translators.clear());

// A translator for the active locale, for code outside React components. One per locale, made on first use.
export function translator(): Translate {
  const locale = activeLocale();
  let t = translators.get(locale);
  if (!t) {
    t = translatorFor(locale);
    translators.set(locale, t);
  }
  return t;
}
