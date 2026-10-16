import type { Locale } from './locale.ts';
import type { Messages } from './messages/vi.ts';

// Types every useTranslations() key against the Vietnamese catalog.
declare module 'use-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
