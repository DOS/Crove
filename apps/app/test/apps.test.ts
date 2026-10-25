import { describe, expect, it } from 'vitest';
import { ALL_NAV, appOfPath, installedApps } from '../src/lib/apps.ts';

describe('apps of the shell (#1528)', () => {
  it('finds the app of a deep link from its screen', () => {
    expect(appOfPath('/o/acme/inbox')).toBe('home');
    expect(appOfPath('/o/acme/inbox/0190-abc')).toBe('home');
    expect(appOfPath('/o/acme/overview')).toBe('home');
    expect(appOfPath('/o/acme/journal')).toBe('accounting');
    expect(appOfPath('/o/acme/journal/opening-balances')).toBe('accounting');
    expect(appOfPath('/o/acme/portal-invoices')).toBe('accounting');
    expect(appOfPath('/o/acme/guide')).toBe('accounting');
    expect(appOfPath('/o/acme/social')).toBe('social');
    expect(appOfPath('/o/acme/social/channels')).toBe('social');
    expect(appOfPath('/o/acme/bookings')).toBe('crm');
  });

  it('puts the org own screens and paths outside an org in no app', () => {
    for (const path of ['/o/acme/settings', '/o/acme/agents', '/o/acme/audit', '/o/acme', '/clients', '/']) {
      expect(appOfPath(path), path).toBeNull();
    }
  });

  it('lists only the apps whose module runs, each opening on its first screen', () => {
    expect(installedApps(['kernel']).map((a) => a.id)).toEqual(['home']);
    const all = installedApps(['kernel', 'finance', 'social', 'crm']);
    expect(all.map((a) => a.id)).toEqual(['home', 'accounting', 'social', 'crm']);
    expect(all.find((a) => a.id === 'accounting')?.home).toBe('/o/$slug/documents');
    expect(all.find((a) => a.id === 'home')?.home).toBe('/o/$slug/overview');
  });

  it('keeps every screen in the palette, each in one place only', () => {
    const paths = ALL_NAV.map((item) => item.to);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('/o/$slug/settings');
    expect(paths).toContain('/o/$slug/ledger');
  });
});
