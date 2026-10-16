// Helpers behind the offboarding card in settings (issue #212).
import { describe, expect, it } from 'vitest';
import { exportFileName, exportPhase, formatBytes, offboardErrorMessage, slugConfirmed } from '../src/lib/offboarding.ts';
import { translatorFor } from '../src/i18n/runtime.ts';

const vi = translatorFor('vi');
const en = translatorFor('en');

describe('exportPhase', () => {
  const made = { createdAt: '2026-10-16T10:00:00.000Z', expiresAt: '2026-11-20T10:00:00.000Z', expired: false };

  it('tells nothing asked, pending, ready and expired apart', () => {
    expect(exportPhase({ status: 'active', requestedAt: null, export: null })).toEqual({ phase: 'none', downloadable: false });
    expect(exportPhase({ status: 'offboarding', requestedAt: '2026-10-16T09:00:00.000Z', export: null })).toEqual({ phase: 'pending', downloadable: false });
    expect(exportPhase({ status: 'offboarding', requestedAt: '2026-10-16T09:00:00.000Z', export: made })).toEqual({ phase: 'ready', downloadable: true });
    expect(exportPhase({ status: 'offboarding', requestedAt: '2026-10-16T09:00:00.000Z', export: { ...made, expired: true } })).toEqual({
      phase: 'expired',
      downloadable: false,
    });
  });

  it('keeps the last export downloadable while a new one is made', () => {
    expect(exportPhase({ status: 'offboarding', requestedAt: '2026-10-17T09:00:00.000Z', export: made })).toEqual({ phase: 'pending', downloadable: true });
    expect(exportPhase({ status: 'offboarding', requestedAt: '2026-10-17T09:00:00.000Z', export: { ...made, expired: true } })).toEqual({
      phase: 'pending',
      downloadable: false,
    });
  });
});

describe('offboarding helpers', () => {
  it('confirms only the exact slug', () => {
    expect(slugConfirmed('cong-ty-a', 'cong-ty-a')).toBe(true);
    expect(slugConfirmed(' cong-ty-a ', 'cong-ty-a')).toBe(true);
    expect(slugConfirmed('Cong-ty-a', 'cong-ty-a')).toBe(false);
    expect(slugConfirmed('', 'cong-ty-a')).toBe(false);
  });

  it('explains the refusals in both languages', () => {
    expect(offboardErrorMessage({ code: 'STEP_UP_REQUIRED', message: 'raw' }, vi)).toContain('xác thực hai lớp');
    expect(offboardErrorMessage({ code: 'STEP_UP_REQUIRED' }, en)).toContain('two-factor');
    expect(offboardErrorMessage({ code: 'SLUG_MISMATCH' }, vi)).toContain('Mã rút gọn');
    expect(offboardErrorMessage({ code: 'EXPORT_PENDING' }, en)).toContain('being exported');
    expect(offboardErrorMessage({ code: 'OTHER', message: 'Lỗi riêng' }, vi)).toBe('Lỗi riêng');
    expect(offboardErrorMessage(null, en)).toBe(en('common.error'));
  });

  it('formats sizes and file names', () => {
    const n = (v: number) => String(v);
    expect(formatBytes(512, n)).toBe('512 B');
    expect(formatBytes(1536, n)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024, n)).toBe('5 MB');
    expect(formatBytes(3 * 1024 ** 4, n)).toBe('3072 GB');
    expect(exportFileName('cong-ty-a', 'manifest')).toBe('crove-cong-ty-a-manifest.json');
    expect(exportFileName('cong-ty-a', 'kernel.party')).toBe('crove-cong-ty-a-kernel.party.ndjson');
  });
});
