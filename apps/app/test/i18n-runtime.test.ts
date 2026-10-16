// The active locale outside and inside React (issue #215): resolution from the saved choice and the browser,
// saving the choice, the per-locale translator cache, <html lang>, other tabs, and the provider following it all.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Runtime = typeof import('../src/i18n/runtime.ts');

class MemoryStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }
}

let storage: MemoryStorage;
let html: { lang: string };

// Each test gets a fresh module, so the locale is resolved again from the stubs.
async function load(options: { stored?: string; languages?: string[]; storage?: unknown } = {}): Promise<Runtime> {
  storage = new MemoryStorage();
  if (options.stored) storage.values.set('crove-locale', options.stored);
  html = { lang: '' };
  vi.stubGlobal('localStorage', options.storage ?? storage);
  vi.stubGlobal('navigator', { languages: options.languages ?? [] });
  vi.stubGlobal('document', { documentElement: html });
  vi.resetModules();
  return import('../src/i18n/runtime.ts');
}

function storageEvent(key: string | null, newValue: string | null): Event {
  return Object.assign(new Event('storage'), { key, newValue });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('activeLocale', () => {
  it('uses the saved choice first', async () => {
    expect((await load({ stored: 'en', languages: ['vi-VN'] })).activeLocale()).toBe('en');
    expect((await load({ stored: 'vi', languages: ['en-US'] })).activeLocale()).toBe('vi');
  });

  it('then the first supported browser language, then Vietnamese', async () => {
    expect((await load({ languages: ['fr-FR', 'en-GB'] })).activeLocale()).toBe('en');
    expect((await load({ stored: 'xx', languages: ['de'] })).activeLocale()).toBe('vi');
    expect((await load()).activeLocale()).toBe('vi');
  });

  it('works when storage is unavailable (private mode)', async () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    const runtime = await load({ storage: blocked, languages: ['en-US'] });
    expect(runtime.activeLocale()).toBe('en');
    runtime.setActiveLocale('vi');
    expect(runtime.activeLocale()).toBe('vi');
  });
});

describe('setActiveLocale', () => {
  it('saves the choice, sets <html lang> and tells every subscriber', async () => {
    const runtime = await load({ languages: ['vi-VN'] });
    const seen: string[] = [];
    const stop = runtime.subscribeLocale(() => seen.push(runtime.activeLocale()));
    runtime.setActiveLocale('en');
    expect(storage.getItem('crove-locale')).toBe('en');
    expect(html.lang).toBe('en');
    expect(seen).toEqual(['en']);
    // The same locale again changes nothing on screen.
    runtime.setActiveLocale('en');
    expect(seen).toEqual(['en']);
    stop();
    runtime.setActiveLocale('vi');
    expect(seen).toEqual(['en']);
    expect(html.lang).toBe('vi');
  });
});

describe('translator', () => {
  it('keeps one translator per locale and follows the active locale', async () => {
    const runtime = await load({ languages: ['vi'] });
    const tVi = runtime.translator();
    expect(runtime.translator()).toBe(tVi);
    expect(tVi('common.cancel')).toBe('Hủy');
    runtime.setActiveLocale('en');
    const tEn = runtime.translator();
    expect(tEn).not.toBe(tVi);
    expect(tEn('common.cancel')).toBe('Cancel');
    runtime.setActiveLocale('vi');
    expect(runtime.translator()).toBe(tVi);
  });
});

describe('startLocaleSync', () => {
  it('sets <html lang> and follows a choice saved in another tab', async () => {
    const runtime = await load({ stored: 'vi', languages: ['en-US'] });
    const tab = new EventTarget();
    const seen: string[] = [];
    runtime.subscribeLocale(() => seen.push(runtime.activeLocale()));
    const stop = runtime.startLocaleSync(tab as unknown as Window);
    expect(html.lang).toBe('vi');

    tab.dispatchEvent(storageEvent('crove-auth', 'token'));
    expect(runtime.activeLocale()).toBe('vi');

    tab.dispatchEvent(storageEvent('crove-locale', 'en'));
    expect(runtime.activeLocale()).toBe('en');
    expect(html.lang).toBe('en');
    expect(seen).toEqual(['en']);
    // The other tab already saved it; this tab does not write it again.
    expect(storage.writes).toBe(0);

    // A removed or unknown value falls back to the browser languages, a cleared storage too.
    tab.dispatchEvent(storageEvent('crove-locale', 'vi'));
    tab.dispatchEvent(storageEvent('crove-locale', null));
    expect(runtime.activeLocale()).toBe('en');
    tab.dispatchEvent(storageEvent('crove-locale', 'vi'));
    tab.dispatchEvent(storageEvent(null, null));
    expect(runtime.activeLocale()).toBe('en');

    stop();
    tab.dispatchEvent(storageEvent('crove-locale', 'vi'));
    expect(runtime.activeLocale()).toBe('en');
  });
});

describe('I18nProvider', () => {
  it('renders the active locale and re-renders after a switch', async () => {
    const runtime = await load({ languages: ['vi-VN'] });
    const { I18nProvider, LocaleSwitcher, useFormat, useLocaleSetting } = await import('../src/i18n/provider.tsx');
    const { useTranslations } = await import('use-intl');
    function Probe() {
      const t = useTranslations('common');
      const { locale } = useLocaleSetting();
      const f = useFormat();
      return createElement('p', null, `${locale}|${t('cancel')}|${f.money('1980000.5')}`);
    }
    const render = () => renderToString(createElement(I18nProvider, null, createElement(Probe), createElement(LocaleSwitcher)));

    const before = render();
    expect(before).toContain('vi|Hủy|1.980.000,5');
    expect(before).toMatch(/value="vi" selected=""/);
    expect(before).toContain('aria-label="Ngôn ngữ"');
    runtime.setActiveLocale('en');
    const after = render();
    expect(after).toContain('en|Cancel|₫1,980,000.5');
    expect(after).toMatch(/value="en" selected=""/);
    expect(after).toContain('aria-label="Language"');
  });
});
