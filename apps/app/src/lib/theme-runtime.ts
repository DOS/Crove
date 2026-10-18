// The active theme, kept outside React like the locale (i18n/runtime.ts): the setting lives in this browser only, the
// <html> element gets the resolved theme, and React follows through useSyncExternalStore (useThemeSetting).
import { useSyncExternalStore } from 'react';
import { resolveTheme, THEME_STORAGE_KEY, themeSetting, type ThemeSetting } from './theme.ts';

const listeners = new Set<() => void>();
let current: ThemeSetting = themeSetting(readStored());

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function systemQuery(): MediaQueryList | null {
  return typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia('(prefers-color-scheme: dark)');
}

function apply(): void {
  const dark = resolveTheme(current, systemQuery()?.matches ?? true) === 'dark';
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

function notify(): void {
  apply();
  for (const listener of listeners) listener();
}

export function activeThemeSetting(): ThemeSetting {
  return current;
}

export function setThemeSetting(setting: ThemeSetting): void {
  current = setting;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, setting);
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts until the page is reloaded.
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Follows the system while the setting is "system", and a choice made in another tab.
export function startThemeSync(): void {
  apply();
  systemQuery()?.addEventListener('change', () => {
    if (current === 'system') notify();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    current = themeSetting(event.newValue);
    notify();
  });
}

export function useThemeSetting(): [ThemeSetting, (setting: ThemeSetting) => void] {
  const setting = useSyncExternalStore(subscribe, activeThemeSetting, activeThemeSetting);
  return [setting, setThemeSetting];
}
