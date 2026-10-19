// The app's color theme (issue #484): the user's setting and the theme it resolves to. No browser or React imports, so
// it is unit tested. public/assets/theme-boot.js applies the same rule before the first paint; keep the two in step.

export const THEMES = ['system', 'light', 'dark'] as const;
export type ThemeSetting = (typeof THEMES)[number];
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'crove-theme';

// Light until the user picks something else (the owner's call, 2026-10-19).
export const DEFAULT_THEME: ThemeSetting = 'light';

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

// The stored setting, or the default when nothing valid is stored.
export function themeSetting(stored: string | null | undefined): ThemeSetting {
  return isThemeSetting(stored) ? stored : DEFAULT_THEME;
}

// The theme to draw: the setting itself, or the system's preference when the setting is "system".
export function resolveTheme(setting: ThemeSetting, systemPrefersDark: boolean): Theme {
  if (setting === 'system') return systemPrefersDark ? 'dark' : 'light';
  return setting;
}
