import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { IntlProvider, useTranslations } from 'use-intl';
import { formatDate, formatDateTime, formatTime, formatDecimal, formatMoney, formatMonthYear, formatNumber, formatWeekdayShort } from '../lib/format.ts';
import { LOCALES, LOCALE_NAMES, type Locale } from './locale.ts';
import { CATALOGS, activeLocale, setActiveLocale, subscribeLocale } from './runtime.ts';

const LocaleContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void }>({
  locale: activeLocale(),
  setLocale: setActiveLocale,
});

// Dates and times show in the browser's time zone, as before i18n.
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// The tree follows the active locale of runtime.ts: a choice made here, or in another tab (startLocaleSync), re-renders
// it. Translated text is never kept in state, so everything on screen switches with it (issue #215).
export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, activeLocale, activeLocale);
  const value = useMemo(() => ({ locale, setLocale: setActiveLocale }), [locale]);
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
      // AI budgets and run costs (6 decimals).
      aiAmount: (value: string) => formatDecimal(value, locale, 6),
      date: (value: string | null | undefined) => formatDate(value, locale),
      dateTime: (value: string | null | undefined) => formatDateTime(value, locale),
      time: (value: string | null | undefined) => formatTime(value, locale),
      monthYear: (value: string) => formatMonthYear(value, locale),
      weekdayShort: (value: string) => formatWeekdayShort(value, locale),
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
      className={className ?? 'text-muted-foreground'}
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
