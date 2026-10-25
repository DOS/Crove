// LinkedIn Company Pages (#1077) are offered only when the deployment says its LinkedIn app has the Community
// Management API: asking a member for a scope the app lacks fails the whole LinkedIn dialog.
import { describe, expect, it } from 'vitest';
import { LINKEDIN_PAGES_NAMED } from '@crove/channel';
import { OAUTH_MAX_ACCOUNTS_PER_GRANT } from '@crove/kernel-contract';
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

  // LinkedIn grants the Community Management API only to an app with no other product.
  it('offers Company Pages from a separate app, alone or beside the member app, and needs both of its values', () => {
    const PAGE_APP = { CHANNEL_LINKEDIN_PAGE_CLIENT_ID: ['77pagesapp', '5678'].join(''), CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET: 'test-only-not-real-either' };
    const alone = loadConfig({ ...BASE, ...PAGE_APP, CHANNEL_LINKEDIN_ORGANIZATIONS: 'true' });
    expect(Object.keys(channelConnectors(alone))).toEqual(['linkedin_page']);
    expect(Object.keys(channelPublishers(alone)).filter((p) => p.startsWith('linkedin'))).toEqual(['linkedin_page']);
    const both = loadConfig({ ...BASE, ...LINKEDIN, ...PAGE_APP, CHANNEL_LINKEDIN_ORGANIZATIONS: 'true' });
    expect(Object.keys(channelConnectors(both)).sort()).toEqual(['linkedin', 'linkedin_page']);
    expect(Object.keys(channelConnectors(loadConfig({ ...BASE, ...LINKEDIN, ...PAGE_APP })))).toEqual(['linkedin']);
    expect(() => loadConfig({ ...BASE, CHANNEL_LINKEDIN_PAGE_CLIENT_ID: PAGE_APP.CHANNEL_LINKEDIN_PAGE_CLIENT_ID })).toThrow(/CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET/);
  });
});

describe('LinkedIn page names (#1096)', () => {
  it('names as many pages as a connect request keeps', () => {
    expect(LINKEDIN_PAGES_NAMED).toBe(OAUTH_MAX_ACCOUNTS_PER_GRANT);
  });
});
