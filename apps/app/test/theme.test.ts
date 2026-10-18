// The theme setting and what it resolves to (issue #484). public/assets/theme-boot.js follows the same rule.
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, isThemeSetting, resolveTheme, themeSetting } from '../src/lib/theme.ts';

describe('theme', () => {
  it('accepts only system, light and dark', () => {
    expect(['system', 'light', 'dark'].every(isThemeSetting)).toBe(true);
    expect([null, undefined, '', 'Dark', 'blue', 1].some(isThemeSetting)).toBe(false);
  });

  it('falls back to dark, as the app has always opened', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(themeSetting(null)).toBe('dark');
    expect(themeSetting('nonsense')).toBe('dark');
    expect(themeSetting('light')).toBe('light');
  });

  it('follows the system only when the setting says so', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
