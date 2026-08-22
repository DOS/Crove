'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Language, translations, Translations } from './translations';

interface I18nContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  toggleLang: () => void;
  t: Translations;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({
  children,
  defaultLang = 'vi',
  storageKey = 'crove_lang',
}: {
  children: React.ReactNode;
  defaultLang?: Language;
  storageKey?: string;
}) {
  const [lang, setLangState] = useState<Language>(defaultLang);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const savedLang = localStorage.getItem(storageKey) as Language | null;
      if (savedLang === 'vi' || savedLang === 'en') {
        setLangState(savedLang);
      } else {
        // Auto-detect from navigator language
        const navLang = navigator.language.toLowerCase();
        if (navLang.startsWith('vi')) {
          setLangState('vi');
        } else {
          setLangState('en');
        }
      }
    } catch {
      // ignore
    }
    setMounted(true);
  }, [storageKey]);

  const setLang = (newLang: Language) => {
    try {
      localStorage.setItem(storageKey, newLang);
    } catch {
      // ignore
    }
    setLangState(newLang);
  };

  const toggleLang = () => {
    const next = lang === 'vi' ? 'en' : 'vi';
    setLang(next);
  };

  const currentTranslations = translations[lang] || translations.vi;

  return (
    <I18nContext.Provider
      value={{
        lang,
        setLang,
        toggleLang,
        t: currentTranslations,
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}
