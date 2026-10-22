// LinkedIn Company Pages (#1077) are offered only when the deployment says its LinkedIn app has the Community
// Management API: asking a member for a scope the app lacks fails the whole LinkedIn dialog.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { channelConnectors, channelPublishers, channelRefreshers } from '../src/kernel.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };
// A made-up app (the shape of a LinkedIn client id, nothing real).
const APP_ID = ['86abcdefgh', '1234'].join('');
const LINKEDIN = { CHANNEL_LINKEDIN_CLIENT_ID: APP_ID, CHANNEL_LINKEDIN_CLIENT_SECRET: 'test-only-not-real' };

describe('CHANNEL_LINKEDIN_ORGANIZATIONS', () => {
  it('offers the member provider alone while the flag is off', () => {
    const config = loadConfig({ ...BASE, ...LINKEDIN });
    expect(config.CHANNEL_LINKEDIN_ORGANIZATIONS).toBe('false');
    expect(Object.keys(channelConnectors(config))).toEqual(['linkedin']);
    expect(Object.keys(channelPublishers(config)).filter((p) => p.startsWith('linkedin'))).toEqual(['linkedin']);
  });

  it('offers Company Pages with the same app once it is on, and renews no token (none can be renewed)', () => {
    const config = loadConfig({ ...BASE, ...LINKEDIN, CHANNEL_LINKEDIN_ORGANIZATIONS: 'true' });
    expect(Object.keys(channelConnectors(config)).sort()).toEqual(['linkedin', 'linkedin_page']);
    expect(channelConnectors(config).linkedin_page?.provider).toBe('linkedin_page');
    expect(channelPublishers(config).linkedin_page?.provider).toBe('linkedin_page');
    expect(Object.keys(channelRefreshers(config)).filter((p) => p.startsWith('linkedin'))).toEqual([]);
  });

  it('refuses the flag without a LinkedIn app', () => {
    expect(() => loadConfig({ ...BASE, CHANNEL_LINKEDIN_ORGANIZATIONS: 'true' })).toThrow(/CHANNEL_LINKEDIN_ORGANIZATIONS/);
  });
});
