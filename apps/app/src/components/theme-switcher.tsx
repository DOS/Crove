import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useTranslations } from 'use-intl';
import { THEMES, type ThemeSetting } from '../lib/theme.ts';
import { useThemeSetting } from '../lib/theme-runtime.ts';

// System, light or dark, next to the language switch (issue #484).
export function ThemeSwitcher({ className }: { className?: string }) {
  const [setting, setSetting] = useThemeSetting();
  const t = useTranslations('common');
  return (
    <NativeSelect
      size="sm"
      className={className ?? 'text-muted-foreground'}
      value={setting}
      aria-label={t('theme')}
      onChange={(e) => setSetting(e.target.value as ThemeSetting)}
    >
      {THEMES.map((theme) => (
        <NativeSelectOption key={theme} value={theme}>
          {t(`themes.${theme}`)}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
