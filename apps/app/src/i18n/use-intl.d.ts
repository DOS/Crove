import type { Locale } from './locale.ts';
import type { Branded } from './brand.ts';
import type { Messages } from './messages/vi.ts';

// Types every useTranslations() key against the Vietnamese catalog, with the product name filled in (brand.ts): no
// call passes `brand`.
declare module 'use-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Branded<Messages>;
  }
}
