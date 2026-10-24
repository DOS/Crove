// Pure helpers for the offboarding card in settings (issue #212). No browser or API imports, so they are unit tested.
import type { Locale } from '../i18n/locale.ts';
import { brandFileName } from '../i18n/brand.ts';
import type { Translate } from '../i18n/runtime.ts';
import { describeError } from './errors.ts';

export interface OrgExportState {
  status: 'active' | 'offboarding' | 'closed';
  requestedAt: string | null;
  export: { createdAt: string; expiresAt: string; expired: boolean } | null;
}

// What the card shows: nothing asked yet, an export being made, the last export ready to download, or only an
// expired one. An export older than the newest request is still offered while the new one is made.
export type ExportPhase = 'none' | 'pending' | 'ready' | 'expired';

export function exportPhase(state: OrgExportState): { phase: ExportPhase; downloadable: boolean } {
  const ready = state.export && !state.export.expired ? state.export : null;
  const pending = state.requestedAt !== null && (!state.export || Date.parse(state.export.createdAt) < Date.parse(state.requestedAt));
  if (pending) return { phase: 'pending', downloadable: ready !== null };
  if (ready) return { phase: 'ready', downloadable: true };
  if (state.export) return { phase: 'expired', downloadable: false };
  return { phase: 'none', downloadable: false };
}

// The confirm button stays off until the owner typed the slug exactly (the server checks it again).
export function slugConfirmed(typed: string, slug: string): boolean {
  return typed.trim() === slug;
}

// Clear messages for the answers kernel.org.offboard can give. STEP_UP_REQUIRED is the R3 answer (P11): a second
// factor in the last 5 minutes; the challenge screen lands with the SPA MFA flows.
export function offboardErrorMessage(error: unknown, t: Translate, locale: Locale): string {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  if (e.code === 'STEP_UP_REQUIRED') return t('offboarding.errors.stepUp');
  if (e.code === 'SLUG_MISMATCH') return t('offboarding.errors.slug');
  if (e.code === 'EXPORT_PENDING') return t('offboarding.errors.pending');
  if (e.code === 'FORBIDDEN') return t('offboarding.errors.forbidden');
  return describeError(error, t, locale);
}

// 1536 -> "1,5 KB" style sizes for the table list.
export function formatBytes(bytes: number, number: (value: number) => string): string {
  if (bytes < 1024) return `${number(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${number(Math.round(value * 10) / 10)} ${units[unit]}`;
}

// The file name a download is saved as, prefixed by the product name (BRAND_NAME, #1045).
export function exportFileName(slug: string, part: string): string {
  return brandFileName(`crove-${slug}-${part}.${part === 'manifest' ? 'json' : 'ndjson'}`);
}
