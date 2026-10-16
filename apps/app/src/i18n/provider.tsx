import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { IntlProvider, useTranslations } from 'use-intl';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../lib/format.ts';
import { LOCALES, LOCALE_NAMES, type Locale } from './locale.ts';
import { CATALOGS, activeLocale, setActiveLocale } from './runtime.ts';

const LocaleContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void }>({
  locale: activeLocale(),
  setLocale: setActiveLocale,
});

// Dates and times show in the browser's time zone, as before i18n.
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(activeLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo(
    () => ({
      locale,
      setLocale: (next: Locale) => {
        setActiveLocale(next);
        setLocaleState(next);
      },
    }),
    [locale],
  );
  return (
    <LocaleContext.Provider value={value}>
      <IntlProvider locale={locale} messages={CATALOGS[locale]} timeZone={timeZone}>
        {children}
      </IntlProvider>
    </LocaleContext.Provider>
  );
}

export function useLocaleSetting() {
  return useContext(LocaleContext);
}

// The formatting helpers bound to the active locale.
export function useFormat() {
  const { locale } = useLocaleSetting();
  return useMemo(
    () => ({
      money: (value: string | null | undefined, currency?: string) => formatMoney(value, locale, currency),
      number: (value: number | bigint | string) => formatNumber(value, locale),
      date: (value: string | null | undefined) => formatDate(value, locale),
      dateTime: (value: string | null | undefined) => formatDateTime(value, locale),
    }),
    [locale],
  );
}

export function LocaleSwitcher({ className }: { className?: string }) {
  const { locale, setLocale } = useLocaleSetting();
  const t = useTranslations('common');
  return (
    <NativeSelect
      size="sm"
      className={className}
      value={locale}
      aria-label={t('language')}
      onChange={(e) => setLocale(e.target.value as Locale)}
    >
      {LOCALES.map((l) => (
        <NativeSelectOption key={l} value={l}>
          {LOCALE_NAMES[l]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
